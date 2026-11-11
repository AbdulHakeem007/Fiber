// Core & DataCenter Sites Operation Grid — read-only dashboard data service.
//
// This mirrors intra-site-saturation.service so the "Core and DataCenter Sites
// Operation Grid" shares the EXACT same caching mechanism and refresh cadence as
// the "Core & DC Intra-Site ODF Saturation" card: a one-hour, stale-while-
// revalidate in-process snapshot (lib/cache/hourly-snapshot). The DB-heavy
// per-exchange aggregation runs at most once per hour and is served instantly to
// every page load and client rotation tick in between.
//
// Only the DB-derived facts live in the snapshot. The two cheap, request-local
// overlays (per-site risk-path count from the live segment scan, and the
// network-mean variance) are merged back in the page so the cache stays free of
// page-specific state.

import { prisma } from "@/lib/db/prisma";
import { countCriticalSites } from "@/lib/telecom/site-flags-db";
import { createHourlySnapshot, ONE_HOUR_MS } from "@/lib/cache/hourly-snapshot";

/** One cached exchange row, before the request-local risk/variance overlay. */
export interface CoreDcGridRow {
  exchange: string;
  totalOdfs: number;
  activePorts: number;
  totalPorts: number;
  saturationPct: number;
  isDatacenter: boolean;
  isCoreSite: boolean;
  isCriticalSite: boolean;
  siteType: string | null;
  coreSiteType: string | null;
  criticalityTags: string[];
}

export interface CoreDcGridSnapshot {
  rows: CoreDcGridRow[];
  /** Mean saturation across the grid — used for the per-exchange variance overlay. */
  meanSaturation: number;
  generatedAt: string;
}

const EMPTY_SNAPSHOT: CoreDcGridSnapshot = {
  rows: [],
  meanSaturation: 0,
  generatedAt: new Date(0).toISOString(),
};

type RawExchangeRow = {
  exchange: string;
  totalOdfs: number;
  activePorts: number;
  totalPorts: number;
  // PostgreSQL returns these boolean columns as booleans; SQLite returned 0/1.
  // The consumer coerces via Number(...), so both shapes are handled.
  isCriticalSite: number | boolean;
  isDatacenter: number | boolean;
  isCoreSite: number | boolean;
  siteType: string | null;
  coreSiteType: string | null;
};

async function computeSnapshot(): Promise<CoreDcGridSnapshot> {
  // Surface every DC-/Core-tagged (or operator-nominated critical) site so the
  // client rotator can page through ALL of them; fall back to the top exchanges by
  // active ports when nothing is tagged yet, so the panel is never empty.
  const [nominatedCriticalCount, coreSiteCount, criticalityTaggedCount, datacenterCount] = await Promise.all([
    countCriticalSites(prisma),
    prisma.site.count({ where: { isCoreSite: true } }),
    prisma.siteCriticalityAssignment.count(),
    prisma.site.count({ where: { isDatacenter: true } }),
  ]);
  const gridHasTaggedSites =
    nominatedCriticalCount > 0 || coreSiteCount > 0 || datacenterCount > 0 || criticalityTaggedCount > 0;
  const gridWhere = gridHasTaggedSites
    ? `WHERE (s."isCriticalSite" = true OR s."isDatacenter" = true OR s."isCoreSite" = true OR s."id" IN (SELECT "siteId" FROM "SiteCriticalityAssignment"))`
    : "";
  const gridLimit = gridHasTaggedSites ? "" : "LIMIT 12";

  const exchangeRows = await prisma
    .$queryRawUnsafe<RawExchangeRow[]>(
      // Aliases are double-quoted so PostgreSQL preserves their camelCase (an
      // unquoted alias is folded to lowercase, breaking the camelCase row reads).
      `SELECT s."code" AS exchange,
              s."isCriticalSite" AS "isCriticalSite",
              s."isDatacenter" AS "isDatacenter",
              s."isCoreSite" AS "isCoreSite",
              s."siteType" AS "siteType",
              s."coreSiteType" AS "coreSiteType",
              COUNT(DISTINCT o."id") AS "totalOdfs",
              SUM(CASE WHEN p."status" IN ('USED','ACTIVE') THEN 1 ELSE 0 END) AS "activePorts",
              SUM(CASE WHEN p."id" IS NOT NULL AND p."status" != 'DECOMMISSIONED' THEN 1 ELSE 0 END) AS "totalPorts"
       FROM "Site" s
       JOIN "ODF" o ON o."siteId" = s."id" AND o."status" != 'DECOMMISSIONED'
       LEFT JOIN "ODFPort" p ON p."odfId" = o."id"
       ${gridWhere}
       GROUP BY s."id"
       HAVING COUNT(DISTINCT o."id") > 0
       ORDER BY "isDatacenter" DESC, "isCoreSite" DESC, "isCriticalSite" DESC, "activePorts" DESC
       ${gridLimit}`,
    )
    .catch(() => [] as RawExchangeRow[]);
  if (!exchangeRows.length) return { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString() };

  // Editable site-criticality tags ("DC", "Core", "DWDM", …) for these exchanges.
  const criticalityByCode = new Map<string, string[]>();
  const assignments = await prisma.siteCriticalityAssignment.findMany({
    where: { site: { code: { in: exchangeRows.map((row) => row.exchange) } } },
    select: { tag: { select: { label: true } }, site: { select: { code: true } } },
  });
  for (const assignment of assignments) {
    const code = assignment.site.code;
    criticalityByCode.set(code, [...(criticalityByCode.get(code) ?? []), assignment.tag.label]);
  }

  const rows: CoreDcGridRow[] = exchangeRows.map((row) => {
    const totalPorts = Number(row.totalPorts);
    const activePorts = Number(row.activePorts);
    return {
      // Raw site code is preserved so the page can overlay its raw-code-keyed
      // risk-path counts; the page applies displaySiteLabel() for presentation.
      exchange: row.exchange,
      totalOdfs: Number(row.totalOdfs),
      activePorts,
      totalPorts,
      saturationPct: totalPorts > 0 ? Math.round((activePorts / totalPorts) * 100) : 0,
      isDatacenter: Boolean(Number(row.isDatacenter)),
      isCoreSite: Boolean(Number(row.isCoreSite)),
      isCriticalSite: Boolean(Number(row.isCriticalSite)),
      siteType: row.siteType ?? null,
      coreSiteType: row.coreSiteType ?? null,
      criticalityTags: criticalityByCode.get(row.exchange) ?? [],
    };
  });
  const meanSaturation = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.saturationPct, 0) / rows.length)
    : 0;

  return { rows, meanSaturation, generatedAt: new Date().toISOString() };
}

const snapshot = createHourlySnapshot(computeSnapshot);

/** Cached (1h, stale-while-revalidate) snapshot for the Core & DC operation grid. */
export async function getCoreDcGridSnapshot(): Promise<CoreDcGridSnapshot> {
  try {
    return await snapshot.get();
  } catch {
    return { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString() };
  }
}

export { ONE_HOUR_MS };
