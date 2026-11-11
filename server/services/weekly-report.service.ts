import { ResourceStatus, type WeeklyReportSchedule } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { notificationService } from "@/server/services/notification.service";
import {
  buildSummaryEmailHtml,
  buildSummaryEmailText,
  type SummaryRow,
} from "@/lib/reports/report-table-email";
import {
  buildMegaAlertEmailHtml,
  buildMegaAlertEmailText,
  type MegaAlertSection,
} from "@/lib/reports/mega-alert-email";
import { buildWorkbookBuffer, barCell } from "@/lib/reports/report-workbook";
import { connectedComponents, dedupeEdges, orderTopology, type TopoEdge } from "@/lib/telecom/topology-graph";
import { effectiveTopologyRole, isStandaloneDashboardRole } from "@/lib/telecom/topology-role";
import { normalizeSiteCode } from "@/lib/telecom/connection-identity";
import { WEEKLY_REPORT_META, reportMeta, isWeeklyReportKey } from "@/lib/reports/report-meta";

/**
 * Weekly alert reports.
 *
 * ARCHITECTURE (2026-06-29 consolidation):
 *   – Four individual schedules (HIGH_UTIL_LINKS, TOPOLOGY_SYSTEMS, CORE_PTP_LINKS,
 *     CORE_CHAINS) are deprecated and force-disabled by ensureDefaults().
 *   – A single "MEGA_ALERT" schedule replaces them, bundling three sub-reports:
 *       1. Highly Utilised Links
 *       2. Network Vulnerabilities
 *       3. PtP links between core sites  (renamed from "Core PtP Link Utilisation")
 *     The Excel attachment has three tabs — one per sub-report.
 *   – The email body carries inline CSS bar charts (no raw data tables).
 *
 * "Core-to-Core Chain Utilisation" (CORE_CHAINS) is fully retired — it is
 * deprecated but not bundled into the Mega Alert.
 */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const AMPLS_TAG = "A-MPLS";

const MEGA_ALERT_DEFAULT_SUBJECT = "Fiber network statistics";
const MEGA_ALERT_DEFAULT_BODY =
  "Dear All, Please find below the high-level statistics of the fiber network. " +
  "For further details, kindly review the attached workbook.";

// Positive status list avoids the SQLite bind-limit issue at 1 k+ live segments.
const LIVE_RESOURCE_STATUSES = Object.values(ResourceStatus).filter(
  (status) => status !== ResourceStatus.DECOMMISSIONED,
);

interface GatherInput {
  warn: number;
  crit: number;
  minNodes: number;
}

interface GatherResult {
  summaryRows: SummaryRow[];
  detailRows: Record<string, unknown>[];
}

// ── shared helpers ──────────────────────────────────────────────────────────

function splitRecipients(value?: string | null): string[] {
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function round1(value: number): number {
  return Number((value ?? 0).toFixed(1));
}

type LinkWithSites = {
  segmentCode: string;
  utilizationPct: number;
  usedFiberCount: number;
  totalFiberCapacity: number;
  status: unknown;
  segmentDefaultRole: string | null;
  endpointA: { rawSiteCode: string | null; site: { code: string } | null } | null;
  endpointB: { rawSiteCode: string | null; site: { code: string } | null } | null;
};

function endpointLabel(endpoint: LinkWithSites["endpointA"]): string {
  return endpoint?.site?.code ?? endpoint?.rawSiteCode ?? "—";
}

function utilBands(values: number[], warn: number, crit: number) {
  const critCount = values.filter((value) => value >= crit).length;
  const highCount = values.filter((value) => value >= warn && value < crit).length;
  return { critCount, highCount, total: values.length };
}

function linkDetailRows(rows: LinkWithSites[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    Segment: row.segmentCode,
    From: endpointLabel(row.endpointA),
    To: endpointLabel(row.endpointB),
    "Utilization %": round1(row.utilizationPct),
    Used: row.usedFiberCount,
    Total: row.totalFiberCapacity,
    Status: String(row.status),
  }));
}

// ── sub-report 1: highly utilised links ─────────────────────────────────────

