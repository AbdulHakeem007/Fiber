import { prisma } from "@/lib/db/prisma";
import { notificationService } from "@/server/services/notification.service";

/**
 * Weekly "Critical Links" report.
 *
 * A critical link is any non-decommissioned LinkSegment that is operationally at
 * risk: utilization at/above the critical threshold, faulty fibers, a partial
 * termination, or a missing physical cable record. The set is compiled into an
 * HTML summary and emailed to stakeholders on a 7-day cadence (configurable).
 *
 * All queries use Prisma, so this is database-agnostic — it runs unchanged on
 * the current SQLite database and on PostgreSQL after migration.
 *
 * Env tuning (all optional):
 *   CRITICAL_LINKS_THRESHOLD_PCT       critical utilization %        (default 95)
 *   CRITICAL_LINKS_REPORT_RECIPIENTS   "a@x.com;b@y.com" override list
 *   CRITICAL_LINKS_REPORT_INTERVAL_MS  min gap between sends          (default 7 days)
 *                                      set to 60000 for 1-minute local QA
 */

const METADATA_KIND = "critical-links-weekly";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function criticalThresholdPct(): number {
  const value = Number(process.env.CRITICAL_LINKS_THRESHOLD_PCT);
  return Number.isFinite(value) && value > 0 ? value : 95;
}

function reportIntervalMs(): number {
  const value = Number(process.env.CRITICAL_LINKS_REPORT_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? value : SEVEN_DAYS_MS;
}

function splitRecipients(value?: string | null): string[] {
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type CriticalLink = Awaited<ReturnType<typeof getCriticalLinks>>[number];

async function getCriticalLinks() {
  const threshold = criticalThresholdPct();
  return prisma.linkSegment.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      OR: [
        { utilizationPct: { gte: threshold } },
        { faultyFiberCount: { gt: 0 } },
        { status: "FAULTY" },
        { isPartialTermination: true },
        { cableId: null },
      ],
    },
    include: {
      endpointA: { include: { site: true } },
      endpointB: { include: { site: true } },
      cable: true,
    },
    orderBy: [{ utilizationPct: "desc" }, { faultyFiberCount: "desc" }],
    take: 1000,
  });
}

/** Human-readable reasons a link qualified as critical. */
function reasonsFor(link: CriticalLink): string[] {
  const threshold = criticalThresholdPct();
  const reasons: string[] = [];
  if (link.utilizationPct >= threshold) reasons.push(`Utilization ${link.utilizationPct.toFixed(1)}% ≥ ${threshold}%`);
  if (link.faultyFiberCount > 0) reasons.push(`${link.faultyFiberCount} faulty fiber(s)`);
  if (String(link.status) === "FAULTY") reasons.push("Status FAULTY");
  if (link.isPartialTermination) reasons.push("Partial termination");
  if (!link.cableId) reasons.push("No cable record");
  return reasons;
}

function endpointLabel(endpoint: CriticalLink["endpointA"]): string {
  return endpoint?.site?.code ?? endpoint?.rawSiteCode ?? "—";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char),
  );
}

function buildReportText(links: CriticalLink[], generatedAt: Date): string {
  if (!links.length) return `Critical Links Report (${generatedAt.toISOString()})\n\nNo critical links found. Network is healthy.`;
  const lines = links.map((link, index) =>
    `${index + 1}. ${link.segmentCode} | ${endpointLabel(link.endpointA)} -> ${endpointLabel(link.endpointB)} | util ${link.utilizationPct.toFixed(1)}% | ${reasonsFor(link).join("; ")}`,
  );
  return `Critical Links Report (${generatedAt.toISOString()})\n${links.length} critical link(s):\n\n${lines.join("\n")}`;
}

