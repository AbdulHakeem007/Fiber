"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Shuffle } from "lucide-react";
import { ExchangeGrid, type ExchangeRow } from "@/components/dashboard/dashboard-overview";

const BATCH_SIZE = 20;
const ROTATE_MS = 45_000;

function siteValue(row: ExchangeRow): number {
  return row.activePorts ?? 0;
}

function hasCriticalityTag(row: ExchangeRow, upperTag: string): boolean {
  return (row.criticalityTags ?? []).some((tag) => tag.trim().toUpperCase() === upperTag);
}
function isDatacenterSite(row: ExchangeRow): boolean {
  return Boolean(row.isDatacenter) || hasCriticalityTag(row, "DC");
}
function isCoreSiteRow(row: ExchangeRow): boolean {
  return Boolean(row.isCoreSite) || hasCriticalityTag(row, "CORE");
}
function tierRank(row: ExchangeRow): number {
  if (isDatacenterSite(row)) return 0;
  if (isCoreSiteRow(row)) return 1;
  return 2;
}

export function ExchangeGridRotator({ rows }: { rows: ExchangeRow[] }) {
  const pool = useMemo(() => {
    const tagged = rows.filter((row) => isDatacenterSite(row) || isCoreSiteRow(row));
    const source = tagged.length ? tagged : rows;
    return [...source].sort((a, b) => tierRank(a) - tierRank(b) || siteValue(b) - siteValue(a));
  }, [rows]);

  const pageCount = Math.max(1, Math.ceil(pool.length / BATCH_SIZE));
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const safePage = page % pageCount;

  useEffect(() => {
    if (paused || pageCount <= 1) return;
    const timer = setInterval(() => setPage((current) => (current + 1) % pageCount), ROTATE_MS);
    return () => clearInterval(timer);
  }, [pageCount, paused]);

  const start = safePage * BATCH_SIZE;
  const batch = pool.slice(start, start + BATCH_SIZE);
  const dcCount = pool.filter((row) => isDatacenterSite(row)).length;
  const coreCount = pool.filter((row) => isCoreSiteRow(row) && !isDatacenterSite(row)).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="subtle">
          Showing {pool.length ? start + 1 : 0}-{Math.min(start + BATCH_SIZE, pool.length)} of {pool.length}
          {" · "}DataCenter ({dcCount}) to Core ({coreCount}) priority · {paused ? "paused" : "rotates every 45s"}
        </span>
        <span className="flex items-center gap-1" aria-label={`Batch ${safePage + 1} of ${pageCount}`}>
          <button className="btn btn-ghost btn-compact" onClick={() => setPaused((value) => !value)} title={paused ? "Resume rotation" : "Pause rotation"}>
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <button className="btn btn-ghost btn-compact" onClick={() => setPage((current) => (current + pageCount - 1) % pageCount)} disabled={pageCount <= 1} title="Previous page">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button className="btn btn-ghost btn-compact" onClick={() => setPage((current) => (current + 1) % pageCount)} disabled={pageCount <= 1} title="Next page">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button className="btn btn-ghost btn-compact" onClick={() => setPage(Math.floor(Math.random() * pageCount))} disabled={pageCount <= 1} title="Shuffle page">
            <Shuffle className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <ExchangeGrid rows={batch} shellClassName="exch-grid-shell-tall" />
    </div>
  );
}
