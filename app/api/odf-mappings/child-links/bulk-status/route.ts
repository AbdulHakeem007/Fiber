import { NextResponse } from "next/server";
import { ResourceStatus } from "@prisma/client";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { fiberCountFromUnit } from "@/lib/telecom/fiber-unit";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { isRehomedOutRemark } from "@/lib/telecom/rehome";
import { effectiveTopologyRole } from "@/lib/telecom/topology-role";

const BULK_CHILD_STATUSES = new Set<ResourceStatus>([
  ResourceStatus.ACTIVE,
  ResourceStatus.AVAILABLE,
  // RESERVED is a first-class, operator-selectable child port state (a port
  // held for planned use) — persisted as-is, never folded into AVAILABLE.
  ResourceStatus.RESERVED,
  ResourceStatus.FAULTY,
  ResourceStatus.PLANNED,
  ResourceStatus.INACTIVE,
  ResourceStatus.DECOMMISSIONED,
]);

function normalizeStatus(value: unknown): ResourceStatus | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!BULK_CHILD_STATUSES.has(text as ResourceStatus)) return null;
  return text as ResourceStatus;
}

function mappingToInventoryRow(mapping: any, segment: any) {
  const topology = effectiveTopologyRole({ childTopologyRole: mapping.childTopologyRole, segmentDefaultRole: segment.segmentDefaultRole });
  return {
    id: mapping.id,
    fiberId: mapping.id,
    serviceId: mapping.serviceCode,
    tag: mapping.tag ?? null,
    childTopologyRole: mapping.childTopologyRole ?? null,
    effectiveTopologyRole: topology.role,
    topologyRoleSource: topology.source,
    localSite: displaySiteLabel(mapping.localSiteCode, segment.segmentGroupName ?? segment.segmentCode),
    localRack: mapping.localRackCode,
    localOdf: mapping.localOdfCode,
    localPort: mapping.localPortLabel,
    farSite: displaySiteLabel(mapping.farSiteCode ?? mapping.farEndpointLabel, segment.segmentGroupName ?? segment.segmentCode),
    farEndpoint: mapping.farEndpointLabel,
    farRack: mapping.farRackCode,
    farOdf: mapping.farOdfCode,
    farPort: mapping.farPortLabel,
    cableId: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
    fiberNumbers: mapping.fiberNumbersJson,
    fiberCount: fiberCountFromUnit(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson),
    status: isRehomedOutRemark(mapping.remarks) ? "REHOMED" : mapping.status,
    remarks: mapping.remarks,
  };
}

function fiberToInventoryRow(fiber: any, segment: any) {
  const local = segment.endpointA;
  const far = segment.endpointB;
  return {
    id: fiber.id,
    fiberId: fiber.id,
    fiberNumber: fiber.fiberNumber,
    serviceId: fiber.serviceCode,
    localSite: displaySiteLabel(local.site?.code ?? local.rawSiteCode, segment.segmentGroupName ?? segment.segmentCode),
    localRack: local.rack?.rackCode ?? local.rawRackCode,
    localOdf: local.odf?.odfCode ?? local.rawOdfCode,
    localPort: local.portGroup?.displayLabel ?? local.displayPortText ?? local.rawPortText,
    farSite: displaySiteLabel(far.site?.code ?? far.rawSiteCode, segment.segmentGroupName ?? segment.segmentCode),
    farRack: far.rack?.rackCode ?? far.rawRackCode,
    farOdf: far.odf?.odfCode ?? far.rawOdfCode,
    farPort: far.portGroup?.displayLabel ?? far.displayPortText ?? far.rawPortText,
    cableId: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
    fiberNumbers: String(fiber.fiberNumber),
    fiberCount: 1,
    status: isRehomedOutRemark(fiber.remarks) ? "REHOMED" : fiber.status,
    remarks: fiber.remarks,
  };
}

