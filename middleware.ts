import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "fiber_inventory_session";
const PUBLIC_PATHS = [
  "/login",
  "/forgot-password",
  "/api/auth/login",
  "/api/auth/forgot-password",
  "/api/auth/logout",
  "/fiber-hero.svg",
  "/favicon.ico",
];

function authSecret() {
  return process.env.AUTH_SECRET ?? "fiber-inventory-local-approval-secret";
}

/**
 * Validate the session cookie's HMAC signature (Web Crypto, Edge-safe) using the
 * SAME scheme as lib/auth/session.ts `signSession` (`${userId}.${hmacHex}`).
 *
 * Previously the middleware trusted mere cookie EXISTENCE. A stale/invalid cookie
 * then bounced /dashboard -> /login (AppShell rejected it) and /login -> /dashboard
 * (cookie present), an infinite 307 loop that also made the login page
 * unreachable. Verifying the signature here breaks that loop: an invalid cookie is
 * treated as logged-out and purged.
 */
async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const firstDot = token.indexOf(".");
  if (firstDot <= 0) return false;
  const userId = token.slice(0, firstDot);
  const signatureHex = token.slice(firstDot + 1);
  if (!userId || !signatureHex) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
    const expectedHex = Array.from(new Uint8Array(signatureBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (expectedHex.length !== signatureHex.length) return false;
    let diff = 0;
    for (let index = 0; index < expectedHex.length; index += 1) {
      diff |= expectedHex.charCodeAt(index) ^ signatureHex.charCodeAt(index);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic =
    PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ||
    pathname.startsWith("/_next/") ||
    pathname.match(/\.(svg|png|jpg|jpeg|gif|webp|ico|css|js)$/);

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const validSession = await isValidSession(token);

  if (!isPublic && !validSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(url);
    // Purge a signature-invalid cookie so the operator is not trapped in a
    // redirect loop and can reach the login page.
    if (token) response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  // Note: we intentionally do NOT redirect /login -> /dashboard here. Middleware
  // (Edge) can only verify the cookie SIGNATURE, not that the user still exists.
  // A signature-valid-but-orphaned cookie would otherwise loop /login <-> /dashboard.
  // The authoritative "already logged in" redirect lives in the /login server page,
  // which checks the real user via the database.

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
