import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { PrioritySiteTagBadge } from "@/components/dashboard/site-tag-badge";
import { displayCleanSiteId } from "@/lib/telecom/site-display";

/**
 * Dense telecom KPI dashboard building blocks modelled on the multi-tier
 * executive-dashboard reference layout. Everything is CSS / inline-SVG and
 * server-renderable — no chart library, no client JS — so the dashboard stays
 * fast at the portal's enterprise data scale.
 */

type TrendDirection = "up" | "down" | "flat";

function TrendVector({ direction, label }: { direction: TrendDirection; label: string }) {
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  const cls = direction === "up" ? "kpi-trend-up" : direction === "down" ? "kpi-trend-down" : "kpi-trend-flat";
  return (
    <span className={`kpi-trend ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export interface KpiCardData {
  title: string;
  value: string;
  /** "of Target" line, e.g. "of 240,000 core ceiling". */
  targetLabel?: string;
  /** Progress toward target as a percent (drives the thin meter). */
  targetPct?: number;
  trendDirection?: TrendDirection;
  trendLabel?: string;
  /** Secondary breakdown line, e.g. "8,940 allocated · 1,060 spare". */
  subLabel?: string;
  icon?: LucideIcon;
  /** Tone of the value text / meter (utilization band coloring). */
  tone?: "sky" | "emerald" | "amber" | "rose" | "violet" | "critical" | "high" | "moderate" | "normal";
}

export function KpiCard({ data }: { data: KpiCardData }) {
  const { title, value, targetLabel, targetPct, trendDirection, trendLabel, subLabel, icon: Icon, tone = "sky" } = data;
  return (
    <div className="kpi-card-dense">
      <div className="flex items-start justify-between gap-2">
        <div className="kpi-card-title">{title}</div>
        {Icon ? <Icon className={`h-4 w-4 kpi-icon-${tone}`} aria-hidden="true" /> : null}
      </div>
      <div className={`kpi-card-value kpi-value-${tone}`}>{value}</div>
      {targetLabel ? <div className="kpi-card-target">{targetLabel}</div> : null}
      {typeof targetPct === "number" ? (
        <div className="kpi-meter" aria-hidden="true">
          <span className={`kpi-meter-fill kpi-fill-${tone}`} style={{ width: `${Math.min(100, Math.max(0, targetPct))}%` }} />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1">
        {subLabel ? <span className="kpi-card-sub">{subLabel}</span> : <span />}
        {trendDirection && trendLabel ? <TrendVector direction={trendDirection} label={trendLabel} /> : null}
      </div>
    </div>
  );
}

/** Performant inline-SVG ring gauge. */
export function RadialGauge({
  label,
  pct,
  caption,
  tone,
}: {
  label: string;
  pct: number;
  caption?: string;
  tone: "critical" | "high" | "moderate" | "normal" | "sky" | "violet";
}) {
  const clamped = Math.min(100, Math.max(0, pct));
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;
  const colorVar = `var(--gauge-${tone})`;
  return (
    <div className="gauge-block">
      <svg viewBox="0 0 140 140" className="gauge-svg" role="img" aria-label={`${label} ${clamped}%`}>
        <circle cx="70" cy="70" r={radius} className="gauge-track" strokeWidth="14" fill="none" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          stroke={colorVar}
          strokeWidth="14"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform="rotate(-90 70 70)"
        />
        <text x="70" y="70" className="gauge-value" textAnchor="middle" dominantBaseline="central">{clamped}%</text>
      </svg>
      <div className="gauge-label">{label}</div>
      {caption ? <div className="gauge-caption">{caption}</div> : null}
    </div>
  );
}

export interface FileCategoryBar {
  label: string;
  count: number;
  color: string;
}

/**
 * File Status bar chart — uploaded document counts per category (ODF Photos /
 * FDD / OTDR), scaled against the live segment population. Pure CSS/flex bars,
 * server-renderable, no chart library.
 */
export function FileStatusBars({ bars, totalSegments, compact = false }: { bars: FileCategoryBar[]; totalSegments: number; compact?: boolean }) {
  const max = Math.max(1, totalSegments, ...bars.map((bar) => bar.count));
  const totalFiles = bars.reduce((sum, bar) => sum + bar.count, 0);
  return (
    <div>
      <div className={`flex ${compact ? "h-20" : "h-48"} items-end justify-around gap-5 border-b border-[var(--border)] pt-3`}>
        {bars.map((bar) => {
          const pct = Math.round((bar.count / max) * 100);
          return (
            <div key={bar.label} className="flex h-full flex-1 flex-col items-center justify-end gap-2" title={`${bar.label}: ${bar.count} file(s)`}>
              <div className="text-base font-semibold" style={{ color: "var(--text-strong)" }}>{bar.count.toLocaleString()}</div>
              <div
                className="w-full max-w-[84px] rounded-t-lg transition-[height]"
                style={{ height: `${Math.max(pct, bar.count > 0 ? 3 : 0)}%`, minHeight: bar.count > 0 ? 6 : 0, background: bar.color }}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-around gap-5">
        {bars.map((bar) => (
          <div key={bar.label} className="flex-1 text-center text-xs font-semibold" style={{ color: "var(--muted-text)" }}>
            <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: bar.color }} />
            {bar.label}
          </div>
        ))}
      </div>
      <div className="subtle mt-3 text-center text-xs">
        {totalFiles.toLocaleString()} uploaded site document(s) across {totalSegments.toLocaleString()} site(s).
      </div>
    </div>
  );
}

export interface AllocationBar {
  label: string;
  used: number;
  reserved: number;
  available: number;
}

/** Dense stacked bars — regional / grouped port allocation over a baseline. */
export function AllocationStackedBars({ bars }: { bars: AllocationBar[] }) {
  const max = Math.max(1, ...bars.map((bar) => bar.used + bar.reserved + bar.available));
  return (
    <div className="alloc-chart">
      <div className="alloc-bars">
        {bars.map((bar) => {
          const total = bar.used + bar.reserved + bar.available;
          const h = (value: number) => `${(value / max) * 100}%`;
          return (
            <div key={bar.label} className="alloc-col" title={`${bar.label}: ${total} ports`}>
              <div className="alloc-stack">
                <span className="alloc-seg alloc-used" style={{ height: h(bar.used) }} />
                <span className="alloc-seg alloc-reserved" style={{ height: h(bar.reserved) }} />
                <span className="alloc-seg alloc-available" style={{ height: h(bar.available) }} />
              </div>
              <div className="alloc-col-label">{bar.label}</div>
            </div>
          );
        })}
        {!bars.length ? <div className="subtle">No regional allocation data yet.</div> : null}
      </div>
      <div className="alloc-legend">
        <span><i className="alloc-dot alloc-used" /> Active</span>
        <span><i className="alloc-dot alloc-reserved" /> Reserved</span>
        <span><i className="alloc-dot alloc-available" /> Available</span>
      </div>
    </div>
  );
}

export interface FlowStage {
  label: string;
  count: number;
  tone: "neutral" | "ready" | "warning" | "committed" | "critical";
}

/** Provisioning lifecycle funnel — staged → validated → committed + backlog. */
export function ProvisioningFlow({ stages, backlog }: { stages: FlowStage[]; backlog: number }) {
  const max = Math.max(1, ...stages.map((stage) => stage.count));
  return (
    <div>
      <div className="flow-stages">
        {stages.map((stage, index) => (
          <div key={stage.label} className="flow-stage">
            <div className="flow-stage-head">
              <span className="flow-stage-label">{stage.label}</span>
              <span className="flow-stage-count">{stage.count.toLocaleString()}</span>
            </div>
            <div className="flow-stage-bar">
              <span className={`flow-fill flow-fill-${stage.tone}`} style={{ width: `${(stage.count / max) * 100}%` }} />
            </div>
            {index < stages.length - 1 ? <div className="flow-arrow" aria-hidden="true">↓</div> : null}
          </div>
        ))}
      </div>
      <div className="flow-backlog">
        <span>Failure-risk / data-gap backlog</span>
        <span className={`flow-backlog-value ${backlog > 0 ? "flow-backlog-warn" : ""}`}>{backlog.toLocaleString()}</span>
      </div>
    </div>
  );
}

export interface ExchangeRow {
  exchange: string;
  siteCode?: string;
  totalOdfs: number;
  activePorts: number;
  riskPaths: number;
  saturationPct: number;
  variancePct: number | null;
  /** Explicit Datacenter tag — auto-extracted and overlaid by the grid engine. */
  isDatacenter?: boolean;
  /** Core-site tag (Site.isCoreSite) — Priority 2 in the rotation order. */
  isCoreSite?: boolean;
  /** Operator-nominated critical exchange. */
  isCriticalSite?: boolean;
  /** Raw Site.siteType tag (e.g. DWDM, PE). */
  siteType?: string | null;
  /** Raw Site.coreSiteType tag (e.g. DWDM, PE). */
  coreSiteType?: string | null;
  /** Operator-editable criticality tags from the Sites form (DC, Core, DWDM, …). */
  criticalityTags?: string[];
}

/** Core & DataCenter sites operational grid with directional warning badges. */
export function ExchangeGrid({ rows, shellClassName }: { rows: ExchangeRow[]; shellClassName?: string }) {
  return (
    <div className={`exch-grid-shell${shellClassName ? ` ${shellClassName}` : ""}`}>
      <table className="exch-grid">
        <thead>
          <tr>
            <th>Clean Site ID</th>
            <th>Site Tag</th>
            <th className="num">Total ODFs</th>
            <th className="num">Active Ports</th>
            <th className="num">Risk Paths</th>
            <th className="num">Saturation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const band = row.saturationPct > 90 ? "critical" : row.saturationPct > 75 ? "high" : row.saturationPct > 50 ? "moderate" : "normal";
            const cleanSiteId = displayCleanSiteId(row.siteCode ?? row.exchange);
            return (
              <tr key={row.exchange}>
                <td className="exch-name">
                  <span className="inline-flex items-center justify-center gap-1.5">
                    {/* Deep-link the Site ID straight to its Site Connectivity Canvas. */}
                    <Link
                      href={`/sites/${encodeURIComponent(row.siteCode ?? row.exchange)}`}
                      className="exch-site-id font-medium text-red-700 hover:text-red-900 hover:underline dark:text-red-200 dark:hover:text-white"
                      title={`Open connectivity canvas for ${row.exchange}`}
                    >
                      {cleanSiteId}
                    </Link>
                    {row.isCriticalSite ? <span className="exch-critical-dot" title="Operator-nominated critical site" /> : null}
                  </span>
                </td>
                <td className="exch-tag-cell">
                  <PrioritySiteTagBadge source={row} />
                </td>
                <td className="num">{row.totalOdfs}</td>
                <td className="num">{row.activePorts.toLocaleString()}</td>
                <td className="num">
                  {row.riskPaths > 0 ? <span className="exch-risk">{row.riskPaths}</span> : <span className="exch-ok">0</span>}
                </td>
                <td className="num">
                  <span className={`exch-sat exch-sat-${band}`}>{row.saturationPct}%</span>
                </td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan={6} className="subtle p-4 text-center">No exchange data yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
