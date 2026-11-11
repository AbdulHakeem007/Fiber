import { Activity, AlertTriangle, BarChart3, Cable, Database, FileBarChart, GitBranch, Gauge, Info, MapPinned, Server, ShieldAlert } from "lucide-react";
import { TopLinksTable } from "@/components/dashboard/top-links-table";
import { NetworkLayoutMetricsCard } from "@/components/dashboard/network-layout-metrics";
import { MonthlyInfrastructureGrowthMetric } from "@/components/dashboard/monthly-infrastructure-growth-metric";
import { IntraSiteSaturationRotator } from "@/components/dashboard/intra-site-saturation-rotator";
import { ActiveServicesFootprint } from "@/components/dashboard/active-services-footprint";
import { getIntraSiteSaturationSnapshot, type ServiceFootprintBar } from "@/server/services/intra-site-saturation.service";
import { getCoreDcGridSnapshot } from "@/server/services/core-dc-grid.service";
import { getMonthlyInfrastructureGrowthMetrics } from "@/server/services/monthly-infrastructure-growth.service";
import { attachmentService } from "@/server/services/attachment.service";
import {
  KpiCard,
  RadialGauge,
  AllocationStackedBars,
  FileStatusBars,
  type KpiCardData,
  type AllocationBar,
  type ExchangeRow,
} from "@/components/dashboard/dashboard-overview";
import { ExchangeGridRotator } from "@/components/dashboard/exchange-grid-rotator";
import { prisma } from "@/lib/db/prisma";
import { ResourceStatus } from "@prisma/client";
import { matchesRegionPrefix, REGION_OPTIONS } from "@/lib/config/regions";
import { utilizationBand } from "@/lib/config/utilization-thresholds";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { normalizeSiteCode } from "@/lib/telecom/connection-identity";
import { computeNetworkLayoutMetrics, type LayoutSegmentInput } from "@/lib/telecom/network-layout-metrics";
import { isStandaloneDashboardRole } from "@/lib/telecom/topology-role";
import { createReadThroughCache } from "@/lib/cache/read-through-cache";


// Every live (non-decommissioned) ResourceStatus, expressed POSITIVELY. Used for
// the nested endpointMappings relation filter below: a `status: { not: … }`
// negation blocks Prisma from chunking the `segmentId IN (…)` list once it grows
// past SQLite's bind-parameter limit (hit at scale, e.g. 1k+ live segments), so we
// give Prisma a splittable positive `in` instead. Derived from the enum so a new
// status is automatically included.
const LIVE_RESOURCE_STATUSES = Object.values(ResourceStatus).filter((status) => status !== ResourceStatus.DECOMMISSIONED);

function fiberCountFromLabel(label?: string | null, fiberNumbersJson?: string | null): number {
  const jsonNumbers = String(fiberNumbersJson ?? "").match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (jsonNumbers.length) return new Set(jsonNumbers).size;
  const numbers = String(label ?? "").replace(/\([^)]*\)/g, " ").match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (numbers.length >= 2) return Math.max(1, Math.abs(numbers[1] - numbers[0]) + 1);
  if (numbers.length === 1) return 1;
  return 0;
}

function childFiberStats(mappings: Array<{ localPortLabel: string | null; farPortLabel: string | null; fiberNumbersJson: string | null; serviceCode: string | null; status: string }>) {
  let total = 0;
  let used = 0;
  let reserved = 0;
  let faulty = 0;
  for (const mapping of mappings) {
    const count = fiberCountFromLabel(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson);
    const status = String(mapping.status ?? "").toUpperCase();
    total += count;
    if (mapping.serviceCode?.trim() || status === "USED" || status === "ACTIVE") used += count;
    else if (status === "RESERVED") reserved += count;
    else if (status === "FAULTY") faulty += count;
  }
  return { total, used, reserved, faulty, available: Math.max(0, total - used - reserved - faulty) };
}

function readablePairKey(siteA?: string | null, siteB?: string | null, fallback?: string | null) {
  const a = displaySiteLabel(siteA);
  const b = displaySiteLabel(siteB);
  if (a !== "-" && b !== "-") return `${a} ↔ ${b}`;
  return displaySiteLabel(fallback ?? "UNKNOWN");
}

function dashboardLiveSegmentWhere() {
  return {
    AND: [
      { status: { not: "DECOMMISSIONED" as const } },
      ...(process.env.FEATURE_DEMO_DATA === "true" ? [] : [{ NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }]),
    ],
  };
}

