/**
 * LDAP / Domain Controller authentication gateway.
 *
 * This is a deliberately dependency-free seam. A real directory integration
 * (e.g. ldapjs / Active Directory) is injected at runtime via
 * `globalThis.__ldapBinder` so production can wire a concrete binder without
 * forcing an LDAP client into the build/bundle. When no binder is present the
 * gateway reports LDAP_NOT_CONFIGURED, and the login route falls back to the
 * emergency local account framework (Section 3A).
 */

export type LdapResultReason =
  | "OK"
  | "INVALID_CREDENTIALS"
  | "LDAP_DISABLED"
  | "LDAP_NOT_CONFIGURED"
  | "LDAP_UNREACHABLE";

export interface LdapVerifyResult {
  ok: boolean;
  reason: LdapResultReason;
  detail?: string;
}

export interface LdapSettings {
  ldapEnabled: boolean;
  ldapHost?: string | null;
  ldapPort?: number | null;
  ldapUseSsl?: boolean;
  ldapBaseDn?: string | null;
  ldapBindDn?: string | null;
  ldapBindPassword?: string | null; // decrypted at the call site
  ldapUserDnPattern?: string | null;
  ldapUserAttribute?: string | null;
}

/** Runtime-provided directory binder. Returns true on a successful user bind. */
export type LdapBinder = (params: { username: string; password: string; settings: LdapSettings }) => Promise<boolean>;

function resolveBinder(): LdapBinder | undefined {
  return (globalThis as unknown as { __ldapBinder?: LdapBinder }).__ldapBinder;
}

export async function verifyLdapCredentials(
  username: string,
  password: string,
  settings: LdapSettings,
): Promise<LdapVerifyResult> {
  if (!settings.ldapEnabled) return { ok: false, reason: "LDAP_DISABLED" };
  if (!settings.ldapHost) return { ok: false, reason: "LDAP_NOT_CONFIGURED" };
  if (!username || !password) return { ok: false, reason: "INVALID_CREDENTIALS" };

  const binder = resolveBinder();
  if (!binder) {
    return {
      ok: false,
      reason: "LDAP_NOT_CONFIGURED",
      detail: "No LDAP binder is wired on this server. Configure globalThis.__ldapBinder to enable directory logins.",
    };
  }

  try {
    const ok = await binder({ username, password, settings });
    return ok ? { ok: true, reason: "OK" } : { ok: false, reason: "INVALID_CREDENTIALS" };
  } catch (error) {
    // Treat any transport/bind exception as the directory being unreachable so
    // the caller can engage the emergency local fallback.
    return { ok: false, reason: "LDAP_UNREACHABLE", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Friendly, operator-facing message for a failed LDAP attempt. */
export function ldapReasonMessage(reason: LdapResultReason): string {
  switch (reason) {
    case "LDAP_DISABLED":
      return "LDAP authentication is currently disabled.";
    case "LDAP_NOT_CONFIGURED":
      return "LDAP is not fully configured. Contact an administrator or use the emergency local account.";
    case "LDAP_UNREACHABLE":
      return "The LDAP/Domain Controller is unreachable. Use the emergency local account for maintenance.";
    case "INVALID_CREDENTIALS":
      return "Invalid domain username or password.";
    default:
      return "LDAP authentication failed.";
  }
}
