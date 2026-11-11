"use client";

import { useState } from "react";
import { Save, Send, Trash2 } from "lucide-react";

type SmtpRow = {
  host?: string | null;
  port?: number | null;
  username?: string | null;
  senderName?: string | null;
  senderEmail?: string | null;
  replyTo?: string | null;
  encryptionType?: string | null;
  lastTestAt?: string | Date | null;
  lastTestStatus?: string | null;
};

type TemplateRow = {
  code: string;
  name: string;
  channel: string;
  subject: string;
  body: string;
  isActive: boolean;
};

type RecipientGroupRow = {
  code: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  members: Array<{ email: string; displayName?: string | null }>;
};

// Parallel Trace-Route deployment template — separate from the Excel-export
// NotificationTemplate set, with first-class TO / CC / body fields.
type DeploymentTemplateRow = {
  code: string;
  name: string;
  module?: string | null;
  toAlias?: string | null;
  ccAlias?: string | null;
  subject: string;
  body: string;
  signature?: string | null;
  attachTraceSheet?: boolean;
  inlineCanvas?: boolean;
  canvasMaxWidthPx?: number;
  isActive: boolean;
};

const NEW_DEPLOYMENT_TEMPLATE: DeploymentTemplateRow = {
  code: "DEPLOYMENT_INSTRUCTIONS",
  name: "Deployment instructions",
  module: "TRACE_ROUTE",
  toAlias: "",
  ccAlias: "",
  subject: 'ATN integration for site "{{site_code}}"',
  body: "Please find the attached ODF port plan and topology for site {{site_code}}, proceed for integration.",
  signature: "—\n{{sender_name}}\n{{sender_team}}\n{{sender_contact}}",
  attachTraceSheet: true,
  inlineCanvas: true,
  canvasMaxWidthPx: 600,
  isActive: true,
};

const NEW_TEMPLATE: TemplateRow = {
  code: "",
  name: "",
  channel: "EMAIL",
  subject: "[{{severity}}] {{alert_name}} - {{site_pair}}",
  body: "Alert {{alert_code}} at {{timestamp}}\nSeverity: {{severity}}\nSite pair: {{site_pair}}\nUtilization: {{utilization}}\nRack/ODF: {{rack_odf}}\nService: {{service_id}}\nPortal: {{portal_link}}",
  isActive: true,
};