async function loadDashboardReadModel() {
  const liveSegmentWhere = dashboardLiveSegmentWhere();
  const liveSplitterWhere = { status: { not: "DECOMMISSIONED" as const } };
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    segments,
    openAlerts,
    recentAudit,
    coreSiteCount,
    importWarnings,
    ospSplitterCount,
    ispSplitterCount,
    splitterTotal,
    splitterEmpty,
    splitterPortAgg,
    splitterCapped,
    distinctServiceRows,
    newCircuitRows,
  ] = await Promise.all([
    prisma.linkSegment.findMany({
      where: liveSegmentWhere,
      select: {
        id: true,
        segmentCode: true,
        sitePairKey: true,
        status: true,
        totalFiberCapacity: true,
        fiberCount: true,
        usableFiberCapacity: true,
        usedFiberCount: true,
        reservedFiberCount: true,
        faultyFiberCount: true,
        availableFiberCount: true,
        utilizationPct: true,
        cableId: true,
        isPartialTermination: true,
        segmentDefaultRole: true,
        endpointA: { select: { siteId: true, portGroupId: true, rawSiteCode: true, site: { select: { code: true, name: true } } } },
        endpointB: { select: { siteId: true, portGroupId: true, rawSiteCode: true, site: { select: { code: true, name: true } } } },
        endpointMappings: {
          where: { status: { in: LIVE_RESOURCE_STATUSES } },
          select: {
            localPortLabel: true,
            farPortLabel: true,
            fiberNumbersJson: true,
            serviceCode: true,
            status: true,
            localSiteCode: true,
            farSiteCode: true,
            farEndpointLabel: true,
            childTopologyRole: true,
            tag: true,
          },
        },
      },
      take: 5000,
    }),
    prisma.alertEvent.findMany({
      where: { state: { in: ["OPEN", "ACKNOWLEDGED", "SUPPRESSED"] } },
      include: { segment: { include: { importBatch: { select: { sourceSystem: true } } } } },
      orderBy: { lastSeenAt: "desc" },
      take: 20,
    }),
    prisma.auditLog.findMany({
      include: { changedBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.site.count({ where: { isCoreSite: true } }),
    prisma.importIssue.count({ where: { resolved: false, severity: { in: ["WARNING", "ERROR", "CRITICAL"] } } }),
    prisma.splitter.count({ where: { scope: "OSP", status: { not: "DECOMMISSIONED" } } }),
    prisma.splitter.count({ where: { scope: "ISP", status: { not: "DECOMMISSIONED" } } }),
    prisma.splitter.count({ where: liveSplitterWhere }),
    prisma.splitter.count({ where: { AND: [liveSplitterWhere, { configuredOutputPorts: { lte: 0 } }] } }),
    prisma.splitter.aggregate({ where: liveSplitterWhere, _sum: { configuredOutputPorts: true, outputPortCapacity: true } }),
    prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM "Splitter" WHERE "status" != 'DECOMMISSIONED' AND "outputPortCapacity" IS NOT NULL AND "outputPortCapacity" > 0 AND "configuredOutputPorts" >= "outputPortCapacity"`,
    ).then((rows) => Number(rows[0]?.n ?? 0)).catch(() => 0),
    prisma.segmentEndpointMapping.findMany({
      where: { status: { not: "DECOMMISSIONED" }, serviceCode: { not: null } },
      select: { serviceCode: true },
      distinct: ["serviceCode"],
    }),
    prisma.segmentEndpointMapping.count({
      where: { status: { not: "DECOMMISSIONED" }, serviceCode: { not: null }, createdAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  return {
    segments,
    openAlerts,
    recentAudit,
    coreSiteCount,
    importWarnings,
    ospSplitterCount,
    ispSplitterCount,
    splitterTotal,
    splitterEmpty,
    splitterPortAgg,
    splitterCapped,
    distinctServiceRows,
    newCircuitRows,
  };
}

const dashboardReadModelCache = createReadThroughCache<Awaited<ReturnType<typeof loadDashboardReadModel>>>({
  ttlMs: 120_000,
  maxEntries: 2,
});

export default async function DashboardPage({ searchParams }: { searchParams?: Promise<{ utilSearch?: string; utilStatus?: string; minUtil?: string; regionPrefix?: string }> }) {
  const params = await searchParams;
  const utilSearch = params?.utilSearch?.trim().toUpperCase() ?? "";
  const utilStatus = params?.utilStatus?.trim() ?? "ALL";
  const minUtil = params?.minUtil ? Number(params.minUtil) : null;
  const regionPrefix = params?.regionPrefix?.trim() ?? "";

  const intraSnapshotPromise = getIntraSiteSaturationSnapshot();
  const coreDcGridPromise = getCoreDcGridSnapshot();
  const monthlyInfrastructureGrowthPromise = getMonthlyInfrastructureGrowthMetrics();

  const {
    segments,
    openAlerts,
    recentAudit,
    coreSiteCount,
    importWarnings,
    ospSplitterCount,
    ispSplitterCount,
    splitterTotal,
    splitterEmpty,
    splitterPortAgg,
    splitterCapped,
    distinctServiceRows,
    newCircuitRows,
  } = await dashboardReadModelCache.get("dashboard-read-model", loadDashboardReadModel);

  const splitterRunRate = {
    total: splitterTotal,
    empty: splitterEmpty,
    capped: splitterCapped,
    partial: Math.max(0, splitterTotal - splitterEmpty - splitterCapped),
    configuredPorts: splitterPortAgg._sum.configuredOutputPorts ?? 0,
    capacityPorts: splitterPortAgg._sum.outputPortCapacity ?? 0,
  };

  const coreDcGrid = await coreDcGridPromise;
  const exchangeRows = coreDcGrid.rows;
  const activeCircuitCount = distinctServiceRows.length;
  const splitterAllocated = splitterRunRate.total - splitterRunRate.empty;
  const regionSegments = regionPrefix
    ? segments.filter((segment) => matchesRegionPrefix(segment.endpointA.site?.code, regionPrefix) || matchesRegionPrefix(segment.endpointB.site?.code, regionPrefix))
    : segments;
  const liveAlerts = openAlerts.filter((alert) => process.env.FEATURE_DEMO_DATA === "true" || alert.segment?.importBatch?.sourceSystem !== "DEMO_SEED");
  const siteIds = new Set<string>();
  const portGroupIds = new Set<string>();
  const pairStats = new Map<string, { sitePair: string; used: number; reserved: number; available: number; faulty: number; total: number }>();
  // Normal-fiber-only aggregation feeding the "Top Utilized Links" table. Segments
  // tagged with a standalone dashboard role (Intra-site / GPON segment) are excluded
  // here because splitter/GPON feeds are one-to-many topologies that sit at critical
  // utilization and skew the inter-site site-pair ranking. Every other dashboard
  // metric (gauges, KPIs, allocation) keeps using the full pairStats above.
  const linkPairStats = new Map<string, { sitePair: string; used: number; reserved: number; available: number; faulty: number; total: number; search: Set<string>; aCode: string; bCode: string }>();

  for (const segment of regionSegments) {
    if (segment.endpointA.siteId) siteIds.add(segment.endpointA.siteId);
    if (segment.endpointB.siteId) siteIds.add(segment.endpointB.siteId);
    if (segment.endpointA.portGroupId) portGroupIds.add(segment.endpointA.portGroupId);
    if (segment.endpointB.portGroupId) portGroupIds.add(segment.endpointB.portGroupId);

    const endpointAName = segment.endpointA.site?.name ?? segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode;
    const endpointBName = segment.endpointB.site?.name ?? segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode;
    const pairKey = readablePairKey(endpointAName, endpointBName, segment.sitePairKey);
    const stat = pairStats.get(pairKey) ?? { sitePair: pairKey, used: 0, reserved: 0, available: 0, faulty: 0, total: 0 };

    // Dashboard utilization should be calculated from committed child fiber/port mappings where available.
    // The parent segment counters can be stale after imports/manual corrections, while child rows are the actual
    // service-carrying fibers. 1-2 = two fibers; 1 = one fiber.
    const childStats = childFiberStats(segment.endpointMappings);
    const contribution = childStats.total > 0
      ? { total: childStats.total, used: childStats.used, reserved: childStats.reserved, available: childStats.available, faulty: childStats.faulty }
      : (() => {
          const capacity = segment.totalFiberCapacity || segment.fiberCount || 0;
          return {
            total: capacity,
            used: segment.usedFiberCount,
            reserved: segment.reservedFiberCount,
            available: Math.max(0, capacity - segment.usedFiberCount - segment.reservedFiberCount - segment.faultyFiberCount),
            faulty: segment.faultyFiberCount,
          };
        })();
    stat.total += contribution.total;
    stat.used += contribution.used;
    stat.reserved += contribution.reserved;
    stat.available += contribution.available;
    stat.faulty += contribution.faulty;
    pairStats.set(pairKey, stat);

    // Only normal fiber segments feed the Top Utilized Links ranking.
    if (!isStandaloneDashboardRole(segment.segmentDefaultRole)) {
      // Site codes used to deep-link a top-link row into the ODF Mappings view
      // (filtered to mappings between exactly these two endpoints). Prefer the
      // canonical Site.code; fall back to the raw imported code.
      const aCode = segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode ?? "";
      const bCode = segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode ?? "";
      const linkStat = linkPairStats.get(pairKey) ?? { sitePair: pairKey, used: 0, reserved: 0, available: 0, faulty: 0, total: 0, search: new Set<string>(), aCode, bCode };
      linkStat.total += contribution.total;
      linkStat.used += contribution.used;
      linkStat.reserved += contribution.reserved;
      linkStat.available += contribution.available;
      linkStat.faulty += contribution.faulty;
      // Accumulate searchable identifiers so the Top-Links search box matches by
      // Site ID / raw site code / sitePairKey / segment code — not only the
      // friendly display label (which was the reason searches returned nothing).
      for (const token of [
        pairKey,
        endpointAName,
        endpointBName,
        segment.endpointA.site?.code,
        segment.endpointA.rawSiteCode,
        segment.endpointB.site?.code,
        segment.endpointB.rawSiteCode,
        segment.sitePairKey,
        segment.segmentCode,
      ]) {
        const normalized = String(token ?? "").trim().toUpperCase();
        if (normalized) linkStat.search.add(normalized);
      }
      linkPairStats.set(pairKey, linkStat);
    }
  }

  const aggregateStats = regionSegments.reduce((acc, segment) => {
    const childStats = childFiberStats(segment.endpointMappings);
    if (childStats.total > 0) {
      acc.used += childStats.used + childStats.reserved;
      acc.available += childStats.available;
    } else {
      const capacity = segment.totalFiberCapacity || segment.fiberCount || 0;
      acc.used += segment.usedFiberCount + segment.reservedFiberCount;
      acc.available += Math.max(0, capacity - segment.usedFiberCount - segment.reservedFiberCount - segment.faultyFiberCount);
    }
    return acc;
  }, { used: 0, available: 0 });
  const usedFibers = aggregateStats.used;
  const spareFibers = aggregateStats.available;
  const globalSaturationPct = (usedFibers + spareFibers) > 0
    ? Math.round((usedFibers / (usedFibers + spareFibers)) * 100)
    : 0;
  const dataGaps =
    regionSegments.filter((segment) => !segment.endpointB.siteId).length +
    regionSegments.filter((segment) => !segment.cableId).length +
    regionSegments.filter((segment) => segment.isPartialTermination).length +
    importWarnings;

  const allTopRows = [...linkPairStats.values()]
    .map((row) => {
      const utilizationPct = row.total ? Math.round(((row.used + row.reserved) / Math.max(1, row.total - row.faulty)) * 100) : 0;
      return {
        sitePair: row.sitePair,
        utilizationPct,
        used: row.used,
        total: row.total,
        status: utilizationBand(utilizationPct),
        searchText: [...row.search].join(" "),
        nearSiteCode: row.aCode,
        farSiteCode: row.bCode,
      };
    })
    // Top Utilized Links is restricted strictly to the Critical and High bands.
    .filter((row) => row.status === "Critical" || row.status === "High")
    // Search matches any accumulated identifier (Site ID, raw code, sitePairKey,
    // segment code, friendly label) — utilSearch is already trimmed + uppercased.
    .filter((row) => !utilSearch || row.searchText.includes(utilSearch))
    .filter((row) => utilStatus === "ALL" || row.status === utilStatus)
    .filter((row) => minUtil === null || Number.isNaN(minUtil) || row.utilizationPct >= minUtil)
    .sort((a, b) => b.utilizationPct - a.utilizationPct || b.total - a.total);
  const topRows = allTopRows.slice(0, 20);

  // Alert focus is fed by real fault streams, not only the alert engine: open
  // AlertEvents plus live inventory faults (faulty fibers, un-terminated stubs /
  // open tails, missing far-end mappings) and unresolved import validation
  // exceptions. This keeps the panel populated even before the alert engine has
  // generated any AlertEvent rows.
  type AlertFocusItem = { id: string; title: string; severity: "CRITICAL" | "WARNING" };
  const segLabel = (segment: (typeof regionSegments)[number]) =>
    readablePairKey(
      segment.endpointA.site?.name ?? segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode,
      segment.endpointB.site?.name ?? segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode,
      segment.sitePairKey,
    );
  const alertFocusItems: AlertFocusItem[] = [
    ...liveAlerts.map((alert) => ({
      id: alert.id,
      title: alert.title,
      severity: (alert.severity === "CRITICAL" ? "CRITICAL" : "WARNING") as "CRITICAL" | "WARNING",
    })),
    ...regionSegments
      .filter((segment) => segment.faultyFiberCount > 0)
      .slice(0, 4)
      .map((segment) => ({ id: `faulty-${segment.id}`, title: `Faulty fibers — ${segLabel(segment)} (${segment.faultyFiberCount})`, severity: "CRITICAL" as const })),
    ...regionSegments
      .filter((segment) => segment.isPartialTermination)
      .slice(0, 4)
      .map((segment) => ({ id: `stub-${segment.id}`, title: `Un-terminated stub / open tail — ${segLabel(segment)}`, severity: "WARNING" as const })),
    ...regionSegments
      .filter((segment) => !segment.endpointB.siteId)
      .slice(0, 3)
      .map((segment) => ({ id: `farend-${segment.id}`, title: `Missing far-end mapping — ${segLabel(segment)}`, severity: "WARNING" as const })),
    ...(importWarnings > 0
      ? [{ id: "import-exceptions", title: `${importWarnings} unresolved import validation exception(s)`, severity: "WARNING" as const }]
      : []),
  ];
  alertFocusItems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "CRITICAL" ? -1 : 1));
  const alertFocus = alertFocusItems.slice(0, 8);
  const hasLiveInventory = regionSegments.length > 0;

  // ODF port saturation distribution: bucket every live site-pair by its
  // utilization band so operators see the capacity spread at a glance.
  const saturationCounts = { Critical: 0, High: 0, Moderate: 0, Normal: 0 };
  for (const row of [...pairStats.values()]) {
    const pct = row.total ? Math.round(((row.used + row.reserved) / Math.max(1, row.total - row.faulty)) * 100) : 0;
    saturationCounts[utilizationBand(pct)] += 1;
  }
  // ── Tier A: executive KPI cards ──
  const tierAKpis: KpiCardData[] = [
    {
      title: "Active Circuits",
      value: activeCircuitCount.toLocaleString(),
      targetLabel: "live provisioned services",
      subLabel: `${pairStats.size} live site pairs`,
      trendDirection: newCircuitRows > 0 ? "up" : "flat",
      trendLabel: `${newCircuitRows} new (30d)`,
      icon: Activity,
      tone: "sky",
    },
    {
      title: "Global ODF Saturation",
      value: `${globalSaturationPct}%`,
      targetLabel: "aggregate port utilization",
      targetPct: globalSaturationPct,
      subLabel: `${usedFibers.toLocaleString()} active · ${spareFibers.toLocaleString()} free`,
      trendDirection: globalSaturationPct > 75 ? "up" : "flat",
      trendLabel: utilizationBand(globalSaturationPct),
      icon: Cable,
      tone: globalSaturationPct > 90 ? "critical" : globalSaturationPct > 75 ? "high" : globalSaturationPct > 50 ? "moderate" : "normal",
    },
    {
      title: "Splitter Inventory",
      value: splitterRunRate.total.toLocaleString(),
      targetLabel: `${splitterAllocated} allocated · ${splitterRunRate.empty} available`,
      targetPct: splitterRunRate.total ? Math.round((splitterAllocated / splitterRunRate.total) * 100) : 0,
      subLabel: `${splitterRunRate.configuredPorts.toLocaleString()} / ${splitterRunRate.capacityPorts.toLocaleString()} output ports`,
      trendDirection: "flat",
      trendLabel: `${ospSplitterCount} OSP · ${ispSplitterCount} ISP`,
      icon: GitBranch,
      tone: "rose",
    },
  ];

  const siteDocumentSummary = await attachmentService.siteDocumentSummary();
  const monthlyInfrastructureGrowth = await monthlyInfrastructureGrowthPromise;
  const fileCategoryCounts = {
    odfPhoto: siteDocumentSummary.counts.ODF_PHOTO,
    fdd: siteDocumentSummary.counts.FDD,
    otdr: siteDocumentSummary.counts.OTDR_REPORT,
  };

  // ── Tier B: radial gauges (tier share of live site pairs) ──
  // Each tier is charted as its own gauge bound to its OWN saturation bucket and
  // laid out in descending priority order (most-utilised first): High → Moderate
  // → … → Normal. Thresholds mirror lib/config/utilization-thresholds: >90
  // Critical, 80–90 High, 50–80 Moderate, ≤50 Normal.
  const pairTotal = Math.max(1, saturationCounts.Critical + saturationCounts.High + saturationCounts.Moderate + saturationCounts.Normal);
  const gauges: Array<{ label: string; pct: number; caption: string; tone: "critical" | "high" | "moderate" | "normal" }> = [
    { label: "Critically Utilized", pct: Math.round((saturationCounts.Critical / pairTotal) * 100), caption: `${saturationCounts.Critical} pairs > 90%`, tone: "critical" },
    { label: "Highly Utilized", pct: Math.round((saturationCounts.High / pairTotal) * 100), caption: `${saturationCounts.High} pairs 80–90%`, tone: "high" },
    { label: "Moderately Utilized", pct: Math.round((saturationCounts.Moderate / pairTotal) * 100), caption: `${saturationCounts.Moderate} pairs 50–80%`, tone: "moderate" },
    { label: "Normally Utilized", pct: Math.round((saturationCounts.Normal / pairTotal) * 100), caption: `${saturationCounts.Normal} pairs < 50%`, tone: "normal" },
  ];

  // ── Tier B: regional allocation stacked bars ──
  // Strict regional grouping: only the eight defined regions (MU/BA/DH/DA/DF/
  // SH/WU/MS) are charted as collective bars. Standalone facility sites that are
  // not regions must never appear as their own bar, so segments whose site code
  // resolves to no region — or to one of these explicit standalone codes — are
  // dropped from the chart data stream entirely.
  const STANDALONE_NON_REGION_SITES = new Set(["WAT", "TCC", "BOU", "PLA", "GHU", "AMA"]);
  const regionAlloc = new Map<string, { used: number; reserved: number; available: number }>();
  for (const segment of regionSegments) {
    const code = String(segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode ?? "").toUpperCase();
    if (STANDALONE_NON_REGION_SITES.has(code)) continue;
    const region = REGION_OPTIONS.find((option) => matchesRegionPrefix(code, option.value))?.label;
    if (!region) continue;
    const bucket = regionAlloc.get(region) ?? { used: 0, reserved: 0, available: 0 };
    const childStats = childFiberStats(segment.endpointMappings);
    if (childStats.total > 0) {
      bucket.used += childStats.used;
      bucket.reserved += childStats.reserved;
      bucket.available += childStats.available;
    } else {
      const capacity = segment.totalFiberCapacity || segment.fiberCount || 0;
      bucket.used += segment.usedFiberCount;
      bucket.reserved += segment.reservedFiberCount;
      bucket.available += Math.max(0, capacity - segment.usedFiberCount - segment.reservedFiberCount - segment.faultyFiberCount);
    }
    regionAlloc.set(region, bucket);
  }
  const allocationBars: AllocationBar[] = [...regionAlloc.entries()]
    .map(([label, value]) => ({ label, ...value }))
    .sort((a, b) => (b.used + b.reserved + b.available) - (a.used + a.reserved + a.available))
    .slice(0, 8);

  // ── Tier C: engine topology — network layout metrics ──
  // The Background Worker Queue and Provisioning Flow Matrix now live in the
  // Reports tab; the main dashboard shows the structural network layout instead.
  const layoutSegments: LayoutSegmentInput[] = regionSegments
    .map((segment) => {
      const fromKey = normalizeSiteCode(segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode) ?? "";
      const toKey = normalizeSiteCode(segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode) ?? "";
      // A topology role configured on a child ODF mapping (e.g. SINGLE_HOMED) must
      // override the segment default, otherwise child-level single-homed rings
      // never register on the dashboard and the counter reads 0.
      const childTopologyRole = segment.endpointMappings.find((mapping) => mapping.childTopologyRole?.trim())?.childTopologyRole ?? null;
      return {
        id: segment.id,
        fromKey,
        toKey,
        fromLabel: segment.endpointA.site?.name ?? segment.endpointA.site?.code ?? fromKey,
        toLabel: segment.endpointB.site?.name ?? segment.endpointB.site?.code ?? toKey,
        segmentDefaultRole: segment.segmentDefaultRole,
        childTopologyRole,
      } satisfies LayoutSegmentInput;
    })
    .filter((segment) => segment.fromKey && segment.toKey);
  const networkLayoutMetrics = computeNetworkLayoutMetrics(layoutSegments);

  // ── Tier C: central exchange operational grid ──
  const riskBySite = new Map<string, number>();
  for (const segment of regionSegments) {
    const risky = !segment.endpointB.siteId || segment.isPartialTermination || !segment.cableId;
    if (!risky) continue;
    for (const code of [segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode, segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode]) {
      if (code) riskBySite.set(code, (riskBySite.get(code) ?? 0) + 1);
    }
  }

  // The hour-cached grid snapshot already carries each exchange's ODF/port counts,
  // saturation, DC/Core flags and editable criticality tags. Only two request-local
  // overlays are merged here: the risk-path count (from the live segment scan above)
  // and the per-exchange "variance" vs the network mean (a real comparative signal;
  // there is no per-exchange year-ago snapshot to diff).
  const meanSaturation = coreDcGrid.meanSaturation;
  const exchangeGridRows: ExchangeRow[] = exchangeRows.map((row) => ({
    exchange: displaySiteLabel(row.exchange),
    siteCode: row.exchange,
    totalOdfs: row.totalOdfs,
    activePorts: row.activePorts,
    riskPaths: riskBySite.get(row.exchange) ?? 0,
    saturationPct: row.saturationPct,
    isDatacenter: row.isDatacenter,
    isCoreSite: row.isCoreSite,
    isCriticalSite: row.isCriticalSite,
    criticalityTags: row.criticalityTags,
    siteType: row.siteType,
    coreSiteType: row.coreSiteType,
    variancePct: exchangeRows.length ? row.saturationPct - meanSaturation : null,
  }));

  // Capacity-pressure focus: the Core & DataCenter ODF saturation grid strictly
  // surfaces sites at or above 80% port saturation. Optimal / lower-utilization
  // assets are hidden by default so operators only see facilities under pressure.
  const SATURATION_ALERT_THRESHOLD = 80;
  const saturatedExchangeRows = exchangeGridRows.filter(
    (row) => row.saturationPct >= SATURATION_ALERT_THRESHOLD,
  );

  // Active Services Footprint — distinct active services per product tag across the
  // ENTIRE network (every live segment's child mappings), deduplicated by service
  // code so a service spanning many segments counts once. (Previously this was
  // scoped to intra-site DC/Core segments only.)
  const serviceFootprintMap = new Map<string, Set<string>>();
  for (const segment of regionSegments) {
    for (const mapping of segment.endpointMappings) {
      const tag = mapping.tag?.trim();
      const service = mapping.serviceCode?.trim();
      if (!tag || !service) continue;
      const set = serviceFootprintMap.get(tag) ?? new Set<string>();
      set.add(service.toUpperCase());
      serviceFootprintMap.set(tag, set);
    }
  }
  const serviceFootprint: ServiceFootprintBar[] = [...serviceFootprintMap.entries()]
    .map(([tag, set]) => ({ tag, count: set.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const intraSnapshot = await intraSnapshotPromise;

  return (
    <div className="space-y-6">
      {!hasLiveInventory ? (
        <div className="card border-red-200 bg-red-50 p-5">
          <div className="section-title">No live inventory imported yet</div>
          <div className="mt-1 text-sm text-red-700">Import inventory or create ODF mappings manually to populate dashboard analytics, site connectivity, service trace, and utilization views.</div>
        </div>
      ) : null}

      {/* ── Tier A: Executive Telecom KPI matrix ── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MonthlyInfrastructureGrowthMetric metrics={monthlyInfrastructureGrowth} />
        {tierAKpis.map((kpi) => <KpiCard key={kpi.title} data={kpi} />)}
      </div>

      {/* Secondary stat strip — supporting operational counters. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        {[
          { title: "Fiber Sites", value: siteIds.size, sub: `${coreSiteCount} core`, icon: MapPinned, tone: "sky" as const },
          { title: "Active Segments", value: regionSegments.length, sub: "live inventory", icon: Cable, tone: "emerald" as const },
          { title: "Active Ports", value: usedFibers, sub: `${portGroupIds.size} ODF groups`, icon: Activity, tone: "violet" as const },
          { title: "Free Ports", value: spareFibers, sub: "spare capacity", icon: Database, tone: "normal" as const },
          { title: "Open Alerts", value: liveAlerts.length, sub: "warning + critical", icon: AlertTriangle, tone: liveAlerts.length ? "amber" as const : "normal" as const },
          { title: "Data Gaps", value: dataGaps, sub: "far-end / cable / partial", icon: ShieldAlert, tone: dataGaps ? "rose" as const : "normal" as const },
        ].map((card) => (
          <KpiCard
            key={card.title}
            data={{ title: card.title, value: card.value.toLocaleString(), subLabel: card.sub, icon: card.icon, tone: card.tone }}
          />
        ))}
      </div>

      {/* ── Tier B: Capacity saturation gauges + regional allocation ── */}
      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-sky-500" />
            <div className="section-title">Capacity Saturation Tiers</div>
          </div>
          <div className="subtle mt-1">Share of {pairStats.size} live site pairs by utilization threshold.</div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {gauges.map((gauge) => <RadialGauge key={gauge.label} {...gauge} />)}
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-3 border-t border-[var(--border)] pt-3 text-xs font-semibold">
            <span className="exch-sat-critical">Critical {saturationCounts.Critical}</span>
            <span className="exch-sat-high">High {saturationCounts.High}</span>
            <span className="exch-sat-moderate">Moderate {saturationCounts.Moderate}</span>
            <span className="exch-sat-normal">Normal {saturationCounts.Normal}</span>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Cable className="h-4 w-4 text-violet-500" />
            <div className="section-title">Regional Port Allocation</div>
          </div>
          <div className="subtle mt-1">Active / reserved / available ODF ports across core exchanges.</div>
          <div className="mt-4">
            <AllocationStackedBars bars={allocationBars} />
          </div>
        </div>
      </div>

      {/* ── Tier C (top): Engine topology layout + COMPACT File Status ──
          File Status is reduced to a minimal footprint and shares this row with
          the topology card; the screen space it used to take full-width is now
          handed to the Core & DataCenter grid below. */}
      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <NetworkLayoutMetricsCard metrics={networkLayoutMetrics} />
        <div className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileBarChart className="h-4 w-4 text-sky-500" />
              <div className="section-title">File Status — Uploaded Documents</div>
            </div>
            <span className="kpi-trend kpi-trend-flat">{siteDocumentSummary.totalSites.toLocaleString()} sites</span>
          </div>
          <div className="mt-3">
            <FileStatusBars
              compact
              totalSegments={siteDocumentSummary.totalSites}
              bars={[
                { label: "ODF Photos", count: fileCategoryCounts.odfPhoto, color: "#0ea5e9" },
                { label: "FDD", count: fileCategoryCounts.fdd, color: "#8b5cf6" },
                { label: "OTDR", count: fileCategoryCounts.otdr, color: "#f59e0b" },
              ]}
            />
          </div>
        </div>
      </div>

      {/* ── Core grid (squeezed) + Intra-Site ODF Saturation + Services Footprint ──
          The Core & DataCenter grid keeps ALL of its existing internals; only its
          width container changed from full-width to the left cell of this 2-column
          layout, freeing room on the right for the new live-rotating Intra-Site
          saturation panel and, beneath it, the Active Services Footprint chart. */}
      <div className="grid gap-6 xl:grid-cols-[1.55fr_1fr]">
        <div className="card min-w-0 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <MapPinned className="h-4 w-4 text-rose-500" />
              <div className="section-title">Core and DataCenter ODFs saturation</div>
            </div>
            <span className="kpi-trend kpi-trend-flat">{saturatedExchangeRows.length} sites ≥ 80%</span>
          </div>
          <div className="subtle mt-1">Sites at or above 80% port saturation only — DataCenter sites first, then Core sites, highest value/criticality first. Click a Site ID to open its connectivity canvas. Rotates 20 sites every 45 seconds.</div>
          <div className="mt-4">
            <ExchangeGridRotator rows={saturatedExchangeRows} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {/* New panel - Core & DC Intra-Site ODF Saturation (45s rotation, 1h cache). */}
          <div className="card min-w-0 p-5">
            <IntraSiteSaturationRotator
              rows={intraSnapshot.rows}
              sectionRows={intraSnapshot.equinixRows}
              sectionLabel="Equinix DCs"
              title="Core and DataCenter intra-site ODFs saturation"
              subtitle="Intra-site segments on DC/Core sites, with Equinix DCs separated and always visible."
              countLabel={`${intraSnapshot.qualifyingSegments + intraSnapshot.equinixRows.length} segments`}
              icon={<Server className="h-4 w-4 text-sky-500" />}
              emptyText="No DC/Core intra-site segments tagged yet."
            />
          </div>

          <div className="card min-w-0 p-5">
            <IntraSiteSaturationRotator
              rows={intraSnapshot.crossBorderRows}
              title="Cross-Border Interconnect ODFs Saturation"
              subtitle="C-BI links with backbone-tagged segments, shown regardless of utilization status."
              countLabel={`${intraSnapshot.crossBorderRows.length} segments`}
              icon={<Cable className="h-4 w-4 text-amber-500" />}
              emptyText="No C-BI backbone segments found."
              exportMetricColumns={3}
            />
          </div>

          {/* New chart - Active Services Footprint (sits above the Alert focus section). */}
          <div className="card min-w-0 p-5">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-violet-500" />
              <div className="section-title">Active Services Footprint</div>
              <span className="group relative inline-flex">
                <Info className="h-3.5 w-3.5 cursor-help text-slate-400" tabIndex={0} aria-label="About the Active Services Footprint" />
                <span className="pointer-events-none absolute left-1/2 top-6 z-20 hidden w-64 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--glass-bg-solid)] p-2 text-xs font-normal normal-case leading-snug text-[var(--muted-text)] shadow-lg group-hover:block group-focus-within:block">
                  Displays the count of unique active services across the entire fiber network, grouped by product tag (deduplicated by service).
                </span>
              </span>
            </div>
            <div className="mt-4">
              <ActiveServicesFootprint bars={serviceFootprint} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <div className="space-y-6">
          <div className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="section-title">Top utilized links</div>
                <div className="subtle mt-1">Up to 20 Critical &amp; High site-pair utilization rows. Search by Site ID or segment name.</div>
              </div>
              <div className="text-sm text-slate-500">{allTopRows.length} matching link group(s)</div>
            </div>
            <form className="mt-4 grid gap-3 md:grid-cols-4" method="get">
              <input className="input-dark" name="utilSearch" defaultValue={params?.utilSearch ?? ""} placeholder="Site ID or segment name" />
              <select className="input-dark" name="utilStatus" defaultValue={utilStatus}>
                <option value="ALL">Status: Critical &amp; High</option>
                <option value="Critical">Critical</option>
                <option value="High">High</option>
              </select>
              <input className="input-dark" name="minUtil" defaultValue={params?.minUtil ?? ""} placeholder="Min utilization %" />
              <button className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Apply filters</button>
            </form>
            <div className="mt-5">
              <TopLinksTable rows={topRows} />
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="card p-5">
              <div className="section-title">Recent changes</div>
              <div className="mt-4 space-y-3 text-sm font-semibold" style={{ color: "var(--text-main)" }}>
                {recentAudit.length ? recentAudit.map((log) => (
                  <div key={log.id}>
                    {(log.changedBy?.name ?? log.changedBy?.email ?? "System")} {log.action.toLowerCase()} {log.entityType} at {log.createdAt.toLocaleString()}
                  </div>
                )) : <div style={{ color: "var(--muted-text)" }}>No audit entries yet.</div>}
              </div>
            </div>
            <div className="card p-5">
              <div className="section-title">Data quality gaps</div>
              <div className="mt-4 space-y-3 text-sm" style={{ color: "var(--text-main)" }}>
                <div>Missing far-end mapping: {regionSegments.filter((segment) => !segment.endpointB.siteId).length}</div>
                <div>Missing cable information: {regionSegments.filter((segment) => !segment.cableId).length}</div>
                <div>Partial terminations: {regionSegments.filter((segment) => segment.isPartialTermination).length}</div>
                <div>Import warnings/errors: {importWarnings}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <div className="section-title">Alert focus</div>
            <div className="subtle mt-1">Open alerts plus live faults — faulty fibers, un-terminated stubs, missing far-ends, import exceptions.</div>
            <div className="mt-4 space-y-3 text-sm font-semibold" style={{ color: "var(--text-main)" }}>
              {alertFocus.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{item.title}</span>
                  <span className={`import-decision import-decision-${item.severity === "CRITICAL" ? "rejected" : "warning"}`}>{item.severity}</span>
                </div>
              ))}
              {!alertFocus.length ? <div className="subtle">No live faults or alerts detected.</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
