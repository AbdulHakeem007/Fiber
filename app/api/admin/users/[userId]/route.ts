import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSessionUser, hashPassword } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { clearLockStateData } from "@/lib/auth/account-lock";

const ROLE_CODES = new Set(["ADMIN", "READ_WRITE", "READ_ONLY"]);
// Requires a domain with an alphabetic TLD of >=2 chars, rejecting inputs the old
// pattern let through such as "user@host." or "user@host.1".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

function toRow(user: any) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.code,
    loginType: user.loginType,
    passwordInPortal: user.loginType === "LOCAL" && Boolean(user.passwordHash),
    isActive: user.isActive,
    isLocked: Boolean(user.lockedAt),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

async function assertNotLastAdmin(userId: string, nextRoleCode?: string, nextIsActive?: boolean) {
  const target = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!target || target.role.code !== "ADMIN") return;
  const removesAdminAccess = nextRoleCode && nextRoleCode !== "ADMIN";
  const disablesAdmin = nextIsActive === false;
  if (!removesAdminAccess && !disablesAdmin) return;

  const activeAdmins = await prisma.user.count({
    where: {
      isActive: true,
      role: { code: "ADMIN" },
      NOT: { id: userId },
    },
  });
  if (!activeAdmins) {
    throw new Error("At least one active admin user must remain.");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
    }

    const { userId } = await params;
    const body = (await request.json()) as { name?: string; email?: string; password?: string; isActive?: boolean; roleCode?: "ADMIN" | "READ_WRITE" | "READ_ONLY"; loginType?: "LOCAL" | "LDAP"; unlock?: boolean };
    const nextRoleCode = body.roleCode && ROLE_CODES.has(body.roleCode) ? body.roleCode : undefined;
    await assertNotLastAdmin(userId, nextRoleCode, body.isActive);

    const role = nextRoleCode ? await prisma.role.findUnique({ where: { code: nextRoleCode }, select: { id: true } }) : null;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined;
    if (email !== undefined && !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
    }
    if (typeof body.password === "string" && body.password && body.password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }
    const nextLoginType = body.loginType === "LOCAL" || body.loginType === "LDAP" ? body.loginType : undefined;

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
        email,
        loginType: nextLoginType,
        // Switching a user to LDAP clears the portal password; a supplied password
        // is only stored for LOCAL users.
        passwordHash:
          nextLoginType === "LDAP"
            ? null
            : typeof body.password === "string" && body.password
              ? hashPassword(body.password)
              : undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
        roleId: role?.id,
        // Admin-initiated unlock: clear the lockout counter, lock flag, and any
        // outstanding unlock code so the user can sign in again immediately.
        ...(body.unlock ? clearLockStateData() : {}),
      },
      include: { role: true },
    });

    await writeAuditLog({
      entityType: "User",
      entityId: user.id,
      action: "UPDATE",
      newValue: { name: user.name, email: user.email, roleCode: user.role.code, loginType: user.loginType, isActive: user.isActive },
      changedById: session?.id ?? null,
      reason: "Admin user update",
    });

    return NextResponse.json({ row: toRow(user) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "User update failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
    }

    const { userId } = await params;
    await assertNotLastAdmin(userId, "READ_ONLY", false);
    if (session?.id === userId) {
      return NextResponse.json({ error: "You cannot delete the account currently in use." }, { status: 400 });
    }

    const dependencyCounts = await Promise.all([
      prisma.importBatch.count({ where: { OR: [{ uploadedById: userId }, { reviewedById: userId }, { committedById: userId }] } }),
      prisma.alertSuppression.count({ where: { createdById: userId } }),
      prisma.alertEvent.count({ where: { acknowledgedById: userId } }),
      prisma.importIssue.count({ where: { resolvedById: userId } }),
      prisma.notificationLog.count({ where: { userId } }),
      prisma.auditLog.count({ where: { changedById: userId } }),
      prisma.temporaryPassword.count({ where: { userId } }),
      prisma.passwordResetToken.count({ where: { userId } }),
    ]);
    const dependencyCount = dependencyCounts.reduce((sum, count) => sum + count, 0);

    if (dependencyCount > 0) {
      const user = await prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
        include: { role: true },
      });
      await writeAuditLog({
        entityType: "User",
        entityId: userId,
        action: "UPDATE",
        changedById: session?.id ?? null,
        reason: "User has operational history, so the account was deactivated instead of deleted.",
      });
      return NextResponse.json({
        row: toRow(user),
        deactivated: true,
        message: "This user has audit or operational history, so the account was deactivated instead of deleted.",
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.temporaryPassword.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });
    await writeAuditLog({
      entityType: "User",
      entityId: userId,
      action: "DELETE",
      changedById: session?.id ?? null,
      reason: "Admin user deletion",
    });
    return NextResponse.json({ deletedId: userId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "User deletion failed." },
      { status: 500 },
    );
  }
}