async function gatherHighUtilLinks({ warn, crit }: GatherInput): Promise<GatherResult> {
  const rows = await prisma.linkSegment.findMany({
    where: { status: { not: "DECOMMISSIONED" }, utilizationPct: { gte: warn } },
    include: { endpointA: { include: { site: true } }, endpointB: { include: { site: true } } },
    orderBy: { utilizationPct: "desc" },
    take: 1000,
  });
  const filtered = (rows as unknown as LinkWithSites[]).filter(
    (row) => !isStandaloneDashboardRole(row.segmentDefaultRole),
  );
  const bands = utilBands(filtered.map((row) => row.utilizationPct), warn, crit);
  return {
    summaryRows: [
      { label: `Highly utilised links (${warn}–${crit}%)`, value: bands.highCount, tone: "warn" },
      { label: `Critically utilised links (≥ ${crit}%)`, value: bands.critCount, tone: "critical" },
      { label: "Total flagged links", value: bands.total },
    ],
    detailRows: linkDetailRows(filtered),
  };
}

// ── sub-report 2: network vulnerabilities ───────────────────────────────────

interface LoadedSegment {
  id: string;
  segmentCode: string;
  util: number;
  fromKey: string;
  toKey: string;
  fromLabel: string;
  toLabel: string;
  segmentDefaultRole: string | null;
  childTopologyRole: string | null;
  isAmpls: boolean;
}

async function loadLayoutSegments(): Promise<LoadedSegment[]> {
  const segments = await prisma.linkSegment.findMany({
    where: { status: { not: "DECOMMISSIONED" } },
    select: {
      id: true,
      segmentCode: true,
      utilizationPct: true,
      segmentDefaultRole: true,
      endpointA: { select: { rawSiteCode: true, site: { select: { code: true, name: true } } } },
      endpointB: { select: { rawSiteCode: true, site: { select: { code: true, name: true } } } },
      endpointMappings: {
        where: { status: { in: LIVE_RESOURCE_STATUSES } },
        select: { childTopologyRole: true, tag: true },
      },
    },
  });

  return segments
    .map((segment) => {
      const fromKey = normalizeSiteCode(segment.endpointA?.site?.code ?? segment.endpointA?.rawSiteCode) ?? "";
      const toKey = normalizeSiteCode(segment.endpointB?.site?.code ?? segment.endpointB?.rawSiteCode) ?? "";
      const childTopologyRole =
        segment.endpointMappings.find((mapping) => mapping.childTopologyRole?.trim())?.childTopologyRole ?? null;
      const isAmpls = segment.endpointMappings.some(
        (mapping) => (mapping.tag ?? "").trim().toUpperCase() === AMPLS_TAG,
      );
      return {
        id: segment.id,
        segmentCode: segment.segmentCode,
        util: segment.utilizationPct,
        fromKey,
        toKey,
        fromLabel: segment.endpointA?.site?.name ?? segment.endpointA?.site?.code ?? fromKey,
        toLabel: segment.endpointB?.site?.name ?? segment.endpointB?.site?.code ?? toKey,
        segmentDefaultRole: segment.segmentDefaultRole,
        childTopologyRole,
        isAmpls,
      } satisfies LoadedSegment;
    })
    .filter((segment) => segment.fromKey && segment.toKey);
}

function toEdge(segment: LoadedSegment): TopoEdge<string> {
  return {
    id: segment.id,
    ref: segment.id,
    fromKey: segment.fromKey,
    toKey: segment.toKey,
    fromLabel: segment.fromLabel,
    toLabel: segment.toLabel,
  };
}

async function loadCoreKeys(): Promise<Set<string>> {
  const sites = await prisma.site.findMany({ where: { isCoreSite: true }, select: { code: true } });
  return new Set(sites.map((site) => normalizeSiteCode(site.code)).filter((code): code is string => Boolean(code)));
}

