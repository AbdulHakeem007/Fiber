import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { fiberCountFromUnit } from "@/lib/telecom/fiber-unit";
import { isRehomedOutRemark } from "@/lib/telecom/rehome";
import { effectiveTopologyRole } from "@/lib/telecom/topology-role";

function endpointView(endpoint: any) {
  return {
    site: endpoint.site?.code ?? endpoint.rawSiteCode ?? null,
    rack: endpoint.rack?.rackCode ?? endpoint.rawRackCode ?? null,
    odf: endpoint.odf?.odfCode ?? endpoint.rawOdfCode ?? null,
    port: endpoint.portGroup?.displayLabel ?? endpoint.displayPortText ?? endpoint.rawPortText ?? null,
  };
}

function nearPortKey(localPort?: string | null, farPort?: string | null): number {
  // Benchmark = NEAR-site port. Child rows are returned in ascending near-port
  // order (the DB returns them in createdAt order, which read as random). Each row
  // keeps its own far-end port, so the near↔far pairing is preserved.
  const near = String(localPort ?? "").match(/\d+/)?.[0];
  if (near !== undefined) return Number(near);
  const far = String(farPort ?? "").match(/\d+/)?.[0];
  return far !== undefined ? Number(far) : Number.MAX_SAFE_INTEGER;
}

export async function GET(_request: Request, { params }: { params: Promise<{ segmentId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryRead")) {
      return NextResponse.json({ error: "Inventory read access is required to view fiber links." }, { status: 403 });
    }

    const { segmentId } = await params;
    const segment = await prisma.linkSegment.findUnique({
      where: { id: segmentId },
      include: {
        cable: true,
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointMappings: { orderBy: { createdAt: "asc" } },
        fibers: { orderBy: { fiberNumber: "asc" } },
      },
    });
    if (!segment) return NextResponse.json({ error: "Segment not found." }, { status: 404 });

    if (segment.endpointMappings.length) {
      const rows = segment.endpointMappings
        .map((mapping) => ({
          id: mapping.id,
          fiberId: mapping.id,
          serviceId: mapping.serviceCode,
          tag: mapping.tag ?? null,
          childTopologyRole: mapping.childTopologyRole ?? null,
          effectiveTopologyRole: effectiveTopologyRole({ childTopologyRole: mapping.childTopologyRole, segmentDefaultRole: segment.segmentDefaultRole }).role,
          topologyRoleSource: effectiveTopologyRole({ childTopologyRole: mapping.childTopologyRole, segmentDefaultRole: segment.segmentDefaultRole }).source,
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
        }))
        // Strict ascending order by the near-site port (DB returns createdAt order).
        .sort((a, b) => nearPortKey(a.localPort, a.farPort) - nearPortKey(b.localPort, b.farPort));
      return NextResponse.json({ rows });
    }

    const local = endpointView(segment.endpointA);
    const far = endpointView(segment.endpointB);
    return NextResponse.json({
      rows: segment.fibers.map((fiber) => ({
        id: fiber.id,
        fiberId: fiber.id,
        fiberNumber: fiber.fiberNumber,
        serviceId: fiber.serviceCode,
        localSite: displaySiteLabel(local.site, segment.segmentGroupName ?? segment.segmentCode),
        localRack: local.rack,
        localOdf: local.odf,
        localPort: local.port,
        farSite: displaySiteLabel(far.site, segment.segmentGroupName ?? segment.segmentCode),
        farRack: far.rack,
        farOdf: far.odf,
        farPort: far.port,
        cableId: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
        fiberNumbers: String(fiber.fiberNumber),
        fiberCount: 1,
        status: isRehomedOutRemark(fiber.remarks) ? "REHOMED" : fiber.status,
        remarks: fiber.remarks,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Fiber link load failed." }, { status: 500 });
  }
}
