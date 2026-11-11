"use client";

import { useState } from "react";
import { Pause, Power, PowerOff, Save, Trash2, XCircle } from "lucide-react";
import { useToast } from "@/components/ui/toast";

interface PolicyRow {
  id: string;
  name: string;
  alertType: string;
  enabled: boolean;
  warningThresholdPct?: number | null;
  criticalThresholdPct?: number | null;
  cooldownMinutes: number;
  consecutiveHits: number;
  notifyEmails?: string | null;
}

export function AlertPolicyEditor({ rows }: { rows: PolicyRow[] }) {
  const [policies, setPolicies] = useState(rows);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();

  async function save(policy: PolicyRow) {
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/alert-policies/${policy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      });
      const payload = await response.json();
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Policy update failed.");
      setPolicies((current) => current.map((row) => (row.id === policy.id ? { ...row, ...payload.policy } : row)));
      setMessage("Alert policy saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy update failed.");
    }
  }

  async function toggleEnabled(policy: PolicyRow) {
    const next = !policy.enabled;
    // Optimistic flip so the master toggle feels instant.
    setPolicies((current) => current.map((row) => (row.id === policy.id ? { ...row, enabled: next } : row)));
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/alert-policies/${policy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Toggle failed.");
      setPolicies((current) => current.map((row) => (row.id === policy.id ? { ...row, ...payload.policy } : row)));
      setMessage(next ? `“${policy.name}” enabled.` : `“${policy.name}” disabled — alerts are now suspended until re-enabled.`);
    } catch (error) {
      // Revert on failure.
      setPolicies((current) => current.map((row) => (row.id === policy.id ? { ...row, enabled: !next } : row)));
      setMessage(error instanceof Error ? error.message : "Toggle failed.");
    }
  }

  async function policyAction(policy: PolicyRow, action: string, extra: Record<string, unknown> = {}) {
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/alert-policies/${policy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Policy action failed.");
      if (payload.deletedId) {
        setPolicies((current) => current.filter((row) => row.id !== policy.id));
        toast.deleted(`Alert policy “${policy.name}”`);
      } else if (payload.policy) setPolicies((current) => current.map((row) => row.id === policy.id ? { ...row, ...payload.policy } : row));
      setMessage(payload.message ?? "Alert policy updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy action failed.");
    }
  }

  return (
    <div className="card p-5">
      <div className="section-title">Alert policies</div>
      <div className="subtle mt-1">Monitor utilization, degraded routes, fully consumed spans, and stale/decommissioned inventory dependencies.</div>
      {message ? <div className="mt-3 text-sm text-cyan-700 dark:text-cyan-200">{message}</div> : null}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {[
          ["Capacity", "Warn when available ports/fibers fall below threshold or a span reaches 100% active usage."],
          ["Topology", "Detect single-homed rings, spur, spur chains and inactive links."],
          ["Data hygiene", "Flag stale ATP/splitter references, decommissioned links still carrying services, and unresolved import issues."],
        ].map(([title, text]) => (
          <div key={title} className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="text-sm font-bold text-slate-950 dark:text-white">{title}</div>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{text}</p>
          </div>
        ))}
      </div>
      <div className="mt-5 space-y-3">
        {policies.map((policy) => (
          <div key={policy.id} className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="grid gap-3 md:grid-cols-6">
              <div className="md:col-span-2">
                <div className="text-sm font-semibold text-[var(--text-strong)]">{policy.name}</div>
                <div className="mt-0.5 text-xs font-normal text-slate-400">{policy.alertType}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${policy.enabled
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                    : "bg-amber-500/15 text-amber-700 dark:text-amber-200"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${policy.enabled ? "bg-emerald-500" : "bg-amber-500"}`} />
                    {policy.enabled ? "Active" : "Suspended"}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleEnabled(policy)}
                    aria-pressed={!policy.enabled}
                    title={policy.enabled ? "Suspend this alert policy — alerts stop until resumed" : "Resume this alert policy"}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${policy.enabled
                      ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                      : "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"}`}
                  >
                    {policy.enabled ? <><PowerOff className="h-3.5 w-3.5" /> Suspend</> : <><Power className="h-3.5 w-3.5" /> Resume</>}
                  </button>
                </div>
              </div>
              <input className="input-dark" value={policy.warningThresholdPct ?? ""} placeholder="Warning %" onChange={(event) => setPolicies((current) => current.map((row) => row.id === policy.id ? { ...row, warningThresholdPct: event.target.value ? Number(event.target.value) : null } : row))} />
              <input className="input-dark" value={policy.criticalThresholdPct ?? ""} placeholder="Critical %" onChange={(event) => setPolicies((current) => current.map((row) => row.id === policy.id ? { ...row, criticalThresholdPct: event.target.value ? Number(event.target.value) : null } : row))} />
              <input className="input-dark" value={policy.cooldownMinutes} placeholder="Cooldown" onChange={(event) => setPolicies((current) => current.map((row) => row.id === policy.id ? { ...row, cooldownMinutes: Number(event.target.value) } : row))} />
              <button className="inline-flex items-center justify-center gap-2 rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950" onClick={() => save(policy)}>
                <Save className="h-4 w-4" />
                Save
              </button>
              <input className="input-dark md:col-span-6" value={policy.notifyEmails ?? ""} placeholder="Notification emails" onChange={(event) => setPolicies((current) => current.map((row) => row.id === policy.id ? { ...row, notifyEmails: event.target.value } : row))} />
              <div className="flex flex-wrap gap-2 md:col-span-6">
                <button className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" onClick={() => policyAction(policy, "pause", { pauseMinutes: 60 })}>
                  <Pause className="h-3 w-3" />
                  Pause 1h
                </button>
                <button className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200" onClick={() => policyAction(policy, "clearSuppressions")}>
                  <XCircle className="h-3 w-3" />
                  Clear suppressions
                </button>
                <button className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200" onClick={() => policyAction(policy, "delete")}>
                  <Trash2 className="h-3 w-3" />
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
