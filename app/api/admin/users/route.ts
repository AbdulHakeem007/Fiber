import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSessionUser, hashPassword } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";

const ROLE_CODES = new Set(["ADMIN", "READ_WRITE", "READ_ONLY"]);
// Requires a domain with an alphabetic TLD of >=2 chars, rejecting inputs the old
// pattern let through such as "user@host." or "user@host.1".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

function userRow(user: any) {
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

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
    }

    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const roleCode = String(body.roleCode ?? "READ_ONLY");
    const loginType = body.loginType === "LDAP" ? "LDAP" : "LOCAL";

    if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
    // LDAP users authenticate against the domain, so no portal password is stored.
    if (loginType === "LOCAL" && password.length < 6) {
      return NextResponse.json({ error: "Local users require a password of at least 6 characters." }, { status: 400 });
    }
    if (!ROLE_CODES.has(roleCode)) return NextResponse.json({ error: "Invalid role selected." }, { status: 400 });

    const role = await prisma.role.findUnique({ where: { code: roleCode as any } });
    if (!role) return NextResponse.json({ error: "Selected role does not exist." }, { status: 400 });

    const user = await prisma.user.create({
      data: {
        name,
        email,
        loginType,
        passwordHash: loginType === "LOCAL" ? hashPassword(password) : null,
        roleId: role.id,
        isActive: body.isActive !== false,
      },
      include: { role: true },
    });

    await writeAuditLog({
      entityType: "User",
      entityId: user.id,
      action: "CREATE",
      newValue: { name, email, roleCode, loginType, isActive: user.isActive },
      changedById: session?.id ?? null,
      reason: "Admin user creation",
    });

    return NextResponse.json({ row: userRow(user) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "User creation failed." },
      { status: 500 },
    );
  }
}