export function NotificationSettings({
  smtp,
  templates,
  deploymentTemplates,
  recipientGroups,
}: {
  smtp: SmtpRow | null;
  templates: TemplateRow[];
  deploymentTemplates: DeploymentTemplateRow[];
  recipientGroups: RecipientGroupRow[];
}) {
  const [smtpForm, setSmtpForm] = useState({
    host: smtp?.host ?? "",
    port: smtp?.port ? String(smtp.port) : "587",
    username: smtp?.username ?? "",
    password: "",
    senderName: smtp?.senderName ?? "Fiber Inventory Portal",
    senderEmail: smtp?.senderEmail ?? "",
    replyTo: smtp?.replyTo ?? "",
    encryptionType: smtp?.encryptionType ?? "STARTTLS",
    testEmail: "",
  });

  // Multiple editable templates: pick one to edit, or choose "New template".
  const [templateList, setTemplateList] = useState<TemplateRow[]>(templates);
  const [selectedTemplateCode, setSelectedTemplateCode] = useState<string>(templates[0]?.code ?? "");
  const [template, setTemplate] = useState<TemplateRow>(templates[0] ?? NEW_TEMPLATE);

  // Parallel Trace-Route "Deployment instructions" template (separate facility).
  const [deploymentList, setDeploymentList] = useState<DeploymentTemplateRow[]>(deploymentTemplates);
  const [deployment, setDeployment] = useState<DeploymentTemplateRow>(deploymentTemplates[0] ?? NEW_DEPLOYMENT_TEMPLATE);

  const [group, setGroup] = useState({
    code: recipientGroups[0]?.code ?? "NOC",
    name: recipientGroups[0]?.name ?? "Network Operations",
    description: recipientGroups[0]?.description ?? "",
    emails: recipientGroups[0]?.members.map((member) => member.email).join(", ") ?? "",
    isActive: recipientGroups[0]?.isActive ?? true,
  });
  const [message, setMessage] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setMessage(null);
    const response = await fetch("/api/admin/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Admin notification action failed.");
    setMessage("Saved.");
    return payload;
  }

  function safePost(body: Record<string, unknown>) {
    post(body).catch((error) => setMessage(error instanceof Error ? error.message : "Action failed."));
  }

  function loadTemplate(code: string) {
    setSelectedTemplateCode(code);
    const found = templateList.find((item) => item.code === code);
    setTemplate(found ? { ...found } : NEW_TEMPLATE);
  }

  async function saveTemplate() {
    try {
      const payload = await post({ action: "saveTemplate", ...template });
      const saved = payload?.template as TemplateRow | undefined;
      if (saved?.code) {
        setTemplateList((current) => (current.some((item) => item.code === saved.code) ? current.map((item) => (item.code === saved.code ? saved : item)) : [...current, saved]));
        setSelectedTemplateCode(saved.code);
        setTemplate({ ...saved });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save template.");
    }
  }

  function loadDeployment(code: string) {
    const found = deploymentList.find((item) => item.code === code);
    setDeployment(found ? { ...found } : NEW_DEPLOYMENT_TEMPLATE);
  }

  async function saveDeploymentTemplate() {
    try {
      const payload = await post({ action: "saveDeploymentTemplate", ...deployment });
      const saved = payload?.deploymentTemplate as DeploymentTemplateRow | undefined;
      if (saved?.code) {
        setDeploymentList((current) => (current.some((item) => item.code === saved.code) ? current.map((item) => (item.code === saved.code ? saved : item)) : [...current, saved]));
        setDeployment({ ...saved });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save deployment template.");
    }
  }

  return (
    <div className="space-y-6">
      {message ? <div className="card border-emerald-500/30 p-4 text-sm text-emerald-300">{message}</div> : null}

      <section className="card p-5">
        <div className="section-title">SMTP / Email Configuration</div>
        <div className="subtle mt-1">Secrets are encrypted before storage. The stored password is never echoed back to the UI.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <input className="input-dark" value={smtpForm.host} onChange={(event) => setSmtpForm({ ...smtpForm, host: event.target.value })} placeholder="Host" />
          <input className="input-dark" value={smtpForm.port} onChange={(event) => setSmtpForm({ ...smtpForm, port: event.target.value })} placeholder="Port" />
          <select className="input-dark" value={smtpForm.encryptionType} onChange={(event) => setSmtpForm({ ...smtpForm, encryptionType: event.target.value })}>
            <option value="STARTTLS">STARTTLS</option>
            <option value="SSL_TLS">SSL/TLS</option>
            <option value="NONE">None</option>
          </select>
          <input className="input-dark" value={smtpForm.username} onChange={(event) => setSmtpForm({ ...smtpForm, username: event.target.value })} placeholder="Username" />
          <input className="input-dark" type="password" value={smtpForm.password} onChange={(event) => setSmtpForm({ ...smtpForm, password: event.target.value })} placeholder="Password" />
          <input className="input-dark" value={smtpForm.senderName} onChange={(event) => setSmtpForm({ ...smtpForm, senderName: event.target.value })} placeholder="Sender Name" />
          <input className="input-dark" value={smtpForm.senderEmail} onChange={(event) => setSmtpForm({ ...smtpForm, senderEmail: event.target.value })} placeholder="Sender Email" />
          <input className="input-dark" value={smtpForm.replyTo} onChange={(event) => setSmtpForm({ ...smtpForm, replyTo: event.target.value })} placeholder="Reply-To" />
          <button className="btn btn-primary" onClick={() => safePost({ action: "saveSmtp", ...smtpForm })}>
            <Save className="h-4 w-4" />
            Save SMTP
          </button>
          <input className="input-dark md:col-span-2" value={smtpForm.testEmail} onChange={(event) => setSmtpForm({ ...smtpForm, testEmail: event.target.value })} placeholder="Test Email" />
          <button className="btn btn-danger-soft" onClick={() => safePost({ action: "testEmail", testEmail: smtpForm.testEmail })}>
            <Send className="h-4 w-4" />
            Send Test Email
          </button>
        </div>
      </section>

      <section className="card p-5">
        <div className="section-title">Notification Templates</div>
        <div className="subtle mt-1">Maintain multiple email templates. Pick one to edit, or choose “New template”. These power the template dropdown in the export email dialog. Placeholders: alert name/code, severity, site pair, utilization, rack/ODF, service ID, timestamp, portal link.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm font-medium text-[var(--text-strong)] md:col-span-3">
            Template
            <select className="input-dark mt-1 w-full" value={selectedTemplateCode} onChange={(event) => loadTemplate(event.target.value)}>
              {templateList.map((item) => <option key={item.code} value={item.code}>{item.name || item.code}</option>)}
              <option value="">+ New template…</option>
            </select>
          </label>
          <input className="input-dark" value={template.code} onChange={(event) => setTemplate({ ...template, code: event.target.value })} placeholder="Template code" />
          <input className="input-dark" value={template.name} onChange={(event) => setTemplate({ ...template, name: event.target.value })} placeholder="Template name" />
          <select className="input-dark" value={template.channel} onChange={(event) => setTemplate({ ...template, channel: event.target.value })}>
            <option value="EMAIL">Email</option>
            <option value="IN_APP">In-app</option>
            <option value="SMS">SMS ready</option>
            <option value="MOBILE_PUSH">Mobile ready</option>
          </select>
          <input className="input-dark md:col-span-3" value={template.subject} onChange={(event) => setTemplate({ ...template, subject: event.target.value })} placeholder="Subject" />
          <textarea className="input-dark min-h-40 md:col-span-3" value={template.body} onChange={(event) => setTemplate({ ...template, body: event.target.value })} placeholder="Body" />
          <button className="btn btn-primary" onClick={saveTemplate}>
            <Save className="h-4 w-4" />
            Save Template
          </button>
        </div>
      </section>

      <section className="card p-5">
        <div className="section-title">Deployment Instructions (Trace Route)</div>
        <div className="subtle mt-1">Parallel template for the Trace Route deployment email — independent of the export templates above. Edit the TO / CC aliases and the email body. The Trace Route data sheet is auto-attached and the canvas topology image is embedded inline (auto-resized to the max width below). Placeholders: {"{{site_code}}"} / {"{{site_codes}}"} / {"{{site_list}}"} (the formatted red-tagged site list), {"{{sender_name}}"}, {"{{sender_team}}"}, {"{{sender_contact}}"}.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm font-medium text-[var(--text-strong)] md:col-span-3">
            Template
            <select className="input-dark mt-1 w-full" value={deployment.code} onChange={(event) => loadDeployment(event.target.value)}>
              {deploymentList.map((item) => <option key={item.code} value={item.code}>{item.name || item.code}</option>)}
              {deploymentList.some((item) => item.code === NEW_DEPLOYMENT_TEMPLATE.code) ? null : <option value={NEW_DEPLOYMENT_TEMPLATE.code}>+ Deployment instructions…</option>}
            </select>
          </label>
          <input className="input-dark" value={deployment.toAlias ?? ""} onChange={(event) => setDeployment({ ...deployment, toAlias: event.target.value })} placeholder="TO (aliases / emails, comma-separated)" />
          <input className="input-dark" value={deployment.ccAlias ?? ""} onChange={(event) => setDeployment({ ...deployment, ccAlias: event.target.value })} placeholder="CC (aliases / emails, comma-separated)" />
          <input className="input-dark" type="number" value={deployment.canvasMaxWidthPx ?? 600} onChange={(event) => setDeployment({ ...deployment, canvasMaxWidthPx: Number(event.target.value) })} placeholder="Canvas max width (px)" />
          <input className="input-dark md:col-span-3" value={deployment.subject} onChange={(event) => setDeployment({ ...deployment, subject: event.target.value })} placeholder="Subject" />
          <textarea className="input-dark min-h-32 md:col-span-3" value={deployment.body} onChange={(event) => setDeployment({ ...deployment, body: event.target.value })} placeholder="Email body text" />
          <textarea className="input-dark min-h-24 md:col-span-3" value={deployment.signature ?? ""} onChange={(event) => setDeployment({ ...deployment, signature: event.target.value })} placeholder="Signature (editable)" />
          <label className="flex items-center gap-2 text-sm text-[var(--text-strong)]">
            <input type="checkbox" checked={deployment.attachTraceSheet ?? true} onChange={(event) => setDeployment({ ...deployment, attachTraceSheet: event.target.checked })} />
            Attach Trace Route data sheet
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text-strong)]">
            <input type="checkbox" checked={deployment.inlineCanvas ?? true} onChange={(event) => setDeployment({ ...deployment, inlineCanvas: event.target.checked })} />
            Embed canvas topology inline
          </label>
          <button className="btn btn-primary" onClick={saveDeploymentTemplate}>
            <Save className="h-4 w-4" />
            Save Deployment Instructions
          </button>
        </div>
      </section>

      <section className="card p-5">
        <div className="section-title">Recipient Aliases (Recipient Groups)</div>
        <div className="subtle mt-1">Named groups of recipient addresses. Each group is selectable as a recipient alias in the export email dialog, which fills the recipients for you.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <input className="input-dark" value={group.code} onChange={(event) => setGroup({ ...group, code: event.target.value })} placeholder="Alias code" />
          <input className="input-dark" value={group.name} onChange={(event) => setGroup({ ...group, name: event.target.value })} placeholder="Alias name" />
          <input className="input-dark" value={group.description} onChange={(event) => setGroup({ ...group, description: event.target.value })} placeholder="Description" />
          <textarea className="input-dark min-h-28 md:col-span-3" value={group.emails} onChange={(event) => setGroup({ ...group, emails: event.target.value })} placeholder="Recipient emails separated by comma or semicolon" />
          <button className="btn btn-primary" onClick={() => safePost({ action: "saveRecipientGroup", ...group })}>
            <Save className="h-4 w-4" />
            Save Alias
          </button>
          <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200" onClick={() => safePost({ action: "deleteRecipientGroup", code: group.code })}>
            <Trash2 className="h-4 w-4" />
            Delete Alias
          </button>
        </div>
      </section>
    </div>
  );
}
