"use client";

import { useState } from "react";
import { Download, Loader2, Mail, Radar } from "lucide-react";
import { activeInventoryFilterEntries, inventoryFiltersToParams, type InventoryFilters } from "@/lib/filters/inventory-filters";
import { SuggestionInput } from "@/components/ui/suggestion-input";
import type { CutoverImpactSummary } from "@/types/impact";

const FILTERS: Array<[keyof InventoryFilters, string]> = [
  ["serviceId", "Service ID"],
  ["transportTrail", "Transport trail / path"],
  ["site", "Site"],
  ["connectedSite", "Connected site"],
];

function suggestionKind(key: keyof InventoryFilters): string | null {
  if (key === "site") return "sites";
  if (key === "connectedSite") return "connected-sites";
  if (key === "serviceId") return "services";
  if (key === "rackId") return "racks";
  if (key === "odfId") return "odfs";
  if (key === "portPair") return "ports";
  if (key === "transportTrail") return "transport-trails";
  if (key === "cableId") return "segments";
  return null;
}

function rowValue(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value);
  }
  return "-";
}

function joinValue(row: Record<string, unknown>, keys: string[], separator = " / "): string {
  const parts = keys
    .map((key) => row[key])
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map(String);
  return parts.length ? parts.join(separator) : "-";
}

function boundaryLabel(endpoint?: { siteId?: string; rackId?: string; odfId?: string } | null): string {
  if (!endpoint) return "-";
  return [endpoint.siteId, endpoint.rackId, endpoint.odfId].filter(Boolean).join(" / ") || "-";
}

function kmLabel(value?: number | null): string {
  const distance = Number(value ?? 0);
  return Number.isFinite(distance) && distance > 0 ? `${Math.round(distance * 100) / 100} km` : "0 km";
}

/** Distinct, sorted, blank-free set of Service IDs from a column of values. */
function uniqueServiceIds(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value && String(value).trim())).map((value) => String(value).trim())),
  ).sort((a, b) => a.localeCompare(b));
}

// Per-table roll-up of the unique services a cutover would touch — rendered above
// each table so the operator can read off the impacted Service IDs at a glance
// without scrolling the wide rows.
function ImpactedServiceIds({ ids, tone }: { ids: string[]; tone: "red" | "amber" }) {
  return (
    <div className="mt-4">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        Unique impacted service IDs ({ids.length})
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {ids.length ? (
          ids.map((id) => (
            <span key={id} className={`badge ${tone === "red" ? "impact-badge-red" : "impact-badge-amber"}`}>{id}</span>
          ))
        ) : (
          <span className="subtle">None</span>
        )}
      </div>
    </div>
  );
}

// Path Evaluation Matrix presentation: Direct = high-contrast critical badge
// (physical traffic loss), Indirect = warning badge (boundary/failover risk).
// Both sections carry a parallel "<X> impact" label so indirect rows are marked
// just as explicitly as direct ones.
function SectionBadge({ section }: { section?: string | null }) {
  const label = String(section ?? "").trim();
  if (!label || label === "-") return <span>-</span>;
  const isDirect = /direct/i.test(label) && !/indirect/i.test(label);
  return (
    <span className={`badge ${isDirect ? "impact-badge-red" : "impact-badge-amber"}`}>
      {isDirect ? "Direct impact" : "Indirect impact"}
    </span>
  );
}

