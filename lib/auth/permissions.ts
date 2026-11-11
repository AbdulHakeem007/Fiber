/**
 * Three-tier RBAC matrix.
 *
 * Tier 1 ADMIN       — full privileges: read, write, individual delete,
 *                      parent-segment delete, and bulk delete everywhere.
 * Tier 2 READ_WRITE  — provisioning, imports, manual creation, inventory
 *                      updates, and deletion of INDIVIDUAL child links/rows
 *                      only. Never bulk deletion, never top-level parent
 *                      segment deletion.
 * Tier 3 READ_ONLY   — view-only: data tables, circuit traces, Impact
 *                      Analysis simulations, and file exports.
 */
export const PERMISSIONS = {
  inventoryRead: ["ADMIN", "READ_WRITE", "READ_ONLY"],
  inventoryWrite: ["ADMIN", "READ_WRITE"],
  importManage: ["ADMIN", "READ_WRITE"],
  alertAcknowledge: ["ADMIN", "READ_WRITE"],
  /** Individual child link / child row deletion (never parents, never bulk). */
  childLinkDelete: ["ADMIN", "READ_WRITE"],
  /** Bulk deletion and top-level parent segment deletion. */
  bulkDelete: ["ADMIN"],
  /** Impact Analysis simulations are available to every authenticated tier. */
  impactAnalyze: ["ADMIN", "READ_WRITE", "READ_ONLY"],
  /** File export generation is available to every authenticated tier. */
  exportData: ["ADMIN", "READ_WRITE", "READ_ONLY"],
  adminManage: ["ADMIN"],
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export function hasPermission(roleCode: string | undefined, permission: PermissionKey): boolean {
  if (!roleCode) return false;
  return PERMISSIONS[permission].includes(roleCode as never);
}
