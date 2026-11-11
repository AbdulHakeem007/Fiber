import { hasPermission } from "@/lib/auth/permissions";

/**
 * Role-based deletion policy shared by every inventory delete endpoint
 * (ODF Mapping, Sites, Splitters, ODF, and Racks inventory).
 *
 *  - ADMIN: full privileges — Bulk Delete / Flush All and individual deletes
 *    run directly with NO prior status checks or restrictions.
 *  - READ_WRITE: individual records only (bulk/flush stays ADMIN-only), and a
 *    row may only be deleted once its status is "Decommissioned". Attempting to
 *    delete an active row returns a descriptive validation error.
 *  - READ_ONLY / unauthenticated: never.
 *
 * Bulk endpoints keep guarding with `adminManage`; this helper governs the
 * per-record deletes that READ_WRITE is allowed to perform.
 */

/** Status string that unlocks deletion for non-admin (READ_WRITE) operators. */
export const DELETABLE_STATUS = "DECOMMISSIONED";

/** Thrown when a delete is blocked by role or by live (non-decommissioned) status. */
export class DeletePolicyError extends Error {
  /** HTTP status to surface: 403 for role denial, 409 for status conflict. */
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "DeletePolicyError";
    this.status = status;
  }
}

/** ADMIN is the only role with bulk-delete / flush-all rights. */
export function isAdminRole(roleCode: string | undefined): boolean {
  return hasPermission(roleCode, "bulkDelete");
}

/**
 * Enforce the individual-record deletion policy for one row.
 *
 * @param roleCode    the authenticated user's role code.
 * @param status      the target record's current status.
 * @param entityLabel human-readable label used in error messages, e.g. "site".
 * @throws DeletePolicyError when the role or status does not permit deletion.
 */
export function assertIndividualDeleteAllowed(
  roleCode: string | undefined,
  status: string | null | undefined,
  entityLabel: string,
): void {
  // ADMIN: unrestricted — no status check.
  if (isAdminRole(roleCode)) return;

  // READ_WRITE: individual deletes only. Anyone without childLinkDelete (i.e.
  // READ_ONLY or unauthenticated) is rejected outright.
  if (!hasPermission(roleCode, "childLinkDelete")) {
    throw new DeletePolicyError(
      `You do not have permission to delete this ${entityLabel}. Read/Write or Admin access is required.`,
      403,
    );
  }

  // READ_WRITE may only remove records that have already been decommissioned.
  const normalized = String(status ?? "").trim().toUpperCase();
  if (normalized !== DELETABLE_STATUS) {
    throw new DeletePolicyError(
      `This ${entityLabel} cannot be deleted while its status is "${status ?? "unknown"}". ` +
        `Read/Write users may only delete records whose status is "Decommissioned". ` +
        `Set the ${entityLabel} to Decommissioned first, then delete it.`,
      409,
    );
  }
}
