import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { notificationService } from "@/server/services/notification.service";
import { exportDataService } from "@/server/services/export-data.service";
import { buildStyledTraceWorkbook } from "@/lib/export/styled-trace-workbook";
import { writeAuditLog } from "@/lib/audit/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Detailed Trace "Email Report" backend. Emails the generated deployment-
// instructions text and, optionally, an inline high-quality canvas snapshot plus
// the trace data sheet (with the RED fault fill mirrored from the canvas).
// Additive to the trace/export stack — it does not touch trace-core logic.
// ─────────────────────────────────────────────────────────────────────────────

const emailSchema = z.string().trim().email();

function splitRecipients(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => splitRecipients(item));
  if (typeof value !== "string") return [];
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function validEmails(value: unknown): string[] {
  const unique = [...new Set(splitRecipients(value).map((email) => email.toLowerCase()))];
  return unique.filter((email) => emailSchema.safeParse(email).success);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Parse a data URL (data:<mime>;base64,<payload>) into a Buffer + mime.
function parseDataUrl(value: unknown): { mime: string; buffer: Buffer } | null {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  const mime = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  try {
    const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    return buffer.length ? { mime, buffer } : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "exportData")) {
      return NextResponse.json({ error: "A valid portal session is required to email a trace report." }, { status: 403 });
    }

    const body = await request.json();
    const toRecipients = validEmails(body.to);
    const ccRecipients = validEmails(body.cc);
    if (!toRecipients.length) {
      return NextResponse.json({ error: "Enter at least one valid TO recipient email address." }, { status: 400 });
    }

    const reportText = String(body.body ?? "").trim();
    if (!reportText) {
      return NextResponse.json({ error: "The report text is empty — run a Detailed Trace first." }, { status: 400 });
    }
    const subject = String(body.subject ?? "").trim() || "Fiber portal — Detailed Trace report";
    const serviceCode = typeof body.serviceCode === "string" ? body.serviceCode.trim() : "";
    const trail = typeof body.trail === "string" ? body.trail.trim() : "";
    const redSites = splitRecipients(body.redSites); // reused splitter: any comma/array form
    const includeSheet = Boolean(body.includeSheet);

    const attachments: Array<{ filename: string; content: Buffer; contentType?: string; cid?: string }> = [];

    // Optional trace data sheet, fault-highlighted to match the canvas.
    let sheetRows = 0;
    if (includeSheet && (serviceCode || trail)) {
      const data = serviceCode
        ? await exportDataService.buildRows({ type: "trace", serviceCode })
        : await exportDataService.buildRows({ type: "trace-path", transportTrail: trail });
      sheetRows = data.rows.length;
      attachments.push({
        filename: data.fileName,
        content: await buildStyledTraceWorkbook({ rows: data.rows, sheetName: data.sheetName, redSites }),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    }

    // Optional inline canvas snapshot (already sanitized of nav dots client-side).
    const inline = parseDataUrl(body.canvasImage);
    if (inline) {
      attachments.push({
        filename: `${(serviceCode || trail || "trace").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60)}-topology.png`,
        content: inline.buffer,
        contentType: inline.mime,
        cid: "trace-topology",
      });
    }

    const html = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;">',
      `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escapeHtml(reportText)}</pre>`,
      inline
        ? `<img src="cid:trace-topology" alt="Trace topology snapshot" style="display:block;width:100%;max-width:720px;height:auto;border:0;margin:16px 0;" />`
        : "",
      "</div>",
    ].join("");

    const result = await notificationService.sendEmail({
      to: toRecipients,
      cc: ccRecipients,
      subject,
      text: reportText,
      html,
      attachments,
      userId: session?.id ?? null,
      metadata: {
        purpose: "TRACE_REPORT",
        serviceCode: serviceCode || null,
        trail: trail || null,
        inlineCanvas: Boolean(inline),
        sheetRows,
        redSites: redSites.length,
      },
    });

    await writeAuditLog({
      entityType: "TraceReportEmail",
      entityId: serviceCode || trail || "detailed-trace",
      action: "EXPORT",
      fieldName: "email",
      newValue: {
        serviceCode: serviceCode || null,
        trail: trail || null,
        to: toRecipients,
        cc: ccRecipients,
        inlineCanvas: Boolean(inline),
        sheetRows,
        redSites: redSites.length,
        emailStatus: result.status,
      },
      changedById: session?.id ?? null,
      reason: "Detailed Trace report email sent.",
    });

    const configured = result.status !== "NOT_CONFIGURED";
    return NextResponse.json({
      status: result.status,
      recipients: toRecipients,
      cc: ccRecipients,
      message: configured
        ? `Trace report ${result.status === "SENT" ? "sent" : "attempted"} → ${toRecipients.length} recipient(s)${ccRecipients.length ? `, ${ccRecipients.length} cc` : ""}${inline ? ", snapshot embedded" : ""}${sheetRows ? ", data sheet attached" : ""}.`
        : "Trace report was logged because SMTP is not configured (Admin → Notifications).",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send the trace report." },
      { status: 500 },
    );
  }
}
