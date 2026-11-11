"use client";

import { useState } from "react";
import { KeyRound, Save, ShieldAlert } from "lucide-react";

export interface AuthSettingsView {
  loginMode: "LOCAL_ONLY" | "LDAP_ONLY" | "LOCAL_AND_LDAP";
  ldapEnabled: boolean;
  ldapHost: string;
  ldapPort: number | null;
  ldapUseSsl: boolean;
  ldapBaseDn: string;
  ldapBindDn: string;
  ldapBindPasswordSet: boolean;
  ldapUserDnPattern: string;
  ldapUserAttribute: string;
  ldapAllowedUsernames: string;
  emergencyAccountEnabled: boolean;
  emergencyUsername: string;
  emergencyAllowedIps: string;
}

const LOGIN_MODE_HELP: Record<AuthSettingsView["loginMode"], string> = {
  LOCAL_ONLY: "Only portal-created database users can log in.",
  LDAP_ONLY: "Only company domain users authenticated via the LDAP server can log in.",
  LOCAL_AND_LDAP: "Both portal users and LDAP domain users may log in simultaneously.",
};

export function AuthSettingsPanel({ initial }: { initial: AuthSettingsView }) {
  const [form, setForm] = useState({ ...initial, ldapBindPassword: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ldapRelevant = form.loginMode !== "LOCAL_ONLY";

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/auth-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Save failed.");
      setForm((current) => ({ ...current, ...payload.settings, ldapBindPassword: "" }));
      setMessage("Authentication settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">Login mode</div>
        <div className="subtle mt-1">Choose how the portal authenticates users globally.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-xs uppercase tracking-[0.14em] text-slate-500">
            Login Mode
            <select
              className="input-dark mt-2 w-full normal-case tracking-normal"
              value={form.loginMode}
              onChange={(event) => update("loginMode", event.target.value as AuthSettingsView["loginMode"])}
            >
              <option value="LOCAL_ONLY">Local only</option>
              <option value="LDAP_ONLY">LDAP only</option>
              <option value="LOCAL_AND_LDAP">Local + LDAP</option>
            </select>
          </label>
          <div className="self-end rounded-lg border border-[var(--border)] p-3 text-sm" style={{ background: "var(--surface)", color: "var(--muted-text)" }}>
            {LOGIN_MODE_HELP[form.loginMode]}
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" style={{ color: "var(--accent-text)" }} />
          <div className="section-title">LDAP / Domain Controller</div>
        </div>
        <div className="subtle mt-1">Connection used to authenticate domain (LDAP) users. {ldapRelevant ? "" : "Not used while Login Mode is Local only."}</div>
        <label className="mt-4 flex items-center gap-2 text-sm" style={{ color: "var(--text-main)" }}>
          <input type="checkbox" checked={form.ldapEnabled} onChange={(event) => update("ldapEnabled", event.target.checked)} />
          Enable LDAP connection
        </label>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <input className="input-dark" placeholder="LDAP host (e.g. dc01.corp.local)" value={form.ldapHost} onChange={(event) => update("ldapHost", event.target.value)} />
          <input className="input-dark" placeholder="Port (e.g. 636)" inputMode="numeric" value={form.ldapPort ?? ""} onChange={(event) => update("ldapPort", event.target.value ? Number(event.target.value) : null)} />
          <input className="input-dark" placeholder="Base DN (dc=corp,dc=local)" value={form.ldapBaseDn} onChange={(event) => update("ldapBaseDn", event.target.value)} />
          <input className="input-dark" placeholder="Bind DN (service account)" value={form.ldapBindDn} onChange={(event) => update("ldapBindDn", event.target.value)} />
          <input className="input-dark" type="password" placeholder={form.ldapBindPasswordSet ? "Bind password (configured — leave blank to keep)" : "Bind password"} value={form.ldapBindPassword} onChange={(event) => update("ldapBindPassword", event.target.value)} />
          <input className="input-dark" placeholder="User attribute (sAMAccountName)" value={form.ldapUserAttribute} onChange={(event) => update("ldapUserAttribute", event.target.value)} />
          <input className="input-dark md:col-span-2" placeholder="User DN pattern (uid={username},ou=people,dc=corp,dc=local)" value={form.ldapUserDnPattern} onChange={(event) => update("ldapUserDnPattern", event.target.value)} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm" style={{ color: "var(--text-main)" }}>
          <input type="checkbox" checked={form.ldapUseSsl} onChange={(event) => update("ldapUseSsl", event.target.checked)} />
          Use SSL/TLS (LDAPS)
        </label>
        <div className="mt-4">
          <div className="text-xs uppercase tracking-[0.14em]" style={{ color: "var(--muted-text)" }}>LDAP access allow-list (usernames)</div>
          <textarea
            className="input-dark mt-2 w-full"
            rows={3}
            placeholder="kamran.lashari, ali.khan  (comma or newline separated)"
            value={form.ldapAllowedUsernames}
            onChange={(event) => update("ldapAllowedUsernames", event.target.value)}
          />
          <div className="subtle mt-1">Only these domain usernames may log in via LDAP — denied even if they exist in the directory. Leave blank for no restriction. The emergency account is governed separately by its IP allow-list below.</div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" style={{ color: "var(--accent-text)" }} />
          <div className="section-title">Emergency local account (fail-safe)</div>
        </div>
        <div className="subtle mt-1">
          If the LDAP/Domain Controller is down, this <strong>Local</strong> account can still authenticate for maintenance — even under LDAP-only mode. It is restricted strictly to the server/admin IP allowlist below (loopback is always permitted).
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm" style={{ color: "var(--text-main)" }}>
          <input type="checkbox" checked={form.emergencyAccountEnabled} onChange={(event) => update("emergencyAccountEnabled", event.target.checked)} />
          Enable emergency account
        </label>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <input className="input-dark" placeholder="Emergency username" value={form.emergencyUsername} onChange={(event) => update("emergencyUsername", event.target.value)} />
          <input className="input-dark" placeholder="Allowed IPs / CIDRs (comma separated)" value={form.emergencyAllowedIps} onChange={(event) => update("emergencyAllowedIps", event.target.value)} />
        </div>
      </div>

      {message ? <div className="rounded-lg border border-[var(--border)] px-4 py-3 text-sm" style={{ background: "var(--surface)", color: "var(--text-main)" }}>{message}</div> : null}

      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          <Save className="h-4 w-4" />
          {busy ? "Saving…" : "Save authentication settings"}
        </button>
      </div>
    </div>
  );
}
