/**
 * Account-lockout helpers for LOCAL ADMIN / READ_WRITE accounts.
 *
 * After MAX_FAILED_LOGINS consecutive failed local password attempts such an
 * account is locked and a one-time numeric unlock code is emailed to the user.
 * The lock is cleared only by entering that code (no automatic time-based
 * unlock) or by an administrator from the Users screen. LDAP users (which
 * authenticate against the domain controller, with its own lockout) and the
 * IP-restricted emergency account are never locked here so a recovery path
 * always remains even when SMTP is unavailable.
 */
import { randomInt } from "crypto";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { notificationService } from "@/server/services/notification.service";

export const MAX_FAILED_LOGINS = 5;
export const UNLOCK_CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong-code guesses tolerated before the active code is invalidated. */
export const MAX_UNLOCK_CODE_ATTEMPTS = 5;

/** Roles subject to lockout, per the operational requirement. READ_ONLY is exempt. */
export function isLockableRole(roleCode?: string | null): boolean {
  return roleCode === "ADMIN" || roleCode === "READ_WRITE";
}

/** Six-digit, zero-padded, cryptographically random unlock code. */
export function generateUnlockCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Lock the account (if not already), generate a fresh unlock code, persist its
 * hash + expiry, email the code to the user, and audit the event. Used both when
 * the failure threshold is first crossed and when a locked user requests a resend.
 */
export async function issueUnlockCode(
  user: { id: string; name: string; email: string },
  reason: string,
) {
  const code = generateUnlockCode();
  const expiresAt = new Date(Date.now() + UNLOCK_CODE_TTL_MS);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      lockedAt: new Date(),
      unlockCodeHash: hashPassword(code),
      unlockCodeExpiresAt: expiresAt,
      unlockCodeAttempts: 0,
    },
  });

  const delivery = await notificationService.sendEmail({
    to: user.email,
    subject: "Fiber Inventory Portal account unlock code",
    text: [
      `Hello ${user.name},`,
      "",
      "Your Fiber Inventory Management Portal account was locked after too many",
      "failed sign-in attempts.",
      "",
      `Unlock code: ${code}`,
      `This code expires at ${expiresAt.toISOString()}.`,
      "",
      "Enter it on the login page to unlock your account, then sign in as usual.",
      "If you did not attempt to sign in, contact an administrator.",
    ].join("\n"),
    userId: user.id,
    metadata: { purpose: "ACCOUNT_UNLOCK", expiresAt: expiresAt.toISOString() },
  });

  await writeAuditLog({
    entityType: "User",
    entityId: user.id,
    action: "MANUAL_OVERRIDE",
    changedById: user.id,
    reason,
    newValue: { event: "ACCOUNT_LOCKED", delivery: delivery.status },
  });

  return { expiresAt, delivery };
}

/** Clear all lockout state for a user (successful unlock, admin override, or login). */
export function clearLockStateData() {
  return {
    failedLoginAttempts: 0,
    lockedAt: null,
    unlockCodeHash: null,
    unlockCodeExpiresAt: null,
    unlockCodeAttempts: 0,
  } as const;
}

/**
 * Resolve a login identifier to a user the same way the login route does:
 * exact email, email local-part ("kamran.lashari"), or display name. Shared so
 * the unlock/resend routes match exactly the account the user tried to sign into.
 */
export async function findUserByLogin(rawUsername: string) {
  const username = rawUsername.trim();
  if (!username) return null;
  const normalizedUsername = username.toLowerCase();
  const adminAlias = normalizedUsername === "admin" || normalizedUsername === "admin@fiber.local";
  return prisma.user.findFirst({
    where: {
      OR: [
        { email: normalizedUsername },
        ...(!normalizedUsername.includes("@") ? [{ email: { startsWith: `${normalizedUsername}@` } }] : []),
        { name: { equals: username } },
        ...(adminAlias ? [{ role: { code: "ADMIN" as const } }] : []),
      ],
    },
    include: { role: true },
  });
}
