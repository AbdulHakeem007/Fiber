import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/security/secrets";
import { notificationService } from "@/server/services/notification.service";
import { writeAuditLog } from "@/lib/audit/audit-log";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
    }

    const body = await request.json();
    const action = String(body.action ?? "");

    if (action === "saveSmtp") {
      const existing = await prisma.smtpConfiguration.findFirst({ where: { isActive: true }, orderBy: { updatedAt: "desc" } });
      const data = {
        host: typeof body.host === "string" ? body.host.trim() || null : undefined,
        port: body.port ? Number(body.port) : null,
        username: typeof body.username === "string" ? body.username.trim() || null : undefined,
        encryptedPassword: typeof body.password === "string" && body.password ? encryptSecret(body.password) : undefined,
        senderName: typeof body.senderName === "string" ? body.senderName.trim() || null : undefined,
        senderEmail: typeof body.senderEmail === "string" ? body.senderEmail.trim() || null : undefined,
        replyTo: typeof body.replyTo === "string" ? body.replyTo.trim() || null : undefined,
        encryptionType: typeof body.encryptionType === "string" ? body.encryptionType : "STARTTLS",
      };
      const smtp = existing
        ? await prisma.smtpConfiguration.update({ where: { id: existing.id }, data })
        : await prisma.smtpConfiguration.create({ data: { ...data, name: "Default SMTP", isActive: true } });

      await writeAuditLog({
        entityType: "SmtpConfiguration",
        entityId: smtp.id,
        action: "SMTP_UPDATE",
        changedById: session?.id,
        reason: "SMTP settings updated",
        newValue: { host: smtp.host, port: smtp.port, senderEmail: smtp.senderEmail, encryptionType: smtp.encryptionType },
      });

      return NextResponse.json({ smtp: { ...smtp, encryptedPassword: smtp.encryptedPassword ? "CONFIGURED" : null } });
    }

    if (action === "testEmail") {
      const testEmail = String(body.testEmail ?? "").trim();
      if (!testEmail) return NextResponse.json({ error: "Test email is required." }, { status: 400 });
      const result = await notificationService.sendEmail({
        to: testEmail,
        subject: "Fiber Inventory Portal SMTP test",
        text: "SMTP test email from Fiber Inventory Management Portal.",
        userId: session?.id,
        metadata: { purpose: "SMTP_TEST" },
      });
      await prisma.smtpConfiguration.updateMany({
        where: { isActive: true },
        data: { lastTestAt: new Date(), lastTestStatus: result.status },
      });
      return NextResponse.json(result);
    }

    if (action === "saveTemplate") {
      const code = String(body.code ?? "").trim().toUpperCase();
      if (!code) {
        return NextResponse.json({ error: "Template code is required (e.g. CUTOVER_ALERT) to add a new template." }, { status: 400 });
      }
      const template = await prisma.notificationTemplate.upsert({
        where: { code },
        update: {
          name: String(body.name ?? "Alert email"),
          channel: body.channel ?? "EMAIL",
          subject: String(body.subject ?? ""),
          body: String(body.body ?? ""),
          placeholdersJson: JSON.stringify(body.placeholders ?? []),
          isActive: Boolean(body.isActive ?? true),
        },
        create: {
          code,
          name: String(body.name ?? "Alert email"),
          channel: body.channel ?? "EMAIL",
          subject: String(body.subject ?? ""),
          body: String(body.body ?? ""),
          placeholdersJson: JSON.stringify(body.placeholders ?? []),
          isActive: Boolean(body.isActive ?? true),
        },
      });
      await writeAuditLog({
        entityType: "NotificationTemplate",
        entityId: template.id,
        action: "TEMPLATE_UPDATE",
        changedById: session?.id,
        reason: "Notification template updated",
      });
      return NextResponse.json({ template });
    }

    if (action === "saveDeploymentTemplate") {
      const code = String(body.code ?? "").trim().toUpperCase() || "DEPLOYMENT_INSTRUCTIONS";
      const data = {
        name: String(body.name ?? "Deployment instructions"),
        module: String(body.module ?? "TRACE_ROUTE"),
        toAlias: typeof body.toAlias === "string" ? body.toAlias.trim() : "",
        ccAlias: typeof body.ccAlias === "string" ? body.ccAlias.trim() : "",
        subject: String(body.subject ?? ""),
        body: String(body.body ?? ""),
        signature: typeof body.signature === "string" ? body.signature : null,
        attachTraceSheet: Boolean(body.attachTraceSheet ?? true),
        inlineCanvas: Boolean(body.inlineCanvas ?? true),
        canvasMaxWidthPx: body.canvasMaxWidthPx ? Number(body.canvasMaxWidthPx) : 600,
        isActive: Boolean(body.isActive ?? true),
      };
      const template = await prisma.deploymentEmailTemplate.upsert({
        where: { code },
        update: data,
        create: { code, ...data },
      });
      await writeAuditLog({
        entityType: "DeploymentEmailTemplate",
        entityId: template.id,
        action: "TEMPLATE_UPDATE",
        changedById: session?.id,
        reason: "Deployment email template updated",
      });
      return NextResponse.json({ deploymentTemplate: template });
    }

    if (action === "saveRecipientGroup") {
      const code = String(body.code ?? "").trim().toUpperCase();
      if (!code) return NextResponse.json({ error: "Recipient group code is required." }, { status: 400 });
      const group = await prisma.recipientGroup.upsert({
        where: { code },
        update: { name: String(body.name ?? code), description: String(body.description ?? ""), isActive: Boolean(body.isActive ?? true) },
        create: { code, name: String(body.name ?? code), description: String(body.description ?? ""), isActive: Boolean(body.isActive ?? true) },
      });
      const emails = String(body.emails ?? "").split(/[;,]/).map((email) => email.trim()).filter(Boolean);
      await prisma.recipientGroupMember.deleteMany({ where: { recipientGroupId: group.id } });
      await prisma.recipientGroupMember.createMany({
        data: emails.map((email) => ({ recipientGroupId: group.id, email })),
      });
      return NextResponse.json({ group });
    }

    if (action === "deleteRecipientGroup") {
      const code = String(body.code ?? "").trim().toUpperCase();
      if (!code) return NextResponse.json({ error: "Recipient group code is required." }, { status: 400 });
      const group = await prisma.recipientGroup.findUnique({ where: { code }, select: { id: true } });
      if (!group) return NextResponse.json({ error: "Recipient group not found." }, { status: 404 });
      await prisma.$transaction(async (tx) => {
        await tx.recipientGroupMember.deleteMany({ where: { recipientGroupId: group.id } });
        await tx.recipientGroup.delete({ where: { id: group.id } });
      });
      return NextResponse.json({ deletedCode: code, message: "Recipient group deleted." });
    }

    return NextResponse.json({ error: "Unknown notification admin action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Notification settings update failed." },
      { status: 500 },
    );
  }
}
