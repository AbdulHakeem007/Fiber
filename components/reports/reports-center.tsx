"use client";

import { useState } from "react";
import { Download, Loader2, Mail, RotateCcw, Search, Send, Tags } from "lucide-react";
import { activeInventoryFilterEntries, inventoryFiltersToParams, type InventoryFilters } from "@/lib/filters/inventory-filters";
import { CHILD_LINK_TAGS } from "@/lib/config/child-link-tags";
import { WEEKLY_REPORT_META } from "@/lib/reports/report-meta";
import { SuggestionInput } from "@/components/ui/suggestion-input";

const reports = [
  {
    title: "Tag-based ODF Mapping export",
    description: "Pick one or more service tags above (e.g. B2B) and export every ODF mapping carrying that tag across the entire network.",
    type: "odf-mappings-by-tag",
    href: "/api/export?type=odf-mappings-by-tag&format=xlsx",
    payload: { type: "odf-mappings-by-tag" },
  },
  {
    title: "Complete inventory export",
    description: "Consolidated ODF Mappings, Splitters, ODF Racks, and ODF IDs in one readable file.",
    type: "complete-inventory",
    href: "/api/export?type=complete-inventory&format=xlsx",
    payload: { type: "complete-inventory" },
  },
  {
    title: "Inventory export",
    description: "Near/far ODF, rack, port pair, cable, distance, and status.",
    type: "inventory",
    href: "/api/export?type=inventory&format=xlsx",
    payload: { type: "inventory" },
  },
  {
    title: "Service trace export",
    description: "Structured hop-by-hop service route for the Service ID entered above.",
    type: "trace",
    href: "/api/export?type=trace&format=xlsx",
    payload: { type: "trace" },
  },
  {
    title: "Cutover impact export",
    description: "Selected ODF port, cable, tube, fiber, service, and core-site impact.",
    type: "impact",
    href: "/api/export?type=impact&format=xlsx",
    payload: { type: "impact" },
  },
  {
    title: "Alert history export",
    description: "Severity, state, scope, timestamps, and alert messages.",
    type: "alerts",
    href: "/api/export?type=alerts&format=xlsx",
    payload: { type: "alerts" },
  },
  {
    title: "Import review export",
    description: "Parsed staging rows with source sheet, ODF, ports, and direction.",
    type: "import",
    href: "/api/export?type=import&format=xlsx",
    payload: { type: "import" },
  },
  {
    title: "ODF & rack export",
    description: "Physical ODF/rack port groups, dummy counts, and splitter output markers.",
    type: "odf-racks",
    href: "/api/export?type=odf-racks&format=xlsx",
    payload: { type: "odf-racks" },
  },
  {
    title: "Splitters export",
    description: "OSP/ISP splitter references and output branches.",
    type: "splitters",
    href: "/api/export?type=splitters&format=xlsx",
    payload: { type: "splitters" },
  },
  {
    title: "Site connectivity export",
    description: "Actual direct connected far ends for the selected site.",
    type: "site-connectivity",
    href: "/api/export?type=site-connectivity&format=xlsx",
    payload: { type: "site-connectivity" },
  },
];

type RecipientAliasOption = { code: string; name: string; members: Array<{ email: string }> };
type TemplateOption = { code: string; name: string; subject: string; body: string };

