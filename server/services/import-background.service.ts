import { importService } from "@/server/services/import.service";

/**
 * Asynchronous batch-commit framework for massive uploads.
 *
 * The operator approves the ENTIRE upload once; the server then walks the
 * batch in bounded resumable windows (reusing the same cursor machinery the
 * synchronous client loop uses) while the operator is free to navigate away.
 * Progress is persisted to the ImportBatch counters by every window, so the
 * import history stays truthful even across page loads, and the in-memory job
 * record gives the Import Center live progress while it polls.
 */
export interface BackgroundCommitJob {
  batchId: string;
  state: "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  committedRows: number;
  skippedRows: number;
  outOfScopeRows: number;
  remainingRows: number | null;
  windowsProcessed: number;
  error: string | null;
}

/** Rows committed per window — small enough that each DB pass stays snappy. */
const WINDOW_SIZE = 250;

// Survive Next.js dev-mode HMR the same way the Prisma client singleton does:
// module state is wiped on hot reload, globalThis is not.
const globalJobs = globalThis as unknown as {
  __importBackgroundJobs?: Map<string, BackgroundCommitJob>;
};
const jobs: Map<string, BackgroundCommitJob> =
  globalJobs.__importBackgroundJobs ?? new Map<string, BackgroundCommitJob>();
globalJobs.__importBackgroundJobs = jobs;

export interface BackgroundApproveOptions {
  rowIds?: string[];
  sheetName?: string | null;
  approveCleanOnly?: boolean;
  reviewerComment?: string | null;
}

/** Bounded number of full-batch sweeps chasing transiently deferred rows.
 *  Each sweep only re-touches rows that are still committable, so re-sweeping
 *  an almost-finished batch is cheap. */
const MAX_DEFERRED_SWEEPS = 5;

async function runJob(batchId: string, committedById: string, options: BackgroundApproveOptions) {
  const job = jobs.get(batchId);
  if (!job) return;
  try {
    // SINGLE-CLICK GUARANTEE (multi-click import bug fix): the outer loop
    // re-sweeps the batch while any window reported deferred rows — rows that
    // hit a transient DB error even after in-window retries and were left
    // committable. Previously those rows were silently parked as SKIPPED and
    // the operator had to click Import again (and again) to push them through.
    for (let sweep = 0; sweep < MAX_DEFERRED_SWEEPS; sweep += 1) {
      let cursor = 0;
      let sweepDeferred = 0;
      for (;;) {
        const result = await importService.approveBatchRows(batchId, committedById, {
          ...options,
          maxRows: WINDOW_SIZE,
          afterRowNumber: cursor,
          progressOnly: true,
        });
        const progress = result.commitProgress;
        job.committedRows += progress.committedRows;
        // Skipped/out-of-scope rows are recounted on every sweep (they stay in
        // committable statuses) — only accumulate them once, on the first pass.
        if (sweep === 0) {
          job.skippedRows += progress.skippedRows;
          job.outOfScopeRows += progress.outOfScopeRows;
        }
        job.remainingRows = progress.remainingRows;
        job.windowsProcessed += 1;
        sweepDeferred += progress.deferredRows ?? 0;
        if (progress.nextCursor === null) break;
        // A cursor that stops advancing means the eligible window cannot make
        // progress (every remaining row is filtered out) — bail instead of spinning.
        if (progress.nextCursor <= cursor) break;
        cursor = progress.nextCursor;
        // Yield the event loop between windows so this long-running approve
        // never starves interactive API requests from operators elsewhere.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!sweepDeferred) break;
      // Give transient contention (locks, connection blips) time to clear
      // before chasing the deferred rows again — linear backoff per sweep.
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (sweep + 1)));
    }
    job.state = "COMPLETED";
    job.remainingRows = 0;
    job.finishedAt = new Date().toISOString();
  } catch (error) {
    job.state = "FAILED";
    job.error = error instanceof Error ? error.message : "Background commit failed.";
    job.finishedAt = new Date().toISOString();
  }
}

export const importBackgroundService = {
  /**
   * Start (or return the already-running) background approval for a batch.
   * Idempotent per batch: a second click while a job runs simply reports the
   * live job instead of double-committing.
   */
  start(batchId: string, committedById: string, options: BackgroundApproveOptions = {}): BackgroundCommitJob {
    const existing = jobs.get(batchId);
    if (existing && existing.state === "RUNNING") return existing;

    const job: BackgroundCommitJob = {
      batchId,
      state: "RUNNING",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      committedRows: 0,
      skippedRows: 0,
      outOfScopeRows: 0,
      remainingRows: null,
      windowsProcessed: 0,
      error: null,
    };
    jobs.set(batchId, job);
    void runJob(batchId, committedById, options);
    return job;
  },

  get(batchId: string): BackgroundCommitJob | null {
    return jobs.get(batchId) ?? null;
  },

  /** Snapshot of all known jobs, newest first — drives the dashboard queue panel. */
  list(): BackgroundCommitJob[] {
    return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },

  /** Live counts for the dashboard worker-queue widget. */
  queueSummary(): { running: number; completed: number; failed: number; committedRows: number } {
    let running = 0;
    let completed = 0;
    let failed = 0;
    let committedRows = 0;
    for (const job of jobs.values()) {
      if (job.state === "RUNNING") running += 1;
      else if (job.state === "COMPLETED") completed += 1;
      else if (job.state === "FAILED") failed += 1;
      committedRows += job.committedRows;
    }
    return { running, completed, failed, committedRows };
  },
};
