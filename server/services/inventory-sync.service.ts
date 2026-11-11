import { prisma } from "@/lib/db/prisma";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { normalizePortLabel } from "@/lib/telecom/connection-identity";
import { resolveRegisteredEndpointAssets } from "@/server/services/inventory-asset-validation.service";

/**
 * Real-time relational synchronization between the physical inventory (Site /
 * Rack / ODF / PortGroup) and the segment layer (SegmentEndpoint / ODF
 * Mappings).
 *
 * Segment endpoints can legitimately be created before their Site/Rack/ODF is
 * registered (imports, mock seeds, staged provisioning) — they then carry only
 * raw codes with null relational FKs. Whenever an inventory asset is created or
 * updated, this service re-links every orphaned endpoint whose raw codes now
 * resolve, so downstream features (capacity upgrade, splits, ODF mappings)
 * always see live FK ids instead of stale nulls.
 */

interface HealResult {
  scanned: number;
  healedEndpoints: number;
  healedMappingGroups: number;
}

type DbClient = typeof prisma | any;

function tripleKey(endpoint: { rawSiteCode: string | null; rawRackCode: string | null; rawOdfCode: string | null }): string {
  return [endpoint.rawSiteCode ?? "", endpoint.rawRackCode ?? "", endpoint.rawOdfCode ?? ""].join("|");
}

async function findPortGroupId(db: DbClient, odfId: string, rawPortText?: string | null): Promise<string | null> {
  const label = normalizePortLabel(rawPortText);
  if (!label) return null;
  const group = await db.portGroup.findUnique({
    where: { odfId_displayLabel: { odfId, displayLabel: label } },
    select: { id: true },
  });
  return group?.id ?? null;
}

