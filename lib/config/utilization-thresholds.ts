export const UTILIZATION_THRESHOLDS = {
  normalMaxPct: 50,
  moderateMaxPct: 80,
  highMaxPct: 90,
} as const;

export type UtilizationBand = "Normal" | "Moderate" | "High" | "Critical";

export function utilizationBand(utilizationPct: number): UtilizationBand {
  if (utilizationPct > UTILIZATION_THRESHOLDS.highMaxPct) return "Critical";
  if (utilizationPct > UTILIZATION_THRESHOLDS.moderateMaxPct) return "High";
  if (utilizationPct > UTILIZATION_THRESHOLDS.normalMaxPct) return "Moderate";
  return "Normal";
}
