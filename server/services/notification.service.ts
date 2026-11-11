import nodemailer from "nodemailer";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/security/secrets";

type EmailInput = {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string; cid?: string }>;
  userId?: string | null;
  metadata?: Record<string, unknown>;
};

type EmailResult = {
  status: "SENT" | "FAILED" | "NOT_CONFIGURED";
  recipients: string[];
  messageId?: string;
  error?: string;
  attempts?: number;
};

const MAX_SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000];

// Transmission timeouts: a hung SMTP server must never block an API request
// indefinitely. nodemailer defaults to no socket timeout at all.
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

function splitRecipients(value: string | string[]) {
  return (Array.isArray(value) ? value : value.split(/[;,]/)).map((item) => item.trim()).filter(Boolean);
}

function safePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

type ResolvedSmtpConfig = {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  encryptionType: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
};

export async function getActiveSmtpConfiguration() {
  return prisma.smtpConfiguration.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Resolve the effective SMTP configuration: database settings first, then
 * environment variables as fallback. Every env value is parsed defensively —
 * a malformed SMTP_PORT must degrade to NOT_CONFIGURED, never crash dispatch.
 */
async function resolveSmtpConfig(): Promise<ResolvedSmtpConfig | null> {
  const smtp = await getActiveSmtpConfiguration();

  const host = smtp?.host?.trim() || process.env.SMTP_HOST?.trim() || null;
  const port = safePort(smtp?.port) ?? safePort(process.env.SMTP_PORT) ?? (host ? 587 : null);
  const fromEmail = smtp?.senderEmail?.trim() || process.env.SMTP_FROM?.trim() || null;
  if (!host || !port || !fromEmail) return null;

  const username = smtp?.username?.trim() || process.env.SMTP_USER?.trim() || null;
  const password = smtp?.encryptedPassword
    ? decryptSecret(smtp.encryptedPassword)
    : process.env.SMTP_PASSWORD ?? process.env.SMTP_PASS ?? null;
  const encryptionType = (smtp?.encryptionType || process.env.SMTP_ENCRYPTION || "STARTTLS").toUpperCase();

  return {
    host,
    port,
    username,
    password,
    encryptionType,
    fromEmail,
    fromName: smtp?.senderName?.trim() || process.env.SMTP_FROM_NAME?.trim() || "Fiber Inventory Portal",
    replyTo: smtp?.replyTo?.trim() || null,
  };
}

/**
 * Permanent SMTP failures (bad credentials, rejected envelope, 5xx replies)
 * must not be retried — retrying them only delays the error report.
 */
function isPermanentFailure(error: unknown): boolean {
  const candidate = error as { code?: string; responseCode?: number } | null;
  if (!candidate) return false;
  if (candidate.code === "EAUTH" || candidate.code === "EENVELOPE" || candidate.code === "EMESSAGE") return true;
  return typeof candidate.responseCode === "number" && candidate.responseCode >= 500 && candidate.responseCode < 600;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logDelivery(
  input: EmailInput,
  recipients: string[],
  status: string,
  extra: Record<string, unknown> = {},
  error?: string,
) {
  try {
    await prisma.notificationLog.createMany({
      data: recipients.map((recipient) => ({
        channel: "EMAIL" as const,
        recipient,
        subject: input.subject,
        body: input.text,
        status,
        error: error ?? null,
        userId: input.userId ?? undefined,
        metadataJson: JSON.stringify({ ...(input.metadata ?? {}), ...extra }),
      })),
    });
  } catch (logError) {
    // The delivery log must never mask the actual dispatch outcome.
    console.error("[notification] failed to write notification log:", logError);
  }
}

export const notificationService = {
  async sendEmail(input: EmailInput): Promise<EmailResult> {
    const recipients = splitRecipients(input.to);
    const ccRecipients = input.cc ? splitRecipients(input.cc) : [];
    if (!recipients.length) throw new Error("At least one recipient is required.");

    const config = await resolveSmtpConfig();
    if (!config) {
      await logDelivery(input, recipients, "NOT_CONFIGURED");
      return { status: "NOT_CONFIGURED", recipients };
    }

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.encryptionType === "SSL_TLS",
      auth: config.username ? { user: config.username, pass: config.password ?? "" } : undefined,
      tls: config.encryptionType === "NONE" ? { rejectUnauthorized: false } : undefined,
      ...SMTP_TIMEOUTS,
    });

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const info = await transporter.sendMail({
          from: `${config.fromName} <${config.fromEmail}>`,
          replyTo: config.replyTo || undefined,
          to: recipients,
          cc: ccRecipients.length ? ccRecipients : undefined,
          subject: input.subject,
          text: input.text,
          html: input.html,
          attachments: input.attachments,
        });

        await logDelivery(input, recipients, "SENT", { messageId: info.messageId, attempts: attempt });
        return { status: "SENT", recipients, messageId: info.messageId, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (isPermanentFailure(error) || attempt === MAX_SEND_ATTEMPTS) break;
        await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 3000);
      }
    }

    // Every failed dispatch is recorded — there is no silent-failure path.
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown SMTP error");
    await logDelivery(input, recipients, "FAILED", { attempts: MAX_SEND_ATTEMPTS }, errorMessage);
    console.error(`[notification] email dispatch failed after retries: ${errorMessage}`);
    return { status: "FAILED", recipients, error: errorMessage, attempts: MAX_SEND_ATTEMPTS };
  },
};
