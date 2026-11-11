import { Prisma, ResourceStatus, SplitterScope } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export interface MonthlyInfrastructureGrowthMetrics {
  newSegments: {
    partialSplits: number;
    fullSplits: number;
    brandNew: number;
    totalCount: number;
  };
  splitterUmbrella: {
    ispCount: number;
    ospCount: number;
  };
  newFiberSites: number;
  capacityUpgrades: number;
}

type EndpointSiteRef = {
  siteId: string | null;
  rawSiteCode: string | null;
  site: { code: string } | null;
};

type SplitAuditPayload = {
  mode?: unknown;
  createdSegments?: unknown;
  branchSegments?: unknown;
  branchSegment?: unknown;
  openTailSegment?: unknown;
};

const PARTIAL_SPLIT_MODES = new Set(["PARTIAL_SPLIT", "PARTIAL_BRANCH"]);
const FULL_SPLIT_MODES = new Set(["FULL_SPLIT"]);

function currentMonthRange(now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { monthStart, monthEnd };
}

function demoSegmentScope(): Prisma.LinkSegmentWhereInput {
  return process.env.FEATURE_DEMO_DATA === "true"
    ? {}
    : { NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } };
}

function parseAuditPayload(value: string | null): SplitAuditPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as SplitAuditPayload : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  const text = typeof value === "string" ? value.trim() : "";
  return text ? [text] : [];
}

function splitGeneratedSegmentCodes(payload: SplitAuditPayload): string[] {
  return [
    ...stringList(payload.createdSegments),
    ...stringList(payload.branchSegments),
    ...stringList(payload.branchSegment),
    ...stringList(payload.openTailSegment),
  ];
}

function countedSplitSegmentTotal(payload: SplitAuditPayload): number {
  const codes = [
    ...stringList(payload.createdSegments),
    ...stringList(payload.branchSegments),
  ];
  return codes.length || 2;
}

function siteKey(endpoint: EndpointSiteRef): string | null {
  if (endpoint.siteId) return `id:${endpoint.siteId}`;
  const code = String(endpoint.site?.code ?? endpoint.rawSiteCode ?? "").trim().toUpperCase();
  return code ? `code:${code}` : null;
}

function collectSiteKeys(segments: Array<{ endpointA: EndpointSiteRef; endpointB: EndpointSiteRef }>) {
  const keys = new Set<string>();
  for (const segment of segments) {
    for (const endpoint of [segment.endpointA, segment.endpointB]) {
      const key = siteKey(endpoint);
      if (key) keys.add(key);
    }
  }
  return keys;
}

export async function getMonthlyInfrastructureGrowthMetrics(now = new Date()): Promise<MonthlyInfrastructureGrowthMetrics> {
  const { monthStart, monthEnd } = currentMonthRange(now);
  const segmentScope = demoSegmentScope();
  const monthlySegmentWhere: Prisma.LinkSegmentWhereInput = {
    ...segmentScope,
    createdAt: { gte: monthStart, lt: monthEnd },
    status: { not: ResourceStatus.DECOMMISSIONED },
  };

  const endpointSelect = {
    siteId: true,
    rawSiteCode: true,
    site: { select: { code: true } },
  } satisfies Prisma.SegmentEndpointSelect;

  const [
    splitAuditLogs,
    monthlyCreatedSegments,
    historicalSegments,
    monthlyIspSplitters,
    monthlyOspSplitters,
    capacityUpgrades,
  ] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        entityType: "LinkSegment",
        action: "MANUAL_OVERRIDE",
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      select: { newValue: true },
    }),
    prisma.linkSegment.findMany({
      where: monthlySegmentWhere,
      select: {
        segmentCode: true,
        overrideReason: true,
        endpointA: { select: endpointSelect },
        endpointB: { select: endpointSelect },
      },
    }),
    prisma.linkSegment.findMany({
      where: {
        ...segmentScope,
        createdAt: { lt: monthStart },
      },
      select: {
        endpointA: { select: endpointSelect },
        endpointB: { select: endpointSelect },
      },
    }),
    prisma.splitter.count({
      where: {
        scope: SplitterScope.ISP,
        status: { not: ResourceStatus.DECOMMISSIONED },
        createdAt: { gte: monthStart, lt: monthEnd },
      },
    }),
    prisma.splitter.count({
      where: {
        scope: SplitterScope.OSP,
        status: { not: ResourceStatus.DECOMMISSIONED },
        createdAt: { gte: monthStart, lt: monthEnd },
      },
    }),
    prisma.auditLog.count({
      where: {
        entityType: "LinkSegment",
        action: "UPDATE",
        fieldName: "capacityUpgrade",
        createdAt: { gte: monthStart, lt: monthEnd },
      },
    }),
  ]);

  let partialSplits = 0;
  let fullSplits = 0;
  const splitGeneratedCodes = new Set<string>();

  for (const log of splitAuditLogs) {
    const payload = parseAuditPayload(log.newValue);
    if (!payload) continue;

    for (const code of splitGeneratedSegmentCodes(payload)) splitGeneratedCodes.add(code);

    const mode = String(payload.mode ?? "").trim().toUpperCase();
    if (PARTIAL_SPLIT_MODES.has(mode)) {
      partialSplits += countedSplitSegmentTotal(payload);
    } else if (FULL_SPLIT_MODES.has(mode)) {
      fullSplits += countedSplitSegmentTotal(payload);
    }
  }

  const brandNew = monthlyCreatedSegments.filter((segment) => {
    const reason = String(segment.overrideReason ?? "");
    return !splitGeneratedCodes.has(segment.segmentCode) && !reason.startsWith("Split from ");
  }).length;

  const monthlySiteKeys = collectSiteKeys(monthlyCreatedSegments);
  const historicalSiteKeys = collectSiteKeys(historicalSegments);
  const newFiberSites = [...monthlySiteKeys].filter((key) => !historicalSiteKeys.has(key)).length;

  return {
    newSegments: {
      partialSplits,
      fullSplits,
      brandNew,
      totalCount: partialSplits + fullSplits + brandNew,
    },
    splitterUmbrella: {
      ispCount: monthlyIspSplitters,
      ospCount: monthlyOspSplitters,
    },
    newFiberSites,
    capacityUpgrades,
  };
}
