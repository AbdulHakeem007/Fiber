// Shared, dependency-free metadata for all weekly alert reports. Lives apart from
// weekly-report.service.ts (which imports Prisma) so client components — the admin
// schedule panel and the Reports Center send buttons — can import the catalogue
// without dragging server-only code into the browser bundle.
//
// DEPRECATION NOTE (2026-06-29):
//   The four individual report schedules (HIGH_UTIL_LINKS, TOPOLOGY_SYSTEMS,
//   CORE_PTP_LINKS, CORE_CHAINS) are superseded by the unified MEGA_ALERT schedule.
//   Their DB rows are force-disabled by ensureDefaults(). They remain in this list
//   for backward-compatibility with any existing DB records and manual API calls.
//   "Core PtP Link Utilisation" is globally renamed to "PtP links between core sites".

export interface WeeklyReportMeta {
  reportKey: string;
  /** Display name + email subject suffix. */
  name: string;
  description: string;
  /** Highly/critically-utilised % thresholds apply to this report. */
  usesThreshold: boolean;
  /** Ring node threshold applies to this report. */
  usesMinNodes: boolean;
  defaultWarn: number | null;
  defaultCrit: number | null;
  defaultMinNodes: number | null;
  /** Deprecated reports are force-disabled by ensureDefaults() and hidden from the admin UI. */
  deprecated: boolean;
}

export const WEEKLY_REPORT_META: readonly WeeklyReportMeta[] = [
  // ── deprecated individual schedules ──────────────────────────────────────────
  {
    reportKey: "HIGH_UTIL_LINKS",
    name: "Highly Utilised Links",
    description: "Links across the network at or above the highly/critically utilised thresholds.",
    usesThreshold: true,
    usesMinNodes: false,
    defaultWarn: 80,
    defaultCrit: 95,
    defaultMinNodes: null,
    deprecated: true,
  },
  {
    reportKey: "TOPOLOGY_SYSTEMS",
    name: "Network Vulnerabilities",
    description: "Spurs and spur chains network-wide; single-homed rings, subrings, and rings above the node threshold for A-MPLS-tagged traffic.",
    usesThreshold: false,
    usesMinNodes: true,
    defaultWarn: null,
    defaultCrit: null,
    defaultMinNodes: 8,
    deprecated: true,
  },
  {
    reportKey: "CORE_PTP_LINKS",
    // Global rename: "Core PtP Link Utilisation" → "PtP links between core sites"
    name: "PtP links between core sites",
    description: "Highly/critically utilised point-to-point links between core sites.",
    usesThreshold: true,
    usesMinNodes: false,
    defaultWarn: 80,
    defaultCrit: 95,
    defaultMinNodes: null,
    deprecated: true,
  },
  {
    reportKey: "CORE_CHAINS",
    name: "Core-to-Core Chain Utilisation",
    description: "Highly/critically utilised chains (intermediate sites between two core sites), derived from A-MPLS rings.",
    usesThreshold: true,
    usesMinNodes: true,
    defaultWarn: 80,
    defaultCrit: 95,
    defaultMinNodes: 8,
    deprecated: true,
  },
  // ── active: unified Mega Alert ────────────────────────────────────────────────
  {
    reportKey: "MEGA_ALERT",
    name: "Fiber Network Statistics",
    description:
      "Unified weekly digest bundling three sub-reports: Highly Utilised Links, Network Vulnerabilities, and PtP links between core sites. A single Excel workbook (three tabs) is attached.",
    usesThreshold: true,
    usesMinNodes: true,
    defaultWarn: 80,
    defaultCrit: 95,
    defaultMinNodes: 8,
    deprecated: false,
  },
] as const;

export const WEEKLY_REPORT_KEYS = WEEKLY_REPORT_META.map((meta) => meta.reportKey);

/** Only the non-deprecated entries shown in the admin UI. */
export const ACTIVE_REPORT_META = WEEKLY_REPORT_META.filter((meta) => !meta.deprecated);

export function reportMeta(reportKey: string): WeeklyReportMeta | undefined {
  return WEEKLY_REPORT_META.find((meta) => meta.reportKey === reportKey);
}

export function isWeeklyReportKey(value: unknown): value is string {
  return typeof value === "string" && WEEKLY_REPORT_KEYS.includes(value);
}