function buildReportHtml(links: CriticalLink[], generatedAt: Date): string {
  const stamp = escapeHtml(generatedAt.toUTCString());
  const headerCells = ["#", "Segment", "From", "To", "Utilization", "Used / Total", "Faulty", "Status", "Why critical"]
    .map((label) => `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #cbd5e1;font-size:12px;color:#334155;">${escapeHtml(label)}</th>`)
    .join("");

  const rows = links
    .map((link, index) => {
      const util = link.utilizationPct;
      const utilColor = util >= 95 ? "#dc2626" : util >= 75 ? "#ea580c" : "#334155";
      const cells = [
        `${index + 1}`,
        escapeHtml(link.segmentCode),
        escapeHtml(endpointLabel(link.endpointA)),
        escapeHtml(endpointLabel(link.endpointB)),
        `<span style="font-weight:700;color:${utilColor};">${util.toFixed(1)}%</span>`,
        `${link.usedFiberCount} / ${link.totalFiberCapacity}`,
        link.faultyFiberCount > 0 ? `<span style="color:#dc2626;font-weight:700;">${link.faultyFiberCount}</span>` : "0",
        escapeHtml(String(link.status)),
        escapeHtml(reasonsFor(link).join("; ")),
      ];
      const bg = index % 2 === 0 ? "#ffffff" : "#f8fafc";
      return `<tr style="background:${bg};">${cells.map((cell) => `<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;">${cell}</td>`).join("")}</tr>`;
    })
    .join("");

  const body = links.length
    ? `<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table>`
    : `<p style="font-family:Arial,Helvetica,sans-serif;color:#16a34a;font-weight:600;">✓ No critical links found. The network is healthy.</p>`;

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#eef2f7;">
  <div style="max-width:900px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:#0f172a;padding:18px 24px;">
      <div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;">Fiber Inventory — Critical Links Report</div>
      <div style="color:#94a3b8;font-family:Arial,Helvetica,sans-serif;font-size:12px;margin-top:4px;">Generated ${stamp} · ${links.length} critical link(s)</div>
    </div>
    <div style="padding:24px;">${body}</div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#64748b;">
      Automated weekly report from the Fiber Inventory Management Portal. Reply to this email to reach the network operations team.
    </div>
  </div></body></html>`;
}

/** Recipients: env override first, then every active alert policy's notify list. */
async function resolveRecipients(): Promise<string[]> {
  const envRecipients = splitRecipients(process.env.CRITICAL_LINKS_REPORT_RECIPIENTS);
  if (envRecipients.length) return [...new Set(envRecipients)];
  const policies = await prisma.alertPolicy.findMany({ select: { notifyEmails: true } });
  const fromPolicies = policies.flatMap((policy) => splitRecipients(policy.notifyEmails));
  return [...new Set(fromPolicies)];
}

export const criticalLinksReportService = {
  getCriticalLinks,

  /** Compile and email the report now. Returns delivery status + link count. */
  async sendCriticalLinksReport(options: { recipients?: string[]; trigger?: string; userId?: string | null } = {}) {
    const generatedAt = new Date();
    const links = await getCriticalLinks();
    const recipients = options.recipients?.length ? options.recipients : await resolveRecipients();
    if (!recipients.length) {
      return { status: "NO_RECIPIENTS" as const, criticalLinkCount: links.length };
    }

    const result = await notificationService.sendEmail({
      to: recipients,
      subject: `[Fiber Portal] Weekly Critical Links Report — ${links.length} critical link(s)`,
      text: buildReportText(links, generatedAt),
      html: buildReportHtml(links, generatedAt),
      userId: options.userId ?? null,
      metadata: { kind: METADATA_KIND, trigger: options.trigger ?? "manual", criticalLinkCount: links.length },
    });

    return { ...result, criticalLinkCount: links.length };
  },

  /**
   * Scheduler entry point: only send when the last send is older than the
   * configured interval, so restarts never re-spam stakeholders. The check
   * cadence itself is owned by the bootstrap in lib/db/prisma.ts.
   */
  async runScheduledReportIfDue() {
    const last = await prisma.notificationLog.findFirst({
      where: { status: "SENT", metadataJson: { contains: METADATA_KIND } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < reportIntervalMs()) {
      return { skipped: true as const };
    }
    return this.sendCriticalLinksReport({ trigger: "scheduled" });
  },
};
