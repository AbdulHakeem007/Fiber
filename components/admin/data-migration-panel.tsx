"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseBackup, Loader2, Play, ShieldCheck, TerminalSquare } from "lucide-react";

interface MigrationJob {
  state: "BACKING_UP" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  backup: { fileName: string; sizeBytes: number } | null;
  backupVerified: boolean;
  inputWorkbook: string | null;
  outputDir: string | null;
  exitCode: number | null;
  logTail: string[];
  error: string | null;
  triggeredBy: string | null;
}

const STATE_LABEL: Record<MigrationJob["state"], string> = {
  BACKING_UP: "Backing up database…",
  RUNNING: "Running Python migration…",
  COMPLETED: "Migration complete",
  FAILED: "Migration failed",
};

const STATE_TONE: Record<MigrationJob["state"], string> = {
  BACKING_UP: "text-amber-700 dark:text-amber-200",
  RUNNING: "text-cyan-700 dark:text-cyan-200",
  COMPLETED: "text-emerald-700 dark:text-emerald-200",
  FAILED: "text-rose-700 dark:text-rose-200",
};

export function DataMigrationPanel() {
  const [inputWorkbook, setInputWorkbook] = useState("");
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const isActive = job?.state === "BACKING_UP" || job?.state === "RUNNING";

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/migrate");
      if (!response.ok) return;
      const payload = await response.json();
      setJob(payload.job ?? null);
    } catch {
      // Transient — the next poll recovers.
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return stopPolling;
  }, [loadStatus, stopPolling]);

  useEffect(() => {
    if (isActive && !timer.current) {
      timer.current = setInterval(loadStatus, 2500);
    } else if (!isActive) {
      stopPolling();
    }
  }, [isActive, loadStatus, stopPolling]);

  async function runMigration() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputWorkbook: inputWorkbook.trim() || undefined }),
      });
      const payload = await response.json();
      if (payload.job) setJob(payload.job as MigrationJob);
      if (!response.ok) {
        setMessage(payload.error ?? payload.job?.error ?? "Migration could not be started.");
      } else {
        setMessage(
          "Verified backup stored. Python migration is running in the background — you can navigate anywhere in the portal.",
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Migration request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <DatabaseBackup className="h-4 w-4 text-violet-500" />
        <div className="section-title">Data migration</div>
      </div>
      <div className="subtle mt-1">
        Runs the Python ODF inventory extractor. A full database backup is taken and verified <strong>before</strong> the
        migration is allowed to start; the script then runs in the background.
      </div>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Source workbook path</span>
          <input
            className="input-dark w-full"
            placeholder="Source workbook path (optional if MIGRATION_INPUT_WORKBOOK is set)"
            value={inputWorkbook}
            onChange={(event) => setInputWorkbook(event.target.value)}
            disabled={busy || isActive}
          />
        </label>
        <button
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          onClick={runMigration}
          disabled={busy || isActive}
        >
          {busy || isActive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {isActive ? STATE_LABEL[job!.state] : "Back up & run migration"}
        </button>
      </div>

      {message ? <div className="mt-4 rounded-xl border border-border bg-white/5 p-3 text-sm text-slate-800 dark:text-slate-100">{message}</div> : null}

      {job ? (
        <div className="mt-4 space-y-3 rounded-xl border border-border bg-white/5 p-4 text-sm">
          <div className={`flex items-center gap-2 font-semibold ${STATE_TONE[job.state]}`}>
            {job.state === "BACKING_UP" || job.state === "RUNNING" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {STATE_LABEL[job.state]}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 ${job.backupVerified ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-200" : "border-amber-500/40 text-amber-700 dark:text-amber-200"}`}>
              {job.backupVerified ? <ShieldCheck className="h-3.5 w-3.5" /> : <DatabaseBackup className="h-3.5 w-3.5" />}
              {job.backup ? `Backup ${job.backupVerified ? "verified" : "pending"}: ${job.backup.fileName}` : "Backup pending"}
            </span>
            {job.inputWorkbook ? <span className="rounded-lg border border-border px-2 py-1">Input: {job.inputWorkbook}</span> : null}
            {job.outputDir ? <span className="rounded-lg border border-border px-2 py-1">Output: {job.outputDir}</span> : null}
            {job.exitCode !== null ? <span className="rounded-lg border border-border px-2 py-1">Exit: {job.exitCode}</span> : null}
          </div>

          {job.error ? <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-800 dark:text-rose-100">{job.error}</div> : null}

          {job.logTail.length ? (
            <div>
              <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <TerminalSquare className="h-3.5 w-3.5" />
                Migration output
              </div>
              <pre className="max-h-48 overflow-auto rounded-lg bg-slate-950/90 p-3 text-[11px] leading-snug text-slate-100">{job.logTail.join("\n")}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