async function loadRowsBySegment(segmentIds: string[]) {
  const segments = await prisma.linkSegment.findMany({
    where: { id: { in: segmentIds } },
    include: {
      cable: true,
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointMappings: { orderBy: { createdAt: "asc" } },
      fibers: { orderBy: { fiberNumber: "asc" } },
    },
  });

  const rowsBySegment: Record<string, unknown[]> = {};
  for (const segment of segments) {
    rowsBySegment[segment.id] = segment.endpointMappings.length
      ? segment.endpointMappings.map((mapping) => mappingToInventoryRow(mapping, segment))
      : segment.fibers.map((fiber) => fiberToInventoryRow(fiber, segment));
  }
  return rowsBySegment;
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to update child link statuses." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map((id: unknown) => String(id ?? "").trim()).filter(Boolean) : [];
    const status = normalizeStatus(body.status);
    if (!ids.length) return NextResponse.json({ error: "Select at least one child link." }, { status: 400 });
    if (!status) return NextResponse.json({ error: "Invalid child status. Allowed: Active, Available, Reserved, Faulty, Planned, Inactive, Decommissioned." }, { status: 400 });

    const mappings = await prisma.segmentEndpointMapping.findMany({ where: { id: { in: ids } } });
    const mappingIds = new Set(mappings.map((mapping) => mapping.id));
    const fibers = await prisma.segmentFiber.findMany({ where: { id: { in: ids.filter((id: string) => !mappingIds.has(id)) } } });

    const notFound = ids.filter((id: string) => !mappingIds.has(id) && !fibers.some((fiber) => fiber.id === id));
    if (notFound.length) return NextResponse.json({ error: `Some child links were not found: ${notFound.join(", ")}.` }, { status: 404 });

    const rehomedIds = [
      ...mappings.filter((mapping) => isRehomedOutRemark(mapping.remarks)).map((mapping) => mapping.id),
      ...fibers.filter((fiber) => isRehomedOutRemark(fiber.remarks)).map((fiber) => fiber.id),
    ];
    if (rehomedIds.length) {
      return NextResponse.json({ error: "Rehomed cleanup rows cannot be bulk-status edited. Delete cleanup rows after split approval instead." }, { status: 400 });
    }

    const allowedStatuses: ResourceStatus[] = [ResourceStatus.ACTIVE, ResourceStatus.FAULTY];
    const serviceBlocked = [
      ...mappings.filter((mapping) => mapping.serviceCode && !allowedStatuses.includes(status)).map((mapping) => mapping.serviceCode),
      ...fibers.filter((fiber) => (fiber.serviceId || fiber.serviceCode) && !allowedStatuses.includes(status)).map((fiber) => fiber.serviceCode ?? fiber.serviceId),
    ].filter(Boolean);
    if (serviceBlocked.length) {
      return NextResponse.json({ error: `Selected child link(s) carry service(s): ${[...new Set(serviceBlocked)].join(", ")}. Release the service before setting Available or Decommissioned.` }, { status: 400 });
    }

    const affectedSegmentIds = [...new Set([...mappings.map((mapping) => mapping.segmentId), ...fibers.map((fiber) => fiber.segmentId)])];
    await prisma.$transaction(async (tx) => {
      if (mappings.length) {
        await tx.segmentEndpointMapping.updateMany({ where: { id: { in: mappings.map((mapping) => mapping.id) } }, data: { status } });
      }
      if (fibers.length) {
        await tx.segmentFiber.updateMany({ where: { id: { in: fibers.map((fiber) => fiber.id) } }, data: { status } });
      }
      for (const segmentId of affectedSegmentIds) {
        await segmentCapacityService.refreshSegmentCapacity(tx, segmentId);
      }
    });

    await writeAuditLog({
      entityType: "SegmentEndpointMapping",
      entityId: affectedSegmentIds.join(","),
      action: "UPDATE",
      fieldName: "bulkChildStatus",
      newValue: { ids, status },
      changedById: session?.id ?? null,
      reason: "Bulk child ODF mapping status update",
    });

    return NextResponse.json({
      message: `Updated ${ids.length} child row(s) to ${status}.`,
      updatedCount: ids.length,
      affectedSegmentIds,
      rowsBySegment: await loadRowsBySegment(affectedSegmentIds),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bulk child status update failed." }, { status: 500 });
  }
}
