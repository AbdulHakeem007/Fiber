// Per-mapping jumper marker.
//
// A "jumper" is a pass-through site in a service chain where fibers cross-connect
// straight through with no local drop. It is a property of a SITE *within a
// specific service path*, so we persist it on the SegmentEndpointMapping rows that
// touch that site.
//
// `jumperSiteCode` stores a comma-separated SET of canonical site keys that are
// jumpers on that mapping (a segment can, in degenerate cases, have a jumper at
// both ends). Empty/cleared marks are stored as NULL. The column is now declared
// in schema.prisma; this is a thin typed-Prisma wrapper.

import type { Prisma } from "@prisma/client";

type DbLike = Prisma.TransactionClient;

function parseKeySet(value?: string | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

/** Retained for call-site compatibility; the column is now schema-managed (no-op). */
export async function ensureJumperColumn(_db: DbLike): Promise<void> {}

/** Read the jumper-site-key set for each mapping id. */
export async function getJumperSiteCodes(db: DbLike, mappingIds: string[]): Promise<Map<string, string[]>> {
  if (!mappingIds.length) return new Map();
  const rows = await db.segmentEndpointMapping.findMany({
    where: { id: { in: mappingIds } },
    select: { id: true, jumperSiteCode: true },
  });
  return new Map(rows.map((row) => [row.id, parseKeySet(row.jumperSiteCode)]));
}

/** Overwrite the jumper-site-key set on a single mapping (NULL when empty). */
export async function setJumperSiteCodes(db: DbLike, mappingId: string, keys: string[]) {
  const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  await db.segmentEndpointMapping.updateMany({
    where: { id: mappingId },
    data: { jumperSiteCode: unique.length ? unique.join(",") : null },
  });
}
