import { z } from "zod";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { exportDataService } from "@/server/services/export-data.service";
import { notificationService } from "@/server/services/notification.service";

const emailSchema = z.string().trim().email();

function splitRecipients(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitRecipients(item));
  }

  if (typeof value !== "string") return [];
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function configuredRecipients(): Promise<string[]> {
  const [users, policies] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true },
      select: { email: true },
    }),
    prisma.alertPolicy.findMany({
      where: { enabled: true },
      select: { notifyEmails: true },
    }),
  ]);

  return [
    ...users.map((user) => user.email),
    ...policies.flatMap((policy) => splitRecipients(policy.notifyEmails)),
  ];
}

function exportWorkbookBuffer(rows: Record<string, unknown>[], sheetName: string): Buffer {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ message: "No rows found" }]);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

export const emailExportService = {
  async emailExport(input: {
    type?: string | null;
    siteCode?: string | null;
    serviceCode?: string | null;
    batchId?: string | null;
    search?: string | null;
    connectedSite?: string | null;
    serviceId?: string | null;
    rackId?: string | null;
    odfId?: string | null;
    portPair?: string | null;
    fiberPortNumber?: string | null;
    cableId?: string | null;
    tubeNumber?: string | null;
    tubeColor?: string | null;
    fiberNumber?: string | null;
    status?: string | null;
    siteType?: string | null;
    regionPrefix?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    tag?: string | null;
    recipients?: unknown;
    includeConfiguredRecipients?: boolean;
    message?: string | null;
    /** Custom subject (e.g. from a chosen template, possibly edited). */
    subject?: string | null;
    /** Editable email body (template preloaded then edited by the user). */
    body?: string | null;
  }) {
    const manualRecipients = splitRecipients(input.recipients);
    const storedRecipients = input.includeConfiguredRecipients ? await configuredRecipients() : [];
    const uniqueRecipients = [...new Set([...manualRecipients, ...storedRecipients].map((email) => email.toLowerCase()))];
    const validRecipients: string[] = [];
    const invalidRecipients: string[] = [];

    for (const recipient of uniqueRecipients) {
      const parsed = emailSchema.safeParse(recipient);
      if (parsed.success) validRecipients.push(parsed.data);
      else invalidRecipients.push(recipient);
    }

    if (!validRecipients.length) {
      throw new Error("Enter at least one valid recipient email address.");
    }

    const exportData = await exportDataService.buildRows(input);
    const attachment = exportWorkbookBuffer(exportData.rows, exportData.sheetName);
    const fallbackUser = await prisma.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const leadText = input.body?.trim() || input.message?.trim() || "A Fiber Inventory Management Portal export was requested.";
    const emailResult = await notificationService.sendEmail({
      to: validRecipients,
      subject: input.subject?.trim() || `Fiber portal export: ${exportData.fileName}`,
      text: [
        leadText,
        "",
        `Export type: ${input.type ?? "inventory"}`,
        `Rows: ${exportData.rows.length}`,
        `File: ${exportData.fileName}`,
        "",
        "The selected live portal result is attached as an Excel workbook.",
      ].join("\n"),
      attachments: [{
        filename: exportData.fileName,
        content: attachment,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }],
      userId: fallbackUser?.id ?? null,
      metadata: { exportType: input.type ?? "inventory", fileName: exportData.fileName, rowCount: exportData.rows.length },
    });
    const smtpConfigured = emailResult.status !== "NOT_CONFIGURED";

    await writeAuditLog({
      entityType: "ExportEmail",
      entityId: `${input.type ?? "inventory"}:${input.serviceCode ?? input.siteCode ?? input.batchId ?? "all"}`,
      action: "EXPORT",
      fieldName: "email",
      newValue: {
        exportType: input.type ?? "inventory",
        serviceCode: input.serviceCode ?? null,
        siteCode: input.siteCode ?? null,
        batchId: input.batchId ?? null,
        search: input.search ?? null,
        status: input.status ?? null,
        recipients: validRecipients,
        invalidRecipients,
        rowCount: exportData.rows.length,
        emailStatus: emailResult.status,
      },
      changedById: fallbackUser?.id ?? null,
      reason: "Export email requested from the portal.",
      comment: input.message ?? null,
    });

    return {
      status: emailResult.status,
      smtpConfigured: emailResult.status !== "NOT_CONFIGURED",
      recipients: validRecipients,
      invalidRecipients,
      rowCount: exportData.rows.length,
      fileName: exportData.fileName,
      message: smtpConfigured
        ? "Export email sent through configured SMTP."
        : "Export email was logged because SMTP is not configured.",
    };
  },
};