async function gatherTopologySystems({ minNodes }: GatherInput): Promise<GatherResult> {
  const segments = await loadLayoutSegments();
  const labelByKey = new Map<string, string>();
  for (const segment of segments) {
    labelByKey.set(segment.fromKey, segment.fromLabel);
    labelByKey.set(segment.toKey, segment.toLabel);
  }
  const roleOf = (segment: LoadedSegment) =>
    effectiveTopologyRole({
      childTopologyRole: segment.childTopologyRole,
      segmentDefaultRole: segment.segmentDefaultRole,
    }).role;

  const detailRows: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};

  const groups: Array<[string, string, boolean]> = [
    ["SPUR", "Spur", false],
    ["SPUR_CHAIN", "Spur chain", false],
    ["SINGLE_HOMED", "Single-homed ring (A-MPLS)", true],
    ["SUBRING", "Subring (A-MPLS)", true],
  ];
  for (const [role, label, amplsOnly] of groups) {
    const edges = segments
      .filter((segment) => roleOf(segment) === role && (!amplsOnly || segment.isAmpls))
      .map(toEdge);
    const components = connectedComponents(dedupeEdges(edges));
    counts[role] = components.length;
    components.forEach((component, index) => {
      const sites = [...component.nodeKeys]
        .map((key) => labelByKey.get(key) ?? key)
        .sort((a, b) => a.localeCompare(b));
      detailRows.push({
        Type: label,
        "System #": index + 1,
        Nodes: component.nodeKeys.size,
        Sites: sites.join(" → "),
      });
    });
  }

  const ampEdges = segments.filter((segment) => segment.isAmpls).map(toEdge);
  const ampComponents = orderTopology(ampEdges);
  const bigRings = ampComponents.filter((component) => component.isClosedRing && component.nodeKeys.length > minNodes);
  counts.AMPLS_RINGS = bigRings.length;
  bigRings.forEach((ring, index) => {
    detailRows.push({
      Type: `A-MPLS ring (> ${minNodes} nodes)`,
      "System #": index + 1,
      Nodes: ring.nodeKeys.length,
      Sites: ring.nodeLabels.join(" → "),
    });
  });

  return {
    summaryRows: [
      { label: "Spurs", value: counts.SPUR ?? 0, tone: "warn" },
      { label: "Spur chains", value: counts.SPUR_CHAIN ?? 0, tone: "warn" },
      { label: "Single-homed rings (A-MPLS)", value: counts.SINGLE_HOMED ?? 0, tone: "warn" },
      { label: "Subrings (A-MPLS)", value: counts.SUBRING ?? 0, tone: "warn" },
      { label: `A-MPLS rings (> ${minNodes} nodes)`, value: counts.AMPLS_RINGS ?? 0, tone: "critical" },
    ],
    detailRows,
  };
}

// ── sub-report 3: PtP links between core sites ───────────────────────────────
// (Renamed from "Core PtP Link Utilisation")

async function gatherPtpLinks({ warn, crit }: GatherInput): Promise<GatherResult> {
  const rows = await prisma.linkSegment.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      utilizationPct: { gte: warn },
      endpointA: { site: { isCoreSite: true } },
      endpointB: { site: { isCoreSite: true } },
    },
    include: { endpointA: { include: { site: true } }, endpointB: { include: { site: true } } },
    orderBy: { utilizationPct: "desc" },
    take: 1000,
  });
  const links = rows as unknown as LinkWithSites[];
  const bands = utilBands(links.map((row) => row.utilizationPct), warn, crit);
  return {
    summaryRows: [
      { label: `Highly utilised PtP links (${warn}–${crit}%)`, value: bands.highCount, tone: "warn" },
      { label: `Critically utilised PtP links (≥ ${crit}%)`, value: bands.critCount, tone: "critical" },
      { label: "Total flagged PtP links", value: bands.total },
    ],
    detailRows: linkDetailRows(links),
  };
}

// ── deprecated: core-to-core chains (kept for manual API backward compat) ────

