// Topology-role / segment-type accessors for ring/subring/spur separation.
//
// These were previously raw-SQL shims against snake_case shadow columns
// (segment_default_role / child_topology_role). They now read/write the
// schema-managed Prisma fields `segmentDefaultRole` (LinkSegment) and
// `childTopologyRole` (SegmentEndpointMapping) — a single source of truth that
// also fixes the prior snake_case/camelCase split. Accepts the Prisma client or a
// transaction client.

import { normalizeSegmentDefaultTopologyRole, normalizeTopologyRole } from "@/lib/telecom/topology-role";
import type { Prisma } from "@prisma/client";

type DbLike = Prisma.TransactionClient;

/** Retained for call-site compatibility; the columns are now schema-managed (no-op). */
export async function ensureTopologyRoleColumns(_db: DbLike): Promise<void> {}

export async function getSegmentDefaultRole(db: DbLike, segmentId: string): Promise<string | null> {
  const row = await db.linkSegment.findUnique({
    where: { id: segmentId },
    select: { segmentDefaultRole: true },
  });
  return normalizeSegmentDefaultTopologyRole(row?.segmentDefaultRole) ?? null;
}

export async function getChildTopologyRole(db: DbLike, mappingId: string): Promise<string | null> {
  const row = await db.segmentEndpointMapping.findUnique({
    where: { id: mappingId },
    select: { childTopologyRole: true },
  });
  return normalizeTopologyRole(row?.childTopologyRole) ?? null;
}

export async function getChildTopologyRoles(db: DbLike, mappingIds: string[]): Promise<Map<string, string | null>> {
  if (!mappingIds.length) return new Map();
  const rows = await db.segmentEndpointMapping.findMany({
    where: { id: { in: mappingIds } },
    select: { id: true, childTopologyRole: true },
  });
  return new Map(rows.map((row) => [row.id, normalizeTopologyRole(row.childTopologyRole) ?? null]));
}

export async function setSegmentDefaultRole(db: DbLike, segmentId: string, role: unknown) {
  const normalized = normalizeSegmentDefaultTopologyRole(role as string | null | undefined);
  if (!normalized) throw new Error("Segment Type must be one of Backbone, Default, Interconnect, Intra-site, GPON segment, or B2B segment.");
  await db.linkSegment.updateMany({ where: { id: segmentId }, data: { segmentDefaultRole: normalized } });
}

export async function setChildTopologyRole(db: DbLike, mappingId: string, role: unknown) {
  const normalized = normalizeTopologyRole(role as string | null | undefined);
  await db.segmentEndpointMapping.updateMany({ where: { id: mappingId }, data: { childTopologyRole: normalized ?? null } });
}
