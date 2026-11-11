import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { parseServicePathInput } from "@/lib/telecom/service-path-parser";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";

type CandidateSegment = Prisma.LinkSegmentGetPayload<{
  include: {
    endpointA: { include: { site: true; rack: true; odf: true; portGroup: true } };
    endpointB: { include: { site: true; rack: true; odf: true; portGroup: true } };
    fibers: { select: { id: true; fiberNumber: true; status: true; serviceId: true } };
  };
}>;
type CandidateEndpoint = CandidateSegment["endpointA"];

function endpointSiteCode(endpoint: CandidateEndpoint): string | null {
  return (endpoint.site?.code ?? endpoint.rawSiteCode ?? "").trim().toUpperCase() || null;
}

function endpointForSite(segment: CandidateSegment, siteCode: string): CandidateEndpoint {
  const code = siteCode.trim().toUpperCase();
  if (endpointSiteCode(segment.endpointA) === code) return segment.endpointA;
  if (endpointSiteCode(segment.endpointB) === code) return segment.endpointB;
  return segment.endpointA;
}

function segmentHasSite(segment: CandidateSegment, siteCode: string): boolean {
  const code = siteCode.trim().toUpperCase();
  return endpointSiteCode(segment.endpointA) === code || endpointSiteCode(segment.endpointB) === code;
}

function hasConsecutiveFiberRun(segment: CandidateSegment, size = 2): boolean {
  if (!segment.fibers.length) return segment.totalFiberCapacity === 0 || segment.availableFiberCount >= size;
  const available = segment.fibers
    .filter((fiber) => !fiber.serviceId && ["AVAILABLE", "ACTIVE"].includes(fiber.status))
    .map((fiber) => fiber.fiberNumber)
    .sort((a, b) => a - b);

  for (let index = 0; index <= available.length - size; index += 1) {
    const startsAt = available[index];
    if (available.slice(index, index + size).every((fiberNumber, offset) => fiberNumber === startsAt + offset)) return true;
  }
  return false;
}

async function loadCandidateSegments(siteA: string, siteB: string) {
  const candidates = await prisma.linkSegment.findMany({
    where: {
      sitePairKey: buildSitePairKey(siteA, siteB),
      status: { in: ["ACTIVE", "AVAILABLE", "USED"] },
      ...(process.env.FEATURE_DEMO_DATA === "true"
        ? {}
        : { NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }),
    },
    include: {
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
      fibers: { select: { id: true, fiberNumber: true, status: true, serviceId: true }, orderBy: { fiberNumber: "asc" } },
    },
    orderBy: [{ updatedAt: "asc" }],
    take: 50,
  });

  return candidates.filter((segment) => segmentHasSite(segment, siteA) && segmentHasSite(segment, siteB));
}