async function gatherCoreChains({ warn, crit }: GatherInput): Promise<GatherResult> {
  const [segments, coreKeys] = await Promise.all([loadLayoutSegments(), loadCoreKeys()]);
  const utilById = new Map(segments.map((segment) => [segment.id, segment.util]));
  const codeById = new Map(segments.map((segment) => [segment.id, segment.segmentCode]));

  const ampEdges = segments.filter((segment) => segment.isAmpls).map(toEdge);
  const components = orderTopology(ampEdges);

  type Chain = { from: string; to: string; intermediates: number; worst: number; worstSeg: string; path: string };
  const chains: Chain[] = [];

  for (const component of components) {
    const coreIndexes = component.nodeKeys
      .map((key, index) => (coreKeys.has(key) ? index : -1))
      .filter((index) => index >= 0);
    if (coreIndexes.length < 2) continue;
    const first = coreIndexes[0];
    const last = coreIndexes[coreIndexes.length - 1];
    if (last - first < 2) continue;

    const arcEdges = component.orderedEdges.slice(first, last);
    if (!arcEdges.length) continue;

    let worst = 0;
    let worstSeg = "";
    for (const edge of arcEdges) {
      const util = utilById.get(String(edge.ref)) ?? 0;
      if (util >= worst) { worst = util; worstSeg = codeById.get(String(edge.ref)) ?? ""; }
    }
    chains.push({
      from: component.nodeLabels[first],
      to: component.nodeLabels[last],
      intermediates: last - first - 1,
      worst,
      worstSeg,
      path: component.nodeLabels.slice(first, last + 1).join(" → "),
    });
  }

  const flagged = chains.filter((chain) => chain.worst >= warn).sort((a, b) => b.worst - a.worst);
  const bands = utilBands(flagged.map((chain) => chain.worst), warn, crit);

  return {
    summaryRows: [
      { label: `Highly utilised core chains (${warn}–${crit}%)`, value: bands.highCount, tone: "warn" },
      { label: `Critically utilised core chains (≥ ${crit}%)`, value: bands.critCount, tone: "critical" },
      { label: "Total core chains flagged", value: bands.total },
    ],
    detailRows: flagged.map((chain) => ({
      "Core chain": `${chain.from} → … → ${chain.to}`,
      "Intermediate sites": chain.intermediates,
      "Worst util %": round1(chain.worst),
      "Worst hop": chain.worstSeg,
      Path: chain.path,
    })),
  };
}

// ── individual-report gatherer map (backward compat for manual sends) ────────

const GATHERERS: Record<string, (input: GatherInput) => Promise<GatherResult>> = {
  HIGH_UTIL_LINKS: gatherHighUtilLinks,
  TOPOLOGY_SYSTEMS: gatherTopologySystems,
  CORE_PTP_LINKS: gatherPtpLinks,
  CORE_CHAINS: gatherCoreChains,
};

// ── mega alert: unified bundled execution ────────────────────────────────────

async function buildMegaAlertReport(schedule: WeeklyReportSchedule) {
  const warn = schedule.warnThresholdPct ?? 80;
  const crit = schedule.critThresholdPct ?? 95;
  const minNodes = schedule.minNodes ?? 8;
  const generatedAt = new Date();

  // Run all three sub-reports concurrently.
  const [highUtil, topology, ptpLinks] = await Promise.all([
    gatherHighUtilLinks({ warn, crit, minNodes }),
    gatherTopologySystems({ warn, crit, minNodes }),
    gatherPtpLinks({ warn, crit, minNodes }),
  ]);

  const sections: MegaAlertSection[] = [
    { title: "Highly Utilised Links", summaryRows: highUtil.summaryRows },
    { title: "Network Vulnerabilities", summaryRows: topology.summaryRows },
    { title: "PtP links between core sites", summaryRows: ptpLinks.summaryRows },
  ];

  const emailSubject = schedule.emailSubject?.trim() || MEGA_ALERT_DEFAULT_SUBJECT;
  const emailBody = schedule.emailBody?.trim() || MEGA_ALERT_DEFAULT_BODY;

  const html = buildMegaAlertEmailHtml({ emailBody, sections, generatedAt });
  const text = buildMegaAlertEmailText({ emailBody, sections, generatedAt });

  // Three-tab workbook: one tab per sub-report (no chart objects).
  const workbook = await buildWorkbookBuffer([
    { name: "Highly Utilised Links", rows: highUtil.detailRows },
    { name: "Network Vulnerabilities", rows: topology.detailRows },
    { name: "PtP links between core sites", rows: ptpLinks.detailRows },
  ]);

  const fileName = `fiber-network-statistics-${generatedAt.toISOString().slice(0, 10)}.xlsx`;

  return {
    meta: reportMeta("MEGA_ALERT")!,
    subject: emailSubject,
    html,
    text,
    workbook,
    fileName,
    summaryRows: [...highUtil.summaryRows, ...topology.summaryRows, ...ptpLinks.summaryRows],
  };
}

// ── individual report builder (deprecated — kept for manual-send backward compat) ──

