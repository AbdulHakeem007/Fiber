import { NextResponse } from "next/server";
import { ResourceStatus } from "@prisma/client";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { fiberCountFromUnit, jsonFiberNumbersFromUnit, pairedSelectedPeerUnit, pairedSurvivorFarUnit, splitPairSurvivor } from "@/lib/telecom/fiber-unit";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { normalizeTopologyRole } from "@/lib/telecom/topology-role";
import { isRehomedOutRemark } from "@/lib/telecom/rehome";

const EDITABLE_STATUSES = new Set(["ACTIVE", "AVAILABLE", "RESERVED", "FAULTY", "DUMMY", "PLANNED", "INACTIVE", "DECOMMISSIONED"]);

function statusFromBody(value: unknown): ResourceStatus | null {
  let text = String(value ?? "").toUpperCase();
  if (text === "USED") text = "ACTIVE";
  // PLANNED is now a first-class child-link status and must persist (no longer
  // folded into AVAILABLE). Legacy SPARE/UNKNOWN still normalize to AVAILABLE.
  if (["SPARE", "UNKNOWN"].includes(text)) text = "AVAILABLE";
  return EDITABLE_STATUSES.has(text) ? text as ResourceStatus : null;
}

function textOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value ?? "").trim();
  return text || null;
}

