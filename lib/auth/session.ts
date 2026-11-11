import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import type { SessionUser } from "@/lib/auth/guards";

export const SESSION_COOKIE = "fiber_inventory_session";

function authSecret() {
  return process.env.AUTH_SECRET ?? "fiber-inventory-local-approval-secret";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password: string, stored?: string | null, roleCode?: string | null) {
  if (!stored) return false;

  if (stored.startsWith("scrypt$")) {
    const [, salt, expected] = stored.split("$");
    if (!salt || !expected) return false;
    const candidate = scryptSync(password, salt, 64).toString("hex");
    const left = Buffer.from(candidate, "hex");
    const right = Buffer.from(expected, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  const legacyDigest = sha256(password);
  if (stored === legacyDigest) return true;

  const seededDefaults: Record<string, string> = {
    ADMIN: "admin123",
    READ_WRITE: "planner123",
    READ_ONLY: "viewer123",
  };
  return stored.startsWith("seeded-") && password === seededDefaults[roleCode ?? ""] ;
}

export function signSession(userId: string) {
  const signature = createHmac("sha256", authSecret()).update(userId).digest("hex");
  return `${userId}.${signature}`;
}

/**
 * Whether the session cookie should carry the `Secure` attribute. Driven off the
 * actual request protocol — `x-forwarded-proto` when behind a TLS-terminating
 * reverse proxy, otherwise the request URL scheme. This sets `Secure` automatically
 * once the portal is served over HTTPS, while still allowing the cookie to work on
 * a plain-HTTP LAN deployment (where a hardcoded `secure: true` would silently
 * drop the cookie and make login impossible).
 */
export function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function verifySessionToken(token?: string | null): string | null {
  if (!token) return null;
  const [userId, signature] = token.split(".");
  if (!userId || !signature) return null;
  const expected = createHmac("sha256", authSecret()).update(userId).digest("hex");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return null;
  return timingSafeEqual(left, right) ? userId : null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const userId = verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });

  if (!user?.isActive) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleCode: user.role.code,
    forcePasswordChange: user.forcePasswordChange,
  };
}

export function generateTemporaryPassword() {
  const secret = randomBytes(18).toString("base64url");
  return `Fiber-${secret.slice(0, 18)}`;
}
