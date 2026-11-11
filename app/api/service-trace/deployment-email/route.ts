import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { formatSelectedSiteIds, normalizeSelectedSiteIds, parseSelectedSiteIds } from "@/lib/telecom/site-list-format";
import { notificationService } from "@/server/services/notification.service";
import { exportDataService } from "@/server/services/export-data.service";
import { buildStyledTraceWorkbook } from "@/lib/export/styled-trace-workbook";
import { writeAuditLog } from "@/lib/audit/audit-log";

const emailSchema = z.string().trim().email();

const DEPLOYMENT_TEMPLATE_CODE = "DEPLOYMENT_INSTRUCTIONS";

function splitTokens(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function selectedSitesFromBody(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.siteCodes)) {
    return normalizeSelectedSiteIds(body.siteCodes.map((site) => String(site ?? "")));
  }
  if (typeof body.siteCodes === "string") return parseSelectedSiteIds(body.siteCodes);
  return normalizeSelectedSiteIds([String(body.siteCode ?? "")]);
}

/**
 * Expand a TO/CC field into concrete email addresses. Each token is either a raw
 * email (kept as-is) or a RecipientGroup alias code (expanded to its members) —
 * the same alias mechanism the export email dialog uses.
 */
async function resolveAliases(value: string | null | undefined): Promise<string[]> {
  const tokens = splitTokens(value);
  if (!tokens.length) return [];
  const emails: string[] = [];
  const aliasCodes: string[] = [];
  for (const token of tokens) {
    if (emailSchema.safeParse(token).success) emails.push(token);
    else aliasCodes.push(token.toUpperCase());
  }
  if (aliasCodes.length) {
    const groups = await prisma.recipientGroup.findMany({
      where: { code: { in: aliasCodes }, isActive: true },
      include: { members: true },
    });
    for (const group of groups) {
      for (const member of group.members) emails.push(member.email);
    }
  }
  // De-duplicate, keep only valid addresses.
  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
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
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Write access is required to send deployment instructions." }, { status: 403 });
    }

    const body = await request.json();
    const serviceCode = String(body.serviceCode ?? "").trim();
    const siteCodes = selectedSitesFromBody(body);
    const siteCode = formatSelectedSiteIds(siteCodes);
    if (!serviceCode) return NextResponse.json({ error: "A traced service is required." }, { status: 400 });
    if (!siteCode) {
      return NextResponse.json({ error: "Tag integration sites red on the canvas (double-click) or enter them before sending." }, { status: 400 });
    }

    const template = await prisma.deploymentEmailTemplate.findUnique({ where: { code: DEPLOYMENT_TEMPLATE_CODE } });
    if (!template || !template.isActive) {
      return NextResponse.json({ error: "The Deployment instructions template is missing or inactive. Configure it under Admin → Notifications." }, { status: 404 });
    }

    // Routing: per-send override fields win; otherwise fall back to the template's
    // configured TO / CC aliases. Aliases expand to RecipientGroup members.
    const toOverride = typeof body.to === "string" ? body.to : "";
    const ccOverride = typeof body.cc === "string" ? body.cc : "";
    const toRecipients = await resolveAliases(toOverride.trim() || template.toAlias);
    const ccRecipients = await resolveAliases(ccOverride.trim() || template.ccAlias);
    if (!toRecipients.length) {
      return NextResponse.json(
        { error: "No valid TO recipients. Set a TO alias/email on the template (Admin → Notifications) or enter one here." },
        { status: 400 },
      );
    }

    // Fill placeholders. {{site_code}} remains the compatibility placeholder and
    // now receives the formatted selected-site string; sender_* come from the
    // acting user where available.
    const senderName = session?.name ?? session?.email ?? "";
    const fill = (input: string | null | undefined): string =>
      (input ?? "")
        .replaceAll("{{site_code}}", siteCode)
        .replaceAll("{{site_codes}}", siteCode)
        .replaceAll("{{site_list}}", siteCode)
        .replaceAll("{{generated_site_string}}", siteCode)
        .replaceAll("{{sender_name}}", senderName)
        .replaceAll("{{sender_team}}", "")
        .replaceAll("{{sender_contact}}", session?.email ?? "");

    const subject = fill(template.subject) || `ATN integration for site "${siteCode}"`;
    const bodyText = fill(template.body);
    const signature = fill(template.signature).trim();

    const attachments: Array<{ filename: string; content: Buffer; contentType?: string; cid?: string }> = [];

    // Trace Route data sheet — the live trace export for this service. The
    // tagged integration sites (siteCodes) are exactly the nodes marked RED on
    // the canvas, so their rows are given the soft-red fault fill in the sheet,
    // keeping the workbook visually in sync with the topology.
    let traceRows = 0;
    if (template.attachTraceSheet) {
      const data = await exportDataService.buildRows({ type: "trace", serviceCode });
      traceRows = data.rows.length;
      attachments.push({
        filename: data.fileName,
        content: await buildStyledTraceWorkbook({ rows: data.rows, sheetName: data.sheetName, redSites: siteCodes }),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    }

    // Canvas topology image — embedded inline via a CID reference, auto-resized
    // in the body to the configured max width.
    const maxWidth = template.canvasMaxWidthPx || 600;
    const inline = template.inlineCanvas ? parseDataUrl(body.canvasImage) : null;
    if (inline) {
      attachments.push({
        filename: `${siteCodes.join("-") || "sites"}-topology.png`,
        content: inline.buffer,
        contentType: inline.mime,
        cid: "canvas-topology",
      });
    }

    const html = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;">',
      `<p>${escapeHtml(bodyText)}</p>`,
      inline
        ? `<img src="cid:canvas-topology" alt="Canvas topology for ${escapeHtml(siteCode)}" style="display:block;width:100%;max-width:${maxWidth}px;height:auto;border:0;margin:16px 0;" />`
        : "",
      signature ? `<div style="white-space:pre-line;color:#6b7280;margin-top:16px;">${escapeHtml(signature)}</div>` : "",
      "</div>",
    ].join("");

    const text = [bodyText, signature].filter(Boolean).join("\n\n");

    const result = await notificationService.sendEmail({
      to: toRecipients,
      cc: ccRecipients,
      subject,
      text,
      html,
      attachments,
      userId: session?.id ?? null,
      metadata: {
        purpose: "DEPLOYMENT_INSTRUCTIONS",
        serviceCode,
        siteCode,
        siteCodes,
        traceRows,
        inlineCanvas: Boolean(inline),
      },
    });

    await writeAuditLog({
      entityType: "DeploymentEmail",
      entityId: `${serviceCode}:${siteCode}`,
      action: "EXPORT",
      fieldName: "email",
      newValue: {
        serviceCode,
        siteCode,
        siteCodes,
        to: toRecipients,
        cc: ccRecipients,
        traceRows,
        inlineCanvas: Boolean(inline),
        emailStatus: result.status,
      },
      changedById: session?.id ?? null,
      reason: "Deployment instructions email sent from Trace Route.",
    });

    const configured = result.status !== "NOT_CONFIGURED";
    return NextResponse.json({
      status: result.status,
      recipients: toRecipients,
      cc: ccRecipients,
      message: configured
        ? `Deployment instructions ${result.status === "SENT" ? "sent" : "attempted"} for ${siteCode} → ${toRecipients.length} recipient(s)${ccRecipients.length ? `, ${ccRecipients.length} cc` : ""}.`
        : "Deployment instructions were logged because SMTP is not configured (Admin → Notifications).",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send deployment instructions." },
      { status: 500 },
    );
  }
}