async function buildReport(reportKey: string, schedule: WeeklyReportSchedule) {
  if (reportKey === "MEGA_ALERT") return buildMegaAlertReport(schedule);

  const meta = reportMeta(reportKey);
  if (!meta) throw new Error(`Unknown weekly report: ${reportKey}`);
  const warn = schedule.warnThresholdPct ?? meta.defaultWarn ?? 80;
  const crit = schedule.critThresholdPct ?? meta.defaultCrit ?? 95;
  const minNodes = schedule.minNodes ?? meta.defaultMinNodes ?? 8;
  const generatedAt = new Date();

  const { summaryRows, detailRows } = await GATHERERS[reportKey]({ warn, crit, minNodes });

  const numericMax = Math.max(1, ...summaryRows.map((row) => (typeof row.value === "number" ? row.value : 0)));
  const graphRows = summaryRows.map((row) => ({
    Category: row.label,
    Count: row.value,
    Chart: barCell(typeof row.value === "number" ? row.value : 0, numericMax),
  }));

  const html = buildSummaryEmailHtml({ title: meta.name, subtitle: meta.description, generatedAt, summaryRows });
  const text = buildSummaryEmailText({ title: meta.name, generatedAt, summaryRows });
  const workbook = await buildWorkbookBuffer([
    { name: "Data", rows: detailRows },
    { name: "Graphs", rows: graphRows },
  ]);
  const fileName = `${reportKey.toLowerCase()}-${generatedAt.toISOString().slice(0, 10)}.xlsx`;
  const subject = `[Fiber Portal] Weekly ${meta.name}`;

  return { meta, subject, html, text, workbook, fileName, summaryRows };
}

// ── schedule persistence ─────────────────────────────────────────────────────

async function ensureDefaults(): Promise<void> {
  for (const meta of WEEKLY_REPORT_META) {
    await prisma.weeklyReportSchedule.upsert({
      where: { reportKey: meta.reportKey },
      // Deprecated schedules are force-disabled and their display name is refreshed
      // (catches the PtP rename). Active schedules are left untouched so admin edits persist.
      update: meta.deprecated ? { enabled: false, name: meta.name } : {},
      create: {
        reportKey: meta.reportKey,
        name: meta.name,
        enabled: false,
        dayOfWeek: 1,
        sendHour: 7,
        sendMinute: 0,
        warnThresholdPct: meta.defaultWarn,
        critThresholdPct: meta.defaultCrit,
        minNodes: meta.defaultMinNodes,
      },
    });
  }
}