export const serviceAllocationService = {
  async allocate(input: { pathInput: string; serviceCode?: string | null; serviceName?: string | null; actor?: { id?: string | null; name?: string | null } }) {
    const parsed = parseServicePathInput(input.pathInput, input.serviceCode);

    // Resolve every ordered path token to a canonical Site by code OR name, so
    // NAMED boundary exchanges ("Majis", "Sohar Exchange") map to their real
    // site code and the first/last edge segments allocate end-to-end. Looking up
    // by code only (the previous behaviour) left named edges unresolved, which —
    // combined with the parser dropping them — silently omitted the boundaries.
    const sites = await prisma.site.findMany({
      where: {
        OR: [
          { code: { in: parsed.sites.map((site) => site.code) } },
          { name: { in: parsed.sites.map((site) => site.label.trim()) } },
        ],
      },
      select: { id: true, code: true, name: true },
    });
    const siteByCodeKey = new Map(sites.map((site) => [site.code.trim().toUpperCase(), site]));
    const siteByNameKey = new Map(sites.filter((site) => site.name).map((site) => [site.name!.trim().toUpperCase(), site]));
    const resolveSite = (token: { code: string; label: string }) =>
      siteByCodeKey.get(token.code.trim().toUpperCase())
      ?? siteByNameKey.get(token.label.trim().toUpperCase())
      ?? null;

    // Ordered path with each token's code remapped to its canonical resolved code.
    const pathSites = parsed.sites.map((site) => {
      const resolved = resolveSite(site);
      return { code: resolved?.code ?? site.code, label: site.label, isJumper: site.isJumper, id: resolved?.id ?? null };
    });
    const missingSites = pathSites.filter((site) => !site.id).map((site) => site.label);
    if (missingSites.length) {
      throw new Error(`These sites are not in the master site list: ${missingSites.join(", ")}.`);
    }
    const siteByCode = new Map(pathSites.map((site) => [site.code, { id: site.id as string }]));

    const chosenSegments = [] as Array<{
      segment: CandidateSegment;
      fromCode: string;
      toCode: string;
      fromLabel: string;
      toLabel: string;
      fromIsJumper: boolean;
      toIsJumper: boolean;
    }>;

    for (let index = 0; index < pathSites.length - 1; index += 1) {
      const from = pathSites[index];
      const to = pathSites[index + 1];
      const candidates = await loadCandidateSegments(from.code, to.code);
      const availableCandidates = candidates.filter((segment) => hasConsecutiveFiberRun(segment, 2));

      if (availableCandidates.length > 1) {
        throw new Error(`Multiple parallel Rack/ODF mappings exist for ${from.label} -> ${to.label}. Please select the preferred mapping path manually before auto-allocation.`);
      }

      const candidate = availableCandidates[0] ?? null;

      if (!candidate) {
        const exhausted = candidates.length
          ? ` Found ${candidates.length} physical segment(s), but no segment has an available fiber pair.`
          : "";
        throw new Error(`No available fiber pair found for ${from.label} -> ${to.label}.${exhausted}`);
      }

      chosenSegments.push({
        segment: candidate,
        fromCode: from.code,
        toCode: to.code,
        fromLabel: from.label,
        toLabel: to.label,
        fromIsJumper: from.isJumper,
        toIsJumper: to.isJumper,
      });
    }

    const fallbackUser = await prisma.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
    const auditActorId = input.actor?.id ?? fallbackUser?.id ?? "SYSTEM_NO_USER";
    if (auditActorId === "SYSTEM_NO_USER") {
      console.warn("WARNING: No active user found. Allocation will be attributed to system.");
    }
    const allocatedAt = new Date();
    const allocatorName = input.actor?.name?.trim() || fallbackUser?.name?.trim() || "system";

    const result = await prisma.$transaction(async (tx) => {
      const service = await tx.service.upsert({
        where: { serviceCode: parsed.serviceCode },
        update: {
          serviceName: input.serviceName?.trim() || undefined,
          status: "ACTIVE",
          remarks: `Auto allocation path: ${parsed.fullPathLabel}`,
        },
        create: {
          serviceCode: parsed.serviceCode,
          serviceName: input.serviceName?.trim() || `Allocated ${parsed.serviceCode}`,
          serviceType: "Fiber Service",
          status: "ACTIVE",
          remarks: `Auto allocation path: ${parsed.fullPathLabel}`,
        },
      });

      await segmentCapacityService.releaseActiveServiceAllocations(tx, service.id);
      // Free any ODF mapping rows we auto-consumed for this service on a prior
      // allocation so a re-allocation does not double-consume ODF ports.
      await segmentCapacityService.releaseAutoStampedMappings(tx, parsed.serviceCode);
      await tx.serviceRoute.updateMany({ where: { serviceId: service.id, routeType: "WORKING", isActive: true }, data: { isActive: false } });

      const route = await tx.serviceRoute.create({
        data: {
          serviceId: service.id,
          routeName: `Auto allocation ${parsed.serviceCode}`,
          routeType: "WORKING",
          isActive: true,
          remarks: parsed.fullPathLabel,
        },
      });

      for (let index = 0; index < chosenSegments.length; index += 1) {
        const allocation = chosenSegments[index];
        const outgoingEndpoint = endpointForSite(allocation.segment, allocation.fromCode);
        const incomingEndpoint = endpointForSite(allocation.segment, allocation.toCode);
        const pathLabel = `${allocation.fromLabel} -> ${allocation.toLabel}`;
        const isJumper = allocation.fromIsJumper || allocation.toIsJumper;
        const fiberAllocation = await segmentCapacityService.allocateFiberRun(tx, {
          segmentId: allocation.segment.id,
          serviceId: service.id,
          serviceRouteId: route.id,
          serviceCode: parsed.serviceCode,
          allocationGroup: route.id,
          pathOrder: index + 1,
          fromSiteId: siteByCode.get(allocation.fromCode)?.id ?? null,
          toSiteId: siteByCode.get(allocation.toCode)?.id ?? null,
          endpointAId: outgoingEndpoint.id,
          endpointBId: incomingEndpoint.id,
          endpointAPortGroupId: outgoingEndpoint.portGroupId,
          endpointBPortGroupId: incomingEndpoint.portGroupId,
          isJumper,
          pathLabel,
          remarks: isJumper ? `${parsed.serviceCode}(Jumper)` : parsed.serviceCode,
        });

        // Persist the allocation into the visible ODF Mappings (SegmentEndpointMapping)
        // rows so the inventory/ODF & Racks views and segment utilization reflect it.
        // refreshSegmentCapacity (called inside allocateFiberRun and again here)
        // derives utilization from these rows for imported segments.
        await segmentCapacityService.stampMappingsForAllocation(tx, {
          segmentId: allocation.segment.id,
          serviceCode: parsed.serviceCode,
          fibersNeeded: fiberAllocation.fiberNumbers.length,
          isJumper,
          pathLabel,
        });
        await segmentCapacityService.refreshSegmentCapacity(tx, allocation.segment.id);

        await tx.linkSegment.update({
          where: { id: allocation.segment.id },
          data: {
            allocationNote: `Fiber-level allocation for ${parsed.serviceCode}: fibers ${fiberAllocation.fiberNumbers.join("-")} from ${parsed.fullPathLabel}`,
            comments: [
              allocation.segment.comments,
              // Audit trail: every automatic allocation comment now carries the
              // allocator's username and the allocation date/time.
              `Auto allocated fibers ${fiberAllocation.fiberNumbers.join("-")} to ${parsed.serviceCode} by ${allocatorName} on ${allocatedAt.toISOString()}.`,
            ].filter(Boolean).join(" "),
          },
        });

        const portGroupIds = [outgoingEndpoint.portGroupId, incomingEndpoint.portGroupId].filter(Boolean) as string[];
        if (portGroupIds.length) {
          await tx.portGroup.updateMany({
            where: { id: { in: portGroupIds } },
            data: { status: "ACTIVE" },
          });
        }

        await tx.serviceRouteHop.create({
          data: {
            serviceRouteId: route.id,
            hopOrder: index + 1,
            siteId: siteByCode.get(allocation.fromCode)?.id,
            rackId: outgoingEndpoint.rackId,
            odfId: outgoingEndpoint.odfId,
            portGroupId: outgoingEndpoint.portGroupId,
            segmentId: allocation.segment.id,
            pathLabel,
            distanceKm: allocation.segment.distanceKm,
            remarks: `Allocated fibers ${fiberAllocation.fiberNumbers.join("-")} for ${parsed.serviceCode}`,
          },
        });
      }

      return {
        serviceCode: service.serviceCode,
        routeId: route.id,
        fullPathLabel: parsed.fullPathLabel,
        allocatedSegments: chosenSegments.map((item) => ({
          segmentCode: item.segment.segmentCode,
          fromSite: item.fromLabel,
          toSite: item.toLabel,
        })),
      };
    });

    await writeAuditLog({
      entityType: "Service",
      entityId: result.serviceCode,
      action: "RESERVE",
      fieldName: "autoAllocation",
      newValue: result,
      changedById: auditActorId === "SYSTEM_NO_USER" ? null : auditActorId,
      reason: `Automatic port allocation from ordered service path (by ${allocatorName})`,
    });

    return result;
  },

  /**
   * Release a service by its Service ID (Trace & Provision "Release Service").
   *   1. Purge the Service record (and its routes/allocations/hops) entirely.
   *   2. Flip every port/fiber + child ODF mapping carrying the service from
   *      ACTIVE/USED back to AVAILABLE.
   *   3. Stamp every released child link's comment with the audit sentence.
   * Works for allocated services and for imported services that only exist as
   * serviceCode-tagged child links.
   */
  async releaseService(serviceCodeInput: string, actor: { id?: string | null; name?: string | null }) {
    const serviceCode = normalizeServiceCodeExact(serviceCodeInput);
    if (!serviceCode) throw new Error("A valid Service ID is required to release a service.");

    const username = (actor.name ?? "").trim() || "system";
    const releasedAt = new Date();
    // Exact format mandated for the child-link release audit comment. The user
    // value comes straight from the active logged-in session account (actor.name).
    const comment = `The user “${username}” released the port dated “${releasedAt.toISOString()}”`;

    const result = await prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({
        where: { serviceCode },
        select: { id: true },
      });

      // Child ODF mapping links carrying this service (the visible inventory rows).
      const childLinks = await tx.segmentEndpointMapping.findMany({
        where: { serviceCode },
        select: { id: true, segmentId: true },
      });
      const childIds = childLinks.map((link) => link.id);
      const affectedSegmentIds = [...new Set(childLinks.map((link) => link.segmentId))];

      // 2 + 3: free the ports and stamp the release comment on each child link.
      if (childIds.length) {
        await tx.segmentEndpointMapping.updateMany({
          where: { id: { in: childIds } },
          data: { status: "AVAILABLE", serviceCode: null, remarks: comment },
        });
      }
      // Free fiber-level rows (Active -> Available) carrying this service.
      await tx.segmentFiber.updateMany({
        where: { serviceCode },
        data: {
          status: "AVAILABLE",
          serviceId: null,
          serviceRouteId: null,
          serviceAllocationId: null,
          serviceCode: null,
          allocationGroup: null,
          pathOrder: null,
          isJumper: false,
          allocatedAt: null,
          remarks: comment,
        },
      });

      // 1: purge the service record and everything bound to it (FK-clean order).
      let purgedService = false;
      if (service) {
        const allocationIds = (await tx.serviceAllocation.findMany({ where: { serviceId: service.id }, select: { id: true } })).map((a) => a.id);
        const routeIds = (await tx.serviceRoute.findMany({ where: { serviceId: service.id }, select: { id: true } })).map((r) => r.id);
        // Detach any fibers still pointing at this service's allocations/routes.
        await tx.segmentFiber.updateMany({
          where: { OR: [{ serviceId: service.id }, { serviceAllocationId: { in: allocationIds } }, { serviceRouteId: { in: routeIds } }] },
          data: { status: "AVAILABLE", serviceId: null, serviceRouteId: null, serviceAllocationId: null, serviceCode: null, allocationGroup: null, pathOrder: null, isJumper: false, allocatedAt: null },
        });
        await tx.serviceRouteHop.deleteMany({ where: { serviceRouteId: { in: routeIds } } });
        await tx.serviceAllocation.deleteMany({ where: { serviceId: service.id } });
        await tx.serviceRoute.deleteMany({ where: { serviceId: service.id } });
        await tx.service.delete({ where: { id: service.id } });
        purgedService = true;
      }

      for (const segmentId of affectedSegmentIds) {
        await segmentCapacityService.refreshSegmentCapacity(tx, segmentId);
      }

      return { serviceCode, purgedService, releasedChildLinks: childIds.length, affectedSegments: affectedSegmentIds.length };
    });

    if (!result.purgedService && !result.releasedChildLinks) {
      throw new Error(`No active service, ports, or child links were found for Service ID ${serviceCode}.`);
    }

    await writeAuditLog({
      entityType: "Service",
      entityId: serviceCode,
      action: "RELEASE",
      fieldName: "releaseService",
      newValue: result,
      changedById: actor.id ?? null,
      reason: comment,
    });

    return { ...result, comment, releasedAt: releasedAt.toISOString() };
  },
};