// Skeleton shown while the deferred traversal runs server-side. Pure CSS shimmer
// — no data is fetched to render it — so the operator gets immediate feedback
// that heavy computation is in flight.
function ResultsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="card p-4">
            <div className="impact-skeleton h-3 w-20 rounded" />
            <div className="impact-skeleton mt-3 h-8 w-16 rounded" />
          </div>
        ))}
      </div>
      {Array.from({ length: 2 }).map((_, card) => (
        <div key={card} className="card p-5">
          <div className="impact-skeleton h-4 w-56 rounded" />
          <div className="impact-skeleton mt-2 h-3 w-80 max-w-full rounded" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 5 }).map((_, row) => (
              <div key={row} className="impact-skeleton h-9 w-full rounded" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Pre-run state. The expensive analysis is intentionally NOT executed on mount;
// this CTA invites the operator to trigger it explicitly.
function PreRunState({ onAnalyze, disabled }: { onAnalyze: () => void; disabled: boolean }) {
  return (
    <div className="card flex flex-col items-center gap-3 p-12 text-center">
      <div className="impact-prerun-orb">
        <Radar className="h-7 w-7" />
      </div>
      <div className="text-base font-semibold text-slate-800 dark:text-slate-100">Ready to analyze impact</div>
      <div className="subtle max-w-md">
        Select a Service ID, transport trail, or site above, then run the analysis. Heavy graph traversal and
        segment scans only execute on demand — the page stays instant until you click Analyze.
      </div>
      <button
        className="mt-1 inline-flex items-center gap-2 rounded-lg bg-red-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
        onClick={onAnalyze}
        disabled={disabled}
      >
        <Radar className="h-4 w-4" /> Run impact analysis
      </button>
    </div>
  );
}

export function ImpactWorkbench({
  initialSummary,
  initialAnalyzed = false,
}: {
  initialSummary: CutoverImpactSummary;
  /** True only when the page deep-linked with filters and pre-ran the analysis. */
  initialAnalyzed?: boolean;
}) {
  const [filters, setFilters] = useState<InventoryFilters>(initialSummary.filters);
  const [summary, setSummary] = useState(initialSummary);
  const [isLoading, setIsLoading] = useState(false);
  // The heavy traversal never runs on mount: results only show after an explicit
  // Analyze click (or a filtered deep link that pre-computed server-side).
  const [hasAnalyzed, setHasAnalyzed] = useState(initialAnalyzed);
  const [message, setMessage] = useState<string | null>(null);
  const activeFilters = activeInventoryFilterEntries(filters);
  const hasRealAnalysis = hasAnalyzed && activeFilters.length > 0 && summary.exportRows.length > 0;
  // Distinct services touched by each table, computed separately per the cutover
  // requirement (boundary-risked vs. directly service-carrying).
  const indirectServiceIds = uniqueServiceIds((summary.indirectPaths ?? []).map((path) => path.serviceId));
  const activeServiceIds = uniqueServiceIds((summary.activeServiceLinks ?? []).map((link) => link.serviceId));

  function updateFilter(key: keyof InventoryFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function analyze() {
    if (!activeFilters.length) {
      setMessage("Select at least one resource (Service ID, transport trail, or site) before running impact analysis.");
      return;
    }
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Impact analysis failed.");
      setSummary(payload);
      setHasAnalyzed(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Impact analysis failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function exportImpact() {
    if (!hasRealAnalysis) {
      setMessage("Run an analysis with a real matching result before exporting impact analysis.");
      return;
    }
    const params = inventoryFiltersToParams(filters);
    params.set("type", "impact");
    params.set("format", "xlsx");
    window.location.href = `/api/export?${params.toString()}`;
  }

  // Deep Impact Export: Rack ID / ODF ID mapped to every active service through
  // them, each with its full end-to-end (A-to-Z) transport path chain traced
  // across the whole network. Heavier than the on-screen view, so it only runs
  // on this explicit export request.
  function exportImpactE2e() {
    if (!hasRealAnalysis) {
      setMessage("Run an analysis with a real matching result before exporting the E2E transport chains.");
      return;
    }
    const params = inventoryFiltersToParams(filters);
    params.set("type", "impact-e2e");
    params.set("format", "xlsx");
    window.location.href = `/api/export?${params.toString()}`;
  }

  async function emailImpact() {
    if (!hasRealAnalysis) {
      setMessage("Run an analysis with a real matching result before emailing impact analysis.");
      return;
    }
    const recipients = window.prompt("Email impact analysis to (comma separated):");
    if (!recipients) return;
    setMessage(null);
    try {
      const response = await fetch("/api/export/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "impact",
          ...filters,
          recipients,
          includeConfiguredRecipients: window.confirm("Also send to configured portal recipients?"),
        }),
      });
      const payload = await response.json();
      setMessage(response.ok ? payload.message : payload.error ?? "Email export failed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Email export failed.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="section-title">Cutover impact analysis</div>
            <div className="subtle mt-1">Analyze impact by Service ID, transport trail/chain, or site connectivity. Rack, ODF, ports, cable, tube, and fiber details appear in the results.</div>
          </div>
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={analyze} disabled={isLoading}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
              Analyze
            </button>
            <button className="btn btn-ghost" onClick={exportImpact} disabled={!hasRealAnalysis}>
              <Download className="h-4 w-4" />
              Export Impact
            </button>
            <button
              className="btn btn-ghost"
              onClick={exportImpactE2e}
              disabled={!hasRealAnalysis}
              title="Export every active service through the selected Rack/ODF with its full end-to-end (A-to-Z) transport path chain."
            >
              <Download className="h-4 w-4" />
              Impact Export (E2E Chains)
            </button>
            <button className="btn btn-ghost" onClick={emailImpact} disabled={!hasRealAnalysis}>
              <Mail className="h-4 w-4" />
              Email Impact
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {FILTERS.map(([key, label]) => (
            <SuggestionInput
              key={key}
              kind={suggestionKind(key) ?? "sites"}
              className="input-dark"
              value={String(filters[key] ?? "")}
              params={{
                site: key === "connectedSite" || key === "rackId" || key === "odfId" || key === "portPair" ? String(filters.site ?? "") : "",
                rack: key === "odfId" || key === "portPair" ? String(filters.rackId ?? "") : "",
                odf: key === "portPair" ? String(filters.odfId ?? "") : "",
              }}
              onChange={(nextValue) => updateFilter(key, nextValue)}
              placeholder={label}
            />
          ))}
        </div>
        <div className="selected-filter-row mt-3 flex flex-wrap gap-2 text-xs">
          <span className="font-medium text-slate-700 dark:text-slate-200">Selected resources:</span>
          {activeFilters.length ? activeFilters.map(([key, value]) => (
            <button key={key} className="selected-filter-chip" onClick={() => updateFilter(key as keyof InventoryFilters, "")}>{key}: {value}</button>
          )) : <span className="text-slate-600 dark:text-slate-300">none</span>}
        </div>
        {message ? <div className="mt-3 text-sm text-amber-700 dark:text-amber-200">{message}</div> : null}
      </div>

      {isLoading ? (
        <ResultsSkeleton />
      ) : !hasAnalyzed ? (
        <PreRunState onAnalyze={analyze} disabled={isLoading} />
      ) : (
      <>
      <div className="grid gap-4 md:grid-cols-4">
        {[
          ["Services", summary.counts.impactedServices],
          ["Links", summary.counts.impactedLinks],
          ["Sites", summary.counts.impactedSites],
          ["Core Sites", summary.counts.coreSites],
        ].map(([label, value]) => (
          <div key={label} className="card p-4">
            <div className="text-xs uppercase tracking-[0.14em] text-slate-400">{label}</div>
            <div className="mt-2 text-3xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap gap-3">
          <span className="badge impact-badge-red">Facing: {summary.facing}</span>
          <span className="badge impact-badge-amber">Scope: {summary.impactScope}</span>
          {summary.criticalCoreSites.map((site) => (
            <span key={site.siteCode} className="badge impact-badge-red">{site.siteCode} {site.coreSiteType}</span>
          ))}
        </div>
        <div className="mt-4 space-y-2 text-sm text-slate-300">
          {summary.notes.map((note) => <div key={note}>{note}</div>)}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="section-title">Indirect / risked boundary impacts</div>
            <div className="subtle mt-1">Flags live services on alternative paths that share the exact same start and end Site/Rack/ODF footprint, even when they do not share the direct segment IDs.</div>
          </div>
          <span className="badge impact-badge-amber">{summary.indirectPaths?.length ?? 0} indirect path(s)</span>
        </div>
        {summary.boundaryFootprint ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="impact-boundary-card">
              <div className="impact-boundary-label">Start boundary</div>
              <div className="impact-boundary-value">{boundaryLabel(summary.boundaryFootprint.start)}</div>
            </div>
            <div className="impact-boundary-card">
              <div className="impact-boundary-label">End boundary</div>
              <div className="impact-boundary-value">{boundaryLabel(summary.boundaryFootprint.end)}</div>
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm font-medium text-amber-800 dark:text-amber-100">
            Exact boundary matching needs both terminal Site/Rack/ODF footprints. Run by Service ID or a fully mapped path to calculate indirect risk.
          </div>
        )}
        <ImpactedServiceIds ids={indirectServiceIds} tone="amber" />
        <div className="impact-table-shell mt-4">
          <table className="impact-result-table impact-result-table--boundary">
            <thead>
              <tr>
                <th>Service ID</th>
                <th>Path</th>
                <th>Reason</th>
                <th>Total Distance</th>
              </tr>
            </thead>
            <tbody>
              {(summary.indirectPaths ?? []).map((path) => (
                <tr key={`${path.serviceId}-${path.fullPathLabel ?? "path"}`}>
                  <td className="service-cell">{path.serviceId}</td>
                  <td className="cell-wrap">{path.fullPathLabel ?? (path.segments.map((segment) => segment.segmentCode).filter(Boolean).join(" -> ") || "-")}</td>
                  <td>{path.reason}</td>
                  <td>{kmLabel(path.totalDistanceKm)}</td>
                </tr>
              ))}
              {!(summary.indirectPaths ?? []).length ? (
                <tr><td colSpan={4}>No indirect boundary-matched service paths detected.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="section-title">Active service-carrying fiber links</div>
            <div className="subtle mt-1">Moved from Service Trail. This table shows exact child ODF port links that carry active services for the selected impact scope.</div>
          </div>
          <span className="badge impact-badge-red">{summary.activeServiceLinks?.length ?? 0} active link row(s)</span>
        </div>
        <ImpactedServiceIds ids={activeServiceIds} tone="red" />
        <div className="impact-table-shell mt-4">
          <table className="impact-result-table impact-result-table--links">
            <thead>
              <tr>
                <th>#</th>
                <th>Service ID</th>
                <th>Segment</th>
                <th>Near Rack ID</th>
                <th>Near End ODF ID</th>
                <th>Near End ODF Ports</th>
                <th>Far Rack ID</th>
                <th>Far ODF ID</th>
                <th>Far ODF Ports</th>
                <th>Section</th>
              </tr>
            </thead>
            <tbody>
              {(summary.activeServiceLinks ?? []).map((link, index) => (
                <tr key={`${link.segmentCode}-${link.serviceId}-${index}`}>
                  <td>{index + 1}</td>
                  <td className="service-cell">{link.serviceId}</td>
                  <td>{link.segmentCode}</td>
                  <td>{link.nearRack ?? "-"}</td>
                  <td>{link.nearOdf ?? "-"}</td>
                  <td>{link.nearPort ?? "-"}</td>
                  <td>{link.farRack ?? "-"}</td>
                  <td>{link.farOdf ?? "-"}</td>
                  <td>{link.farPort ?? "-"}</td>
                  <td><SectionBadge section={link.section} /></td>
                </tr>
              ))}
              {!(summary.activeServiceLinks ?? []).length ? <tr><td colSpan={10}>No active service-carrying child ODF links found for this impact scope.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="section-title">Impact result: segments, services, and transport chains</div>
            <div className="subtle mt-1">One operational table for Direct and Indirect impact. Direct = exact physical segment/service match. Indirect = alternative live service path sharing the same terminal Site/Rack/ODF boundaries.</div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="badge impact-badge-red">{summary.exportRows.length} result row(s)</span>
            <span className="badge impact-badge-amber">{summary.riskFactors.length} indirect segment row(s)</span>
          </div>
        </div>
        <div className="impact-table-shell mt-4">
          <table className="impact-result-table">
            <thead>
              <tr>
                <th>Sr.No</th>
                <th>Calculation Time</th>
                <th>Section</th>
                <th>Service ID</th>
                <th>Start / End</th>
                <th>Transport Chain</th>
                <th>Segment ID</th>
                <th>Segment</th>
                <th>Near End</th>
                <th>Far End</th>
                <th>Resource</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {summary.exportRows.map((row, index) => (
                <tr key={index}>
                  <td>{rowValue(row, "srNo", "Sr.No") || String(index + 1)}</td>
                  <td>{rowValue(row, "impactCalculationTime", "Impact calculation time")}</td>
                  <td><SectionBadge section={rowValue(row, "impactSection", "Impact Section", "Impact Type")} /></td>
                  <td className="service-cell">{rowValue(row, "serviceId", "Service ID", "serviceCode", "serviceIds", "All service IDs on segment")}</td>
                  <td>{joinValue(row, ["startSite", "endSite"], " → ") !== "-" ? joinValue(row, ["startSite", "endSite"], " → ") : joinValue(row, ["Start site", "End site"], " → ")}</td>
                  <td className="cell-wrap">{rowValue(row, "transportChain", "Transport Chain")}</td>
                  <td>{rowValue(row, "segmentId", "Segment ID")}</td>
                  <td>{rowValue(row, "segmentCode", "Segment code")}</td>
                  <td>{joinValue(row, ["nearSite", "nearRack", "nearOdf", "nearPort"]) !== "-" ? joinValue(row, ["nearSite", "nearRack", "nearOdf", "nearPort"]) : joinValue(row, ["Near site", "Near rack", "Near ODF", "Near port"])}</td>
                  <td>{joinValue(row, ["farSite", "farRack", "farOdf", "farPort"]) !== "-" ? joinValue(row, ["farSite", "farRack", "farOdf", "farPort"]) : joinValue(row, ["Far site", "Far rack", "Far ODF", "Far port"])}</td>
                  <td>{joinValue(row, ["cable", "tube", "fiberPort", "fiberNumber"]) !== "-" ? joinValue(row, ["cable", "tube", "fiberPort", "fiberNumber"]) : joinValue(row, ["Cable", "Tube", "Fiber port", "Fiber number"])}</td>
                  <td>{rowValue(row, "status", "Status")}</td>
                </tr>
              ))}
              {!summary.exportRows.length ? <tr><td colSpan={12}>No matching impact rows found. Try Service ID or Transport Trail.</td></tr> : null}
            </tbody>
          </table>
        </div>
        {summary.riskFactors.length ? (
          <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm font-medium text-amber-800 dark:text-amber-100">
            {summary.riskFactors.length} indirect boundary-matched segment row(s) were detected and are included in export.
          </div>
        ) : null}
      </div>
      </>
      )}
    </div>
  );
}
