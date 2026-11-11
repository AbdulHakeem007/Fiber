"use client";

import { useMemo, useState } from "react";
import { ImageIcon, Loader2, Mail, Paperclip, Send, X } from "lucide-react";
import { svgToPngDataUrl } from "@/lib/canvas/canvas-raster";

// ─────────────────────────────────────────────────────────────────────────────
// DETAILED TRACE — "Email Report" module.
//
// An interactive email-delivery panel for the Detailed Trace results. It emails
// the generated deployment-instructions text and, optionally, embeds a
// high-quality graphical snapshot of the LIVE topology canvas alongside it
// (rasterized on send, sanitized of on-screen navigation dots via
// svgToPngDataUrl). Additive: it wraps the existing email/export backend and
// does not modify the Detailed Trace, canvas, or trace-core logic.
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceEmailReportProps {
  /** Pre-generated deployment-instructions text for the current detailed trace. */
  reportText: string;
  /** Default subject line (operator-editable in the form). */
  subjectDefault: string;
  /** Returns the live topology canvas SVG to snapshot, or null when none shown. */
  getCanvasSvg: () => SVGSVGElement | null;
  /** Service code for the optional attached trace data sheet. */
  serviceCode?: string | null;
  /** Transport trail (e.g. "SITE-A -> SITE-B") for a trace-path data sheet. */
  trail?: string | null;
  /** Sites tagged RED on the canvas — carried through to the sheet's fault fill. */
  redSites?: string[];
  /** True while another action is running; disables the trigger. */
  disabled?: boolean;
}

type SendState = { tone: "ok" | "error" | "info"; text: string } | null;

export function TraceEmailReport({
  reportText,
  subjectDefault,
  getCanvasSvg,
  serviceCode,
  trail,
  redSites,
  disabled,
}: TraceEmailReportProps) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(subjectDefault);
  const [body, setBody] = useState(reportText);
  const [includeSnapshot, setIncludeSnapshot] = useState(true);
  const [includeSheet, setIncludeSheet] = useState(Boolean(serviceCode || trail));
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState<SendState>(null);

  const canAttachSheet = useMemo(() => Boolean(serviceCode || trail), [serviceCode, trail]);

  // Re-seed the editable fields from the current trace whenever the panel opens,
  // so a freshly-run Detailed Trace populates a clean, up-to-date report.
  function openPanel() {
    setSubject(subjectDefault);
    setBody(reportText);
    setIncludeSheet(canAttachSheet);
    setStatus(null);
    setOpen(true);
  }

  async function send() {
    if (!to.trim()) {
      setStatus({ tone: "error", text: "Enter at least one TO recipient." });
      return;
    }
    setIsSending(true);
    setStatus({ tone: "info", text: "Sending report…" });
    try {
      let canvasImage: string | null = null;
      if (includeSnapshot) {
        const svg = getCanvasSvg();
        canvasImage = svg ? await svgToPngDataUrl(svg) : null;
        if (!canvasImage) {
          setStatus({ tone: "info", text: "No canvas is on screen — sending the text report without a snapshot." });
        }
      }
      const response = await fetch("/api/service-trace/trace-report-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          cc,
          subject,
          body,
          canvasImage,
          includeSheet,
          serviceCode: serviceCode ?? null,
          trail: trail ?? null,
          redSites: redSites ?? [],
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to send the trace report.");
      setStatus({ tone: "ok", text: payload.message ?? "Trace report sent." });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Failed to send the trace report." });
    } finally {
      setIsSending(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost"
        onClick={openPanel}
        disabled={disabled}
        title="Email this trace as deployment instructions, optionally with a canvas snapshot"
      >
        <Mail className="h-4 w-4" /> Email Report
      </button>
    );
  }

  const statusColor =
    status?.tone === "error"
      ? "text-red-500"
      : status?.tone === "ok"
        ? "text-emerald-500"
        : "text-slate-500 dark:text-slate-400";

  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Mail className="h-4 w-4 text-cyan-400" />
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Email Report</div>
        <button
          type="button"
          className="ml-auto rounded-lg p-1 text-slate-400 hover:bg-black/5 hover:text-slate-600 dark:hover:bg-white/5"
          onClick={() => setOpen(false)}
          aria-label="Close email report"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <input className="input-dark" value={to} onChange={(e) => setTo(e.target.value)} placeholder="TO (comma separated) *" />
        <input className="input-dark" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="CC (comma separated)" />
      </div>
      <input className="input-dark mt-3 w-full" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
      <textarea
        className="input-dark mt-3 h-40 w-full resize-y font-mono text-xs leading-relaxed"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Deployment instructions text"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="inline-flex cursor-pointer items-center gap-2 text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={includeSnapshot} onChange={(e) => setIncludeSnapshot(e.target.checked)} />
          <ImageIcon className="h-4 w-4 text-cyan-400" /> Embed high-quality canvas snapshot
        </label>
        <label
          className={`inline-flex items-center gap-2 ${canAttachSheet ? "cursor-pointer text-slate-600 dark:text-slate-300" : "cursor-not-allowed text-slate-400"}`}
          title={canAttachSheet ? "" : "Run a service trace to attach its data sheet"}
        >
          <input type="checkbox" checked={includeSheet && canAttachSheet} disabled={!canAttachSheet} onChange={(e) => setIncludeSheet(e.target.checked)} />
          <Paperclip className="h-4 w-4 text-cyan-400" /> Attach trace data sheet (Excel)
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 hover:bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors disabled:opacity-50"
          onClick={send}
          disabled={isSending}
        >
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send Report
        </button>
        {status ? <span className={`text-xs font-medium ${statusColor}`}>{status.text}</span> : null}
      </div>
    </div>
  );
}
