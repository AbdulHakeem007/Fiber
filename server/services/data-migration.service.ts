import { spawn } from "node:child_process";
import { stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { backupService, type BackupFileInfo } from "@/server/services/backup.service";

/**
 * Backup-guarded Python data-migration trigger.
 *
 * Flow (enforced order):
 *   1. The moment an admin triggers a run, a FULL database backup is taken and
 *      VERIFIED on disk. If the backup fails or cannot be verified, the run is
 *      aborted and the Python script NEVER executes.
 *   2. Only after a safely-stored, verified backup does the Python migration
 *      script launch — as a background child process. The admin can navigate
 *      anywhere in the portal; job state lives in process/global memory and is
 *      polled by the Admin panel.
 *
 * Only one migration runs at a time (idempotent: re-triggering while a job is
 * BACKING_UP / RUNNING returns the live job instead of starting a second one).
 */
export interface DataMigrationJob {
  state: "BACKING_UP" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  backup: BackupFileInfo | null;
  backupVerified: boolean;
  inputWorkbook: string | null;
  outputDir: string | null;
  exitCode: number | null;
  logTail: string[];
  error: string | null;
  triggeredBy: string | null;
}

const LOG_TAIL_MAX = 80;

// Survive Next.js dev-mode HMR the way the Prisma singleton does: module state is
// wiped on hot reload, globalThis is not.
const globalState = globalThis as unknown as { __dataMigrationJob?: DataMigrationJob | null };

function pythonBin(): string {
  return process.env.PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3");
}

function appendLog(job: DataMigrationJob, chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed) job.logTail.push(trimmed);
  }
  if (job.logTail.length > LOG_TAIL_MAX) job.logTail.splice(0, job.logTail.length - LOG_TAIL_MAX);
}

/** Confirm the backup file actually exists on disk and is non-empty. */
async function verifyBackupOnDisk(backup: BackupFileInfo): Promise<boolean> {
  try {
    const dir = process.env.BACKUP_DIR?.trim() || "backups";
    const info = await stat(path.resolve(process.cwd(), dir, backup.fileName));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function finish(job: DataMigrationJob, state: "COMPLETED" | "FAILED", error?: string | null) {
  job.state = state;
  if (error) job.error = error;
  job.finishedAt = new Date().toISOString();
}

export const dataMigrationService = {
  get(): DataMigrationJob | null {
    return globalState.__dataMigrationJob ?? null;
  },

  async start(options: { inputWorkbook?: string | null; triggeredBy?: string | null }): Promise<DataMigrationJob> {
    const existing = globalState.__dataMigrationJob ?? null;
    if (existing && (existing.state === "BACKING_UP" || existing.state === "RUNNING")) {
      return existing; // idempotent — never double-run
    }

    const inputWorkbook = options.inputWorkbook?.trim() || process.env.MIGRATION_INPUT_WORKBOOK?.trim() || "";
    const job: DataMigrationJob = {
      state: "BACKING_UP",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      backup: null,
      backupVerified: false,
      inputWorkbook: inputWorkbook || null,
      outputDir: null,
      exitCode: null,
      logTail: [],
      error: null,
      triggeredBy: options.triggeredBy ?? null,
    };
    globalState.__dataMigrationJob = job;

    // ── GUARDRAIL: full, verified backup BEFORE anything else ──
    try {
      const backup = await backupService.runBackup("pre-migration guardrail");
      job.backup = backup;
      job.backupVerified = await verifyBackupOnDisk(backup);
      if (!job.backupVerified) {
        finish(job, "FAILED", "Pre-migration backup could not be verified on disk. Migration aborted; no data was touched.");
        return job;
      }
    } catch (error) {
      finish(job, "FAILED", `Pre-migration backup failed: ${error instanceof Error ? error.message : "unknown error"}. Migration aborted.`);
      return job;
    }

    // ── Validate inputs only AFTER the backup is safely stored ──
    if (!inputWorkbook) {
      finish(job, "FAILED", "No migration input workbook was provided. Set MIGRATION_INPUT_WORKBOOK or pass an input path. A verified backup was still taken.");
      return job;
    }
    const resolvedInput = path.resolve(process.cwd(), inputWorkbook);
    try {
      const info = await stat(resolvedInput);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      finish(job, "FAILED", `Migration input workbook not found: ${inputWorkbook}. A verified backup was still taken.`);
      return job;
    }

    const outputDir = path.resolve(process.cwd(), process.env.MIGRATION_OUTPUT_DIR?.trim() || "storage/migration_output");
    await mkdir(outputDir, { recursive: true }).catch(() => {});
    job.outputDir = outputDir;

    const scriptPath = path.resolve(process.cwd(), "scripts/odf_inventory_template_extractor_v27.py");

    // ── Launch the Python migration in the background ──
    job.state = "RUNNING";
    try {
      const child = spawn(pythonBin(), [scriptPath, "--input", resolvedInput, "--output-dir", outputDir], {
        cwd: process.cwd(),
        windowsHide: true,
      });
      child.stdout?.on("data", (data) => appendLog(job, String(data)));
      child.stderr?.on("data", (data) => appendLog(job, String(data)));
      child.on("error", (error) => {
        if (job.state === "RUNNING") {
          finish(job, "FAILED", `Failed to launch Python migration: ${error.message}. Confirm Python is installed and on PATH (or set PYTHON_BIN).`);
        }
      });
      child.on("close", (code) => {
        if (job.state !== "RUNNING") return; // already failed via "error"
        job.exitCode = code;
        finish(job, code === 0 ? "COMPLETED" : "FAILED", code === 0 ? null : `Python migration exited with code ${code}. See log output below.`);
      });
    } catch (error) {
      finish(job, "FAILED", `Failed to start Python migration: ${error instanceof Error ? error.message : "unknown error"}.`);
    }

    return job;
  },
};