export function ReportsCenter({ recipientAliases = [], templates = [], canSendReports = false }: { recipientAliases?: RecipientAliasOption[]; templates?: TemplateOption[]; canSendReports?: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [sendingReportKey, setSendingReportKey] = useState<string | null>(null);
  const [filters, setFilters] = useState<InventoryFilters>({});
  const [appliedFilters, setAppliedFilters] = useState<InventoryFilters>({});
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const activeFilters = activeInventoryFilterEntries(appliedFilters);
  // Email-export modal state. emailDraft holds the pending export's identity; null = closed.
  const [emailDraft, setEmailDraft] = useState<{ type: string; serviceCode?: string } | null>(null);
  const [emailAliasCode, setEmailAliasCode] = useState("");
  const [emailTemplateCode, setEmailTemplateCode] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailRecipients, setEmailRecipients] = useState("");
  const [emailIncludeConfigured, setEmailIncludeConfigured] = useState(false);
  const [emailSending, setEmailSending] = useState(false);

  function toggleTag(tag: string) {
    setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  }

  function suggestionKind(key: keyof InventoryFilters): string {
    if (key === "site") return "sites";
    if (key === "connectedSite") return "connected-sites";
    if (key === "serviceId") return "services";
    if (key === "rackId") return "racks";
    if (key === "odfId") return "odfs";
    if (key === "portPair") return "ports";
    if (key === "transportTrail") return "transport-trails";
    if (key === "cableId") return "segments";
    return "sites";
  }

  function reportParams(report: { type: string; href: string }) {
    const params = new URLSearchParams(report.href.split("?")[1] ?? "");
    const filterParams = inventoryFiltersToParams(appliedFilters);
    filterParams.forEach((value, key) => params.set(key, value));
    if (selectedTags.length) params.set("tag", selectedTags.join(","));
    if (report.type === "odf-mappings-by-tag" && !selectedTags.length) {
      setMessage("Select at least one service tag (e.g. B2B) before exporting tag-filtered ODF Mappings.");
      return null;
    }
    if (report.type === "trace") {
      const service = String(appliedFilters.serviceId ?? "").trim();
      if (!service) {
        setMessage("Enter a Service ID before exporting a service trace.");
        return null;
      }
      params.set("service", service);
      params.delete("serviceId");
    }
    if (report.type === "impact" && activeFilters.length === 0) {
      setMessage("Select at least one impact filter before exporting impact analysis.");
      return null;
    }
    if (report.type === "site-connectivity" && !String(appliedFilters.site ?? "").trim()) {
      setMessage("Enter a Site before exporting site connectivity.");
      return null;
    }
    return params;
  }

  function openEmailModal(payload: { type: string; serviceCode?: string }) {
    const serviceCode = payload.type === "trace" ? String(appliedFilters.serviceId ?? "").trim() : payload.serviceCode;
    if (payload.type === "trace" && !serviceCode) {
      setMessage("Enter a Service ID before emailing a service trace.");
      return;
    }
    if (payload.type === "odf-mappings-by-tag" && !selectedTags.length) {
      setMessage("Select at least one service tag (e.g. B2B) before emailing tag-filtered ODF Mappings.");
      return;
    }
    if (payload.type === "impact" && activeFilters.length === 0) {
      setMessage("Select at least one impact filter before emailing impact analysis.");
      return;
    }
    if (payload.type === "site-connectivity" && !String(appliedFilters.site ?? "").trim()) {
      setMessage("Enter a Site before emailing site connectivity.");
      return;
    }
    setMessage(null);
    setEmailDraft({ type: payload.type, serviceCode });
  }

  function applyRecipientAlias(code: string) {
    setEmailAliasCode(code);
    const alias = recipientAliases.find((item) => item.code === code);
    if (!alias) return;
    // Merge the chosen recipient alias's addresses into the (still editable) field.
    const existing = emailRecipients.split(/[;,]/).map((value) => value.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...alias.members.map((member) => member.email)])];
    setEmailRecipients(merged.join(", "));
  }

  function applyTemplate(code: string) {
    setEmailTemplateCode(code);
    const template = templates.find((item) => item.code === code);
    if (template) {
      // The chosen template loads into the subject/body but stays fully editable.
      setEmailSubject(template.subject);
      setEmailBody(template.body);
    }
  }

  async function sendEmailExport() {
    if (!emailDraft) return;
    const recipients = emailRecipients.trim();
    if (!recipients) {
      setMessage("Enter at least one recipient email address.");
      return;
    }
    setEmailSending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/export/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: emailDraft.type,
          ...appliedFilters,
          ...(selectedTags.length ? { tag: selectedTags.join(",") } : {}),
          serviceCode: emailDraft.serviceCode,
          subject: emailSubject,
          body: emailBody,
          recipients,
          includeConfiguredRecipients: emailIncludeConfigured,
        }),
      });
      const result = await response.json();
      setMessage(response.ok ? result.message : result.error ?? "Email export failed.");
      if (response.ok) setEmailDraft(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Email export failed.");
    } finally {
      setEmailSending(false);
    }
  }

  async function sendWeeklyReport(reportKey: string) {
    setSendingReportKey(reportKey);
    setMessage(null);
    try {
      const response = await fetch("/api/reports/weekly/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportKey }),
      });
      const payload = await response.json();
      setMessage(response.ok ? payload.message : payload.error ?? "Report send failed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Report send failed.");
    } finally {
      setSendingReportKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">Reports and exports</div>
        <div className="subtle mt-1">Structured Excel outputs for telecom operations and data review.</div>
        {message ? <div className="mt-3 text-sm text-amber-700 dark:text-amber-200">{message}</div> : null}
        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[
            ["serviceId", "Service ID"],
            ["transportTrail", "Transport trail / path"],
            ["site", "Site"],
            ["connectedSite", "Connected site"],
            ["cableId", "Segment / cable"],
          ].map(([key, label]) => (
            <SuggestionInput
              key={key}
              kind={suggestionKind(key as keyof InventoryFilters)}
              className="input-dark"
              value={String(filters[key as keyof InventoryFilters] ?? "")}
              params={{
                site: key === "connectedSite" || key === "rackId" || key === "odfId" || key === "portPair" ? String(filters.site ?? "") : "",
                rack: key === "odfId" || key === "portPair" ? String(filters.rackId ?? "") : "",
                odf: key === "portPair" ? String(filters.odfId ?? "") : "",
              }}
              onChange={(nextValue) => setFilters({ ...filters, [key]: nextValue })}
              placeholder={label}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-200">
            <Tags className="h-3.5 w-3.5" />
            Service tag filter (ODF Mapping):
          </span>
          {CHILD_LINK_TAGS.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`rounded-full border px-3 py-1 font-semibold transition ${selectedTags.includes(tag)
                ? "border-red-400 bg-red-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:border-red-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"}`}
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
          {selectedTags.length ? (
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" onClick={() => setSelectedTags([])}>
              Clear tags
            </button>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => { setAppliedFilters(filters); setMessage("Filters applied."); }}>
            <Search className="h-4 w-4" />
            Search / Apply Filters
          </button>
          <button className="btn btn-ghost" onClick={() => { setFilters({}); setAppliedFilters({}); setMessage("Filters cleared."); }}>
            <RotateCcw className="h-4 w-4" />
            Clear Filters
          </button>
          <button className="btn btn-ghost" onClick={() => {
            const params = new URLSearchParams({ type: "inventory", format: "xlsx" });
            inventoryFiltersToParams(appliedFilters).forEach((value, key) => params.set(key, value));
            window.location.href = `/api/export?${params.toString()}`;
          }}>
            <Download className="h-4 w-4" />
            Export Current Result
          </button>
          <button className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/50 bg-[#1d3a30] px-4 py-2 text-sm font-semibold text-emerald-50 dark:bg-emerald-500/15" onClick={() => {
            const params = new URLSearchParams({ type: "complete-inventory", format: "xlsx" });
            inventoryFiltersToParams(appliedFilters).forEach((value, key) => params.set(key, value));
            window.location.href = `/api/export?${params.toString()}`;
          }}>
            <Download className="h-4 w-4" />
            Export Complete Inventory
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
          <span>Export filters:</span>
          {activeFilters.length ? activeFilters.map(([key, value]) => <span key={key} className="rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1 text-red-100">{key}: {value}</span>) : <span className="text-slate-500">none</span>}
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {reports.map((report) => (
            <div
              key={report.title}
              className="rounded-lg border border-border bg-white/5 p-5 text-left transition hover:border-red-400/50 hover:bg-red-500/10"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]">
                <Download className="h-4 w-4 text-red-600 dark:text-red-200" />
                {report.title}
              </div>
              <div className="mt-3 text-sm text-slate-400">{report.description}</div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-3 py-2 text-xs font-semibold text-white" onClick={() => {
                  const params = reportParams(report);
                  if (!params) return;
                  window.location.href = `/api/export?${params.toString()}`;
                }}>
                  <Download className="h-3 w-3" />
                  Download
                </button>
                <button className="inline-flex items-center gap-2 rounded-lg border border-border bg-white/5 px-3 py-2 text-xs" onClick={() => openEmailModal(report.payload)}>
                  <Mail className="h-3 w-3" />
                  Email
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {canSendReports ? (
        <div className="card p-5">
          <div className="section-title">Weekly alert reports</div>
          <div className="subtle mt-1">Send any weekly alert report now to its configured recipients. Body carries a summary table; full detail and a graphical view are attached as an Excel workbook. Recurring schedules are managed under Admin → Notifications.</div>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {WEEKLY_REPORT_META.map((report) => (
              <div key={report.reportKey} className="rounded-lg border border-border bg-white/5 p-5 text-left">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]">
                  <Send className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                  {report.name}
                </div>
                <div className="mt-3 text-sm text-slate-400">{report.description}</div>
                <button
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={sendingReportKey === report.reportKey}
                  onClick={() => sendWeeklyReport(report.reportKey)}
                >
                  {sendingReportKey === report.reportKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Send now
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {emailDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-6 text-[var(--text-main)] shadow-2xl">
            <div className="section-title">Email export — {emailDraft.type}</div>
            <div className="subtle mt-1">Choose a sender alias and a predefined template, edit the message freely, then enter recipients.</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-sm font-medium text-[var(--text-strong)]">
                Recipient alias
                <select className="input-dark mt-1 w-full" value={emailAliasCode} onChange={(event) => applyRecipientAlias(event.target.value)}>
                  <option value="">— Select a recipient alias —</option>
                  {recipientAliases.map((alias) => (
                    <option key={alias.code} value={alias.code}>
                      {alias.name} ({alias.members.length})
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-[var(--text-strong)]">
                Predefined template
                <select className="input-dark mt-1 w-full" value={emailTemplateCode} onChange={(event) => applyTemplate(event.target.value)}>
                  <option value="">— Select a template —</option>
                  {templates.map((template) => <option key={template.code} value={template.code}>{template.name}</option>)}
                </select>
              </label>
            </div>
            <label className="mt-3 block text-sm font-medium text-[var(--text-strong)]">
              Subject
              <input className="input-dark mt-1 w-full" value={emailSubject} onChange={(event) => setEmailSubject(event.target.value)} placeholder="Email subject" />
            </label>
            <label className="mt-3 block text-sm font-medium text-[var(--text-strong)]">
              Message body (the selected template loads here and stays fully editable)
              <textarea className="input-dark mt-1 min-h-44 w-full" value={emailBody} onChange={(event) => setEmailBody(event.target.value)} placeholder="Append any extra information for the recipients here." />
            </label>
            <label className="mt-3 block text-sm font-medium text-[var(--text-strong)]">
              Recipient email addresses
              <input className="input-dark mt-1 w-full" value={emailRecipients} onChange={(event) => setEmailRecipients(event.target.value)} placeholder="comma or semicolon separated addresses" />
            </label>
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={emailIncludeConfigured} onChange={(event) => setEmailIncludeConfigured(event.target.checked)} />
              Also send to configured portal recipients
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setEmailDraft(null)} disabled={emailSending}>Cancel</button>
              <button className="btn btn-primary" onClick={sendEmailExport} disabled={emailSending}>
                <Mail className="h-4 w-4" />
                {emailSending ? "Sending…" : "Send export email"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
