import { z } from "zod";

export const alertPolicySchema = z.object({
  code: z.string().min(3),
  name: z.string().min(3),
  alertType: z.enum([
    "HIGH_UTILIZATION",
    "MISSING_FAR_END_MAPPING",
    "MISSING_CABLE_INFORMATION",
    "PARTIAL_TERMINATION",
    "IMPORT_WARNING",
    "DATA_GAP",
    "CUSTOM",
  ]),
  metricType: z.enum(["SEGMENT_UTILIZATION", "SITE_PAIR_UTILIZATION", "ODF_UTILIZATION", "CABLE_UTILIZATION"]).nullable().optional(),
  warningThresholdPct: z.number().min(0).max(100).nullable().optional(),
  criticalThresholdPct: z.number().min(0).max(100).nullable().optional(),
  consecutiveHits: z.number().int().positive().default(1),
  cooldownMinutes: z.number().int().nonnegative().default(60),
  hysteresisPct: z.number().min(0).max(100).default(5),
});