export const inventorySyncService = {
  /**
   * Re-link orphaned segment endpoints (null siteId/rackId/odfId, raw codes
   * present) to registered inventory assets. Optionally scoped to a single
   * segment for cheap targeted healing on mutation paths.
   */
  async healSegmentEndpoints(db: DbClient = prisma, scope?: { segmentId?: string }): Promise<HealResult> {
    let endpointIdFilter: string[] | undefined;
    if (scope?.segmentId) {
      const segment = await db.linkSegment.findUnique({
        where: { id: scope.segmentId },
        select: { endpointAId: true, endpointBId: true },
      });
      if (!segment) return { scanned: 0, healedEndpoints: 0, healedMappingGroups: 0 };
      endpointIdFilter = [segment.endpointAId, segment.endpointBId];
    }

    const endpoints: Array<{
      id: string;
      siteId: string | null;
      rackId: string | null;
      odfId: string | null;
      portGroupId: string | null;
      rawSiteCode: string | null;
      rawRackCode: string | null;
      rawOdfCode: string | null;
      rawPortText: string | null;
    }> = await db.segmentEndpoint.findMany({
      where: {
        ...(endpointIdFilter ? { id: { in: endpointIdFilter } } : {}),
        OR: [{ siteId: null }, { rackId: null }, { odfId: null }],
        rawSiteCode: { not: null },
        rawRackCode: { not: null },
        rawOdfCode: { not: null },
      },
      select: {
        id: true,
        siteId: true,
        rackId: true,
        odfId: true,
        portGroupId: true,
        rawSiteCode: true,
        rawRackCode: true,
        rawOdfCode: true,
        rawPortText: true,
      },
    });
    if (!endpoints.length) return { scanned: 0, healedEndpoints: 0, healedMappingGroups: 0 };

    // Resolve each distinct Site|Rack|ODF triple once; unresolvable triples are
    // skipped, never failed — healing is strictly additive and non-destructive.
    const resolvedByTriple = new Map<string, { siteId: string; rackId: string; odfId: string } | null>();
    let healedEndpoints = 0;

    for (const endpoint of endpoints) {
      const key = tripleKey(endpoint);
      if (!resolvedByTriple.has(key)) {
        try {
          const assets = await resolveRegisteredEndpointAssets(db, {
            siteCode: endpoint.rawSiteCode,
            rackCode: endpoint.rawRackCode,
            odfCode: endpoint.rawOdfCode,
          });
          resolvedByTriple.set(key, { siteId: assets.siteId, rackId: assets.rackId, odfId: assets.odfId });
        } catch {
          resolvedByTriple.set(key, null);
        }
      }
      const assets = resolvedByTriple.get(key);
      if (!assets) continue;

      const portGroupId = endpoint.portGroupId ?? (await findPortGroupId(db, assets.odfId, endpoint.rawPortText));
      await db.segmentEndpoint.update({
        where: { id: endpoint.id },
        data: {
          siteId: assets.siteId,
          rackId: assets.rackId,
          odfId: assets.odfId,
          ...(portGroupId ? { portGroupId } : {}),
        },
      });
      healedEndpoints += 1;
    }

    const healedMappingGroups = scope?.segmentId
      ? await this.healMappingPortGroups(db, scope.segmentId)
      : 0;

    return { scanned: endpoints.length, healedEndpoints, healedMappingGroups };
  },

  /**
   * Push an ODF's (possibly renamed) Site/Rack/ODF identity down to every
   * segment endpoint and ODF Mapping child row that is FK-linked to it, so the
   * denormalized raw codes never go stale after an inventory edit.
   */
  async propagateOdfIdentity(db: DbClient = prisma, odfId: string): Promise<void> {
    const odf = await db.oDF.findUnique({
      where: { id: odfId },
      select: { id: true, odfCode: true, site: { select: { id: true, code: true } }, rack: { select: { id: true, rackCode: true } } },
    });
    if (!odf) return;
    const siteCode = normalizeAlias(odf.site.code) ?? odf.site.code;

    await db.segmentEndpoint.updateMany({
      where: { odfId: odf.id },
      data: {
        siteId: odf.site.id,
        rackId: odf.rack.id,
        rawSiteCode: siteCode,
        rawRackCode: odf.rack.rackCode,
        rawOdfCode: odf.odfCode,
      },
    });

    const portGroupIds = (
      await db.portGroup.findMany({ where: { odfId: odf.id }, select: { id: true } })
    ).map((group: { id: string }) => group.id);
    if (portGroupIds.length) {
      await db.segmentEndpointMapping.updateMany({
        where: { localPortGroupId: { in: portGroupIds } },
        data: { localSiteCode: siteCode, localRackCode: odf.rack.rackCode, localOdfCode: odf.odfCode },
      });
      await db.segmentEndpointMapping.updateMany({
        where: { farPortGroupId: { in: portGroupIds } },
        data: { farSiteCode: siteCode, farRackCode: odf.rack.rackCode, farOdfCode: odf.odfCode },
      });
    }
  },

  /**
   * Link a segment's ODF Mapping child rows to their PortGroups where the
   * mapping still holds only raw codes/labels. Non-destructive: existing links
   * are never overwritten.
   */
  async healMappingPortGroups(db: DbClient = prisma, segmentId: string): Promise<number> {
    const segment = await db.linkSegment.findUnique({
      where: { id: segmentId },
      select: {
        endpointA: { select: { odfId: true } },
        endpointB: { select: { odfId: true } },
      },
    });
    const localOdfId = segment?.endpointA?.odfId ?? null;
    const farOdfId = segment?.endpointB?.odfId ?? null;
    if (!localOdfId && !farOdfId) return 0;

    const mappings: Array<{ id: string; localPortGroupId: string | null; farPortGroupId: string | null; localPortLabel: string | null; farPortLabel: string | null }> =
      await db.segmentEndpointMapping.findMany({
        where: { segmentId, OR: [{ localPortGroupId: null }, { farPortGroupId: null }] },
        select: { id: true, localPortGroupId: true, farPortGroupId: true, localPortLabel: true, farPortLabel: true },
      });

    let healed = 0;
    for (const mapping of mappings) {
      const localPortGroupId = mapping.localPortGroupId ?? (localOdfId ? await findPortGroupId(db, localOdfId, mapping.localPortLabel) : null);
      const farPortGroupId = mapping.farPortGroupId ?? (farOdfId ? await findPortGroupId(db, farOdfId, mapping.farPortLabel) : null);
      const data: Record<string, string> = {};
      if (localPortGroupId && !mapping.localPortGroupId) data.localPortGroupId = localPortGroupId;
      if (farPortGroupId && !mapping.farPortGroupId) data.farPortGroupId = farPortGroupId;
      if (!Object.keys(data).length) continue;
      await db.segmentEndpointMapping.update({ where: { id: mapping.id }, data });
      healed += 1;
    }
    return healed;
  },
};
