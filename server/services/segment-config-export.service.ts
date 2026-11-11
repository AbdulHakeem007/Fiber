import { prisma } from "@/lib/db/prisma";
import { serviceTraceService } from "@/server/services/service-trace.service";

/**
 * Segment-deletion Excel export offered when segments are marked for deletion.
 *
 * Sheet 1 — one row PER DEPENDENT SERVICE with its sequential end-to-end
 * transport chain (first endpoint -> intermediate sites -> far endpoint),
 * traced across the whole network. Per-hop Rack/ODF details are deliberately
 * omitted; only the SOURCE segment (the one being deleted) has its Rack/ODF
 * identity spelled out.
 *
 * Sheet 2 — the source segment configuration (endpoints, capacity, cable) and
 * Sheet 3 — its child port mappings, kept so the export still supports a
 * manual rebuild after the hold expires.
 */

export interface SegmentDeletionExport {
  fileStamp: string;
  serviceChainRows: Record<string, unknown>[];
  segmentConfigRows: Record<string, unknown>[];
  portMappingRows: Record<string, unknown>[];
}

function cleanCode(value?: string | null): string {
  return String(value ?? "").trim() || "-";
}

function rackOdfLabel(rack?: string | null, odf?: string | null): string {
  return `${cleanCode(rack)} / ${cleanCode(odf)}`;
}

