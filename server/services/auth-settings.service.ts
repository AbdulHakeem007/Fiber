import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/security/secrets";
import type { LoginMode } from "@/lib/auth/login-policy";

const LOGIN_MODES: LoginMode[] = ["LOCAL_ONLY", "LDAP_ONLY", "LOCAL_AND_LDAP"];

const DEFAULTS = {
  loginMode: "LOCAL_ONLY" as LoginMode,
  ldapEnabled: false,
  ldapHost: null as string | null,
  ldapPort: null as number | null,
  ldapUseSsl: true,
  ldapBaseDn: null as string | null,
  ldapBindDn: null as string | null,
  ldapUserDnPattern: null as string | null,
  ldapUserAttribute: "sAMAccountName" as string | null,
  ldapAllowedUsernames: null as string | null,
  emergencyAccountEnabled: true,
  emergencyUsername: "portal.superadmin",
  emergencyAllowedIps: null as string | null,
};

function coerceLoginMode(value: unknown): LoginMode {
  return LOGIN_MODES.includes(value as LoginMode) ? (value as LoginMode) : "LOCAL_ONLY";
}

export interface EffectiveAuthSettings {
  loginMode: LoginMode;
  ldapEnabled: boolean;
  ldapHost: string | null;
  ldapPort: number | null;
  ldapUseSsl: boolean;
  ldapBaseDn: string | null;
  ldapBindDn: string | null;
  ldapBindPassword: string | null;
  ldapUserDnPattern: string | null;
  ldapUserAttribute: string | null;
  ldapAllowedUsernames: string | null;
  emergencyAccountEnabled: boolean;
  emergencyUsername: string;
  emergencyAllowedIps: string | null;
}

export const authSettingsService = {
  /** Load the active singleton, lazily creating defaults. Null if the table is unavailable. */
  async getRecord() {
    try {
      const existing = await prisma.authSetting.findFirst({ where: { isActive: true }, orderBy: { updatedAt: "desc" } });
      if (existing) return existing;
      return await prisma.authSetting.create({ data: {} });
    } catch {
      // Pre-migration / unavailable — caller falls back to DEFAULTS.
      return null;
    }
  },

  /** Effective settings for the login route (bind password decrypted). */
  async getEffective(): Promise<EffectiveAuthSettings> {
    const record = await this.getRecord();
    if (!record) return { ...DEFAULTS, ldapBindPassword: null };
    return {
      loginMode: coerceLoginMode(record.loginMode),
      ldapEnabled: record.ldapEnabled,
      ldapHost: record.ldapHost,
      ldapPort: record.ldapPort,
      ldapUseSsl: record.ldapUseSsl,
      ldapBaseDn: record.ldapBaseDn,
      ldapBindDn: record.ldapBindDn,
      ldapBindPassword: decryptSecret(record.ldapBindPasswordEnc),
      ldapUserDnPattern: record.ldapUserDnPattern,
      ldapUserAttribute: record.ldapUserAttribute,
      ldapAllowedUsernames: record.ldapAllowedUsernames,
      emergencyAccountEnabled: record.emergencyAccountEnabled,
      emergencyUsername: record.emergencyUsername,
      emergencyAllowedIps: record.emergencyAllowedIps,
    };
  },

  /** Admin-facing projection (secret redacted to a boolean flag). */
  async getPublic() {
    const record = await this.getRecord();
    const base = record ?? DEFAULTS;
    return {
      loginMode: coerceLoginMode(base.loginMode),
      ldapEnabled: base.ldapEnabled,
      ldapHost: base.ldapHost ?? "",
      ldapPort: base.ldapPort ?? null,
      ldapUseSsl: base.ldapUseSsl,
      ldapBaseDn: base.ldapBaseDn ?? "",
      ldapBindDn: base.ldapBindDn ?? "",
      ldapBindPasswordSet: Boolean(record?.ldapBindPasswordEnc),
      ldapUserDnPattern: base.ldapUserDnPattern ?? "",
      ldapUserAttribute: base.ldapUserAttribute ?? "sAMAccountName",
      ldapAllowedUsernames: base.ldapAllowedUsernames ?? "",
      emergencyAccountEnabled: base.emergencyAccountEnabled,
      emergencyUsername: base.emergencyUsername,
      emergencyAllowedIps: base.emergencyAllowedIps ?? "",
    };
  },

  async save(input: Record<string, unknown>, userId?: string | null) {
    const record = await this.getRecord();
    const trimmed = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    const data = {
      loginMode: coerceLoginMode(input.loginMode),
      ldapEnabled: Boolean(input.ldapEnabled),
      ldapHost: trimmed(input.ldapHost),
      ldapPort: input.ldapPort ? Number(input.ldapPort) : null,
      ldapUseSsl: input.ldapUseSsl !== false,
      ldapBaseDn: trimmed(input.ldapBaseDn),
      ldapBindDn: trimmed(input.ldapBindDn),
      // Only rewrite the secret when a new one is supplied.
      ldapBindPasswordEnc: typeof input.ldapBindPassword === "string" && input.ldapBindPassword ? encryptSecret(input.ldapBindPassword) : undefined,
      ldapUserDnPattern: trimmed(input.ldapUserDnPattern),
      ldapUserAttribute: trimmed(input.ldapUserAttribute) ?? "sAMAccountName",
      ldapAllowedUsernames: trimmed(input.ldapAllowedUsernames),
      emergencyAccountEnabled: input.emergencyAccountEnabled !== false,
      emergencyUsername: trimmed(input.emergencyUsername) ?? "portal.superadmin",
      emergencyAllowedIps: trimmed(input.emergencyAllowedIps),
      updatedById: userId ?? null,
    };

    return record
      ? prisma.authSetting.update({ where: { id: record.id }, data })
      : prisma.authSetting.create({ data });
  },
};
