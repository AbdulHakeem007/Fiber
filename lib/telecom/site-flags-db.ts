// Operator-managed Site flags.
//
// `isCriticalSite` = a write-access operator has explicitly nominated this site
//   as a core/critical exchange. The dashboard "Central Exchange Operational
//   Grid" shows ONLY nominated sites (falling back to top-by-saturation when
//   none have been nominated yet, so the grid is never empty on a fresh DB).
// `isDatacenter`   = explicit DC tag. The grid engine auto-extracts every
//   DC-tagged site and overlays it on the grid regardless of nomination.
//
// These two columns are now declared in schema.prisma and created by Prisma
// migrations, so this module is a thin typed-Prisma wrapper (it previously managed
// the columns through SQLite-only raw DDL). Accepts the Prisma client or a
// transaction client.

import type { Prisma } from "@prisma/client";

type DbLike = Prisma.TransactionClient;

export type SiteFlagField = "isCriticalSite" | "isDatacenter";
export type SiteFlags = { isCriticalSite: boolean; isDatacenter: boolean };

/** Retained for call-site compatibility; columns are now schema-managed (no-op). */
export async function ensureSiteFlagColumns(_db: DbLike): Promise<void> {}

/** Set a single boolean flag on a site (matched by site code). */
export async function setSiteFlag(db: DbLike, siteCode: string, field: SiteFlagField, value: boolean) {
  const data = field === "isDatacenter" ? { isDatacenter: value } : { isCriticalSite: value };
  await db.site.updateMany({ where: { code: siteCode.toUpperCase() }, data });
}

/** Read both flags for a set of site codes (missing codes are absent from the map). */
export async function getSiteFlags(db: DbLike, siteCodes: string[]): Promise<Map<string, SiteFlags>> {
  if (!siteCodes.length) return new Map();
  const codes = [...new Set(siteCodes.map((code) => code.toUpperCase()))];
  const rows = await db.site.findMany({
    where: { code: { in: codes } },
    select: { code: true, isCriticalSite: true, isDatacenter: true },
  });
  return new Map(rows.map((row) => [row.code, { isCriticalSite: row.isCriticalSite, isDatacenter: row.isDatacenter }]));
}

/** Count of nominated critical sites — drives the grid's "nominated vs fallback" decision. */
export async function countCriticalSites(db: DbLike): Promise<number> {
  return db.site.count({ where: { isCriticalSite: true } });
}
