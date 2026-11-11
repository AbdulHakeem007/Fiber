/**
 * Two-tier log lifecycle policy.
 *
 * - Data tier: audit / activity logs are retained in the Prisma/SQL store for at
 *   least LOG_RETENTION_MONTHS (6 months). Nothing younger than this window is
 *   ever purged, so the full ledger is always available for export.
 * - UI view tier: online activity panels only query the most recent
 *   LOG_VIEW_DAYS (15 days) to keep page loads bounded as the ledger grows.
 *
 * The full 6-month ledger remains reachable through the "Export Logs" action,
 * which streams it as a downloadable workbook rather than rendering it inline.
 */
export const LOG_RETENTION_MONTHS = 6;
export const LOG_VIEW_DAYS = 15;

/** Oldest timestamp still inside the 6-month retention window. */
export function logRetentionCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - LOG_RETENTION_MONTHS);
  return cutoff;
}

/** Oldest timestamp shown in the online activity panel (last 15 days). */
export function logViewCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - LOG_VIEW_DAYS * 24 * 60 * 60 * 1000);
}
