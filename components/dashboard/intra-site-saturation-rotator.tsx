"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Download, Pause, Play, Shuffle, X } from "lucide-react";
import * as XLSX from "xlsx";
import type { IntraSiteSaturationRow } from "@/server/services/intra-site-saturation.service";
import { SiteTagBadge } from "@/components/dashboard/site-tag-badge";
import { displayCleanSiteId } from "@/lib/telecom/site-display";
import { prioritySiteTag } from "@/lib/telecom/site-tags";

const PAGE_SIZE = 7;
const ROTATE_MS = 45_000;

function band(pct: number): "critical" | "high" | "moderate" | "normal" {
  return pct > 90 ? "critical" : pct > 75 ? "high" : pct > 50 ? "moderate" : "normal";
}

function rowKey(row: IntraSiteSaturationRow, suffix = "") {
  return `${row.segmentId}:${row.parentSiteId ?? row.parentSiteLabel}:${suffix}`;
}

function exportRows(title: string, rows: IntraSiteSaturationRow[]) {
  const data = rows.map((row) => ({
    Segment: row.segmentName,
    "Active Ports": row.activePorts,
    "Available Ports": row.availablePorts,
    "Total Capacity": row.totalCapacity,
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), "Segments");
  XLSX.writeFile(workbook, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "odf-saturation"}.xlsx`);
}

function SaturationTableRows({ rows, emptyText, sectionLabel }: { rows: IntraSiteSaturationRow[]; emptyText?: string; sectionLabel?: string }) {
  return (
    <>
      {sectionLabel && rows.length ? (
        <tr className="odf-section-row">
          <td colSpan={7}>{sectionLabel}</td>
        </tr>
      ) : null}
      {rows.map((row) => {
        const cleanSiteId = displayCleanSiteId(row.parentSiteId ?? row.parentSiteLabel);
        const tag = prioritySiteTag({ criticalityTags: row.siteTags });
        return (
          <tr key={rowKey(row, sectionLabel)}>
            <td className="intra-seg-name">
              <Link href={`/inventory?search=${encodeURIComponent(row.segmentName)}`} className="intra-seg-title hover:underline" title={`Open ${row.segmentName} in Inventory`}>
                {row.segmentName}
              </Link>
              <span className="intra-seg-parent" title="Parent site">{row.parentSiteLabel}</span>
            </td>
            <td className="exch-name">
              <Link href={`/sites/${encodeURIComponent(row.parentSiteId ?? cleanSiteId)}`} className="exch-site-id hover:underline" title={`Open ${row.parentSiteLabel} topology canvas`}>
                {cleanSiteId}
              </Link>
            </td>
            <td className="exch-tag-cell"><SiteTagBadge tag={tag} /></td>
            <td className="num">{row.totalCapacity.toLocaleString()}</td>
            <td className="num">{row.nearAvailablePorts.toLocaleString()}</td>
            <td className="num">{row.farAvailablePorts.toLocaleString()}</td>
            <td className="num"><span className={`exch-sat exch-sat-${band(row.saturationPct)}`}>{row.saturationPct}%</span></td>
          </tr>
        );
      })}
      {!rows.length && emptyText ? (
        <tr>
          <td colSpan={7} className="subtle p-4 text-center">{emptyText}</td>
        </tr>
      ) : null}
    </>
  );
}

export function IntraSiteSaturationRotator({
  rows,
  sectionRows = [],
  sectionLabel,
  title,
  subtitle,
  countLabel,
  icon,
  emptyText = "No matching ODF segments found.",
  exportMetricColumns = 4,
}: {
  rows: IntraSiteSaturationRow[];
  sectionRows?: IntraSiteSaturationRow[];
  sectionLabel?: string;
  title?: string;
  subtitle?: string;
  countLabel?: string;
  icon?: ReactNode;
  emptyText?: string;
  exportMetricColumns?: 3 | 4;
}) {
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const displayRows = useMemo(() => [...rows], [rows]);
  const allRows = useMemo(() => [...rows, ...sectionRows], [rows, sectionRows]);
  const pageCount = Math.max(1, Math.ceil(displayRows.length / PAGE_SIZE));
  const safePage = page % pageCount;

  useEffect(() => {
    if (paused || pageCount <= 1) return;
    const timer = setInterval(() => setPage((current) => (current + 1) % pageCount), ROTATE_MS);
    return () => clearInterval(timer);
  }, [pageCount, paused]);

  const start = safePage * PAGE_SIZE;
  const batch = displayRows.slice(start, start + PAGE_SIZE);

  return (
    <div>
      {title ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <button className="section-title inline-flex min-h-0 items-center gap-2 p-0 text-left hover:underline" onClick={() => setDetailsOpen(true)} title="Open unified segment list">
              {icon}
              {title}
            </button>
            {subtitle ? <div className="subtle mt-1">{subtitle}</div> : null}
          </div>
          {countLabel ? <span className="kpi-trend kpi-trend-flat">{countLabel}</span> : null}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="subtle">
          {displayRows.length ? `Showing ${start + 1}-${Math.min(start + PAGE_SIZE, displayRows.length)} of ${displayRows.length}` : "No segments"}
          {displayRows.length ? paused ? " · paused" : " · rotates every 45s" : ""}
        </span>
        <span className="flex items-center gap-1">
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

      <div className="intra-grid-shell">
        <table className="exch-grid intra-grid">
          <thead>
            <tr>
              <th className="intra-seg-head">Segment</th>
              <th>Clean Site ID</th>
              <th>Site Tag</th>
              <th className="num">Total Cap.</th>
              <th className="num">Near Avail</th>
              <th className="num">Far Avail</th>
              <th className="num">Saturation</th>
            </tr>
          </thead>
          <tbody>
            <SaturationTableRows rows={batch} emptyText={emptyText} />
            <SaturationTableRows rows={sectionRows} sectionLabel={sectionLabel} />
          </tbody>
        </table>
      </div>

      {detailsOpen ? (
        <div className="modal-backdrop">
          <div className="modal-panel modal-wide">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="section-title">{title ?? "ODF Saturation Segments"}</div>
                <div className="subtle mt-1">{allRows.length.toLocaleString()} segment(s)</div>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn btn-primary" onClick={() => exportRows(title ?? "ODF Saturation", allRows)} title={`Export ${exportMetricColumns} scoped metric columns to Excel`}>
                  <Download className="h-4 w-4" /> Export Excel
                </button>
                <button className="btn btn-ghost btn-compact" onClick={() => setDetailsOpen(false)} title="Close">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="intra-grid-shell mt-4">
              <table className="exch-grid intra-grid">
                <thead>
                  <tr>
                    <th className="intra-seg-head">Segment</th>
                    <th>Clean Site ID</th>
                    <th>Site Tag</th>
                    <th className="num">Total Cap.</th>
                    <th className="num">Near Avail</th>
                    <th className="num">Far Avail</th>
                    <th className="num">Saturation</th>
                  </tr>
                </thead>
                <tbody><SaturationTableRows rows={allRows} emptyText={emptyText} /></tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
