import { prisma } from "@/lib/db/prisma";
import {
  buildIntraSiteDashboardMetrics,
  type ActiveServiceFootprintBar,
  type DashboardCoreSiteInput,
  type DashboardOdfSegmentInput,
  type IntraSiteSaturationGroup,
} from "@/lib/dashboard/odf-dashboard-metrics";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { ensureSiteFlagColumns } from "@/lib/telecom/site-flags-db";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface CachedIntraSiteDashboardPayload {
  saturationGroups: IntraSiteSaturationGroup[];
  activeServiceFootprint: ActiveServiceFootprintBar[];
  cachedAt: string;
  nextRefreshAt: string;
  refreshIntervalSeconds: 3600;
}

interface IntraSiteCacheState {
  payload?: CachedIntraSiteDashboardPayload;
  refreshPromise?: Promise<CachedIntraSiteDashboardPayload>;
  timer?: ReturnType<typeof setInterval>;
}

const globalCache = globalThis as typeof globalThis & {
  __intraSiteDashboardCache?: IntraSiteCacheState;
};

const cacheState = globalCache.__intraSiteDashboardCache ??= {};

interface CoreDcSiteRow {
  id: string;
  code: string;
  name: string | null;
  siteType: string | null;
  coreSiteType: string | null;
  isCoreSite: number | boolean;
  isDatacenter: number | boolean;
}

function uniqueTags(values: Array<string | null | undefined>): string[] {
  const tags = new Map<string, string>();
  for (const value of values) {
    const label = String(value ?? "").trim();
    if (label) tags.set(label.toUpperCase(), label);
  }
  return [...tags.values()];
}

async function loadIntraSiteDashboardPayload(): Promise<CachedIntraSiteDashboardPayload> {
  await ensureSiteFlagColumns(prisma);
  const demoFilter = process.env.FEATURE_DEMO_DATA === "true"
    ? []
    : [{ NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }];

  const [segmentRows, coreDcSiteRows] = await Promise.all([
    prisma.linkSegment.findMany({
      where: {
        AND: [
          { status: { not: "DECOMMISSIONED" } },
          { segmentDefaultRole: "INTRA_SITE" },
          ...demoFilter,
        ],
      },
      select: {
        id: true,
        segmentCode: true,
        sitePairKey: true,
        segmentDefaultRole: true,
        totalFiberCapacity: true,
        fiberCount: true,
        availableFiberCount: true,
        endpointA: { select: { rawSiteCode: true, site: { select: { code: true } } } },
        endpointB: { select: { rawSiteCode: true, site: { select: { code: true } } } },
        endpointMappings: {
          where: { status: { not: "DECOMMISSIONED" } },
          select: {
            id: true,
            localSiteCode: true,
            farSiteCode: true,
            farEndpointLabel: true,
            localPortLabel: true,
            farPortLabel: true,
            fiberNumbersJson: true,
            serviceCode: true,
            tag: true,
            status: true,
          },
        },
      },
    }),
    prisma.$queryRawUnsafe<CoreDcSiteRow[]>(
      `SELECT DISTINCT
          s."id",
          s."code",
          s."name",
          s."siteType",
          s."coreSiteType",
          s."isCoreSite",
          s."isDatacenter"
       FROM "Site" s
       WHERE s."status" != 'DECOMMISSIONED'
         AND (
           s."isCoreSite" = true
           OR s."isDatacenter" = true
           OR UPPER(TRIM(COALESCE(s."siteType", ''))) IN ('CORE', 'DC', 'DATACENTER', 'DATA CENTER')
           OR UPPER(TRIM(COALESCE(s."coreSiteType", ''))) IN ('CORE', 'DC', 'DATACENTER', 'DATA CENTER')
           OR EXISTS (
             SELECT 1
             FROM "SiteCriticalityAssignment" a
             JOIN "SiteCriticalityTag" t ON t."id" = a."tagId"
             WHERE a."siteId" = s."id"
               AND UPPER(TRIM(t."label")) IN ('CORE', 'DC', 'DATACENTER', 'DATA CENTER')
           )
         )`,
    ),
  ]);

  const siteIds = coreDcSiteRows.map((site) => site.id);
  const assignments = siteIds.length
    ? await prisma.siteCriticalityAssignment.findMany({
        where: { siteId: { in: siteIds } },
        select: { siteId: true, tag: { select: { label: true } } },
      })
    : [];
  const tagsBySite = new Map<string, string[]>();
  for (const assignment of assignments) {
    tagsBySite.set(assignment.siteId, [...(tagsBySite.get(assignment.siteId) ?? []), assignment.tag.label]);
  }

  const sites: DashboardCoreSiteInput[] = coreDcSiteRows.map((site) => {
    const isDatacenter = Boolean(site.isDatacenter);
    const isCoreSite = Boolean(site.isCoreSite);
    return {
      id: site.id,
      code: site.code,
      label: displaySiteLabel(site.code),
      isDatacenter,
      isCoreSite,
      tags: uniqueTags([
        isDatacenter ? "DC" : null,
        isCoreSite ? "Core" : null,
        site.coreSiteType,
        site.siteType,
        ...(tagsBySite.get(site.id) ?? []),
      ]),
    };
  });

  const segments: DashboardOdfSegmentInput[] = segmentRows.map((segment) => ({
    id: segment.id,
    segmentCode: segment.segmentCode,
    sitePairKey: segment.sitePairKey,
    segmentDefaultRole: segment.segmentDefaultRole,
    totalFiberCapacity: segment.totalFiberCapacity,
    fiberCount: segment.fiberCount,
    availableFiberCount: segment.availableFiberCount,
    endpointA: { siteCode: segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode },
    endpointB: { siteCode: segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode },
    endpointMappings: segment.endpointMappings,
  }));

  const metrics = buildIntraSiteDashboardMetrics(segments, sites);
  const refreshedAt = Date.now();
  return {
    ...metrics,
    cachedAt: new Date(refreshedAt).toISOString(),
    nextRefreshAt: new Date(refreshedAt + REFRESH_INTERVAL_MS).toISOString(),
    refreshIntervalSeconds: 3600,
  };
}

async function refreshCache(): Promise<CachedIntraSiteDashboardPayload> {
  if (cacheState.refreshPromise) return cacheState.refreshPromise;

  cacheState.refreshPromise = loadIntraSiteDashboardPayload()
    .then((payload) => {
      cacheState.payload = payload;
      return payload;
    })
    .catch((error) => {
      if (cacheState.payload) {
        console.error("Hourly intra-site dashboard cache refresh failed; serving the previous payload.", error);
        return cacheState.payload;
      }
      throw error;
    })
    .finally(() => {
      cacheState.refreshPromise = undefined;
    });

  return cacheState.refreshPromise;
}

function ensureBackgroundRefresh(): void {
  if (cacheState.timer) return;
  cacheState.timer = setInterval(() => {
    void refreshCache().catch((error) => {
      console.error("Initial intra-site dashboard cache refresh failed.", error);
    });
  }, REFRESH_INTERVAL_MS);
  cacheState.timer.unref?.();
}

/**
 * Serves the last completed payload immediately while the next hourly refresh
 * runs in the background. Database work occurs once per server process per hour,
 * never on carousel rotation and never on warm dashboard page loads.
 */
export async function getCachedIntraSiteDashboardPayload(): Promise<CachedIntraSiteDashboardPayload> {
  ensureBackgroundRefresh();
  return cacheState.payload ?? refreshCache();
}

