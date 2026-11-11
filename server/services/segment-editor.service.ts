import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { segmentUpsertSchema, type SegmentUpsertInput } from "@/lib/validation/segment";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { normalizeRackCode } from "@/lib/telecom/connection-identity";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";

export const segmentEditorService = {
  async updateSegment(id: string, rawInput: SegmentUpsertInput, changedById: string) {
    const input = segmentUpsertSchema.parse(rawInput);

    const siteCodeA = input.endpointA.rawSiteCode ?? null;
    const siteCodeB = input.endpointB.rawSiteCode ?? null;

    const updated = await prisma.$transaction(async (tx) => {
      const segment = await tx.linkSegment.update({
        where: { id },
        data: {
          segmentCode: input.segmentCode,
          cableId: input.cableId ?? null,
          routeLabel: input.routeLabel ?? null,
          tubeLabel: input.tubeLabel ?? null,
          fiberLabel: input.fiberLabel ?? null,
          totalFiberCapacity: input.segmentCapacity ?? undefined,
          distanceKm: input.distanceKm ?? null,
          status: input.status,
          manualOverride: input.manualOverride,
          overrideReason: input.overrideReason ?? null,
          comments: input.comments ?? null,
          sitePairKey: buildSitePairKey(siteCodeA, siteCodeB),
        },
      });

      // Cascade the parent endpoint identity down to the two segment endpoints and
      // every child mapping row. A segment is strictly one Site-Rack-ODF per end, so
      // the child ports inherit the parent's Site/Rack/ODF. Only fields actually
      // provided are overwritten (never wipe a child code with a blank); per-row
      // port labels are left untouched.
      const aSite = normalizeAlias(input.endpointA.rawSiteCode);
      const aRack = normalizeRackCode(input.endpointA.rawRackCode);
      const aOdf = normalizeOdfCode(input.endpointA.rawOdfCode);
      const bSite = normalizeAlias(input.endpointB.rawSiteCode);
      const bRack = normalizeRackCode(input.endpointB.rawRackCode);
      const bOdf = normalizeOdfCode(input.endpointB.rawOdfCode);

      const endpointAData: Record<string, unknown> = {};
      if (input.endpointA.siteId) endpointAData.siteId = input.endpointA.siteId;
      if (input.endpointA.rackId) endpointAData.rackId = input.endpointA.rackId;
      if (input.endpointA.odfId) endpointAData.odfId = input.endpointA.odfId;
      if (aSite) endpointAData.rawSiteCode = aSite;
      if (aRack) endpointAData.rawRackCode = aRack;
      if (aOdf) endpointAData.rawOdfCode = aOdf;
      if (Object.keys(endpointAData).length) {
        await tx.segmentEndpoint.update({ where: { id: segment.endpointAId }, data: endpointAData });
      }

      const endpointBData: Record<string, unknown> = {};
      if (input.endpointB.siteId) endpointBData.siteId = input.endpointB.siteId;
      if (input.endpointB.rackId) endpointBData.rackId = input.endpointB.rackId;
      if (input.endpointB.odfId) endpointBData.odfId = input.endpointB.odfId;
      if (bSite) endpointBData.rawSiteCode = bSite;
      if (bRack) endpointBData.rawRackCode = bRack;
      if (bOdf) endpointBData.rawOdfCode = bOdf;
      if (Object.keys(endpointBData).length) {
        await tx.segmentEndpoint.update({ where: { id: segment.endpointBId }, data: endpointBData });
      }

      const childCascade: Record<string, string> = {};
      if (aSite) childCascade.localSiteCode = aSite;
      if (aRack) childCascade.localRackCode = aRack;
      if (aOdf) childCascade.localOdfCode = aOdf;
      if (bSite) childCascade.farSiteCode = bSite;
      if (bRack) childCascade.farRackCode = bRack;
      if (bOdf) childCascade.farOdfCode = bOdf;
      if (Object.keys(childCascade).length) {
        await tx.segmentEndpointMapping.updateMany({ where: { segmentId: id }, data: childCascade });
      }

      await segmentCapacityService.ensureFiberInventory(tx, id, input.segmentCapacity);
      return segmentCapacityService.refreshSegmentCapacity(tx, id);
    });

    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: id,
      action: "UPDATE",
      fieldName: "segment",
      newValue: input,
      changedById,
      reason: input.overrideReason ?? null,
    });

    return updated;
  },
};
