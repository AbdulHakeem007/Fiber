/**
 * Pure (DB-free) decision helpers for the hybrid Local + LDAP login flow.
 * Kept side-effect free so they are trivially testable and reusable by both the
 * login route and the admin settings UI.
 */

export type LoginMode = "LOCAL_ONLY" | "LDAP_ONLY" | "LOCAL_AND_LDAP";

export interface EmergencyPolicy {
  emergencyAccountEnabled: boolean;
  emergencyUsername: string;
  emergencyAllowedIps?: string | null;
}

/** Loopback is always permitted so on-box maintenance never locks ops out. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function localLoginAllowed(mode: LoginMode): boolean {
  return mode === "LOCAL_ONLY" || mode === "LOCAL_AND_LDAP";
}

export function ldapLoginAllowed(mode: LoginMode): boolean {
  return mode === "LDAP_ONLY" || mode === "LOCAL_AND_LDAP";
}

/**
 * Whether a domain user may authenticate via LDAP given the configured username
 * allow-list. Matching is case-insensitive and works whether the allow-list
 * entries (and the supplied username) include a domain or are bare local-parts.
 * An empty/blank allow-list means "no extra restriction" so the feature is
 * opt-in and never accidentally locks out existing LDAP users.
 */
export function ldapUsernameAllowed(username: string, allowList?: string | null): boolean {
  const entries = String(allowList ?? "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) return true;

  const candidate = username.trim().toLowerCase();
  const candidateLocal = candidate.split("@")[0];
  return entries.some((entry) => {
    const entryLocal = entry.split("@")[0];
    return entry === candidate || entry === candidateLocal || entryLocal === candidate || entryLocal === candidateLocal;
  });
}

/** Case-insensitive match of the supplied username against the emergency account. */
export function isEmergencyAccount(username: string, policy: EmergencyPolicy): boolean {
  if (!policy.emergencyAccountEnabled) return false;
  const candidate = username.trim().toLowerCase();
  const emergency = policy.emergencyUsername.trim().toLowerCase();
  // Match the bare username or its email-localpart form.
  return candidate === emergency || candidate.split("@")[0] === emergency;
}

/** Normalise a request IP (strip IPv4-mapped IPv6 prefix, lowercase). */
export function normalizeIp(ip?: string | null): string | null {
  if (!ip) return null;
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

/** Exact or CIDR (IPv4) match; IPv6 is matched exactly. */
function ipMatches(ip: string, rule: string): boolean {
  const candidate = normalizeIp(ip);
  const target = normalizeIp(rule);
  if (!candidate || !target) return false;
  if (candidate === target) return true;

  if (target.includes("/")) {
    const [network, bitsText] = target.split("/");
    const bits = Number(bitsText);
    const candidateInt = ipv4ToInt(candidate);
    const networkInt = ipv4ToInt(network);
    if (candidateInt === null || networkInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (candidateInt & mask) === (networkInt & mask);
  }
  return false;
}

/**
 * Whether the emergency account may authenticate from this IP. The allowlist is
 * always implicitly extended with loopback. A null/unknown IP is treated as an
 * on-box (loopback) request so local server maintenance is never blocked.
 */
export function ipAllowedForEmergency(ip: string | null | undefined, policy: EmergencyPolicy): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized || LOOPBACK.has(normalized)) return true;

  const rules = String(policy.emergencyAllowedIps ?? "")
    .split(/[,\s]+/)
    .map((rule) => rule.trim())
    .filter(Boolean);

  return rules.some((rule) => LOOPBACK.has(rule) || ipMatches(normalized, rule));
}

/** Best-effort client IP from common proxy headers. */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return normalizeIp(forwarded.split(",")[0]);
  return normalizeIp(headers.get("x-real-ip"));
}
