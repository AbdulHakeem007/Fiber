"use client";

import { useState } from "react";
import { Loader2, Mail, Plus, Save, Send, Trash2, X } from "lucide-react";
import { reportMeta } from "@/lib/reports/report-meta";

export type WeeklyScheduleRow = {
  reportKey: string;
  name: string;
  enabled: boolean;
  dayOfWeek: number;
  sendHour: number;
  sendMinute: number;
  warnThresholdPct: number | null;
  critThresholdPct: number | null;
  minNodes: number | null;
  recipients: string | null;
  recipientGroupCode: string | null;
  includeConfigured: boolean;
  emailSubject: string | null;
  emailBody: string | null;
  lastSentAt: string | null;
  lastStatus: string | null;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function parseEmails(value: string | null): string[] {
  return String(value ?? "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinEmails(list: string[]): string {
  return list.join("; ");
}

const DEFAULT_SUBJECT = "Fiber network statistics";
const DEFAULT_BODY =
  "Dear All, Please find below the high-level statistics of the fiber network. " +
  "For further details, kindly review the attached workbook.";

export function WeeklyReportsSettings({
  schedules,
  recipientGroups,
  canSend,
}: {
  schedules: WeeklyScheduleRow[];
  recipientGroups: Array<{ code: string; name: string }>;
  canSend: boolean;
}) {
  // The component only receives the MEGA_ALERT schedule (filtered by the page).
  const initial = schedules[0] ?? null;

  const [row, setRow] = useState<WeeklyScheduleRow>(
    initial ?? {
      reportKey: "MEGA_ALERT",
      name: "Fiber Network Statistics",
      enabled: false,
      dayOfWeek: 1,
      sendHour: 7,
      sendMinute: 0,
      warnThresholdPct: 80,
      critThresholdPct: 95,
      minNodes: 8,
      recipients: null,
      recipientGroupCode: null,
      includeConfigured: false,
      emailSubject: null,
      emailBody: null,
      lastSentAt: null,
      lastStatus: null,
    },
  );

  // Inline recipient list management
  const [emailList, setEmailList] = useState<string[]>(parseEmails(row.recipients));
  const [newEmail, setNewEmail] = useState("");

  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<"ok" | "err">("ok");

  function patch(changes: Partial<WeeklyScheduleRow>) {
    setRow((prev) => ({ ...prev, ...changes }));
  }

  function addEmail() {
    const email = newEmail.trim().toLowerCase();
    if (!email || emailList.includes(email)) return;
    const updated = [...emailList, email];
    setEmailList(updated);
    patch({ recipients: joinEmails(updated) });
    setNewEmail("");
  }

  function removeEmail(email: string) {
    const updated = emailList.filter((e) => e !== email);
    setEmailList(updated);
    patch({ recipients: joinEmails(updated) });
  }

  function handleEmailInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addEmail();
    }
  }

  // Persist the current form state (recipients, group, thresholds, template copy)
  // to the database. Returns the saved row, or throws on failure. Shared by both
  // "Save schedule" and "Send now" — the latter must persist before sending so the
  // server-side resolveRecipients() can see the addresses just entered.
  async function persist(): Promise<WeeklyScheduleRow> {
    // Fold any half-typed address in the "add email" box into the list so it is
    // never silently dropped on save/send.
    const pending = newEmail.trim().toLowerCase();
    const mergedEmails = pending && !emailList.includes(pending) ? [...emailList, pending] : emailList;
    if (pending) {
      setEmailList(mergedEmails);
      setNewEmail("");
    }
    const toSave: WeeklyScheduleRow = { ...row, recipients: joinEmails(mergedEmails) };

    const response = await fetch("/api/admin/weekly-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toSave),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Save failed.");
    const saved = (payload.schedule as WeeklyScheduleRow) ?? toSave;
    setRow(saved);
    setEmailList(parseEmails(saved.recipients));
    return saved;
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await persist();
      setMsgTone("ok");
      setMessage("Mega Alert schedule saved.");
    } catch (error) {
      setMsgTone("err");
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function sendNow() {
    setSending(true);
    setMessage(null);
    try {
      // Persist first so the recipients/group/thresholds/template copy just entered
      // are written to the DB. The send endpoint then resolves recipients from the
      // saved row — inline addresses, the group alias, and "configured portal
      // recipients" are all honoured together (no explicit override).
      const saved = await persist();
      const response = await fetch("/api/reports/weekly/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportKey: saved.reportKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Send failed.");
      setMsgTone(payload.status === "SENT" ? "ok" : "err");
      setMessage(payload.message ?? "Report sent.");
      if (payload.status === "SENT") {
        patch({ lastSentAt: new Date().toISOString(), lastStatus: "SENT" });
      }
    } catch (error) {
      setMsgTone("err");
      setMessage(error instanceof Error ? error.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  const meta = reportMeta(row.reportKey);

  return (
    <section className="card p-5">
      <div className="section-title">Mega Alert — Unified Weekly Network Digest</div>
      <div className="subtle mt-1">
        A single weekly email bundling three sub-reports: <strong>Highly Utilised Links</strong>,{" "}
        <strong>Network Vulnerabilities</strong>, and <strong>PtP links between core sites</strong>. The
        email contains inline bar charts; full detail rows are in the three-tab Excel attachment.
      </div>

      {message ? (
        <div
          className={`mt-3 rounded-xl border px-4 py-2 text-sm ${
            msgTone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200"
          }`}
        >
          {message}
        </div>
      ) : null}

      <div className="mt-5 rounded-2xl border border-border bg-white/5 p-5 space-y-6">

        {/* ── enable + last sent ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={row.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <div className="text-[11px] text-slate-500">
            {row.lastSentAt
              ? `Last sent ${new Date(row.lastSentAt).toLocaleString()} · ${row.lastStatus ?? ""}`
              : "Not sent yet"}
          </div>
        </div>

        {/* ── cron scheduler ── */}
        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Schedule
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-xs font-medium text-slate-500">
              Day of week
              <select
                className="input-dark mt-1 w-full"
                value={row.dayOfWeek}
                onChange={(e) => patch({ dayOfWeek: Number(e.target.value) })}
              >
                {DAYS.map((day, i) => (
                  <option key={day} value={i}>{day}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-500">
              Hour (0–23)
              <input
                type="number"
                min={0}
                max={23}
                className="input-dark mt-1 w-full"
                value={row.sendHour}
                onChange={(e) => patch({ sendHour: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs font-medium text-slate-500">
              Minute (0–59)
              <input
                type="number"
                min={0}
                max={59}
                className="input-dark mt-1 w-full"
                value={row.sendMinute}
                onChange={(e) => patch({ sendMinute: Number(e.target.value) })}
              />
            </label>
            <div className="text-xs font-medium text-slate-500">
              Send time
              <div className="input-dark mt-1 w-full bg-transparent font-mono">
                {DAYS[row.dayOfWeek]} {pad2(row.sendHour)}:{pad2(row.sendMinute)}
              </div>
            </div>
          </div>
        </div>

        {/* ── threshold configuration ── */}
        {meta?.usesThreshold ? (
          <div>
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Link Utilisation Thresholds
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs font-medium text-slate-500">
                Highly utilised links %
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="input-dark w-full"
                    value={row.warnThresholdPct ?? ""}
                    placeholder="80"
                    onChange={(e) =>
                      patch({ warnThresholdPct: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                  <span className="text-slate-400">%</span>
                </div>
                <div className="mt-1 text-[10px] text-amber-500">Warning threshold</div>
              </label>
              <label className="text-xs font-medium text-slate-500">
                Critically utilised links %
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="input-dark w-full"
                    value={row.critThresholdPct ?? ""}
                    placeholder="95"
                    onChange={(e) =>
                      patch({ critThresholdPct: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                  <span className="text-slate-400">%</span>
                </div>
                <div className="mt-1 text-[10px] text-rose-500">Critical threshold</div>
              </label>
              {meta.usesMinNodes ? (
                <label className="text-xs font-medium text-slate-500">
                  A-MPLS ring node threshold (&gt;)
                  <input
                    type="number"
                    min={0}
                    className="input-dark mt-1 w-full"
                    value={row.minNodes ?? ""}
                    placeholder="8"
                    onChange={(e) =>
                      patch({ minNodes: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                  <div className="mt-1 text-[10px] text-slate-400">Flags rings above this node count</div>
                </label>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── email template copy editor ── */}
        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Email Template
          </div>
          <div className="space-y-3">
            <label className="block text-xs font-medium text-slate-500">
              Subject line
              <input
                className="input-dark mt-1 w-full"
                value={row.emailSubject ?? ""}
                placeholder={DEFAULT_SUBJECT}
                onChange={(e) => patch({ emailSubject: e.target.value || null })}
              />
            </label>
            <label className="block text-xs font-medium text-slate-500">
              Email body greeting
              <textarea
                className="input-dark mt-1 min-h-24 w-full"
                value={row.emailBody ?? ""}
                placeholder={DEFAULT_BODY}
                onChange={(e) => patch({ emailBody: e.target.value || null })}
              />
              <div className="mt-1 text-[10px] text-slate-400">
                Appears above the inline charts. Leave blank to use the default greeting.
              </div>
            </label>
          </div>
        </div>

        {/* ── recipient management ── */}
        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recipient Routing
          </div>

          {/* Inline email list */}
          <div className="mb-3">
            <div className="text-xs font-medium text-slate-500 mb-2">
              Email addresses
            </div>
            {emailList.length > 0 ? (
              <div className="flex flex-wrap gap-2 mb-3">
                {emailList.map((email) => (
                  <span
                    key={email}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-white/10 px-3 py-1 text-xs text-[var(--text-strong)]"
                  >
                    <Mail className="h-3 w-3 text-slate-400" />
                    {email}
                    <button
                      type="button"
                      className="ml-1 text-slate-400 hover:text-rose-400"
                      onClick={() => removeEmail(email)}
                      aria-label={`Remove ${email}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="mb-3 text-xs text-slate-500 italic">No recipient addresses configured.</div>
            )}
            <div className="flex gap-2">
              <input
                type="email"
                className="input-dark flex-1"
                placeholder="name@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={handleEmailInputKey}
              />
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-white/5 px-3 py-2 text-xs font-semibold text-[var(--text-strong)] hover:bg-white/10"
                onClick={addEmail}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
            <div className="mt-1 text-[10px] text-slate-400">
              Press Enter or comma to add. Click × to remove.
            </div>
          </div>

          {/* Recipient alias group */}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs font-medium text-slate-500">
              Recipient alias (group)
              <select
                className="input-dark mt-1 w-full"
                value={row.recipientGroupCode ?? ""}
                onChange={(e) => patch({ recipientGroupCode: e.target.value || null })}
              >
                <option value="">— none —</option>
                {recipientGroups.map((group) => (
                  <option key={group.code} value={group.code}>{group.name}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={row.includeConfigured}
                  onChange={(e) => patch({ includeConfigured: e.target.checked })}
                />
                Also send to configured portal recipients
              </label>
            </div>
          </div>
        </div>

        {/* ── action buttons ── */}
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            disabled={saving}
            onClick={save}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save schedule
          </button>
          {canSend ? (
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/50 bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              disabled={sending}
              onClick={sendNow}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send now
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
