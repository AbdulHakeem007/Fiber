"use client";

import { UTILIZATION_THRESHOLDS, utilizationBand, type UtilizationBand } from "@/lib/config/utilization-thresholds";

export type UtilizationTier = UtilizationBand | "ALL";

const TIERS: Array<{ key: UtilizationTier; label: string; hint: string; cls: string }> = [
  { key: "ALL", label: "All", hint: "Every port", cls: "util-chip-all" },
  { key: "Critical", label: "Critical", hint: `> ${UTILIZATION_THRESHOLDS.highMaxPct}%`, cls: "util-chip-critical" },
  { key: "High", label: "High", hint: `${UTILIZATION_THRESHOLDS.moderateMaxPct + 1}–${UTILIZATION_THRESHOLDS.highMaxPct}%`, cls: "util-chip-high" },
  { key: "Moderate", label: "Moderate", hint: `${UTILIZATION_THRESHOLDS.normalMaxPct + 1}–${UTILIZATION_THRESHOLDS.moderateMaxPct}%`, cls: "util-chip-moderate" },
  { key: "Normal", label: "Normal", hint: `≤ ${UTILIZATION_THRESHOLDS.normalMaxPct}%`, cls: "util-chip-normal" },
];

/** Shared utilization-tier band check so grids filter identically. */
export function matchesUtilizationTier(utilizationPct: number, tier: UtilizationTier): boolean {
  return tier === "ALL" || utilizationBand(utilizationPct) === tier;
}

export function UtilizationFilter({
  value,
  onChange,
  counts,
}: {
  value: UtilizationTier;
  onChange: (tier: UtilizationTier) => void;
  /** Optional per-tier counts shown as a badge on each chip. */
  counts?: Partial<Record<UtilizationTier, number>>;
}) {
  return (
    <div className="util-filter" role="group" aria-label="Filter by utilization tier">
      <span className="util-filter-label">Utilization</span>
      {TIERS.map((tier) => {
        const active = value === tier.key;
        const count = counts?.[tier.key];
        return (
          <button
            key={tier.key}
            type="button"
            className={`util-chip ${tier.cls} ${active ? "util-chip-active" : ""}`}
            aria-pressed={active}
            title={`${tier.label} (${tier.hint})`}
            onClick={() => onChange(tier.key)}
          >
            <span className="util-chip-dot" aria-hidden="true" />
            {tier.label}
            {typeof count === "number" ? <span className="util-chip-count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
