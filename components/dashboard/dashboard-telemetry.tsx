import { Activity, GitBranch, Loader2 } from "lucide-react";

/**
 * Lightweight CSS-vector telemetry widgets for the dashboard. No chart library
 * is pulled in — the bars are plain divs sized by percentage, so the panels
 * stay fast and render server-side with zero client JS.
 */

export interface SaturationBucket {
  band: "Critical" | "High" | "Moderate" | "Normal";
  count: number;
}

export interface SplitterRunRate {
  total: number;
  empty: number;
  partial: number;
  capped: number;
  configuredPorts: number;
  capacityPorts: number;
}

export interface WorkerQueueSnapshot {
  running: number;
  completed: number;
  failed: number;
  committedRows: number;
  jobs: Array<{
    batchId: string;
    state: string;
    committedRows: number;
    remainingRows: number | null;
  }>;
}

const BAND_META: Record<SaturationBucket["band"], { label: string; cls: string }> = {
  Critical: { label: "Critical", cls: "util-cell-critical" },
  High: { label: "High", cls: "util-cell-high" },
  Moderate: { label: "Moderate", cls: "util-cell-moderate" },
  Normal: { label: "Normal", cls: "util-cell-normal" },
};

export function OdfSaturationWidget({ buckets, scopeLabel }: { buckets: SaturationBucket[]; scopeLabel: string }) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-sky-500" />
        <div className="section-title">ODF Port Saturation Distribution</div>
      </div>
      <div className="subtle mt-1">Capacity tiers across {total} {scopeLabel}.</div>
      <div className="mt-4 space-y-3">
        {buckets.map((bucket) => {
          const pct = total ? Math.round((bucket.count / total) * 100) : 0;
          const meta = BAND_META[bucket.band];
          return (
            <div key={bucket.band}>
              <div className="mb-1 flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-700 dark:text-slate-200">{meta.label}</span>
                <span className="text-slate-500 dark:text-slate-400">{bucket.count} · {pct}%</span>
              </div>
              <span className={`util-cell-bar ${meta.cls} block !w-full`}>
                <span style={{ width: `${pct}%` }} />
              </span>
            </div>
          );
        })}
        {!total ? <div className="subtle">No live utilization data yet.</div> : null}
      </div>
    </div>
  );
}

export function SplitterRunRateWidget({ runRate }: { runRate: SplitterRunRate }) {
  const { total, empty, partial, capped, configuredPorts, capacityPorts } = runRate;
  const segments = [
    { label: "Capped", count: capped, cls: "util-cell-critical" },
    { label: "Partial", count: partial, cls: "util-cell-moderate" },
    { label: "Empty", count: empty, cls: "util-cell-normal" },
  ];
  const fillPct = capacityPorts ? Math.round((configuredPorts / capacityPorts) * 100) : 0;
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-rose-500" />
        <div className="section-title">Splitter Allocation Run-Rates</div>
      </div>
      <div className="subtle mt-1">{total} live splitters · {fillPct}% of output ports configured.</div>
      <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        {segments.map((segment) => {
          const pct = total ? (segment.count / total) * 100 : 0;
          if (!pct) return null;
          return <span key={segment.label} className={`block h-full ${segment.cls.replace("util-cell-", "util-fill-")}`} style={{ width: `${pct}%` }} title={`${segment.label}: ${segment.count}`} />;
        })}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        {segments.map((segment) => (
          <div key={segment.label} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="text-2xl font-semibold text-slate-950 dark:text-white">{segment.count}</div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">{segment.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkerQueueWidget({ snapshot }: { snapshot: WorkerQueueSnapshot }) {
  const { running, completed, failed, committedRows, jobs } = snapshot;
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        {running > 0 ? <Loader2 className="h-4 w-4 animate-spin text-indigo-500" /> : <Activity className="h-4 w-4 text-indigo-500" />}
        <div className="section-title">Background Worker Queue</div>
      </div>
      <div className="subtle mt-1">Asynchronous batch ingestion · {committedRows.toLocaleString()} rows committed this session.</div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg border border-indigo-300/40 bg-indigo-500/10 p-3">
          <div className="text-2xl font-semibold text-indigo-700 dark:text-indigo-200">{running}</div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Running</div>
        </div>
        <div className="rounded-lg border border-emerald-300/40 bg-emerald-500/10 p-3">
          <div className="text-2xl font-semibold text-emerald-700 dark:text-emerald-200">{completed}</div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Completed</div>
        </div>
        <div className="rounded-lg border border-rose-300/40 bg-rose-500/10 p-3">
          <div className="text-2xl font-semibold text-rose-700 dark:text-rose-200">{failed}</div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Failed</div>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {jobs.length ? jobs.slice(0, 4).map((job, index) => (
          <div key={job.batchId} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300">Import batch {index + 1}</span>
            <span className={`import-decision import-decision-${job.state === "RUNNING" ? "ready" : job.state === "COMPLETED" ? "committed" : "rejected"}`}>
              {job.state === "RUNNING" ? `${job.committedRows} committed · ${job.remainingRows ?? "?"} left` : job.state}
            </span>
          </div>
        )) : <div className="subtle">No background jobs running. Approve a large upload to queue one.</div>}
      </div>
    </div>
  );
}