async function fetchSchedule(reportKey: string): Promise<WeeklyReportSchedule> {
  await ensureDefaults();
  const schedule = await prisma.weeklyReportSchedule.findUnique({ where: { reportKey } });
  if (!schedule) throw new Error(`Unknown weekly report: ${reportKey}`);
  return schedule;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Math.trunc(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function trimmedOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

// ── recipients ────────────────────────────────────────────────────────────────

async function resolveRecipients(schedule: WeeklyReportSchedule): Promise<string[]> {
  const list = splitRecipients(schedule.recipients);
  if (schedule.recipientGroupCode) {
    const group = await prisma.recipientGroup.findUnique({
      where: { code: schedule.recipientGroupCode },
      include: { members: { select: { email: true } } },
    });
    if (group) list.push(...group.members.map((member) => member.email));
  }
  if (schedule.includeConfigured) {
    const [users, policies] = await Promise.all([
      prisma.user.findMany({ where: { isActive: true }, select: { email: true } }),
      prisma.alertPolicy.findMany({ where: { enabled: true }, select: { notifyEmails: true } }),
    ]);
    list.push(...users.map((user) => user.email));
    list.push(...policies.flatMap((policy) => splitRecipients(policy.notifyEmails)));
  }
  return [...new Set(list.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

// ── send ──────────────────────────────────────────────────────────────────────

export interface SendReportResult {
  reportKey: string;
  status: "SENT" | "FAILED" | "NOT_CONFIGURED" | "NO_RECIPIENTS";
  recipients: string[];
  error?: string;
}

async function sendReport(
  reportKey: string,
  options: { recipients?: string[]; trigger?: string; userId?: string | null } = {},
): Promise<SendReportResult> {
  if (!isWeeklyReportKey(reportKey)) throw new Error(`Unknown weekly report: ${reportKey}`);
  const schedule = await fetchSchedule(reportKey);
  const built = await buildReport(reportKey, schedule);
  const recipients = options.recipients?.length ? options.recipients : await resolveRecipients(schedule);

  if (!recipients.length) {
    await prisma.weeklyReportSchedule.update({ where: { reportKey }, data: { lastStatus: "NO_RECIPIENTS" } });
    return { reportKey, status: "NO_RECIPIENTS", recipients: [] };
  }

  const result = await notificationService.sendEmail({
    to: recipients,
    subject: built.subject,
    text: built.text,
    html: built.html,
    attachments: [{ filename: built.fileName, content: built.workbook, contentType: XLSX_MIME }],
    userId: options.userId ?? null,
    metadata: { kind: `weekly-report:${reportKey}`, trigger: options.trigger ?? "manual" },
  });

  await prisma.weeklyReportSchedule.update({
    where: { reportKey },
    data: { lastSentAt: new Date(), lastStatus: result.status },
  });

  return { reportKey, status: result.status, recipients: result.recipients, error: result.error };
}

// ── scheduler ─────────────────────────────────────────────────────────────────

function scheduledThisWeek(now: Date, dayOfWeek: number, hour: number, minute: number): Date {
  const target = new Date(now);
  target.setDate(target.getDate() + (dayOfWeek - target.getDay()));
  target.setHours(hour, minute, 0, 0);
  return target;
}

async function runDueSchedules(): Promise<Array<{ reportKey: string; status: string }>> {
  const schedules = await listSchedules();
  const now = new Date();
  const results: Array<{ reportKey: string; status: string }> = [];

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const due = scheduledThisWeek(now, schedule.dayOfWeek, schedule.sendHour, schedule.sendMinute);
    if (now < due) continue;
    if (schedule.lastSentAt && schedule.lastSentAt >= due) continue;

    let status = "ERROR";
    try {
      const result = await sendReport(schedule.reportKey, { trigger: "scheduled" });
      status = result.status;
    } catch (error) {
      console.error(`[weekly-report] ${schedule.reportKey} send failed:`, error);
    }
    await prisma.weeklyReportSchedule.update({
      where: { id: schedule.id },
      data: { lastSentAt: new Date(), lastStatus: status },
    });
    results.push({ reportKey: schedule.reportKey, status });
  }

  return results;
}

async function listSchedules(): Promise<WeeklyReportSchedule[]> {
  await ensureDefaults();
  return prisma.weeklyReportSchedule.findMany({ orderBy: { reportKey: "asc" } });
}

async function saveSchedule(input: Record<string, unknown>): Promise<WeeklyReportSchedule> {
  const reportKey = String(input.reportKey ?? "");
  const meta = reportMeta(reportKey);
  if (!meta) throw new Error("Unknown weekly report.");

  const data = {
    enabled: Boolean(input.enabled),
    dayOfWeek: clampInt(input.dayOfWeek, 0, 6, 1),
    sendHour: clampInt(input.sendHour, 0, 23, 7),
    sendMinute: clampInt(input.sendMinute, 0, 59, 0),
    warnThresholdPct: meta.usesThreshold ? numberOrNull(input.warnThresholdPct) : null,
    critThresholdPct: meta.usesThreshold ? numberOrNull(input.critThresholdPct) : null,
    minNodes: meta.usesMinNodes
      ? numberOrNull(input.minNodes) === null
        ? null
        : clampInt(input.minNodes, 0, 1000, meta.defaultMinNodes ?? 8)
      : null,
    recipients: trimmedOrNull(input.recipients),
    recipientGroupCode: trimmedOrNull(input.recipientGroupCode),
    includeConfigured: Boolean(input.includeConfigured),
    emailSubject: trimmedOrNull(input.emailSubject),
    emailBody: trimmedOrNull(input.emailBody),
  };

  return prisma.weeklyReportSchedule.upsert({
    where: { reportKey },
    update: data,
    create: { reportKey, name: meta.name, ...data },
  });
}

export const weeklyReportService = {
  ensureDefaults,
  listSchedules,
  saveSchedule,
  buildReport,
  sendReport,
  runDueSchedules,
};
