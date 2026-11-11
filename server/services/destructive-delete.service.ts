import { ResourceStatus, RouteType, ServiceStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { logChange } from "@/server/services/audit.service";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";

type Tx = any;

type EndpointLike = {
  id: string;
  endpointSide: "A" | "B";
  siteId?: string | null;
  rackId?: string | null;
  odfId?: string | null;
  portGroupId?: string | null;
  rawSiteCode?: string | null;
  rawRackCode?: string | null;
  rawOdfCode?: string | null;
  rawPortText?: string | null;
  displayPortText?: string | null;
  site?: { code: string } | null;
  rack?: { rackCode: string } | null;
  odf?: { odfCode: string } | null;
  portGroup?: { displayLabel: string } | null;
};

function cleanCode(value?: string | null): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return code || null;
}

function endpointSiteCode(endpoint: EndpointLike): string | null {
  return cleanCode(endpoint.site?.code ?? endpoint.rawSiteCode);
}

function endpointRackCode(endpoint: EndpointLike): string | null {
  return cleanCode(endpoint.rack?.rackCode ?? endpoint.rawRackCode);
}

function endpointOdfCode(endpoint: EndpointLike): string | null {
  return cleanCode(endpoint.odf?.odfCode ?? endpoint.rawOdfCode);
}

function endpointPortLabel(endpoint: EndpointLike): string | null {
  return String(endpoint.portGroup?.displayLabel ?? endpoint.displayPortText ?? endpoint.rawPortText ?? "").trim() || null;
}

function copyEndpointData(endpoint: EndpointLike, side: "A" | "B") {
  return {
    endpointSide: side,
    siteId: endpoint.siteId ?? null,
    rackId: endpoint.rackId ?? null,
    odfId: endpoint.odfId ?? null,
    portGroupId: endpoint.portGroupId ?? null,
    rawSiteCode: endpointSiteCode(endpoint),
    rawRackCode: endpointRackCode(endpoint),
    rawOdfCode: endpointOdfCode(endpoint),
    rawPortText: endpointPortLabel(endpoint),
    displayPortText: endpointPortLabel(endpoint),
    terminationStatus: ResourceStatus.ACTIVE,
    remarks: "Created by topology boundary merge.",
  };
}

