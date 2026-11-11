import type { CSSProperties } from "react";
import { BarChart3 } from "lucide-react";
import type { MonthlyInfrastructureGrowthMetrics } from "@/server/services/monthly-infrastructure-growth.service";

const BAR_COLORS = {
  newSegments: "#0ea5e9",
  isp: "#8b5cf6",
  osp: "#6366f1",
  newFiberSites: "#10b981",
  capacityUpgrades: "#f59e0b",
};

function MetricBar({
  value,
  max,
  color,
  tooltip,
  ariaLabel,
}: {
  value: number;
  max: number;
  color: string;
  tooltip: string;
  ariaLabel: string;
}) {
  const heightPct = value > 0 ? Math.max((value / max) * 100, 8) : 0;

  return (
    <div className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
      <div className="mb-1 text-xs font-bold tabular-nums" style={{ color: "var(--text-strong)" }}>
        {value.toLocaleString()}
      </div>
      <div
        tabIndex={0}
        aria-label={ariaLabel}
        className="w-full max-w-[42px] rounded-t-[7px] outline-none ring-offset-2 transition-[height] focus-visible:ring-2"
        style={{
          height: `${heightPct}%`,
          minHeight: value > 0 ? 8 : 0,
          background: color,
          "--tw-ring-color": color,
        } as CSSProperties}
      />
      <div className="pointer-events-none absolute left-1/2 top-1 z-20 hidden w-max max-w-56 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--glass-bg-solid)] px-2 py-1 text-[10px] font-semibold leading-snug text-[var(--text-main)] shadow-lg group-hover:block group-focus-within:block">
        {tooltip}
      </div>
    </div>
  );
}

export function MonthlyInfrastructureGrowthMetric({ metrics }: { metrics: MonthlyInfrastructureGrowthMetrics }) {
  const max = Math.max(
    1,
    metrics.newSegments.totalCount,
    metrics.splitterUmbrella.ispCount,
    metrics.splitterUmbrella.ospCount,
    metrics.newFiberSites,
    metrics.capacityUpgrades,
  );

  return (
    <div className="kpi-card-dense min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="kpi-card-title">Monthly Infrastructure Growth Metric</div>
        <BarChart3 className="h-4 w-4 text-sky-500" aria-hidden="true" />
      </div>

      <div className="mt-3 grid h-28 grid-cols-[1fr_1.25fr_1fr_1fr] items-end gap-3 border-b border-[var(--border)] px-1 pt-4">
        <MetricBar
          value={metrics.newSegments.totalCount}
          max={max}
          color={BAR_COLORS.newSegments}
          tooltip={`Partial: ${metrics.newSegments.partialSplits}, Full: ${metrics.newSegments.fullSplits}, New: ${metrics.newSegments.brandNew}`}
          ariaLabel={`New Segments ${metrics.newSegments.totalCount}. Partial ${metrics.newSegments.partialSplits}, Full ${metrics.newSegments.fullSplits}, New ${metrics.newSegments.brandNew}.`}
        />

        <div className="flex h-full min-w-0 items-end justify-center gap-1.5">
          <MetricBar
            value={metrics.splitterUmbrella.ispCount}
            max={max}
            color={BAR_COLORS.isp}
            tooltip={`ISP splitters: ${metrics.splitterUmbrella.ispCount}`}
            ariaLabel={`ISP splitters ${metrics.splitterUmbrella.ispCount}`}
          />
          <MetricBar
            value={metrics.splitterUmbrella.ospCount}
            max={max}
            color={BAR_COLORS.osp}
            tooltip={`OSP splitters: ${metrics.splitterUmbrella.ospCount}`}
            ariaLabel={`OSP splitters ${metrics.splitterUmbrella.ospCount}`}
          />
        </div>

        <MetricBar
          value={metrics.newFiberSites}
          max={max}
          color={BAR_COLORS.newFiberSites}
          tooltip={`New fiber sites: ${metrics.newFiberSites}`}
          ariaLabel={`New Fiber sites ${metrics.newFiberSites}`}
        />
        <MetricBar
          value={metrics.capacityUpgrades}
          max={max}
          color={BAR_COLORS.capacityUpgrades}
          tooltip={`Capacity upgrades: ${metrics.capacityUpgrades}`}
          ariaLabel={`Capacity Upgrades ${metrics.capacityUpgrades}`}
        />
      </div>

      <div className="mt-2 grid grid-cols-[1fr_1.25fr_1fr_1fr] gap-3 px-1 text-center text-[10px] font-semibold leading-tight" style={{ color: "var(--muted-text)" }}>
        <div className="break-words">New Segments</div>
        <div className="min-w-0">
          <div>Splitters</div>
          <div className="mt-0.5 grid grid-cols-2 gap-1 text-[9px] uppercase tracking-normal">
            <span>ISP</span>
            <span>OSP</span>
          </div>
        </div>
        <div className="break-words">New Fiber sites</div>
        <div className="break-words">Capacity Upgrades</div>
      </div>
    </div>
  );
}
