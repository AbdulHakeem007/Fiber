import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, isSecureRequest, SESSION_COOKIE, signSession, verifyPassword } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { authSettingsService } from "@/server/services/auth-settings.service";
import {
  clientIpFromHeaders,
  ipAllowedForEmergency,
  isEmergencyAccount,
  ldapLoginAllowed,
  ldapUsernameAllowed,
  localLoginAllowed,
} from "@/lib/auth/login-policy";
import { ldapReasonMessage, verifyLdapCredentials } from "@/lib/auth/ldap";
import {
  clearLockStateData,
  isLockableRole,
  issueUnlockCode,
  MAX_FAILED_LOGINS,
} from "@/lib/auth/account-lock";

const LOCKED_MESSAGE =
  "This account is locked after too many failed sign-in attempts. " +
  "We emailed a one-time unlock code to the registered address — enter it to unlock.";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { username?: string; password?: string; rememberMe?: boolean };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    if (!username || !password) {
      return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
    }

    const settings = await authSettingsService.getEffective();
    const ip = clientIpFromHeaders(request.headers);

    const normalizedUsername = username.toLowerCase();
    const adminAlias = normalizedUsername === "admin" || normalizedUsername === "admin@fiber.local";
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedUsername },
          // Allow username-style logins (email local-part), e.g. "kamran.lashari".
          ...(!normalizedUsername.includes("@") ? [{ email: { startsWith: `${normalizedUsername}@` } }] : []),
          { name: { equals: username } },
          ...(adminAlias ? [{ role: { code: "ADMIN" as const } }] : []),
        ],
      },
      include: { role: true },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
    }

    const isLdapUser = user.loginType === "LDAP";
    const emergency = !isLdapUser && isEmergencyAccount(normalizedUsername, settings);

    // The emergency local account is restricted strictly to server/admin IPs —
    // enforced regardless of the global Login Mode.
    if (emergency && !ipAllowedForEmergency(ip, settings)) {
      await writeAuditLog({
        entityType: "User",
        entityId: user.id,
        action: "LOGIN",
        changedById: user.id,
        reason: `Emergency account login denied from non-approved IP ${ip ?? "unknown"}`,
      });
      return NextResponse.json(
        { error: "The emergency account can only be used from approved server/admin IP addresses." },
        { status: 403 },
      );
    }

    // Local credential evaluation (used by LOCAL users and the emergency account).
    const defaultAdminBootstrap = adminAlias && user.role.code === "ADMIN" && !user.passwordHash && password === "admin123";
    const temporaryPassword = await prisma.temporaryPassword.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    const temporaryPasswordMatched = temporaryPassword ? verifyPassword(password, temporaryPassword.passwordHash, user.role.code) : false;
    const normalPasswordMatched = verifyPassword(password, user.passwordHash, user.role.code);
    const localMatched = defaultAdminBootstrap || normalPasswordMatched || temporaryPasswordMatched;

    let viaLdap = false;

    if (isLdapUser) {
      // Directory-authenticated user.
      if (!ldapLoginAllowed(settings.loginMode)) {
        return NextResponse.json({ error: "Directory (LDAP) logins are disabled by the current Login Mode." }, { status: 403 });
      }
      // Username allow-list gate: when configured, only listed domain usernames
      // may authenticate via LDAP — denied even if the directory would accept them.
      if (!ldapUsernameAllowed(username, settings.ldapAllowedUsernames)) {
        return NextResponse.json({ error: "This domain account is not on the LDAP access allow-list." }, { status: 403 });
      }
      const result = await verifyLdapCredentials(username, password, settings);
      if (!result.ok) {
        return NextResponse.json({ error: ldapReasonMessage(result.reason) }, { status: 401 });
      }
      viaLdap = true;
    } else {
      // Lockout applies to LOCAL ADMIN / READ_WRITE accounts only; the emergency
      // account is exempt so an IP-approved operator can always recover.
      const lockable = isLockableRole(user.role.code) && !emergency;

      // A locked account is rejected before any password evaluation — recovery is
      // the emailed unlock code (or an admin), never by continuing to guess.
      if (lockable && user.lockedAt) {
        return NextResponse.json({ error: LOCKED_MESSAGE, locked: true }, { status: 423 });
      }

      // The emergency account bypasses the Login Mode gate (it has already passed
      // the IP allowlist), but every other local user is subject to it.
      if (!emergency && !localLoginAllowed(settings.loginMode)) {
        return NextResponse.json({ error: "Local logins are disabled by the current Login Mode (LDAP only)." }, { status: 403 });
      }

      if (!localMatched) {
        if (lockable) {
          const attempts = user.failedLoginAttempts + 1;
          if (attempts >= MAX_FAILED_LOGINS) {
            // Threshold crossed: lock, email a one-time code, and report it as locked.
            await issueUnlockCode(user, `Account locked after ${attempts} failed login attempts; unlock code emailed.`);
            return NextResponse.json({ error: LOCKED_MESSAGE, locked: true }, { status: 423 });
          }
          await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: attempts } });
        }
        return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
      }
    }

    // Portal-managed password hash maintenance applies to LOCAL users only.
    // Upgrading the stored hash is best-effort: a hashing failure must never block
    // an otherwise-valid login (the upgrade simply retries on the next login).
    let passwordHash: string | undefined;
    try {
      const shouldUpgradeHash =
        !viaLdap &&
        (defaultAdminBootstrap ||
          user.passwordHash?.startsWith("seeded-") ||
          (user.passwordHash && !user.passwordHash.startsWith("scrypt$") && normalPasswordMatched));
      if (shouldUpgradeHash) passwordHash = hashPassword(password);
    } catch (error) {
      console.warn("[login] password hash upgrade failed; leaving existing hash in place:", error);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        // A successful sign-in clears any accumulated failure count / lock state.
        ...clearLockStateData(),
        lastLoginAt: new Date(),
        passwordHash,
        forcePasswordChange: temporaryPasswordMatched ? true : undefined,
      },
      include: { role: true },
    });

    await writeAuditLog({
      entityType: "User",
      entityId: updated.id,
      action: "LOGIN",
      changedById: updated.id,
      reason: viaLdap ? "User login (LDAP)" : emergency ? "Emergency local account login" : "User login (local)",
    });

    const response = NextResponse.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        roleCode: updated.role.code,
        loginType: updated.loginType,
      },
      requiresPasswordChange: updated.forcePasswordChange,
    });
    response.cookies.set(SESSION_COOKIE, signSession(updated.id), {
      httpOnly: true,
      // `lax` (not `strict`): still blocks the cookie on cross-site POST/subresource
      // requests (the CSRF vector), but keeps it on top-level navigations so emailed
      // report links into the portal don't bounce the user to /login. `secure` tracks
      // the real request protocol so it's set under HTTPS without breaking HTTP LAN.
      sameSite: "lax",
      secure: isSecureRequest(request),
      path: "/",
      maxAge: body.rememberMe ? 60 * 60 * 24 * 30 : 60 * 60 * 10,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Login failed." },
      { status: 500 },
    );
  }
}