function parseFiberNumbers(allocation: { fiberNumbersJson?: string | null; fiberStart: number; fiberEnd: number }): number[] {
  try {
    const parsed = JSON.parse(allocation.fiberNumbersJson ?? "[]");
    if (Array.isArray(parsed)) {
      const values = parsed.map(Number).filter((value) => Number.isInteger(value) && value > 0);
      if (values.length) return [...new Set(values)].sort((a, b) => a - b);
    }
  } catch {
    // Fall back to fiberStart/fiberEnd.
  }
  const start = Math.min(allocation.fiberStart, allocation.fiberEnd);
  const end = Math.max(allocation.fiberStart, allocation.fiberEnd);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

function sharedSiteCode(segments: Array<{ endpointA: EndpointLike; endpointB: EndpointLike }>): string | null {
  if (segments.length !== 2) return null;
  const first = [endpointSiteCode(segments[0].endpointA), endpointSiteCode(segments[0].endpointB)].filter(Boolean) as string[];
  const second = [endpointSiteCode(segments[1].endpointA), endpointSiteCode(segments[1].endpointB)].filter(Boolean) as string[];
  const shared = first.filter((code) => second.includes(code));
  return shared.length === 1 ? shared[0] : null;
}

function outerEndpoint(segment: { endpointA: EndpointLike; endpointB: EndpointLike }, sharedCode: string): EndpointLike {
  return endpointSiteCode(segment.endpointA) === sharedCode ? segment.endpointB : segment.endpointA;
}

function commonEndpointPortGroups(segments: Array<{ endpointA: EndpointLike; endpointB: EndpointLike }>, sharedCode: string): string[] {
  return [...new Set(segments.flatMap((segment) => [segment.endpointA, segment.endpointB]
    .filter((endpoint) => endpointSiteCode(endpoint) === sharedCode)
    .map((endpoint) => endpoint.portGroupId)
    .filter(Boolean) as string[]))];
}

/**
 * A site is a "linear pass-through" when exactly two live segments touch it and
 * their only shared boundary is this site, landing on two DISTINCT outer sites —
 * i.e. a chain that merely transits the site (A–SITE + SITE–C). Deleting such a
 * site must splice the chain back into A–C (reverse split) so the end-to-end
 * path and its service mappings survive, rather than being torn open. Anything
 * else — a stub (0/1 segment), a junction/ring/spur (3+ segments), or a parallel
 * A–SITE + SITE–A pair — is ambiguous to auto-merge and falls back to a cascade
 * delete. Returns the two segment ids to merge, or null.
 */
function findLinearPassThrough(
  segments: Array<{ id: string; endpointA: EndpointLike; endpointB: EndpointLike }>,
  siteCodeRaw: string,
): [string, string] | null {
  const siteCode = cleanCode(siteCodeRaw);
  if (!siteCode || segments.length !== 2) return null;
  const shared = sharedSiteCode(segments);
  if (!shared || shared !== siteCode) return null;
  const outerA = endpointSiteCode(outerEndpoint(segments[0], shared));
  const outerB = endpointSiteCode(outerEndpoint(segments[1], shared));
  if (!outerA || !outerB || outerA === outerB) return null;
  return [segments[0].id, segments[1].id];
}

async function nextSegmentCode(tx: Tx, baseCode: string): Promise<string> {
  const cleanBase = baseCode.replace(/[^A-Z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toUpperCase();
  let segmentCode = cleanBase || `MERGED-${Date.now()}`;
  let suffix = 1;
  while (await tx.linkSegment.findUnique({ where: { segmentCode }, select: { id: true } })) {
    suffix += 1;
    segmentCode = `${cleanBase}-${suffix}`;
  }
  return segmentCode;
}

async function deleteSegmentGraph(tx: Tx, segmentIds: string[]) {
  const ids = Array.from(new Set(segmentIds.filter(Boolean)));
  if (!ids.length) return { deletedCount: 0, endpointIds: [] as string[] };

  const segments = await tx.linkSegment.findMany({
    where: { id: { in: ids } },
    select: { id: true, endpointAId: true, endpointBId: true },
  });
  const foundIds = segments.map((segment: { id: string }) => segment.id);
  const endpointIds = segments.flatMap((segment: { endpointAId: string; endpointBId: string }) => [segment.endpointAId, segment.endpointBId]);
  const metricIds = (await tx.utilizationMetric.findMany({
    where: { scopeSegmentId: { in: foundIds } },
    select: { id: true },
  })).map((metric: { id: string }) => metric.id);

  await tx.alertEvent.deleteMany({
    where: {
      OR: [
        { linkSegmentId: { in: foundIds } },
        { metricId: { in: metricIds } },
      ],
    },
  });
  await tx.utilizationMetric.deleteMany({ where: { scopeSegmentId: { in: foundIds } } });
  await tx.serviceRouteHop.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.segmentEndpointMapping.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.segmentFiber.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.serviceAllocation.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.linkSegment.deleteMany({ where: { id: { in: foundIds } } });
  await tx.segmentEndpoint.deleteMany({ where: { id: { in: endpointIds } } });

  return { deletedCount: foundIds.length, endpointIds };
}

function childFiberCount(mapping: { localPortLabel?: string | null; farPortLabel?: string | null; fiberNumbersJson?: string | null }) {
  const jsonNumbers = String(mapping.fiberNumbersJson ?? "").match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (jsonNumbers.length) return new Set(jsonNumbers).size;
  const text = String(mapping.localPortLabel ?? mapping.farPortLabel ?? "");
  const numbers = text.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (numbers.length >= 2 && text.includes("-")) return Math.abs(numbers[1] - numbers[0]) + 1;
  return numbers.length ? 1 : 0;
}

async function snapshotAndHardDeleteSegmentGraph(tx: Tx, segmentIds: string[], changedById?: string | null) {
  const ids = Array.from(new Set(segmentIds.filter(Boolean)));
  if (!ids.length) return { deletedCount: 0, deletedIds: [] as string[], endpointIds: [] as string[], childLinkCount: 0 };

  const segments = await tx.linkSegment.findMany({
    where: { id: { in: ids } },
    include: {
      endpointA: true,
      endpointB: true,
      endpointMappings: true,
      fibers: true,
      serviceAllocations: true,
      serviceRouteHops: true,
    },
  });
  const foundIds = segments.map((segment: { id: string }) => segment.id);
  const endpointIds = segments.flatMap((segment: { endpointAId: string; endpointBId: string }) => [segment.endpointAId, segment.endpointBId]);
  const childLinkCount = segments.reduce((sum: number, segment: { endpointMappings: unknown[] }) => sum + segment.endpointMappings.length, 0);

  for (const segment of segments) {
    const totalFibers = segment.endpointMappings.reduce((sum: number, mapping: any) => sum + childFiberCount(mapping), 0) || segment.totalFiberCapacity || segment.fiberCount || 0;
    const activeFibers = segment.endpointMappings.reduce((sum: number, mapping: any) => {
      const status = String(mapping.status ?? "").toUpperCase();
      return sum + (mapping.serviceCode || status === "ACTIVE" || status === "USED" ? childFiberCount(mapping) : 0);
    }, 0);
    await tx.utilizationHistory.create({
      data: {
        sourceTable: "LinkSegment",
        sourceId: segment.id,
        segmentName: segment.segmentCode,
        siteId: segment.endpointA.siteId ?? segment.endpointB.siteId,
        rackId: segment.endpointA.rackId ?? segment.endpointB.rackId,
        odfId: segment.endpointA.odfId ?? segment.endpointB.odfId,
        totalFibers,
        activeFibers,
        availableFibers: Math.max(0, totalFibers - activeFibers),
        snapshot: JSON.parse(JSON.stringify(segment)),
      },
    });
    for (const routeHop of segment.serviceRouteHops) {
      await logChange(tx, { operatorId: changedById, actionType: "DELETE", targetTable: "ServiceRouteHop", targetId: routeHop.id, originalState: routeHop, batchId: segment.importBatchId });
    }
    for (const fiber of segment.fibers) {
      await logChange(tx, { operatorId: changedById, actionType: "DELETE", targetTable: "SegmentFiber", targetId: fiber.id, originalState: fiber, batchId: segment.importBatchId });
    }
    for (const allocation of segment.serviceAllocations) {
      await logChange(tx, { operatorId: changedById, actionType: "DELETE", targetTable: "ServiceAllocation", targetId: allocation.id, originalState: allocation, batchId: segment.importBatchId });
    }
    for (const mapping of segment.endpointMappings) {
      await logChange(tx, { operatorId: changedById, actionType: "DELETE", targetTable: "SegmentEndpointMapping", targetId: mapping.id, originalState: mapping, batchId: segment.importBatchId });
    }
    await logChange(tx, {
      operatorId: changedById,
      actionType: "DELETE",
      targetTable: "LinkSegment",
      targetId: segment.id,
      originalState: {
        ...segment,
        endpointA: undefined,
        endpointB: undefined,
        endpointMappings: undefined,
        fibers: undefined,
        serviceAllocations: undefined,
        serviceRouteHops: undefined,
      },
      batchId: segment.importBatchId,
    });
    // Log the two SegmentEndpoint rows too: they are deleted below, and the
    // LinkSegment we just logged references them via endpointAId/endpointBId.
    // Without these DELETE logs, audit reconstruction cannot restore the parent
    // endpoints and aborts with "references missing SegmentEndpoint(...)".
    for (const endpoint of [segment.endpointA, segment.endpointB]) {
      if (!endpoint) continue;
      await logChange(tx, {
        operatorId: changedById,
        actionType: "DELETE",
        targetTable: "SegmentEndpoint",
        targetId: endpoint.id,
        originalState: endpoint,
        batchId: segment.importBatchId,
      });
    }
  }

  const metricIds = (await tx.utilizationMetric.findMany({
    where: { scopeSegmentId: { in: foundIds } },
    select: { id: true },
  })).map((metric: { id: string }) => metric.id);

  await tx.alertEvent.deleteMany({
    where: {
      OR: [
        { linkSegmentId: { in: foundIds } },
        { metricId: { in: metricIds } },
      ],
    },
  });
  await tx.utilizationMetric.deleteMany({ where: { scopeSegmentId: { in: foundIds } } });
  await tx.serviceRouteHop.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.segmentFiber.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.serviceAllocation.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.segmentEndpointMapping.deleteMany({ where: { segmentId: { in: foundIds } } });
  await tx.linkSegment.deleteMany({ where: { id: { in: foundIds } } });
  await tx.segmentEndpoint.deleteMany({ where: { id: { in: endpointIds } } });

  return { deletedCount: foundIds.length, deletedIds: foundIds, endpointIds, childLinkCount };
}

async function releaseUnusedPortGroups(tx: Tx, portGroupIds: string[]) {
  const ids = Array.from(new Set(portGroupIds.filter(Boolean)));
  for (const portGroupId of ids) {
    const [endpointCount, hopCount, allocationCount] = await Promise.all([
      tx.segmentEndpoint.count({ where: { portGroupId } }),
      tx.serviceRouteHop.count({ where: { portGroupId } }),
      tx.serviceAllocation.count({ where: { OR: [{ endpointAPortGroupId: portGroupId }, { endpointBPortGroupId: portGroupId }] } }),
    ]);
    if (endpointCount || hopCount || allocationCount) continue;
    await tx.portGroup.update({ where: { id: portGroupId }, data: { status: ResourceStatus.AVAILABLE, reservationNote: null } }).catch(() => null);
    const memberPortIds = (await tx.portGroupMember.findMany({ where: { portGroupId }, select: { odfPortId: true } })).map((member: { odfPortId: string }) => member.odfPortId);
    if (memberPortIds.length) {
      await tx.oDFPort.updateMany({ where: { id: { in: memberPortIds }, isBlocked: false }, data: { status: ResourceStatus.AVAILABLE } });
    }
  }
}

async function mergeTwoAdjacentSegments(tx: Tx, segmentIds: string[], changedById?: string | null) {
  if (segmentIds.length !== 2) {
    throw new Error("Topology merge requires exactly two adjacent segments, for example A-B and B-C.");
  }

  const segments = await tx.linkSegment.findMany({
    where: { id: { in: segmentIds }, status: { not: ResourceStatus.DECOMMISSIONED } },
    include: {
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
      fibers: { orderBy: { fiberNumber: "asc" } },
      serviceAllocations: { include: { service: true, serviceRoute: true }, orderBy: { pathOrder: "asc" } },
    },
  });

  const ordered = segmentIds.map((id) => segments.find((segment: { id: string }) => segment.id === id)).filter(Boolean) as typeof segments;
  if (ordered.length !== 2) throw new Error("Both selected segments must exist and be live before a topology merge can be applied.");

  const shared = sharedSiteCode(ordered);
  if (!shared) throw new Error("The selected segments are not a simple A-B + B-C boundary. Select exactly two adjacent segments that share one site.");

  const endpointA = outerEndpoint(ordered[0], shared);
  const endpointB = outerEndpoint(ordered[1], shared);
  const siteA = endpointSiteCode(endpointA);
  const siteB = endpointSiteCode(endpointB);
  if (!siteA || !siteB || siteA === siteB) throw new Error("The outer endpoints for the merged segment are invalid. Check the selected segments.");

  const leftFiberNumbers = ordered[0].fibers.map((fiber: { fiberNumber: number }) => fiber.fiberNumber);
  const rightFiberNumbers = ordered[1].fibers.map((fiber: { fiberNumber: number }) => fiber.fiberNumber);
  const rightSet = new Set(rightFiberNumbers);
  const commonFibers = leftFiberNumbers.filter((fiberNumber: number) => rightSet.has(fiberNumber));
  const unionFibers = [...new Set([...leftFiberNumbers, ...rightFiberNumbers])].sort((a, b) => a - b);
  const capacity = Math.max(1, commonFibers.length ? commonFibers.length : unionFibers.length || Math.min(ordered[0].totalFiberCapacity || 0, ordered[1].totalFiberCapacity || 0) || 1);
  const fiberNumbers = commonFibers.length ? commonFibers : unionFibers.length ? unionFibers : Array.from({ length: capacity }, (_, index) => index + 1);

  const newEndpointA = await tx.segmentEndpoint.create({ data: copyEndpointData(endpointA, "A") });
  const newEndpointB = await tx.segmentEndpoint.create({ data: copyEndpointData(endpointB, "B") });
  const segmentCode = await nextSegmentCode(tx, `MERGED-${siteA}-${siteB}`);

  const mergedSegment = await tx.linkSegment.create({
    data: {
      segmentCode,
      segmentGroupName: ordered[0].segmentGroupName ?? ordered[1].segmentGroupName ?? segmentCode,
      segmentSequence: null,
      segmentCapacityFibers: fiberNumbers.length,
      sourceSegmentKey: `MERGED:${ordered.map((segment: { segmentCode: string }) => segment.segmentCode).join("+")}`,
      spanType: ordered[0].spanType ?? ordered[1].spanType,
      inventoryClass: ordered[0].inventoryClass ?? ordered[1].inventoryClass,
      matchStatus: "MANUAL_MERGE",
      sitePairKey: buildSitePairKey(siteA, siteB),
      endpointAId: newEndpointA.id,
      endpointBId: newEndpointB.id,
      cableId: ordered[0].cableId ?? ordered[1].cableId,
      routeLabel: `${siteA} - ${siteB}`,
      tubeNumber: ordered[0].tubeNumber ?? ordered[1].tubeNumber,
      tubeColor: ordered[0].tubeColor ?? ordered[1].tubeColor,
      tubeLabel: ordered[0].tubeLabel ?? ordered[1].tubeLabel,
      fiberPortNumber: ordered[0].fiberPortNumber ?? ordered[1].fiberPortNumber,
      fiberCount: fiberNumbers.length,
      totalFiberCapacity: fiberNumbers.length,
      usableFiberCapacity: fiberNumbers.length,
      availableFiberCount: fiberNumbers.length,
      distanceKm: Number(ordered[0].distanceKm ?? 0) + Number(ordered[1].distanceKm ?? 0) || null,
      status: ResourceStatus.ACTIVE,
      manualOverride: true,
      overrideReason: `Merged boundary ${shared}; replaced ${ordered.map((segment: { segmentCode: string }) => segment.segmentCode).join(" + ")}`,
      comments: `Topology merge removed intermediate boundary ${shared}.`,
      source: "MANUAL",
    },
    include: { endpointA: true, endpointB: true },
  });

  for (const fiberNumber of fiberNumbers) {
    await tx.segmentFiber.create({
      data: {
        segmentId: mergedSegment.id,
        fiberNumber,
        status: ResourceStatus.AVAILABLE,
        tubeNumber: mergedSegment.tubeNumber,
        tubeColor: mergedSegment.tubeColor,
        tubeLabel: mergedSegment.tubeLabel,
        fiberPortNumber: mergedSegment.fiberPortNumber ? mergedSegment.fiberPortNumber + fiberNumber - 1 : null,
        remarks: `Merged from ${ordered.map((segment: { segmentCode: string }) => segment.segmentCode).join(" + ")}`,
      },
    });
    await tx.segmentEndpointMapping.create({
      data: {
        segmentId: mergedSegment.id,
        localSiteCode: siteA,
        localRackCode: endpointRackCode(endpointA),
        localOdfCode: endpointOdfCode(endpointA),
        localPortLabel: String(fiberNumber),
        farSiteCode: siteB,
        farRackCode: endpointRackCode(endpointB),
        farOdfCode: endpointOdfCode(endpointB),
        farPortLabel: String(fiberNumber),
        localPortGroupId: endpointA.portGroupId ?? null,
        farPortGroupId: endpointB.portGroupId ?? null,
        fiberNumbersJson: JSON.stringify([fiberNumber]),
        status: ResourceStatus.AVAILABLE,
        source: "MANUAL",
        remarks: `Created by topology merge across ${shared}.`,
      },
    });
  }

  const allocationGroups = new Map<string, any[]>();
  for (const segment of ordered) {
    for (const allocation of segment.serviceAllocations) {
      if (!allocation.serviceId || allocation.status === ResourceStatus.DECOMMISSIONED) continue;
      const routeType = allocation.serviceRoute?.routeType ?? RouteType.WORKING;
      const key = `${allocation.serviceId}:${routeType}`;
      allocationGroups.set(key, [...(allocationGroups.get(key) ?? []), allocation]);
    }
  }

  for (const allocations of allocationGroups.values()) {
    const first = allocations[0];
    const serviceCode = first.service?.serviceCode;
    if (!first.serviceId || !serviceCode) continue;
    const routeType = first.serviceRoute?.routeType ?? RouteType.WORKING;
    const allocationFibers = [...new Set(allocations.flatMap(parseFiberNumbers))].filter((fiberNumber) => fiberNumbers.includes(fiberNumber)).sort((a, b) => a - b);
    if (!allocationFibers.length) continue;

    await tx.serviceRoute.updateMany({
      where: { serviceId: first.serviceId, isActive: true, routeType },
      data: { isActive: false, remarks: `Superseded by topology merge ${segmentCode}.` },
    });
    const route = await tx.serviceRoute.create({
      data: {
        serviceId: first.serviceId,
        routeName: `Merged route ${serviceCode} ${siteA}-${siteB}`,
        routeType,
        isActive: true,
        remarks: `Automatically remapped after deleting boundary ${shared}.`,
      },
    });
    const allocation = await tx.serviceAllocation.create({
      data: {
        serviceId: first.serviceId,
        serviceRouteId: route.id,
        segmentId: mergedSegment.id,
        allocationGroup: route.id,
        pathOrder: 1,
        fromSiteId: mergedSegment.endpointA.siteId,
        toSiteId: mergedSegment.endpointB.siteId,
        endpointAId: mergedSegment.endpointAId,
        endpointBId: mergedSegment.endpointBId,
        endpointAPortGroupId: mergedSegment.endpointA.portGroupId,
        endpointBPortGroupId: mergedSegment.endpointB.portGroupId,
        fiberStart: Math.min(...allocationFibers),
        fiberEnd: Math.max(...allocationFibers),
        fiberNumbersJson: JSON.stringify(allocationFibers),
        status: ResourceStatus.ACTIVE,
        isJumper: Boolean(first.isJumper),
        isProtection: Boolean(first.isProtection),
        pathLabel: `${siteA} -> ${siteB}`,
        remarks: `Merged from boundary ${shared}.`,
      },
    });
    await tx.segmentFiber.updateMany({
      where: { segmentId: mergedSegment.id, fiberNumber: { in: allocationFibers } },
      data: {
        status: ResourceStatus.ACTIVE,
        serviceId: first.serviceId,
        serviceRouteId: route.id,
        serviceAllocationId: allocation.id,
        serviceCode,
        allocationGroup: route.id,
        pathOrder: 1,
        isJumper: Boolean(first.isJumper),
        allocatedAt: new Date(),
        remarks: `${siteA} -> ${siteB}`,
      },
    });
    await tx.segmentEndpointMapping.updateMany({
      where: { segmentId: mergedSegment.id, fiberNumbersJson: { in: allocationFibers.map((fiberNumber) => JSON.stringify([fiberNumber])) } },
      data: { status: ResourceStatus.ACTIVE, serviceCode },
    });
    await tx.serviceRouteHop.create({
      data: {
        serviceRouteId: route.id,
        hopOrder: 1,
        siteId: mergedSegment.endpointA.siteId,
        rackId: mergedSegment.endpointA.rackId,
        odfId: mergedSegment.endpointA.odfId,
        portGroupId: mergedSegment.endpointA.portGroupId,
        segmentId: mergedSegment.id,
        pathLabel: `${siteA} -> ${siteB}`,
        distanceKm: mergedSegment.distanceKm,
        remarks: `Merged route after deleting boundary ${shared}.`,
      },
    });
  }

  const commonPortGroups = commonEndpointPortGroups(ordered, shared);
  await deleteSegmentGraph(tx, segmentIds);
  await releaseUnusedPortGroups(tx, commonPortGroups);
  await segmentCapacityService.refreshSegmentCapacity(tx, mergedSegment.id);

  return {
    deletedCount: segmentIds.length,
    retiredCount: 0,
    endpointIds: [],
    mergedSegmentId: mergedSegment.id,
    mergedSegmentCode: segmentCode,
    mergedIntermediateSite: shared,
  };
}

// Bulk hard-delete batch size. Each chunk is its own short transaction so the
// SQLite write lock is released between chunks instead of being held for the
// whole selection. A single giant $transaction over thousands of segments —
// each segment fanning out into utilization snapshots + per-child audit log
// writes — outran the 30s transaction timeout and surfaced as the Prisma
// "Socket timeout (the database failed to respond to a query…)" error on the
// ODF Mapping bulk delete. Chunking keeps every transaction bounded and snappy.
const HARD_DELETE_CHUNK_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export type OdfDeleteDependency = {
  id: string;
  kind: "mapping" | "fiber" | "allocation" | "routeHop" | "splitterOutput";
  label: string;
  detail?: string | null;
  href: string;
};

export class OdfDeleteBlockedError extends Error {
  readonly status = 409;
  readonly dependencies: OdfDeleteDependency[];

  constructor(dependencies: OdfDeleteDependency[], liveRecordCount?: number) {
    super(
      liveRecordCount
        ? `${liveRecordCount} live inventory record(s) still reference this ODF. Open the consolidated segment view below, retire or reassign the linked services, then retry the delete.`
        : "This ODF is linked to live inventory mappings. Retire or reassign the linked dependencies before deleting the ODF.",
    );
    this.name = "OdfDeleteBlockedError";
    this.dependencies = dependencies;
  }
}

type LoadedOdfForDelete = {
  id: string;
  odfCode: string;
  site: { code: string };
  rack: { rackCode: string };
  portGroups: Array<{ id: string }>;
  ports: Array<{ id: string }>;
};

const NON_BLOCKING_DELETE_STATUSES = [
  ResourceStatus.AVAILABLE,
  ResourceStatus.SPARE,
  ResourceStatus.FAULTY,
  ResourceStatus.DUMMY,
  ResourceStatus.DECOMMISSIONED,
];
const NON_BLOCKING_DELETE_STATUS_SET = new Set<ResourceStatus>(NON_BLOCKING_DELETE_STATUSES);
const BLOCKING_DELETE_STATUSES = Object.values(ResourceStatus).filter((status) => !NON_BLOCKING_DELETE_STATUS_SET.has(status));
const BLOCKING_SERVICE_STATUSES_LIST = [
  ServiceStatus.ACTIVE,
  ServiceStatus.PROTECTION,
  ServiceStatus.TEMPORARY,
  ServiceStatus.SUSPENDED,
] as const;
const BLOCKING_SERVICE_STATUSES = new Set<ServiceStatus>(BLOCKING_SERVICE_STATUSES_LIST);

function isBlockingServiceStatus(status?: ServiceStatus | string | null): boolean {
  return BLOCKING_SERVICE_STATUSES.has(status as ServiceStatus);
}

function hasText(value?: string | null): boolean {
  return Boolean(String(value ?? "").trim());
}

function inventoryHref(filters: {
  search?: string | null;
  site?: string | null;
  connectedSite?: string | null;
  serviceId?: string | null;
  rackId?: string | null;
  odfId?: string | null;
  portPair?: string | null;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const text = String(value ?? "").trim();
    if (text) params.set(key, text);
  }
  params.set("page", "1");
  params.set("pageSize", "1000");
  return `/inventory?${params.toString()}`;
}

function inventoryServiceHref(serviceCode?: string | null, fallbackSegmentCode?: string | null) {
  return hasText(serviceCode)
    ? inventoryHref({ serviceId: serviceCode })
    : inventoryHref({ search: fallbackSegmentCode });
}

function inventoryMappingHref(odf: LoadedOdfForDelete, mapping: {
  serviceCode?: string | null;
  localSiteCode?: string | null;
  localRackCode?: string | null;
  localOdfCode?: string | null;
  localPortLabel?: string | null;
  farSiteCode?: string | null;
  farEndpointLabel?: string | null;
  farRackCode?: string | null;
  farOdfCode?: string | null;
  farPortLabel?: string | null;
  segment: { segmentCode: string };
}) {
  const localMatches =
    mapping.localSiteCode === odf.site.code &&
    mapping.localRackCode === odf.rack.rackCode &&
    mapping.localOdfCode === odf.odfCode;
  const site = localMatches ? mapping.localSiteCode : mapping.farSiteCode ?? mapping.farEndpointLabel;
  const rack = localMatches ? mapping.localRackCode : mapping.farRackCode;
  const odfCode = localMatches ? mapping.localOdfCode : mapping.farOdfCode;
  const port = localMatches ? mapping.localPortLabel : mapping.farPortLabel;
  return inventoryHref({
    serviceId: mapping.serviceCode,
    site,
    rackId: rack,
    odfId: odfCode,
    portPair: port,
    search: mapping.segment.segmentCode,
  });
}

function splitterHref(...parts: Array<string | null | undefined>) {
  const search = parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
  return `/splitters?search=${encodeURIComponent(search)}`;
}

function uniqueDependencies(dependencies: OdfDeleteDependency[]) {
  const seen = new Set<string>();
  const unique: OdfDeleteDependency[] = [];
  for (const dependency of dependencies) {
    const key = `${dependency.kind}:${dependency.id}:${dependency.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dependency);
  }
  return unique;
}

const DEPENDENCY_KIND_LABELS: Record<OdfDeleteDependency["kind"], string> = {
  mapping: "ODF mapping(s)",
  fiber: "allocated fiber(s)",
  allocation: "service allocation(s)",
  routeHop: "active route hop(s)",
  splitterOutput: "splitter output(s)",
};

/**
 * Consolidated dependency warning: instead of one popup entry (and link) per
 * blocking record, the popup carries a SINGLE dynamic link that opens the ODF
 * Mappings (segments) view pre-filtered to this exact Site ID / Rack ID / ODF
 * ID, where every live blocker is listed together.
 */
function consolidatedDependencyLink(odf: LoadedOdfForDelete, dependencies: OdfDeleteDependency[]): OdfDeleteDependency[] {
  if (!dependencies.length) return [];
  const params = new URLSearchParams();
  params.set("siteId", odf.site.code);
  params.set("rackId", odf.rack.rackCode);
  params.set("odfId", odf.odfCode);
  params.set("page", "1");
  params.set("pageSize", "1000");
  const countsByKind = new Map<OdfDeleteDependency["kind"], number>();
  for (const dependency of dependencies) {
    countsByKind.set(dependency.kind, (countsByKind.get(dependency.kind) ?? 0) + 1);
  }
  const breakdown = [...countsByKind.entries()]
    .map(([kind, count]) => `${count} ${DEPENDENCY_KIND_LABELS[kind] ?? kind}`)
    .join(", ");
  return [{
    id: `${odf.id}:consolidated`,
    kind: "mapping",
    label: `View all ${dependencies.length} live linked record(s) on ${odf.site.code} / ${odf.rack.rackCode} / ${odf.odfCode}`,
    detail: `Live dependencies: ${breakdown}. The link opens the segments view filtered to this Site ID, Rack ID, and ODF ID.`,
    href: `/inventory?${params.toString()}`,
  }];
}

function endpointWhereForOdf(odfId: string, portGroupIds: string[]) {
  return {
    OR: [
      { odfId },
      ...(portGroupIds.length ? [{ portGroupId: { in: portGroupIds } }] : []),
    ],
  };
}

function mappingWhereForOdf(odf: LoadedOdfForDelete, portGroupIds: string[]) {
  return {
    OR: [
      ...(portGroupIds.length ? [{ localPortGroupId: { in: portGroupIds } }, { farPortGroupId: { in: portGroupIds } }] : []),
      { localSiteCode: odf.site.code, localRackCode: odf.rack.rackCode, localOdfCode: odf.odfCode },
      { farSiteCode: odf.site.code, farRackCode: odf.rack.rackCode, farOdfCode: odf.odfCode },
    ],
  };
}

function serviceAllocationWhereForOdf(portGroupIds: string[], segmentIds: string[], endpointIds: string[]) {
  return {
    OR: [
      ...(portGroupIds.length ? [{ endpointAPortGroupId: { in: portGroupIds } }, { endpointBPortGroupId: { in: portGroupIds } }] : []),
      ...(segmentIds.length ? [{ segmentId: { in: segmentIds } }] : []),
      ...(endpointIds.length ? [{ endpointAId: { in: endpointIds } }, { endpointBId: { in: endpointIds } }] : []),
    ],
  };
}

function routeHopWhereForOdf(odfId: string, portGroupIds: string[], segmentIds: string[]) {
  return {
    OR: [
      { odfId },
      ...(portGroupIds.length ? [{ portGroupId: { in: portGroupIds } }] : []),
      ...(segmentIds.length ? [{ segmentId: { in: segmentIds } }] : []),
    ],
  };
}

async function odfDeleteBlockers(odf: LoadedOdfForDelete, portGroupIds: string[]) {
  const endpointRows = await prisma.segmentEndpoint.findMany({
    where: endpointWhereForOdf(odf.id, portGroupIds),
    select: { id: true },
  });
  const endpointIds = endpointRows.map((endpoint) => endpoint.id);
  const endpointSegments = endpointIds.length
    ? await prisma.linkSegment.findMany({
        where: { OR: [{ endpointAId: { in: endpointIds } }, { endpointBId: { in: endpointIds } }] },
        select: { id: true },
      })
    : [];
  const endpointSegmentIds = endpointSegments.map((segment) => segment.id);
  const matchingMappingWhere = mappingWhereForOdf(odf, portGroupIds);
  const serviceAllocationWhere = serviceAllocationWhereForOdf(portGroupIds, endpointSegmentIds, endpointIds);
  const serviceMappingWhere = { serviceCode: { not: null } };
  const serviceFiberWhere = {
    OR: [
      { serviceCode: { not: null } },
      { serviceId: { not: null } },
      { serviceRouteId: { not: null } },
      { serviceAllocationId: { not: null } },
    ],
  };

  const [
    odfMappings,
    segmentMappings,
    blockingFibers,
    allocations,
    routeHops,
    splitterOutputs,
  ] = await Promise.all([
    prisma.segmentEndpointMapping.findMany({
      where: { AND: [matchingMappingWhere, serviceMappingWhere] },
      include: { segment: { select: { segmentCode: true, status: true } } },
      orderBy: { createdAt: "asc" },
    }),
    endpointSegmentIds.length
      ? prisma.segmentEndpointMapping.findMany({
          where: { AND: [{ segmentId: { in: endpointSegmentIds } }, serviceMappingWhere] },
          include: { segment: { select: { segmentCode: true, status: true } } },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    endpointSegmentIds.length
      ? prisma.segmentFiber.findMany({
          where: {
            segmentId: { in: endpointSegmentIds },
            ...serviceFiberWhere,
          },
          include: { segment: { select: { segmentCode: true } } },
          orderBy: { fiberNumber: "asc" },
        })
      : Promise.resolve([]),
    prisma.serviceAllocation.findMany({
      where: serviceAllocationWhere.OR.length
        ? { AND: [serviceAllocationWhere, { status: { in: BLOCKING_DELETE_STATUSES } }] }
        : { id: "__never__" },
      include: { service: { select: { serviceCode: true, status: true } }, segment: { select: { segmentCode: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.serviceRouteHop.findMany({
      where: routeHopWhereForOdf(odf.id, portGroupIds, endpointSegmentIds),
      include: {
        segment: { select: { segmentCode: true } },
        serviceRoute: { include: { service: { select: { serviceCode: true, status: true } } } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    portGroupIds.length
      ? prisma.splitterOutput.findMany({
          where: {
            portGroupId: { in: portGroupIds },
            OR: [
              { serviceCode: { not: null } },
              { sharingCustomerServiceCode: { not: null } },
              { status: { in: BLOCKING_DELETE_STATUSES } },
            ],
          },
          include: { splitter: { select: { splitterCode: true, splitterName: true } } },
          orderBy: { updatedAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const dependencies: OdfDeleteDependency[] = [];
  for (const mapping of [...odfMappings, ...segmentMappings]) {
    dependencies.push({
      id: mapping.id,
      kind: "mapping",
      label: mapping.serviceCode ? `ODF mapping ${mapping.serviceCode}` : `ODF mapping ${mapping.segment.segmentCode}`,
      detail: `${mapping.localSiteCode ?? "?"}/${mapping.localRackCode ?? "?"}/${mapping.localOdfCode ?? "?"}/${mapping.localPortLabel ?? "?"} -> ${mapping.farSiteCode ?? mapping.farEndpointLabel ?? "?"}/${mapping.farRackCode ?? "?"}/${mapping.farOdfCode ?? "?"}/${mapping.farPortLabel ?? "?"} (${mapping.status})`,
      href: inventoryMappingHref(odf, mapping),
    });
  }
  for (const fiber of blockingFibers) {
    dependencies.push({
      id: fiber.id,
      kind: "fiber",
      label: fiber.serviceCode ? `Fiber ${fiber.serviceCode}` : `Fiber ${fiber.segment.segmentCode} #${fiber.fiberNumber}`,
      detail: `Segment ${fiber.segment.segmentCode}, fiber ${fiber.fiberNumber} (${fiber.status})`,
      href: inventoryServiceHref(fiber.serviceCode, fiber.segment.segmentCode),
    });
  }
  for (const allocation of allocations) {
    if (!isBlockingServiceStatus(allocation.service.status)) continue;
    dependencies.push({
      id: allocation.id,
      kind: "allocation",
      label: allocation.service.serviceCode ? `Service allocation ${allocation.service.serviceCode}` : `Service allocation ${allocation.segment.segmentCode}`,
      detail: `Segment ${allocation.segment.segmentCode}, fibers ${allocation.fiberStart}-${allocation.fiberEnd} (${allocation.status})`,
      href: inventoryServiceHref(allocation.service.serviceCode, allocation.segment.segmentCode),
    });
  }
  for (const hop of routeHops) {
    const serviceCode = hop.serviceRoute.service.serviceCode;
    const liveRoute = hop.serviceRoute.isActive && isBlockingServiceStatus(hop.serviceRoute.service.status);
    if (!liveRoute) continue;
    dependencies.push({
      id: hop.id,
      kind: "routeHop",
      label: `Route hop ${serviceCode}`,
      detail: hop.segment?.segmentCode ? `Active route hop on segment ${hop.segment.segmentCode}` : "Active route hop references this ODF.",
      href: inventoryServiceHref(serviceCode, hop.segment?.segmentCode),
    });
  }
  for (const output of splitterOutputs) {
    const splitterCode = output.splitter.splitterCode ?? output.splitter.splitterName ?? output.splitterId;
    dependencies.push({
      id: output.id,
      kind: "splitterOutput",
      label: output.serviceCode ? `Splitter output ${output.serviceCode}` : `Splitter output ${splitterCode}`,
      detail: `${output.outputLabel ?? output.outputPort ?? "Output"} on ${splitterCode} (${output.status})`,
      href: splitterHref(output.serviceCode, splitterCode, output.destinationLabel),
    });
  }

  const uniqueLiveRecords = uniqueDependencies(dependencies);
  return {
    endpointIds,
    endpointSegmentIds,
    liveRecordCount: uniqueLiveRecords.length,
    dependencies: consolidatedDependencyLink(odf, uniqueLiveRecords),
  };
}

export const destructiveDeleteService = {
  async hardDeleteSegments(segmentIds: string[], changedById?: string | null, reason = "Admin ODF Mapping hard delete") {
    const ids = Array.from(new Set(segmentIds.filter(Boolean)));
    const deletedIds: string[] = [];
    const endpointIds: string[] = [];
    let deletedCount = 0;
    let childLinkCount = 0;

    // Process in bounded chunks; each chunk commits independently so a large
    // selection never holds one lock long enough to time out, and a failure
    // mid-way still leaves earlier chunks durably deleted (and audited).
    for (const idChunk of chunk(ids, HARD_DELETE_CHUNK_SIZE)) {
      const chunkResult = await prisma.$transaction(
        (tx) => snapshotAndHardDeleteSegmentGraph(tx, idChunk, changedById),
        // A chunk of 100 segments + their children/snapshots stays well under
        // this, but give the lock-acquisition wait and commit headroom.
        { maxWait: 15_000, timeout: 60_000 },
      );
      deletedIds.push(...chunkResult.deletedIds);
      endpointIds.push(...chunkResult.endpointIds);
      deletedCount += chunkResult.deletedCount;
      childLinkCount += chunkResult.childLinkCount;
    }

    const result = { deletedCount, deletedIds, endpointIds, childLinkCount };
    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: `BULK-HARD-DELETE:${ids.length}`,
      action: "DELETE",
      oldValue: { ids },
      newValue: { deletedIds: result.deletedIds, childLinkCount: result.childLinkCount },
      changedById: changedById ?? null,
      reason,
    });
    return result;
  },

  async deleteSegments(
    segmentIds: string[],
    changedById?: string | null,
    reason = "Bulk inventory mapping delete",
    options: { mergeTopology?: boolean } = {},
  ) {
    const ids = Array.from(new Set(segmentIds.filter(Boolean)));
    if (!ids.length) return { deletedCount: 0, retiredCount: 0, endpointIds: [] as string[], mergedSegmentId: null as string | null };

    if (options.mergeTopology && ids.length === 2) {
      const result = await prisma.$transaction((tx) => mergeTwoAdjacentSegments(tx, ids, changedById));
      await writeAuditLog({
        entityType: "LinkSegment",
        entityId: `BULK-MERGE:${ids.length}`,
        action: "DELETE",
        oldValue: { ids },
        newValue: { mergedSegmentId: result.mergedSegmentId, mergedSegmentCode: result.mergedSegmentCode, removedIntermediateSite: result.mergedIntermediateSite },
        changedById: changedById ?? null,
        reason: `${reason}. Adjacent topology was merged into ${result.mergedSegmentCode}.`,
      });
      return result;
    }

    const result = await prisma.$transaction(async (tx) => {
      const segments = await tx.linkSegment.findMany({
        where: { id: { in: ids } },
        select: { id: true, endpointAId: true, endpointBId: true },
      });
      const foundIds = segments.map((segment: { id: string }) => segment.id);
      const endpointIds = segments.flatMap((segment: { endpointAId: string; endpointBId: string }) => [segment.endpointAId, segment.endpointBId]);
      await tx.segmentEndpoint.updateMany({ where: { id: { in: endpointIds } }, data: { terminationStatus: ResourceStatus.DECOMMISSIONED } });
      await tx.segmentEndpointMapping.updateMany({ where: { segmentId: { in: foundIds } }, data: { status: ResourceStatus.DECOMMISSIONED, remarks: "Retired from live inventory." } });
      await tx.segmentFiber.updateMany({ where: { segmentId: { in: foundIds }, status: { notIn: [ResourceStatus.ACTIVE, ResourceStatus.USED] } }, data: { status: ResourceStatus.DECOMMISSIONED } });
      await tx.linkSegment.updateMany({
        where: { id: { in: foundIds } },
        data: { status: ResourceStatus.DECOMMISSIONED, decommissionedAt: new Date(), comments: "Retired from live inventory. Historical records preserved." },
      });
      return { deletedCount: 0, retiredCount: foundIds.length, endpointIds, mergedSegmentId: null as string | null };
    });
    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: `BULK-RETIRE:${ids.length}`,
      action: "DELETE",
      oldValue: { ids: segmentIds },
      changedById: changedById ?? null,
      reason: `${reason}. Segments were retired/deactivated; historical records were preserved.`,
    });
    return result;
  },

  /**
   * Blocker pre-check shared by the delete endpoint and the delayed-deletion
   * hold service. Throws the consolidated OdfDeleteBlockedError when any live
   * inventory record still references the ODF; otherwise returns the loaded
   * ODF so callers can label the hold.
   */
  async assertOdfDeletable(odfId: string) {
    const odf = await prisma.oDF.findUnique({
      where: { id: odfId },
      include: { site: true, rack: true, portGroups: { select: { id: true } }, ports: { select: { id: true } } },
    });
    if (!odf) throw new Error("ODF not found.");
    const portGroupIds = odf.portGroups.map((group) => group.id);
    const blockers = await odfDeleteBlockers(odf, portGroupIds);
    if (blockers.dependencies.length) {
      throw new OdfDeleteBlockedError(blockers.dependencies, blockers.liveRecordCount);
    }
    return odf;
  },

  async deleteOdf(odfId: string, changedById?: string | null) {
    const odf = await prisma.oDF.findUnique({
      where: { id: odfId },
      include: { site: true, rack: true, portGroups: { select: { id: true } }, ports: { select: { id: true } } },
    });
    if (!odf) throw new Error("ODF not found.");
    const portGroupIds = odf.portGroups.map((group) => group.id);
    const blockers = await odfDeleteBlockers(odf, portGroupIds);
    if (blockers.dependencies.length) {
      throw new OdfDeleteBlockedError(blockers.dependencies, blockers.liveRecordCount);
    }

    await prisma.$transaction(async (tx) => {
      const endpointIds = blockers.endpointIds.length
        ? blockers.endpointIds
        : (await tx.segmentEndpoint.findMany({
            where: endpointWhereForOdf(odfId, portGroupIds),
            select: { id: true },
          })).map((endpoint: { id: string }) => endpoint.id);
      const segmentIds = blockers.endpointSegmentIds.length
        ? blockers.endpointSegmentIds
        : endpointIds.length
          ? (await tx.linkSegment.findMany({
              where: { OR: [{ endpointAId: { in: endpointIds } }, { endpointBId: { in: endpointIds } }] },
              select: { id: true },
            })).map((segment: { id: string }) => segment.id)
          : [];
      if (segmentIds.length) await deleteSegmentGraph(tx, segmentIds);

      const metricIds = (await tx.utilizationMetric.findMany({ where: { scopeOdfId: odfId }, select: { id: true } })).map((metric: { id: string }) => metric.id);
      await tx.alertEvent.deleteMany({
        where: {
          OR: [
            { odfId },
            { metricId: { in: metricIds } },
          ],
        },
      });
      await tx.utilizationMetric.deleteMany({ where: { scopeOdfId: odfId } });
      const serviceAllocationWhere = serviceAllocationWhereForOdf(portGroupIds, segmentIds, endpointIds);
      if (serviceAllocationWhere.OR.length) {
        await tx.serviceAllocation.deleteMany({
          where: {
            AND: [
              serviceAllocationWhere,
              {
                OR: [
                  { status: { in: NON_BLOCKING_DELETE_STATUSES } },
                  { service: { status: { notIn: [...BLOCKING_SERVICE_STATUSES_LIST] } } },
                ],
              },
            ],
          },
        });
      }
      await tx.serviceRouteHop.deleteMany({ where: routeHopWhereForOdf(odfId, portGroupIds, segmentIds) });
      await tx.segmentEndpointMapping.deleteMany({
        where: {
          AND: [
            mappingWhereForOdf(odf, portGroupIds),
            { serviceCode: null },
          ],
        },
      });
      if (portGroupIds.length) {
        await tx.splitterOutput.updateMany({
          where: { portGroupId: { in: portGroupIds } },
          data: { portGroupId: null },
        });
      }
      await tx.segmentEndpoint.deleteMany({ where: endpointWhereForOdf(odfId, portGroupIds) });
      await tx.portGroupMember.deleteMany({
        where: {
          OR: [
            { portGroupId: { in: portGroupIds } },
            { odfPortId: { in: odf.ports.map((port) => port.id) } },
          ],
        },
      });
      await tx.portGroup.deleteMany({ where: { odfId } });
      await tx.oDFPort.deleteMany({ where: { odfId } });
      await tx.oDF.delete({ where: { id: odfId } });
    });

    await writeAuditLog({
      entityType: "ODF",
      entityId: odfId,
      action: "DELETE",
      oldValue: { siteCode: odf.site.code, rackCode: odf.rack.rackCode, odfCode: odf.odfCode },
      changedById: changedById ?? null,
      reason: "Admin ODF delete",
    });
    return { deletedId: odfId };
  },

  async deleteSite(siteCode: string, changedById?: string | null) {
    const site = await prisma.site.findUnique({
      where: { code: siteCode.toUpperCase() },
      select: { id: true, code: true, name: true },
    });
    if (!site) throw new Error("Site not found.");

    // Full cascade. Previously this blocked whenever ANY reference existed —
    // including DECOMMISSIONED endpoints / racks / ODFs left behind by soft
    // deletes, historical utilization metrics, cleared alerts, and import
    // staging rows — so a site could never actually be removed even after its
    // live inventory was deleted. An authorized caller (RBAC is enforced at the
    // route) now gets a true cascade: every dependent record tied to the site is
    // removed (or detached, for shared rows) so the delete is permanent and the
    // site cannot reappear via a dangling reference.
    const summary = await prisma.$transaction(async (tx) => {
      // Asset ids belonging to this site.
      const odfIds = (await tx.oDF.findMany({ where: { siteId: site.id }, select: { id: true } })).map((row: { id: string }) => row.id);
      const portGroupIds = (await tx.portGroup.findMany({ where: { siteId: site.id }, select: { id: true } })).map((row: { id: string }) => row.id);
      const rackIds = (await tx.rack.findMany({ where: { siteId: site.id }, select: { id: true } })).map((row: { id: string }) => row.id);

      // Every segment that touches this site through ANY of its assets. Each
      // SegmentEndpoint belongs to exactly one LinkSegment, so deleting the
      // segment graph removes both endpoints (near + far) and all child rows.
      const endpointIds = (await tx.segmentEndpoint.findMany({
        where: {
          OR: [
            { siteId: site.id },
            ...(odfIds.length ? [{ odfId: { in: odfIds } }] : []),
            ...(rackIds.length ? [{ rackId: { in: rackIds } }] : []),
            ...(portGroupIds.length ? [{ portGroupId: { in: portGroupIds } }] : []),
          ],
        },
        select: { id: true },
      })).map((row: { id: string }) => row.id);
      const segmentIds = endpointIds.length
        ? (await tx.linkSegment.findMany({
            where: { OR: [{ endpointAId: { in: endpointIds } }, { endpointBId: { in: endpointIds } }] },
            select: { id: true },
          })).map((row: { id: string }) => row.id)
        : [];

      // Reverse-split before cascading. If this site is only a pass-through hop
      // of a chain (A–SITE + SITE–C), splice the two segments back into a single
      // A–C segment so the end-to-end path and its service/ODF mappings are not
      // left dangling. mergeTwoAdjacentSegments rebuilds the merged segment on
      // the two OUTER sites, so removing this site's ODF/rack inventory below
      // cannot orphan it. Anything that is not a clean linear pass-through
      // (stub, ring/spur junction, parallel pair) is cascade-deleted as before.
      const liveTouchingSegments = segmentIds.length
        ? await tx.linkSegment.findMany({
            where: { id: { in: segmentIds }, status: { not: ResourceStatus.DECOMMISSIONED } },
            include: { endpointA: { include: { site: true } }, endpointB: { include: { site: true } } },
          })
        : [];
      const passThroughPair = findLinearPassThrough(liveTouchingSegments, site.code);
      const mergedSegments: Array<{ mergedSegmentCode: string; mergedSegmentId: string; boundarySite: string | null }> = [];
      if (passThroughPair) {
        const merge = await mergeTwoAdjacentSegments(tx, passThroughPair, changedById);
        mergedSegments.push({
          mergedSegmentCode: merge.mergedSegmentCode,
          mergedSegmentId: merge.mergedSegmentId,
          boundarySite: merge.mergedIntermediateSite ?? site.code,
        });
      }
      const mergedIds = new Set<string>(passThroughPair ?? []);
      const segmentResult = await deleteSegmentGraph(tx, segmentIds.filter((id: string) => !mergedIds.has(id)));

      // Site/ODF/port-group-scoped operational rows NOT tied to those segments.
      await tx.serviceAllocation.deleteMany({
        where: {
          OR: [
            { fromSiteId: site.id },
            { toSiteId: site.id },
            ...(portGroupIds.length ? [{ endpointAPortGroupId: { in: portGroupIds } }, { endpointBPortGroupId: { in: portGroupIds } }] : []),
          ],
        },
      });
      await tx.serviceRouteHop.deleteMany({
        where: {
          OR: [
            { siteId: site.id },
            ...(odfIds.length ? [{ odfId: { in: odfIds } }] : []),
            ...(rackIds.length ? [{ rackId: { in: rackIds } }] : []),
            ...(portGroupIds.length ? [{ portGroupId: { in: portGroupIds } }] : []),
          ],
        },
      });
      const metricIds = (await tx.utilizationMetric.findMany({
        where: { OR: [{ scopeSiteId: site.id }, ...(odfIds.length ? [{ scopeOdfId: { in: odfIds } }] : [])] },
        select: { id: true },
      })).map((row: { id: string }) => row.id);
      await tx.alertEvent.deleteMany({
        where: {
          OR: [
            { siteId: site.id },
            ...(odfIds.length ? [{ odfId: { in: odfIds } }] : []),
            ...(metricIds.length ? [{ metricId: { in: metricIds } }] : []),
          ],
        },
      });
      await tx.utilizationMetric.deleteMany({
        where: { OR: [{ scopeSiteId: site.id }, ...(odfIds.length ? [{ scopeOdfId: { in: odfIds } }] : [])] },
      });

      // Detach shared rows that merely point at this site's assets so deleting
      // the assets cannot FK-fail (splitter outputs are kept; cables are shared
      // infrastructure, so we only clear the endpoint reference).
      if (portGroupIds.length) {
        await tx.splitterOutput.updateMany({ where: { portGroupId: { in: portGroupIds } }, data: { portGroupId: null } });
      }

      // Physical inventory under the site.
      await tx.portGroupMember.deleteMany({
        where: {
          OR: [
            ...(portGroupIds.length ? [{ portGroupId: { in: portGroupIds } }] : []),
            ...(odfIds.length ? [{ odfPort: { odfId: { in: odfIds } } }] : []),
          ],
        },
      });
      if (odfIds.length) await tx.oDFPort.deleteMany({ where: { odfId: { in: odfIds } } });
      await tx.portGroup.deleteMany({ where: { siteId: site.id } });
      await tx.oDF.deleteMany({ where: { siteId: site.id } });
      await tx.rack.deleteMany({ where: { siteId: site.id } });

      // Detach shared cables and import staging rows that reference this site.
      await tx.cable.updateMany({ where: { siteAId: site.id }, data: { siteAId: null } });
      await tx.cable.updateMany({ where: { siteBId: site.id }, data: { siteBId: null } });
      await tx.importStagingRow.updateMany({ where: { normalizedSiteAId: site.id }, data: { normalizedSiteAId: null } });
      await tx.importStagingRow.updateMany({ where: { normalizedSiteBId: site.id }, data: { normalizedSiteBId: null } });

      // Site directory rows and the site itself.
      await tx.siteCriticalityAssignment.deleteMany({ where: { siteId: site.id } });
      await tx.siteAlias.deleteMany({ where: { siteId: site.id } });
      await tx.site.delete({ where: { id: site.id } });

      return {
        segmentsDeleted: segmentResult.deletedCount,
        segmentsMerged: mergedSegments.length,
        mergedSegments,
        odfs: odfIds.length,
        racks: rackIds.length,
      };
    }, { maxWait: 15_000, timeout: 60_000 });

    await writeAuditLog({
      entityType: "Site",
      entityId: site.code,
      action: "DELETE",
      oldValue: { code: site.code, name: site.name },
      newValue: summary,
      changedById: changedById ?? null,
      reason: "Admin site delete (cascade)",
    });
    return { deletedCode: site.code, ...summary };
  },
};