export async function buildSegmentDeletionExport(segmentIds: string[]): Promise<SegmentDeletionExport> {
  const ids = Array.from(new Set(segmentIds.filter(Boolean)));
  if (!ids.length) throw new Error("No segment ids supplied.");
  if (ids.length > 500) throw new Error("Export is limited to 500 segments per request.");

  const segments = await prisma.linkSegment.findMany({
    where: { id: { in: ids } },
    include: {
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
      cable: true,
      endpointMappings: { orderBy: { createdAt: "asc" } },
      fibers: { orderBy: { fiberNumber: "asc" } },
      serviceAllocations: {
        include: { service: { select: { serviceCode: true, serviceName: true, status: true } } },
        orderBy: { pathOrder: "asc" },
      },
    },
  });
  if (!segments.length) throw new Error("None of the selected segments were found.");

  type LoadedSegment = (typeof segments)[number];
  const endpointSite = (endpoint: LoadedSegment["endpointA"]) => cleanCode(endpoint.site?.code ?? endpoint.rawSiteCode);
  const endpointRack = (endpoint: LoadedSegment["endpointA"]) => endpoint.rack?.rackCode ?? endpoint.rawRackCode;
  const endpointOdf = (endpoint: LoadedSegment["endpointA"]) => endpoint.odf?.odfCode ?? endpoint.rawOdfCode;
  const endpointPort = (endpoint: LoadedSegment["endpointA"]) =>
    endpoint.portGroup?.displayLabel ?? endpoint.displayPortText ?? endpoint.rawPortText;

  // Source-segment Rack/ODF identity — the ONLY place rack/ODF ids appear on
  // the service-chain sheet, per the export contract.
  const sourceLabel = (segment: LoadedSegment) =>
    `${endpointSite(segment.endpointA)} ${rackOdfLabel(endpointRack(segment.endpointA), endpointOdf(segment.endpointA))}` +
    ` <-> ${endpointSite(segment.endpointB)} ${rackOdfLabel(endpointRack(segment.endpointB), endpointOdf(segment.endpointB))}`;

  // Every service that depends on a source segment: union of child ODF-mapping
  // rows, fiber assignments, and service allocations (dead rows excluded).
  const sourcesByService = new Map<string, { segments: Set<string>; sourceLabels: Set<string>; fallbackChain: string }>();
  for (const segment of segments) {
    const fallbackChain = `${endpointSite(segment.endpointA)} -> ${endpointSite(segment.endpointB)}`;
    const serviceCodes = new Set<string>();
    for (const mapping of segment.endpointMappings) {
      if (mapping.serviceCode && mapping.status !== "DECOMMISSIONED") serviceCodes.add(mapping.serviceCode.trim());
    }
    for (const fiber of segment.fibers) {
      if (fiber.serviceCode && fiber.status !== "DECOMMISSIONED") serviceCodes.add(fiber.serviceCode.trim());
    }
    for (const allocation of segment.serviceAllocations) {
      if (allocation.service?.serviceCode && allocation.status !== "DECOMMISSIONED") serviceCodes.add(allocation.service.serviceCode.trim());
    }
    for (const serviceCode of serviceCodes) {
      if (!serviceCode) continue;
      const entry = sourcesByService.get(serviceCode) ?? { segments: new Set<string>(), sourceLabels: new Set<string>(), fallbackChain };
      entry.segments.add(segment.segmentCode);
      entry.sourceLabels.add(sourceLabel(segment));
      sourcesByService.set(serviceCode, entry);
    }
  }

  // One full A-to-Z trace per distinct service. The trace's fullPathLabel is
  // already the sequential site chain: first endpoint -> ... -> far endpoint.
  const serviceChainRows: Record<string, unknown>[] = [];
  let srNo = 1;
  for (const [serviceCode, entry] of [...sourcesByService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let chain = "";
    try {
      const trace = await serviceTraceService.getTraceCore(serviceCode);
      chain = trace?.fullPathLabel ?? "";
    } catch {
      // A single failed trace must not sink the export; fall back below.
    }
    serviceChainRows.push({
      "Sr.No": srNo++,
      "Service ID": serviceCode,
      "End-to-End Transport Chain (A-Z)": chain || entry.fallbackChain,
      "Source Segment(s)": [...entry.segments].join(", "),
      "Source Segment Rack/ODF": [...entry.sourceLabels].join(" ; "),
    });
  }

  const segmentConfigRows = segments.map((segment, index) => ({
    "Sr.No": index + 1,
    "Segment": segment.segmentCode,
    "Status": segment.status,
    "Segment Type": segment.segmentDefaultRole ?? "-",
    "Near Site": endpointSite(segment.endpointA),
    "Near Rack/ODF": rackOdfLabel(endpointRack(segment.endpointA), endpointOdf(segment.endpointA)),
    "Near Port": cleanCode(endpointPort(segment.endpointA)),
    "Far Site": endpointSite(segment.endpointB),
    "Far Rack/ODF": rackOdfLabel(endpointRack(segment.endpointB), endpointOdf(segment.endpointB)),
    "Far Port": cleanCode(endpointPort(segment.endpointB)),
    "Capacity (fibers)": segment.totalFiberCapacity ?? segment.fiberCount ?? "-",
    "Used Fibers": segment.usedFiberCount,
    "Distance (km)": segment.distanceKm ?? "-",
    "Cable": segment.cable?.cableCode ?? segment.cable?.cableName ?? "-",
    "Tube": segment.tubeNumber ?? "-",
    "Tube Color": segment.tubeColor ?? "-",
    "Comments": segment.comments ?? "-",
  }));

  const portMappingRows = segments.flatMap((segment) =>
    segment.endpointMappings.map((mapping) => ({
      "Segment": segment.segmentCode,
      "Local Site": cleanCode(mapping.localSiteCode),
      "Local Rack/ODF": rackOdfLabel(mapping.localRackCode, mapping.localOdfCode),
      "Local Port": cleanCode(mapping.localPortLabel),
      "Far Site": cleanCode(mapping.farSiteCode ?? mapping.farEndpointLabel),
      "Far Rack/ODF": rackOdfLabel(mapping.farRackCode, mapping.farOdfCode),
      "Far Port": cleanCode(mapping.farPortLabel),
      "Service ID": cleanCode(mapping.serviceCode),
      "Fibers": cleanCode(mapping.fiberNumbersJson),
      "Role": cleanCode(mapping.childTopologyRole),
      "Tag": cleanCode(mapping.tag),
      "Status": mapping.status,
      "Remarks": cleanCode(mapping.remarks),
    })),
  );

  return {
    fileStamp: new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"),
    serviceChainRows,
    segmentConfigRows,
    portMappingRows,
  };
}