function mappingToInventoryRow(mapping: any) {
  return {
    id: mapping.id,
    fiberId: mapping.id,
    serviceId: mapping.serviceCode,
    tag: mapping.tag ?? null,
    childTopologyRole: mapping.childTopologyRole ?? null,
    localSite: displaySiteLabel(mapping.localSiteCode),
    localRack: mapping.localRackCode,
    localOdf: mapping.localOdfCode,
    localPort: mapping.localPortLabel,
    farSite: displaySiteLabel(mapping.farSiteCode ?? mapping.farEndpointLabel),
    farEndpoint: mapping.farEndpointLabel,
    farRack: mapping.farRackCode,
    farOdf: mapping.farOdfCode,
    farPort: mapping.farPortLabel,
    fiberNumbers: mapping.fiberNumbersJson,
    fiberCount: fiberCountFromUnit(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson),
    status: mapping.status,
    remarks: mapping.remarks,
  };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ fiberId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to update fiber links." }, { status: 403 });
    }
    const { fiberId } = await params;
    const body = await request.json().catch(() => ({}));
    const status = statusFromBody(body.status);
    const releaseService = Boolean(body.releaseService);
    const requestedService = textOrNull(body.serviceCode ?? body.serviceId);
    const effectiveStatus = releaseService
      ? ResourceStatus.AVAILABLE
      : requestedService
        ? (status && status !== ResourceStatus.AVAILABLE ? status : ResourceStatus.ACTIVE)
        : status;

    const fiber = await prisma.segmentFiber.findUnique({ where: { id: fiberId }, select: { id: true, segmentId: true, serviceId: true, serviceAllocationId: true, serviceCode: true, fiberNumber: true } });
    if (fiber) {
      if (status && (fiber.serviceId || fiber.serviceCode) && status !== ResourceStatus.FAULTY && !releaseService && requestedService === undefined) {
        return NextResponse.json({ error: "This fiber link is active on a service. Release or edit the service ID before changing its inventory status." }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        if (releaseService && fiber.serviceAllocationId) {
          await tx.serviceAllocation.update({ where: { id: fiber.serviceAllocationId }, data: { status: "SPARE", remarks: "Released from fiber-link editor." } });
        }
        await tx.segmentFiber.update({
          where: { id: fiberId },
          data: {
            status: effectiveStatus ?? undefined,
            serviceId: releaseService ? null : undefined,
            serviceRouteId: releaseService ? null : undefined,
            serviceAllocationId: releaseService ? null : undefined,
            serviceCode: releaseService ? null : requestedService,
            allocationGroup: releaseService ? null : undefined,
            pathOrder: releaseService ? null : undefined,
            allocatedAt: releaseService ? null : requestedService ? new Date() : undefined,
            remarks: typeof body.remarks === "string" ? body.remarks : undefined,
          },
        });
        await segmentCapacityService.refreshSegmentCapacity(tx, fiber.segmentId);
      });

      await writeAuditLog({
        entityType: "SegmentFiber",
        entityId: fiberId,
        action: releaseService ? "RELEASE" : "UPDATE",
        newValue: body,
        changedById: session?.id ?? null,
        reason: releaseService ? "Fiber service released" : "Fiber link status/service update",
      });
      return NextResponse.json({ message: releaseService ? "Fiber link released successfully." : "Fiber link updated successfully." });
    }

    const mapping = await prisma.segmentEndpointMapping.findUnique({
      where: { id: fiberId },
      select: {
        id: true,
        segmentId: true,
        serviceCode: true,
        tag: true,
        childTopologyRole: true,
        localSiteCode: true,
        localRackCode: true,
        localOdfCode: true,
        localPortLabel: true,
        farSiteCode: true,
        farEndpointLabel: true,
        farRackCode: true,
        farOdfCode: true,
        farPortLabel: true,
        fiberNumbersJson: true,
        status: true,
        source: true,
        remarks: true,
      },
    });
    if (!mapping) return NextResponse.json({ error: "Fiber link / endpoint mapping not found." }, { status: 404 });

    const explicitLocalPort = textOrNull(body.localPort);
    const explicitFarPort = textOrNull(body.farPort);
    const nextLocalPort = pairedSelectedPeerUnit(mapping.farPortLabel, explicitFarPort ?? mapping.farPortLabel, mapping.localPortLabel, explicitLocalPort) ?? mapping.localPortLabel;
    const nextFarPort = pairedSelectedPeerUnit(mapping.localPortLabel, nextLocalPort, mapping.farPortLabel, explicitFarPort) ?? mapping.farPortLabel;
    const survivorLocalPort = splitPairSurvivor(mapping.localPortLabel, nextLocalPort);
    const survivorFarPort = pairedSurvivorFarUnit(mapping.localPortLabel, nextLocalPort, mapping.farPortLabel, nextFarPort);
    const shouldSplitPair = Boolean(survivorLocalPort && survivorFarPort);

    let rows: any[] = [];
    let refreshedSegment: any = null;
    await prisma.$transaction(async (tx) => {
      await tx.segmentEndpointMapping.update({
        where: { id: fiberId },
        data: {
          status: effectiveStatus ?? undefined,
          serviceCode: releaseService ? null : requestedService,
          childTopologyRole: normalizeTopologyRole(body.childTopologyRole),
          localSiteCode: textOrNull(body.localSite),
          localRackCode: textOrNull(body.localRack),
          localOdfCode: textOrNull(body.localOdf),
          localPortLabel: nextLocalPort,
          farSiteCode: textOrNull(body.farSite),
          farRackCode: textOrNull(body.farRack),
          farOdfCode: textOrNull(body.farOdf),
          farPortLabel: nextFarPort,
          fiberNumbersJson: jsonFiberNumbersFromUnit(nextLocalPort),
          remarks: typeof body.remarks === "string" ? body.remarks : undefined,
        },
      });

      if (shouldSplitPair) {
        const existingSurvivor = await tx.segmentEndpointMapping.findFirst({
          where: {
            segmentId: mapping.segmentId,
            localSiteCode: textOrNull(body.localSite) ?? mapping.localSiteCode,
            localRackCode: textOrNull(body.localRack) ?? mapping.localRackCode,
            localOdfCode: textOrNull(body.localOdf) ?? mapping.localOdfCode,
            localPortLabel: survivorLocalPort,
            farSiteCode: textOrNull(body.farSite) ?? mapping.farSiteCode,
            farRackCode: textOrNull(body.farRack) ?? mapping.farRackCode,
            farOdfCode: textOrNull(body.farOdf) ?? mapping.farOdfCode,
            farPortLabel: survivorFarPort,
          },
          select: { id: true },
        });

        if (!existingSurvivor) {
          await tx.segmentEndpointMapping.create({
            data: {
              segmentId: mapping.segmentId,
              importStagingRowId: null,
              localSiteCode: textOrNull(body.localSite) ?? mapping.localSiteCode,
              localRackCode: textOrNull(body.localRack) ?? mapping.localRackCode,
              localOdfCode: textOrNull(body.localOdf) ?? mapping.localOdfCode,
              localPortLabel: survivorLocalPort,
              farSiteCode: textOrNull(body.farSite) ?? mapping.farSiteCode,
              farEndpointLabel: mapping.farEndpointLabel,
              farRackCode: textOrNull(body.farRack) ?? mapping.farRackCode,
              farOdfCode: textOrNull(body.farOdf) ?? mapping.farOdfCode,
              farPortLabel: survivorFarPort,
              fiberNumbersJson: jsonFiberNumbersFromUnit(survivorLocalPort),
              serviceCode: null,
              childTopologyRole: null,
              status: ResourceStatus.AVAILABLE,
              source: mapping.source,
              remarks: `Auto-created surviving single fiber from ${mapping.localPortLabel ?? "pair"} after child edit.`,
            },
          });
        }
      }

      refreshedSegment = await segmentCapacityService.refreshSegmentCapacity(tx, mapping.segmentId);
      rows = await tx.segmentEndpointMapping.findMany({
        where: { segmentId: mapping.segmentId },
        orderBy: { createdAt: "asc" },
      });
    });

    await writeAuditLog({
      entityType: "SegmentEndpointMapping",
      entityId: fiberId,
      action: releaseService ? "RELEASE" : "UPDATE",
      newValue: body,
      changedById: session?.id ?? null,
      reason: shouldSplitPair
        ? "Endpoint mapping updated and pair split into standalone fibers"
        : releaseService ? "Endpoint mapping service released" : "Endpoint mapping status/service update",
    });
    return NextResponse.json({
      message: shouldSplitPair
        ? "Endpoint mapping updated. Remaining fiber kept as a standalone available child row."
        : releaseService ? "Endpoint mapping released successfully." : "Endpoint mapping updated successfully.",
      rows: rows.map(mappingToInventoryRow),
      segment: refreshedSegment,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Fiber link update failed." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ fiberId: string }> }) {
  try {
    const session = await getSessionUser();
    // RBAC Tier 2: READ_WRITE accounts may delete INDIVIDUAL child links only.
    // Bulk deletion and parent segment deletion remain ADMIN-only elsewhere.
    if (!hasPermission(session?.roleCode, "childLinkDelete")) {
      return NextResponse.json({ error: "Write access is required to delete individual fiber links." }, { status: 403 });
    }
    const { fiberId } = await params;
    const fiber = await prisma.segmentFiber.findUnique({ where: { id: fiberId }, select: { id: true, segmentId: true, serviceId: true, serviceCode: true, remarks: true } });
    if (fiber) {
      const isRehomedCleanup = isRehomedOutRemark(fiber.remarks);
      if (!isRehomedCleanup && (fiber.serviceId || fiber.serviceCode)) {
        return NextResponse.json({ error: "This fiber link is active on a service. Release the service before deleting." }, { status: 400 });
      }
      await prisma.$transaction(async (tx) => {
        if (isRehomedCleanup) {
          await tx.segmentFiber.delete({ where: { id: fiberId } });
        } else {
          await tx.segmentFiber.update({ where: { id: fiberId }, data: { status: "DECOMMISSIONED", remarks: "Retired from child fiber-link editor." } });
        }
        await segmentCapacityService.refreshSegmentCapacity(tx, fiber.segmentId);
      });
      await writeAuditLog({ entityType: "SegmentFiber", entityId: fiberId, action: "DELETE", changedById: session?.id ?? null, reason: isRehomedCleanup ? "Rehomed cleanup fiber safely deleted" : "Fiber link retired" });
      return NextResponse.json({ message: isRehomedCleanup ? "Rehomed cleanup row deleted safely." : "Fiber link deleted successfully.", retired: !isRehomedCleanup, removed: isRehomedCleanup });
    }

    const mapping = await prisma.segmentEndpointMapping.findUnique({ where: { id: fiberId }, select: { id: true, segmentId: true, serviceCode: true, remarks: true } });
    if (!mapping) return NextResponse.json({ error: "Fiber link / endpoint mapping not found." }, { status: 404 });
    const isRehomedCleanup = isRehomedOutRemark(mapping.remarks);
    if (!isRehomedCleanup && mapping.serviceCode) {
      return NextResponse.json({ error: "This endpoint mapping carries a service. Release the service before deleting." }, { status: 400 });
    }
    await prisma.$transaction(async (tx) => {
      if (isRehomedCleanup) {
        await tx.segmentEndpointMapping.delete({ where: { id: fiberId } });
      } else {
        await tx.segmentEndpointMapping.update({ where: { id: fiberId }, data: { status: "DECOMMISSIONED", remarks: "Retired from child endpoint-mapping editor." } });
      }
      await segmentCapacityService.refreshSegmentCapacity(tx, mapping.segmentId);
    });
    await writeAuditLog({ entityType: "SegmentEndpointMapping", entityId: fiberId, action: "DELETE", changedById: session?.id ?? null, reason: isRehomedCleanup ? "Rehomed cleanup endpoint mapping safely deleted" : "Endpoint mapping retired" });
    return NextResponse.json({ message: isRehomedCleanup ? "Rehomed cleanup row deleted safely." : "Endpoint mapping deleted successfully.", retired: !isRehomedCleanup, removed: isRehomedCleanup });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Fiber link delete failed. Check dependencies and try again." }, { status: 500 });
  }
}
