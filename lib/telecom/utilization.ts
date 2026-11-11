import { utilizationBand } from "@/lib/config/utilization-thresholds";
import { fiberCountFromUnit } from "@/lib/telecom/fiber-unit";

export interface UtilizationBreakdown {
  totalGroups: number;
  usedGroups: number;
  spareGroups: number;
  reservedGroups: number;
  faultyGroups: number;
  utilizationPct: number;
}

/**
 * One countable utilization unit. A single unit may represent MORE THAN ONE
 * physical fiber: an ODF port label "1-2" is two fibers; a fiberNumbersJson of
 * [1,2,3] is three. Per the inventory rule, utilization is computed from
 * INDIVIDUAL FIBER NUMBERS — never one-count-per-row/group — so each unit
 * contributes its real fiber count via fiberCountFromUnit. Units that carry no
 * port/fiber metadata fall back to a single fiber, so legacy `{ status }`-only
 * callers keep their previous (one-per-row) totals unchanged.
 */
export interface UtilizationUnit {
  status: string;
  portLabel?: string | null;
  fiberNumbersJson?: string | null;
}

export { utilizationBand };

export function computeUtilization(units: UtilizationUnit[]): UtilizationBreakdown {
  let totalGroups = 0;
  let usedGroups = 0;
  let spareGroups = 0;
  let reservedGroups = 0;
  let faultyGroups = 0;

  for (const unit of units) {
    // Count by individual fiber numbers, never by row/group.
    const fibers = fiberCountFromUnit(unit.portLabel, unit.fiberNumbersJson) || 1;
    const status = String(unit.status ?? "").toUpperCase();
    totalGroups += fibers;
    if (["ACTIVE", "USED"].includes(status)) usedGroups += fibers;
    else if (["SPARE", "AVAILABLE"].includes(status)) spareGroups += fibers;
    else if (status === "RESERVED") reservedGroups += fibers;
    else if (status === "FAULTY") faultyGroups += fibers;
  }

  const denominator = Math.max(totalGroups - faultyGroups, 1);
  const utilizationPct = Number(((usedGroups / denominator) * 100).toFixed(2));

  return { totalGroups, usedGroups, spareGroups, reservedGroups, faultyGroups, utilizationPct };
}
