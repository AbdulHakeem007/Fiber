import type { Prisma } from "@prisma/client";
import type { IndirectRouteSummary, ServiceEndpointView, ServiceTraceLinkView, ServiceTraceResult, ServiceTraceTopologyGroup, SplitterTraceFork, SplitterTraceGroup } from "@/types/telecom";
import { sumDistanceKm } from "@/lib/telecom/trace";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";
import { isRehomedOutRemark } from "@/lib/telecom/rehome";
import { prisma } from "@/lib/db/prisma";
import { serviceRepository } from "@/server/repositories/service.repository";
import { extractPurifiedSiteCode, extractPurifiedSiteCodes, purifyTransportSiteToken, splitTransportPathSites } from "@/lib/telecom/site-id-purification";
import { effectiveTopologyRole, topologyRoleLabel, type TopologyRole } from "@/lib/telecom/topology-role";
import { getJumperSiteCodes, setJumperSiteCodes } from "@/lib/telecom/jumper-db";
import { writeAuditLog } from "@/lib/audit/audit-log";
import {
  findAllSimplePaths,
  findShortestPath,
  orderTopology,
  findJunctions,
  type ShortestPathResult,
  type TopoEdge,
  type OrderedTopology,
  type WeightedTopoEdge,
} from "@/lib/telecom/topology-graph";

type TraceService = NonNullable<
  Awaited<ReturnType<typeof serviceRepository.getTraceByServiceCode>>
>;
type TraceRoute = TraceService["routes"][number];
type TraceAllocation = TraceRoute["allocations"][number];
type TraceHop = TraceRoute["hops"][number];
type TraceSegment = NonNullable<TraceHop["segment"]>;
type TraceEndpoint = TraceSegment["endpointA"];
type MappingTraceRecord = Awaited<
  ReturnType<typeof loadMappingsForService>
>[number];
type MappingSegment = MappingTraceRecord["segment"];

const previewSegmentInclude = {
  importBatch: { select: { sourceSystem: true } },
  endpointA: {
    include: { site: true, rack: true, odf: true, portGroup: true },
  },
  endpointB: {
    include: { site: true, rack: true, odf: true, portGroup: true },
  },
  endpointMappings: true,
  serviceAllocations: { include: { service: true } },
  fibers: true,
} satisfies Prisma.LinkSegmentInclude;

type PreviewSegment = Prisma.LinkSegmentGetPayload<{
  include: typeof previewSegmentInclude;
}>;

type TransportPreviewHop = {
  from: string;
  to: string;
  matched: boolean;
  segmentCode?: string | null;
  segmentGroupName?: string | null;
  local?: ServiceEndpointView | null;
  far?: ServiceEndpointView | null;
  serviceIds?: string | null;
  totalFibers?: number | null;
  usedFibers?: number | null;
  availableFibers?: number | null;
  status?: string | null;
  distanceKm?: number | null;
  cumulativeDistanceKm?: number | null;
};

function cleanSiteLabel(value?: string | null): string | null {
  const text = purifyTransportSiteToken(value);
  return text || null;
}

function cleanSegmentCode(value?: string | null): string | null {
  const text = purifyTransportSiteToken(value);
  return text || null;
}

function normalizedSite(value?: string | null): string | null {
  return normalizeAlias(value) ?? null;
}

function sameSite(left?: string | null, right?: string | null): boolean {
  const a = normalizedSite(left);
  const b = normalizedSite(right);
  return Boolean(a && b && a === b);
}

function splitPathLabel(label?: string | null): [string | null, string | null] {
  if (!label?.includes("->")) return [null, null];
  const [left, ...rest] = label.split("->");
  return [cleanSiteLabel(left), cleanSiteLabel(rest.join("->"))];
}

function endpointSiteCode(endpoint: TraceEndpoint): string | null {
  return endpoint.site?.code ?? endpoint.rawSiteCode ?? null;
}

function endpointView(
  segment: TraceSegment,
  endpoint: TraceEndpoint,
): ServiceEndpointView {
  const capacity = segmentCapacityView(
    segment as unknown as CapacitySegmentLike,
  );
  return {
    siteCode: endpointSiteCode(endpoint),
    rackCode: endpoint.rack?.rackCode ?? endpoint.rawRackCode,
    odfCode: endpoint.odf?.odfCode ?? endpoint.rawOdfCode,
    portGroupLabel:
      endpoint.portGroup?.displayLabel ??
      endpoint.displayPortText ??
      endpoint.rawPortText,
    segmentCode: cleanSegmentCode(segment.segmentCode),
    tubeNumber: segment.tubeNumber,
    tubeColor: segment.tubeColor,
    tubeLabel: segment.tubeLabel,
    fiberPortNumber:
      segment.fiberPortNumber ?? endpoint.portGroup?.fiberPortNumber ?? null,
    fiberNumber: segment.fiberNumber ?? endpoint.portGroup?.fiberNumber ?? null,
    fiberLabel: segment.fiberLabel,
    totalFibers: capacity.totalFibers,
    availableFibers: capacity.availableFibers,
    usedFibers: capacity.usedFibers,
    reservedFibers: capacity.reservedFibers,
    faultyFibers: capacity.faultyFibers,
    utilizationPct: capacity.utilizationPct,
    distanceKm: segment.distanceKm,
  };
}

function mappingEndpointView(
  segment: MappingSegment,
  side: "LOCAL" | "FAR",
  mapping: MappingTraceRecord,
): ServiceEndpointView {
  const fiberNumbers = parseFiberNumbers(mapping.fiberNumbersJson);
  const capacity = segmentCapacityView(
    segment as unknown as CapacitySegmentLike,
  );
  return {
    siteCode:
      side === "LOCAL"
        ? mapping.localSiteCode
        : (mapping.farSiteCode ?? mapping.farEndpointLabel),
    rackCode: side === "LOCAL" ? mapping.localRackCode : mapping.farRackCode,
    odfCode: side === "LOCAL" ? mapping.localOdfCode : mapping.farOdfCode,
    portGroupLabel:
      side === "LOCAL" ? mapping.localPortLabel : mapping.farPortLabel,
    segmentCode: cleanSegmentCode(segment.segmentCode),
    tubeNumber: segment.tubeNumber,
    tubeColor: segment.tubeColor,
    tubeLabel: segment.tubeLabel,
    fiberPortNumber: segment.fiberPortNumber,
    fiberNumbers,
    fiberRangeLabel: fiberNumbers.length
      ? rangeLabel(fiberNumbers)
      : mapping.fiberNumbersJson,
    fiberLabel: segment.fiberLabel,
    totalFibers: capacity.totalFibers,
    availableFibers: capacity.availableFibers,
    usedFibers: capacity.usedFibers,
    reservedFibers: capacity.reservedFibers,
    faultyFibers: capacity.faultyFibers,
    utilizationPct: capacity.utilizationPct,
    distanceKm: segment.distanceKm,
  };
}

function parseFiberNumbers(value?: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
  } catch {
    // fall through to regex parsing
  }
  return (value.match(/\d+/g) ?? [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function rangeLabel(values: number[]): string | null {
  if (!values.length) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

type CapacityMappingLike = {
  localPortLabel?: string | null;
  farPortLabel?: string | null;
  fiberNumbersJson?: string | null;
  serviceCode?: string | null;
  status?: string | null;
  remarks?: string | null;
};

type CapacityFiberLike = {
  fiberNumber?: number | null;
  status?: string | null;
  serviceId?: string | null;
  serviceCode?: string | null;
  remarks?: string | null;
};

type CapacitySegmentLike = {
  segmentCode?: string | null;
  segmentSequence?: string | null;
  segmentCapacityFibers?: number | null;
  totalFiberCapacity?: number | null;
  availableFiberCount?: number | null;
  usedFiberCount?: number | null;
  reservedFiberCount?: number | null;
  faultyFiberCount?: number | null;
  endpointMappings?: CapacityMappingLike[] | null;
  fibers?: CapacityFiberLike[] | null;
  serviceAllocations?:
    | {
        status?: string | null;
        fiberNumbersJson?: string | null;
        fiberStart?: number | null;
        fiberEnd?: number | null;
      }[]
    | null;
};


// EDIT HERE: Trace/Provision physical capacity source of truth.
// Segment summaries must use the corresponding segment's real physical capacity,
// normally encoded in names like MU3000-MU3000-C02-12F or segmentSequence C02 - 12F.
// This prevents stale aggregate DB values such as 72 from rendering as 68 available
// on a 12F span.
function capacityFromSegmentLabel(...labels: Array<string | null | undefined>): number | null {
  for (const label of labels) {
    const text = label?.trim();
    if (!text) continue;
    const matches = [...text.matchAll(/(?:^|[-\s])C\d+\s*[-_]??\s*(\d+)\s*F(?:\b|$)/gi)];
    const last = matches[matches.length - 1];
    const value = last ? Number(last[1]) : null;
    if (Number.isFinite(value) && value && value > 0) return value;

    const trailing = text.match(/(?:^|[-\s])(\d+)\s*F(?:\b|$)/i);
    const fallback = trailing ? Number(trailing[1]) : null;
    if (Number.isFinite(fallback) && fallback && fallback > 0) return fallback;
  }
  return null;
}

function parsePortNumbers(value?: string | null): number[] {
  const text = value?.trim();
  if (!text) return [];
  const values = new Set<number>();
  for (const token of text.split(/[;,]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        for (let port = low; port <= high; port += 1) values.add(port);
      }
      continue;
    }
    for (const match of trimmed.matchAll(/\d+/g)) values.add(Number(match[0]));
  }
  return [...values].filter(Number.isFinite).sort((a, b) => a - b);
}

function mappingPhysicalPortCount(mapping: CapacityMappingLike): number {
  const localCount = parsePortNumbers(mapping.localPortLabel).length;
  const farCount = parsePortNumbers(mapping.farPortLabel).length;
  const fiberCount = parseFiberNumbers(mapping.fiberNumbersJson).length;
  return Math.max(localCount, farCount, fiberCount, 1);
}

function allocationPhysicalPortCount(
  allocation: NonNullable<CapacitySegmentLike["serviceAllocations"]>[number],
): number {
  const parsed = parseFiberNumbers(allocation.fiberNumbersJson);
  if (parsed.length) return parsed.length;
  const start = Number(allocation.fiberStart ?? 0);
  const end = Number(allocation.fiberEnd ?? 0);
  if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > 0)
    return Math.abs(end - start) + 1;
  return 1;
}

function isLiveStatus(status?: string | null): boolean {
  return !["DECOMMISSIONED", "DUMMY", "FAULTY", "UNKNOWN", "PLANNED"].includes(
    String(status ?? "").toUpperCase(),
  );
}

function isAllocatedStatus(status?: string | null): boolean {
  // REHOMED is a display-only cleanup marker, not an allocatable/used state.
  return ["ACTIVE", "USED", "RESERVED"].includes(
    String(status ?? "").toUpperCase(),
  );
}

function segmentCapacityView(segment: CapacitySegmentLike) {
  const mappings = Array.isArray(segment.endpointMappings)
    ? segment.endpointMappings.filter((mapping) => isLiveStatus(mapping.status) && !isRehomedOutRemark(mapping.remarks))
    : [];
  // Capacity is the segment's own child-row ledger (single source of truth).
  // The name suffix (e.g. C01-12F) is display-only and can drift after a partial
  // rehome that does not rename the segment, so it must NEVER define capacity —
  // it is used only as a last resort when there is no child row or stored count.
  const refreshedCapacity = Number(segment.segmentCapacityFibers ?? 0);
  const explicitTotal = Number(segment.totalFiberCapacity ?? 0);

  // One pass, one bucket per row. ACTIVE counts as Used; AVAILABLE/SPARE are the
  // only free ("Available") rows; Reserved and Faulty are their own buckets and
  // are never counted as Used. (Matches refreshSegmentCapacity exactly so the
  // trace view and the Inventory Explorer can no longer disagree.)
  let total = 0;
  let used = 0;
  let reserved = 0;
  let faulty = 0;
  const bucket = (status: string | null | undefined, hasService: boolean, n: number) => {
    const s = String(status ?? "").toUpperCase();
    total += n;
    if (hasService || s === "USED" || s === "ACTIVE") used += n;
    else if (s === "RESERVED") reserved += n;
    else if (s === "FAULTY") faulty += n;
  };

  if (mappings.length) {
    for (const mapping of mappings) {
      bucket(mapping.status, Boolean(mapping.serviceCode?.trim()), mappingPhysicalPortCount(mapping));
    }
  } else if (Array.isArray(segment.fibers) && segment.fibers.length) {
    for (const fiber of segment.fibers) {
      if (!isLiveStatus(fiber.status) || isRehomedOutRemark(fiber.remarks)) continue;
      bucket(fiber.status, Boolean(fiber.serviceId || fiber.serviceCode), 1);
    }
  } else if (Array.isArray(segment.serviceAllocations) && segment.serviceAllocations.length) {
    for (const allocation of segment.serviceAllocations) {
      if (!isLiveStatus(allocation.status)) continue;
      const n = allocationPhysicalPortCount(allocation);
      total += n;
      used += n;
    }
  } else {
    used = Number(segment.usedFiberCount ?? 0);
    reserved = Number(segment.reservedFiberCount ?? 0);
    faulty = Number(segment.faultyFiberCount ?? 0);
  }

  // Total is the child-row ledger; fall back to the stored live count, then the
  // segment label only as a final resort (never as the primary source).
  if (total <= 0) {
    total =
      refreshedCapacity > 0
        ? refreshedCapacity
        : explicitTotal > 0
          ? explicitTotal
          : capacityFromSegmentLabel(segment.segmentCode, segment.segmentSequence) ?? 0;
  }

  used = Math.min(Math.max(0, used), Math.max(0, total));
  reserved = Math.min(Math.max(0, reserved), Math.max(0, total - used));
  faulty = Math.min(Math.max(0, faulty), Math.max(0, total - used - reserved));
  const available = Math.max(0, total - used - reserved - faulty);
  return {
    totalFibers: total,
    usedFibers: used,
    availableFibers: available,
    reservedFibers: reserved,
    faultyFibers: faulty,
    utilizationPct: total > 0 ? Math.round((used / total) * 10000) / 100 : 0,
  };
}

function allocationFiberNumbers(allocation: TraceAllocation): number[] {
  if (allocation.fibers.length)
    return allocation.fibers
      .map((fiber) => fiber.fiberNumber)
      .sort((a, b) => a - b);
  try {
    const parsed = JSON.parse(allocation.fiberNumbersJson);
    return Array.isArray(parsed)
      ? parsed
          .map(Number)
          .filter(Number.isFinite)
          .sort((a, b) => a - b)
      : [];
  } catch {
    return [];
  }
}

function endpointViewForAllocation(
  allocation: TraceAllocation,
  endpoint: TraceEndpoint,
): ServiceEndpointView {
  const segment = allocation.segment;
  const capacity = segmentCapacityView(
    segment as unknown as CapacitySegmentLike,
  );
  const fiberNumbers = allocationFiberNumbers(allocation);
  const firstFiber = fiberNumbers[0] ?? allocation.fiberStart;
  const lastFiber =
    fiberNumbers[fiberNumbers.length - 1] ?? allocation.fiberEnd;
  return {
    siteCode: endpointSiteCode(endpoint),
    rackCode: endpoint.rack?.rackCode ?? endpoint.rawRackCode,
    odfCode: endpoint.odf?.odfCode ?? endpoint.rawOdfCode,
    portGroupLabel:
      endpoint.portGroup?.displayLabel ??
      endpoint.displayPortText ??
      endpoint.rawPortText,
    segmentCode: cleanSegmentCode(segment.segmentCode),
    tubeNumber: segment.tubeNumber,
    tubeColor: segment.tubeColor,
    tubeLabel: segment.tubeLabel,
    fiberPortNumber:
      segment.fiberPortNumber ?? endpoint.portGroup?.fiberPortNumber ?? null,
    fiberNumber: firstFiber,
    fiberNumbers,
    fiberRangeLabel:
      firstFiber === lastFiber
        ? String(firstFiber)
        : `${firstFiber}-${lastFiber}`,
    fiberLabel: allocation.isJumper
      ? (allocation.remarks ?? "Jumper")
      : segment.fiberLabel,
    totalFibers: capacity.totalFibers,
    availableFibers: capacity.availableFibers,
    usedFibers: capacity.usedFibers,
    reservedFibers: capacity.reservedFibers,
    faultyFibers: capacity.faultyFibers,
    utilizationPct: capacity.utilizationPct,
    distanceKm: segment.distanceKm,
  };
}

function endpointForSite(
  segment: TraceSegment,
  siteLabel: string | null,
  prefer: "A" | "B",
): ServiceEndpointView {
  const normalized = normalizedSite(siteLabel);
  const endpointA = endpointSiteCode(segment.endpointA);
  const endpointB = endpointSiteCode(segment.endpointB);

  if (normalized && normalizedSite(endpointA) === normalized)
    return endpointView(segment, segment.endpointA);
  if (normalized && normalizedSite(endpointB) === normalized)
    return endpointView(segment, segment.endpointB);
  return endpointView(
    segment,
    prefer === "A" ? segment.endpointA : segment.endpointB,
  );
}

function routeSegmentLabels(hops: TraceHop[]): string[] {
  const labels: string[] = [];

  for (const hop of hops) {
    if (!hop.segment) continue;
    const [fromPath, toPath] = splitPathLabel(hop.pathLabel);
    const from =
      fromPath ?? endpointSiteCode(hop.segment.endpointA) ?? "UNKNOWN";
    const to = toPath ?? endpointSiteCode(hop.segment.endpointB) ?? "UNKNOWN";

    if (labels.length === 0) pushSiteLabel(labels, from);
    pushSiteLabel(labels, to);
  }

  return labels;
}

function routeAllocationLabels(allocations: TraceAllocation[]): string[] {
  const labels: string[] = [];
  for (const allocation of allocations) {
    if (
      allocation.segment.importBatch?.sourceSystem === "DEMO_SEED" &&
      process.env.FEATURE_DEMO_DATA !== "true"
    )
      continue;
    const [fromPath, toPath] = splitPathLabel(allocation.pathLabel);
    const from =
      fromPath ??
      allocation.fromSite?.code ??
      endpointSiteCode(allocation.endpointA ?? allocation.segment.endpointA) ??
      "UNKNOWN";
    const to =
      toPath ??
      allocation.toSite?.code ??
      endpointSiteCode(allocation.endpointB ?? allocation.segment.endpointB) ??
      "UNKNOWN";
    if (labels.length === 0) pushSiteLabel(labels, from);
    pushSiteLabel(labels, to);
  }
  return labels;
}

function pathSites(pathInput?: string | null): string[] {
  const rawSites = splitTransportPathSites(pathInput);

  // EDIT HERE: Do not create a fake self-hop when the same inserted split node
  // appears twice in a typed/generated trail, e.g. X -> Y -> Y -> Z. Also strips
  // route-index suffixes such as BA2000-2 so BA20000 is never rendered.
  return rawSites.filter(
    (site, index) => index === 0 || !sameSite(site, rawSites[index - 1]),
  );
}

function pushSiteLabel(labels: string[], label?: string | null) {
  const clean = cleanSiteLabel(label);
  if (!clean) return;
  if (!labels.length || !sameSite(labels[labels.length - 1], clean))
    labels.push(clean);
}

function endpointForAllocationSite(
  allocation: TraceAllocation,
  siteLabel: string | null,
  prefer: "A" | "B",
): ServiceEndpointView {
  const normalized = normalizedSite(siteLabel);
  const endpointA = allocation.endpointA ?? allocation.segment.endpointA;
  const endpointB = allocation.endpointB ?? allocation.segment.endpointB;
  const endpointACode = endpointSiteCode(endpointA);
  const endpointBCode = endpointSiteCode(endpointB);

  if (normalized && normalizedSite(endpointACode) === normalized)
    return endpointViewForAllocation(allocation, endpointA);
  if (normalized && normalizedSite(endpointBCode) === normalized)
    return endpointViewForAllocation(allocation, endpointB);
  return endpointViewForAllocation(
    allocation,
    prefer === "A" ? endpointA : endpointB,
  );
}

async function loadMappingsForService(serviceCode: string) {
  const normalized = normalizeServiceCodeExact(serviceCode);
  if (!normalized) return [];
  const mappings = await prisma.segmentEndpointMapping.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      // Case-insensitive so mixed-case service codes (e.g. "ZLongChain") resolve
      // even though the input is normalized to upper-case for matching. Mirrors the
      // inventory filter, which already matches service codes case-insensitively.
      serviceCode: { contains: normalized, mode: "insensitive" },
      segment: {
        status: { not: "DECOMMISSIONED" },
        ...(process.env.FEATURE_DEMO_DATA === "true"
          ? {}
          : { NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }),
      },
    },
    include: {
      segment: {
        include: {
          cable: true,
          endpointA: {
            include: { site: true, rack: true, odf: true, portGroup: true },
          },
          endpointB: {
            include: { site: true, rack: true, odf: true, portGroup: true },
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });
  return mappings.filter((mapping) => !isRehomedOutRemark(mapping.remarks));
}

// EDIT HERE: Topology ordering is now delegated to the pure, unit-tested
// engine in lib/telecom/topology-graph.ts. This keeps the graph algorithm out
// of the DB-bound service so it can be tested in isolation, and fixes the old
// bug where rings, branches, and per-hop distances were jumbled together.
type MappingTopoEdge = TopoEdge<MappingTraceRecord>;
type OrderedMappingComponent = OrderedTopology<MappingTraceRecord>;

function extractSiteCodeToken(value?: string | null): string | null {
  const cleaned = purifyTransportSiteToken(value?.replace(/^\s*to\s+/i, "")).trim();
  if (!cleaned) return null;

  // Use the last real site token from compound labels such as BA1000-BA2000-2.
  // The purifier strips route suffixes first, preventing BA2000-2 from becoming
  // the impossible physical site BA20000.
  const purifiedCodes = extractPurifiedSiteCodes(cleaned);
  if (purifiedCodes.length) return purifiedCodes[purifiedCodes.length - 1];

  const compact = cleaned.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const patterns = [/MUTR\d{4}/, /MU\d{4}/, /DH\d{4}/, /BA\d{4}/, /SH\d{4}/, /MS\d{4}/, /DA\d{4}/, /DF\d{4}/, /WU\d{4}/];
  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match) return match[0];
  }

  // Keep well-known non-numeric exchange aliases consistent.
  if (compact.includes("BOUSHER") && compact.includes("MSC")) return "BOUSHERMSCBSC";
  if (compact.includes("GHUBRAH") && compact.includes("MSC")) return "GHUBRAHMSCBSC";
  return null;
}

function siteDisplay(value?: string | null): string {
  return displaySiteLabel(purifyTransportSiteToken(value));
}

function siteKey(value?: string | null): string {
  const token = extractSiteCodeToken(value);
  if (token) return token;
  return (
    normalizeAlias(value?.replace(/^\s*to\s+/i, "")) ??
    siteDisplay(value).toUpperCase() ??
    "UNKNOWN"
  );
}

function isLocalizedTwoNodeClosedWalk(role: TopologyRole, nodes: string[], isClosedRing: boolean): boolean {
  if (role !== "SINGLE_HOMED" || !isClosedRing || nodes.length < 2 || nodes.length > 3) return false;
  const keys = nodes.map((node) => siteKey(node)).filter(Boolean);
  const uniqueKeys = new Set(keys);
  if (nodes.length === 2) return uniqueKeys.size === 2;
  return keys[0] === keys[2] && uniqueKeys.size === 2;
}

function shouldShowExplicitRingClosure(role: TopologyRole, nodes: string[], isClosedRing: boolean): boolean {
  return isClosedRing && !isLocalizedTwoNodeClosedWalk(role, nodes, isClosedRing);
}

function topologyFullPathLabel(role: TopologyRole, nodes: string[], isClosedRing: boolean): string {
  if (isLocalizedTwoNodeClosedWalk(role, nodes, isClosedRing)) {
    return nodes.length === 2 ? `${nodes[0]} -> ${nodes[1]} -> ${nodes[0]}` : nodes.join(" -> ");
  }
  if (!shouldShowExplicitRingClosure(role, nodes, isClosedRing)) return nodes.join(" -> ");
  return `${nodes.join(" -> ")}${nodes[nodes.length - 1] === nodes[0] ? "" : ` -> ${nodes[0]}`} (ring closed)`;
}

function farMappingLabel(mapping: MappingTraceRecord): string {
  return siteDisplay(mapping.farSiteCode ?? mapping.farEndpointLabel);
}

function localMappingLabel(mapping: MappingTraceRecord): string {
  return siteDisplay(mapping.localSiteCode);
}

function mappingEdgeId(mapping: MappingTraceRecord): string {
  return [
    mapping.id,
    mapping.segmentId,
    mapping.localPortLabel,
    mapping.farPortLabel,
    mapping.serviceCode,
  ]
    .filter(Boolean)
    .join("|");
}

/** Convert mapping rows into abstract topology edges for the graph engine. */
function mappingEdges(mappings: MappingTraceRecord[]): MappingTopoEdge[] {
  return mappings.map((mapping) => {
    const fromLabel = localMappingLabel(mapping);
    const toLabel = farMappingLabel(mapping);
    return {
      fromKey: siteKey(fromLabel) || "UNKNOWN",
      toKey: siteKey(toLabel) || "UNKNOWN",
      fromLabel,
      toLabel,
      ref: mapping,
      id: mappingEdgeId(mapping),
    };
  });
}

function orderedMappingComponents(
  mappings: MappingTraceRecord[],
  serviceCode?: string,
  options: { preserveParallelEdges?: boolean } = {},
): OrderedMappingComponent[] {
  return orderTopology(mappingEdges(mappings), { serviceCode, preserveParallelEdges: options.preserveParallelEdges });
}

function endpointForMappingKey(
  mapping: MappingTraceRecord,
  key: string,
): ServiceEndpointView {
  const localKey = siteKey(mapping.localSiteCode);
  return mappingEndpointView(
    mapping.segment,
    localKey === key ? "LOCAL" : "FAR",
    mapping,
  );
}

function serviceLinksFromMappings(
  mappings: MappingTraceRecord[],
): ServiceTraceResult["serviceLinks"] {
  return mappings.map((mapping) => ({
    id: mapping.id,
    serviceId: mapping.serviceCode,
    segmentId: mapping.segmentId,
    segmentCode: cleanSegmentCode(mapping.segment.segmentCode),
    local: mappingEndpointView(mapping.segment, "LOCAL", mapping),
    far: mappingEndpointView(mapping.segment, "FAR", mapping),
    localSite: siteDisplay(mapping.localSiteCode),
    farSite: siteDisplay(mapping.farSiteCode ?? mapping.farEndpointLabel),
    localPort: mapping.localPortLabel,
    farPort: mapping.farPortLabel,
    fiberNumbers: mapping.fiberNumbersJson,
    status: mapping.status,
    remarks: mapping.remarks,
  }));
}

function serviceLinksFromAllocations(
  serviceCode: string,
  allocations: TraceAllocation[],
): ServiceTraceResult["serviceLinks"] {
  return allocations.map((allocation) => ({
    id: allocation.id,
    serviceId: serviceCode,
    segmentId: allocation.segment.id,
    segmentCode: cleanSegmentCode(allocation.segment.segmentCode),
    local: endpointViewForAllocation(
      allocation,
      allocation.endpointA ?? allocation.segment.endpointA,
    ),
    far: endpointViewForAllocation(
      allocation,
      allocation.endpointB ?? allocation.segment.endpointB,
    ),
    localSite: displaySiteLabel(
      allocation.fromSite?.code ??
        endpointSiteCode(allocation.endpointA ?? allocation.segment.endpointA),
    ),
    farSite: displaySiteLabel(
      allocation.toSite?.code ??
        endpointSiteCode(allocation.endpointB ?? allocation.segment.endpointB),
    ),
    localPort:
      (allocation.endpointA ?? allocation.segment.endpointA).portGroup
        ?.displayLabel ??
      (allocation.endpointA ?? allocation.segment.endpointA).displayPortText ??
      (allocation.endpointA ?? allocation.segment.endpointA).rawPortText,
    farPort:
      (allocation.endpointB ?? allocation.segment.endpointB).portGroup
        ?.displayLabel ??
      (allocation.endpointB ?? allocation.segment.endpointB).displayPortText ??
      (allocation.endpointB ?? allocation.segment.endpointB).rawPortText,
    fiberNumbers: allocation.fiberNumbersJson,
    status: allocation.status,
    remarks: allocation.remarks,
  }));
}

function topologyForMapping(mapping: MappingTraceRecord) {
  return effectiveTopologyRole({
    childTopologyRole: mapping.childTopologyRole,
    segmentDefaultRole: mapping.segment.segmentDefaultRole,
  });
}

function serviceLinksFromMappingsWithTopology(
  mappings: MappingTraceRecord[],
): ServiceTraceResult["serviceLinks"] {
  return mappings.map((mapping) => {
    const topology = topologyForMapping(mapping);
    return {
      id: mapping.id,
      serviceId: mapping.serviceCode,
      segmentId: mapping.segmentId,
      segmentCode: cleanSegmentCode(mapping.segment.segmentCode),
      local: mappingEndpointView(mapping.segment, "LOCAL", mapping),
      far: mappingEndpointView(mapping.segment, "FAR", mapping),
      localSite: siteDisplay(mapping.localSiteCode),
      farSite: siteDisplay(mapping.farSiteCode ?? mapping.farEndpointLabel),
      localPort: mapping.localPortLabel,
      farPort: mapping.farPortLabel,
      fiberNumbers: mapping.fiberNumbersJson,
      status: mapping.status,
      remarks: mapping.remarks,
      tag: mapping.tag ?? null,
      childTopologyRole: mapping.childTopologyRole ?? null,
      segmentDefaultRole: mapping.segment.segmentDefaultRole ?? null,
      topologyRole: topology.role,
      topologyRoleSource: topology.source,
    };
  });
}

// Trace report noise reduction: a long/complex service ID matched via the
// `contains` lookup can resolve to overlapping mappings that emit identical
// service-link rows (same segment + role + near/far site/rack/ODF/port). Collapse
// those exact repeats so the trace report — the on-screen Service Trail table and
// the Trace & Provision export — shows each physical hop once. Rows that differ on
// any identity column (a distinct port/site/role) are genuinely different
// allocations and are preserved; the first occurrence's position is kept so
// topology ordering is unaffected.
function serviceLinkIdentityKey(link: ServiceTraceLinkView): string {
  const norm = (value: unknown) => String(value ?? "").trim().toUpperCase();
  return [
    link.segmentId,
    link.segmentCode,
    link.serviceId,
    link.topologyRole,
    link.local?.siteCode ?? link.localSite,
    link.local?.rackCode,
    link.local?.odfCode,
    link.localPort ?? link.local?.portGroupLabel,
    link.far?.siteCode ?? link.farSite,
    link.far?.rackCode,
    link.far?.odfCode,
    link.farPort ?? link.far?.portGroupLabel,
  ]
    .map(norm)
    .join("|");
}

function dedupeServiceLinks(links: ServiceTraceLinkView[] | undefined): ServiceTraceLinkView[] {
  const seen = new Set<string>();
  const deduped: ServiceTraceLinkView[] = [];
  for (const link of links ?? []) {
    const key = serviceLinkIdentityKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }
  return deduped;
}


type AllocationTopoEdge = TopoEdge<TraceAllocation>;
type OrderedAllocationComponent = OrderedTopology<TraceAllocation>;
type HopTopoEdge = TopoEdge<TraceHop>;
type OrderedHopComponent = OrderedTopology<TraceHop>;

function undirectedEdgePairKey(leftKey?: string | null, rightKey?: string | null): string {
  return [leftKey || "UNKNOWN", rightKey || "UNKNOWN"].sort().join("<>");
}

function mappingPairKey(mapping: MappingTraceRecord): string {
  return undirectedEdgePairKey(siteKey(mapping.localSiteCode), siteKey(mapping.farSiteCode ?? mapping.farEndpointLabel));
}

function edgePairKey(edge: TopoEdge<unknown>): string {
  return undirectedEdgePairKey(edge.fromKey, edge.toKey);
}

function orderedComponentEdges<T>(component: OrderedTopology<T>): TopoEdge<T>[] {
  return [
    ...component.orderedEdges,
    ...(component.closingEdge ? [component.closingEdge] : []),
    ...component.branchEdges,
  ];
}

function componentPairRank<T>(components: OrderedTopology<T>[]): Map<string, number> {
  const rank = new Map<string, number>();
  let index = 0;
  for (const component of components) {
    for (const edge of orderedComponentEdges(component)) {
      const pair = edgePairKey(edge);
      if (!rank.has(pair)) rank.set(pair, index);
      index += 1;
    }
  }
  return rank;
}

function mappingStableSort(a: MappingTraceRecord, b: MappingTraceRecord): number {
  return (
    String(a.segment.segmentCode ?? "").localeCompare(String(b.segment.segmentCode ?? "")) ||
    String(a.localPortLabel ?? "").localeCompare(String(b.localPortLabel ?? ""), undefined, { numeric: true }) ||
    String(a.farPortLabel ?? "").localeCompare(String(b.farPortLabel ?? ""), undefined, { numeric: true }) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function orderMappingsByTopology(
  mappings: MappingTraceRecord[],
  components: OrderedMappingComponent[],
): MappingTraceRecord[] {
  const rank = componentPairRank(components);
  const fallback = rank.size + 1000;
  return mappings.slice().sort((a, b) => {
    const aRank = rank.get(mappingPairKey(a)) ?? fallback;
    const bRank = rank.get(mappingPairKey(b)) ?? fallback;
    return aRank - bRank || mappingStableSort(a, b);
  });
}

function allocationFromLabel(allocation: TraceAllocation): string {
  const [fromPath] = splitPathLabel(allocation.pathLabel);
  return siteDisplay(
    fromPath ??
      allocation.fromSite?.code ??
      endpointSiteCode(allocation.endpointA ?? allocation.segment.endpointA) ??
      "UNKNOWN",
  );
}

function allocationToLabel(allocation: TraceAllocation): string {
  const [, toPath] = splitPathLabel(allocation.pathLabel);
  return siteDisplay(
    toPath ??
      allocation.toSite?.code ??
      endpointSiteCode(allocation.endpointB ?? allocation.segment.endpointB) ??
      "UNKNOWN",
  );
}

function allocationEdgeId(allocation: TraceAllocation): string {
  return [
    allocation.id,
    allocation.segmentId,
    allocation.pathOrder,
    allocation.fiberNumbersJson,
  ]
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .join("|");
}

function allocationEdges(allocations: TraceAllocation[]): AllocationTopoEdge[] {
  return allocations.map((allocation) => {
    const fromLabel = allocationFromLabel(allocation);
    const toLabel = allocationToLabel(allocation);
    return {
      fromKey: siteKey(fromLabel),
      toKey: siteKey(toLabel),
      fromLabel,
      toLabel,
      ref: allocation,
      id: allocationEdgeId(allocation),
    };
  });
}

function orderedAllocationComponents(
  allocations: TraceAllocation[],
  serviceCode?: string,
): OrderedAllocationComponent[] {
  return orderTopology(allocationEdges(allocations), { serviceCode });
}

function allocationPairKey(allocation: TraceAllocation): string {
  return undirectedEdgePairKey(siteKey(allocationFromLabel(allocation)), siteKey(allocationToLabel(allocation)));
}

function allocationStableSort(a: TraceAllocation, b: TraceAllocation): number {
  return (
    Number(a.pathOrder ?? 0) - Number(b.pathOrder ?? 0) ||
    String(a.segment.segmentCode ?? "").localeCompare(String(b.segment.segmentCode ?? "")) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function orderAllocationsByTopology(
  allocations: TraceAllocation[],
  components: OrderedAllocationComponent[],
): TraceAllocation[] {
  const rank = componentPairRank(components);
  const fallback = rank.size + 1000;
  return allocations.slice().sort((a, b) => {
    const aRank = rank.get(allocationPairKey(a)) ?? fallback;
    const bRank = rank.get(allocationPairKey(b)) ?? fallback;
    return aRank - bRank || allocationStableSort(a, b);
  });
}

function topologyGroupFromAllocationComponent(
  role: TopologyRole,
  component: OrderedAllocationComponent,
  serviceCode: string,
): NonNullable<ServiceTraceResult["mainRingPath"]> {
  const nodes = component.nodeLabels;
  const segments = component.orderedEdges.map((edge) => ({
    segmentId: edge.ref.segment.id,
    segmentCode: cleanSegmentCode(edge.ref.segment.segmentCode),
    fromSite: edge.fromLabel,
    toSite: edge.toLabel,
    distanceKm: edge.ref.segment.distanceKm,
  }));
  const allWalkEdges = component.closingEdge
    ? [...component.orderedEdges, component.closingEdge]
    : component.orderedEdges;
  const distanceBySegment = new Map<string, number>();
  for (const edge of allWalkEdges) {
    const distance = edge.ref.segment.distanceKm;
    if (distance !== null && distance !== undefined && !distanceBySegment.has(edge.ref.segment.id)) {
      distanceBySegment.set(edge.ref.segment.id, distance);
    }
  }
  const branches = component.branchEdges.map((edge) => ({
    fromSite: edge.fromLabel,
    toSite: edge.toLabel,
    segmentCode: cleanSegmentCode(edge.ref.segment.segmentCode),
    distanceKm: edge.ref.segment.distanceKm,
  }));
  return {
    topologyRole: role,
    topologyLabel: topologyRoleLabel(role),
    fullPathLabel: topologyFullPathLabel(role, nodes, component.isClosedRing),
    totalDistanceKm:
      Math.round([...distanceBySegment.values()].reduce((sum, value) => sum + value, 0) * 100) / 100,
    nodes,
    segments,
    links: serviceLinksFromAllocations(serviceCode, component.orderedEdges.map((edge) => edge.ref)) ?? [],
    shape: component.shape,
    isClosedRing: shouldShowExplicitRingClosure(role, nodes, component.isClosedRing),
    ringClosesAt: shouldShowExplicitRingClosure(role, nodes, component.isClosedRing) ? nodes[0] : null,
    junctions: component.junctionKeys.map((key) => component.labelByKey.get(key) ?? key),
    jumpers: nodes.filter((node) => /\(\s*jumper\s*\)/i.test(node)),
    branches,
  };
}

function hopsFromAllocationComponent(
  component: OrderedAllocationComponent,
  fullPathLabel: string,
): ServiceTraceResult["hops"] {
  return component.nodeLabels.map((siteLabel, index) => {
    const incomingEdge = index > 0 ? (component.orderedEdges[index - 1] ?? null) : null;
    const outgoingEdge = index < component.orderedEdges.length ? (component.orderedEdges[index] ?? null) : null;
    const incomingAllocation = incomingEdge?.ref ?? null;
    const outgoingAllocation = outgoingEdge?.ref ?? null;
    return {
      siteCode: normalizedSite(siteLabel),
      siteLabel,
      isJumper: /\(jumper\)/i.test(siteLabel),
      incoming: incomingAllocation ? endpointForAllocationSite(incomingAllocation, siteLabel, "B") : null,
      outgoing: outgoingAllocation ? endpointForAllocationSite(outgoingAllocation, siteLabel, "A") : null,
      segmentCode: cleanSegmentCode(
        outgoingAllocation?.segment.segmentCode ?? incomingAllocation?.segment.segmentCode,
      ),
      pathLabel: fullPathLabel,
      distanceKm:
        outgoingAllocation?.segment.distanceKm ?? incomingAllocation?.segment.distanceKm ?? null,
    };
  });
}

function hopFromLabel(hop: TraceHop): string {
  const [fromPath] = splitPathLabel(hop.pathLabel);
  return siteDisplay(
    fromPath ??
      endpointSiteCode(hop.segment?.endpointA as TraceEndpoint) ??
      hop.site?.code ??
      "UNKNOWN",
  );
}

function hopToLabel(hop: TraceHop): string {
  const [, toPath] = splitPathLabel(hop.pathLabel);
  return siteDisplay(
    toPath ??
      endpointSiteCode(hop.segment?.endpointB as TraceEndpoint) ??
      "UNKNOWN",
  );
}

function hopEdgeId(hop: TraceHop): string {
  return [hop.id, hop.segmentId, hop.hopOrder, hop.pathLabel]
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .join("|");
}

function hopEdges(hops: TraceHop[]): HopTopoEdge[] {
  return hops
    .filter((hop) => Boolean(hop.segment))
    .map((hop) => {
      const fromLabel = hopFromLabel(hop);
      const toLabel = hopToLabel(hop);
      return {
        fromKey: siteKey(fromLabel),
        toKey: siteKey(toLabel),
        fromLabel,
        toLabel,
        ref: hop,
        id: hopEdgeId(hop),
      };
    });
}

function orderedHopComponents(
  hops: TraceHop[],
  serviceCode?: string,
): OrderedHopComponent[] {
  return orderTopology(hopEdges(hops), { serviceCode });
}

function hopPairKey(hop: TraceHop): string {
  return undirectedEdgePairKey(siteKey(hopFromLabel(hop)), siteKey(hopToLabel(hop)));
}

function hopStableSort(a: TraceHop, b: TraceHop): number {
  return (
    Number(a.hopOrder ?? 0) - Number(b.hopOrder ?? 0) ||
    String(a.segment?.segmentCode ?? "").localeCompare(String(b.segment?.segmentCode ?? "")) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function orderHopsByTopology(
  hops: TraceHop[],
  components: OrderedHopComponent[],
): TraceHop[] {
  const rank = componentPairRank(components);
  const fallback = rank.size + 1000;
  return hops.slice().sort((a, b) => {
    const aRank = rank.get(hopPairKey(a)) ?? fallback;
    const bRank = rank.get(hopPairKey(b)) ?? fallback;
    return aRank - bRank || hopStableSort(a, b);
  });
}

function serviceLinksFromRouteHops(
  serviceCode: string,
  hops: TraceHop[],
): ServiceTraceResult["serviceLinks"] {
  return hops.map((hop) => ({
    id: hop.id,
    serviceId: serviceCode,
    segmentId: hop.segment?.id ?? null,
    segmentCode: cleanSegmentCode(hop.segment?.segmentCode),
    local: hop.segment ? endpointView(hop.segment, hop.segment.endpointA) : null,
    far: hop.segment ? endpointView(hop.segment, hop.segment.endpointB) : null,
    localSite: hop.segment ? displaySiteLabel(endpointSiteCode(hop.segment.endpointA)) : null,
    farSite: hop.segment ? displaySiteLabel(endpointSiteCode(hop.segment.endpointB)) : null,
    status: hop.segment?.status ?? null,
  }));
}

function topologyGroupFromHopComponent(
  role: TopologyRole,
  component: OrderedHopComponent,
  serviceCode: string,
): NonNullable<ServiceTraceResult["mainRingPath"]> {
  const nodes = component.nodeLabels;
  const segments = component.orderedEdges.map((edge) => ({
    segmentId: edge.ref.segment?.id ?? null,
    segmentCode: cleanSegmentCode(edge.ref.segment?.segmentCode),
    fromSite: edge.fromLabel,
    toSite: edge.toLabel,
    distanceKm: edge.ref.distanceKm ?? edge.ref.segment?.distanceKm ?? null,
  }));
  const allWalkEdges = component.closingEdge
    ? [...component.orderedEdges, component.closingEdge]
    : component.orderedEdges;
  const distanceBySegment = new Map<string, number>();
  for (const edge of allWalkEdges) {
    const segmentId = edge.ref.segment?.id ?? edge.ref.id;
    const distance = edge.ref.distanceKm ?? edge.ref.segment?.distanceKm;
    if (distance !== null && distance !== undefined && !distanceBySegment.has(segmentId)) {
      distanceBySegment.set(segmentId, distance);
    }
  }
  const branches = component.branchEdges.map((edge) => ({
    fromSite: edge.fromLabel,
    toSite: edge.toLabel,
    segmentCode: cleanSegmentCode(edge.ref.segment?.segmentCode),
    distanceKm: edge.ref.distanceKm ?? edge.ref.segment?.distanceKm ?? null,
  }));
  return {
    topologyRole: role,
    topologyLabel: topologyRoleLabel(role),
    fullPathLabel: topologyFullPathLabel(role, nodes, component.isClosedRing),
    totalDistanceKm:
      Math.round([...distanceBySegment.values()].reduce((sum, value) => sum + value, 0) * 100) / 100,
    nodes,
    segments,
    links: serviceLinksFromRouteHops(serviceCode, component.orderedEdges.map((edge) => edge.ref)) ?? [],
    shape: component.shape,
    isClosedRing: shouldShowExplicitRingClosure(role, nodes, component.isClosedRing),
    ringClosesAt: shouldShowExplicitRingClosure(role, nodes, component.isClosedRing) ? nodes[0] : null,
    junctions: component.junctionKeys.map((key) => component.labelByKey.get(key) ?? key),
    branches,
  };
}

function hopsFromHopComponent(
  component: OrderedHopComponent,
  fullPathLabel: string,
): ServiceTraceResult["hops"] {
  return component.nodeLabels.map((siteLabel, index) => {
    const incomingEdge = index > 0 ? (component.orderedEdges[index - 1] ?? null) : null;
    const outgoingEdge = index < component.orderedEdges.length ? (component.orderedEdges[index] ?? null) : null;
    const incomingSegment = incomingEdge?.ref.segment ?? null;
    const outgoingSegment = outgoingEdge?.ref.segment ?? null;
    return {
      siteCode: normalizedSite(siteLabel),
      siteLabel,
      isJumper: /\(jumper\)/i.test(siteLabel),
      incoming: incomingSegment ? endpointForSite(incomingSegment, siteLabel, "B") : null,
      outgoing: outgoingSegment ? endpointForSite(outgoingSegment, siteLabel, "A") : null,
      segmentCode: cleanSegmentCode(outgoingSegment?.segmentCode ?? incomingSegment?.segmentCode),
      pathLabel: fullPathLabel,
      distanceKm:
        outgoingEdge?.ref.distanceKm ??
        outgoingSegment?.distanceKm ??
        incomingEdge?.ref.distanceKm ??
        incomingSegment?.distanceKm ??
        null,
    };
  });
}

function topologyGroupFromComponent(
  role: TopologyRole,
  component: OrderedMappingComponent,
): NonNullable<ServiceTraceResult["attachedSubrings"]>[number] {
  const nodes = component.nodeLabels;

  // segments[i] is the hop between nodes[i] and nodes[i+1], so the UI can label
  // each hop's distance without any index drift.
  const segments = component.orderedEdges.map((edge) => ({
    segmentId: edge.ref.segment.id,
    segmentCode: cleanSegmentCode(edge.ref.segment.segmentCode),
    fromSite: edge.fromLabel,
    toSite: edge.toLabel,
    distanceKm: edge.ref.segment.distanceKm,
  }));

  // Distance counts every physical segment once (open hops + closing edge),
  // never double-counting a shared segment id.
  const distanceBySegment = new Map<string, number>();
  const allWalkEdges = component.closingEdge
    ? [...component.orderedEdges, component.closingEdge]
    : component.orderedEdges;
  for (const edge of allWalkEdges) {
    const distance = edge.ref.segment.distanceKm;
    if (distance !== null && distance !== undefined && !distanceBySegment.has(edge.ref.segment.id)) {
      distanceBySegment.set(edge.ref.segment.id, distance);
    }
  }

  const branches = component.branchEdges.map((edge) => ({
    fromSite: edge.fromLabel,
    toSite: edge.toLabel,
    segmentCode: cleanSegmentCode(edge.ref.segment.segmentCode),
    distanceKm: edge.ref.segment.distanceKm,
  }));

  const fullPathLabel = topologyFullPathLabel(role, nodes, component.isClosedRing);

  // links use the OPEN walk edges only (closing edge excluded) so the first and
  // last link give two distinct terminals; the closing edge still counts toward
  // distance above.
  const linkMappings = component.orderedEdges.map((edge) => edge.ref);

  return {
    topologyRole: role,
    topologyLabel: topologyRoleLabel(role),
    fullPathLabel,
    totalDistanceKm:
      Math.round([...distanceBySegment.values()].reduce((sum, value) => sum + value, 0) * 100) / 100,
    nodes,
    segments,
    // links holds only the ordered main-walk edges (ring/path order preserved).
    // Off-main branch rows are exposed separately via `branches`.
    links: serviceLinksFromMappingsWithTopology(linkMappings) ?? [],
    shape: component.shape,
    isClosedRing: shouldShowExplicitRingClosure(role, nodes, component.isClosedRing),
    ringClosesAt: shouldShowExplicitRingClosure(role, nodes, component.isClosedRing) ? nodes[0] : null,
    junctions: component.junctionKeys.map((key) => component.labelByKey.get(key) ?? key),
    branches,
  };
}

function topologyGroupsFromMappings(
  role: TopologyRole,
  mappings: MappingTraceRecord[],
  serviceCode: string,
) {
  if (!mappings.length) return [];
  return orderedMappingComponents(mappings, serviceCode).map((component) => topologyGroupFromComponent(role, component));
}

// A subring is ALWAYS a closed ring. The graph engine only sees the SUBRING-role
// edges, so a subring landing on TWO distinct main-ring anchors reads as an open
// PATH in isolation (unlike a single-junction subring, whose own edges form the
// cycle). The loop physically completes through the main-ring arc between its
// anchors — promote such groups to closed so the shape badge, path label and
// closure chip report the ring truthfully.
//
// Every subring group also gets its main-ring anchor node(s) recorded as
// `junctions` (in walk order). The panel's rectangular layout keys on this:
// anchors pin to the TOP line (both corners when dual-anchored, the top slot
// when single-anchored) while downlink nodes settle on the other three sides.
function markSubringsClosedViaMainRing(
  subrings: NonNullable<ServiceTraceResult["attachedSubrings"]>,
  mainRingPath: ServiceTraceResult["mainRingPath"],
): void {
  if (!mainRingPath) return;
  const mainKeys = new Set(mainRingPath.nodes.map((node) => siteKey(node)));
  for (const group of subrings) {
    const anchorByKey = new Map<string, string>();
    for (const node of group.nodes) {
      const key = siteKey(node);
      if (mainKeys.has(key) && !anchorByKey.has(key)) anchorByKey.set(key, node);
    }
    if (anchorByKey.size) group.junctions = [...anchorByKey.values()];

    if (group.isClosedRing || group.nodes.length < 2) continue;
    const first = group.nodes[0];
    const last = group.nodes[group.nodes.length - 1];
    if (siteKey(first) === siteKey(last)) continue;
    if (!mainKeys.has(siteKey(first)) || !mainKeys.has(siteKey(last))) continue;
    group.shape = "RING";
    group.isClosedRing = true;
    group.ringClosesAt = first;
    group.fullPathLabel = `${group.nodes.join(" -> ")} (ring closed via main ring)`;
  }
}

function topologyReviewWarnings(
  mappings: MappingTraceRecord[],
  mainComponent?: OrderedMappingComponent,
): string[] {
  const warnings: string[] = [];
  const junctions = findJunctions(mappingEdges(mappings));
  for (const junction of junctions.slice(0, 8)) {
    warnings.push(
      `${junction.label} is a topology junction (degree ${junction.degree}). If a branch here is a subring/spur, mark those child rows as SUBRING / SPUR / SPUR_CHAIN so they do not disturb the Main Ring trace.`,
    );
  }
  if (mainComponent?.branchEdges.length) {
    const branchPairs = mainComponent.branchEdges
      .slice(0, 4)
      .map((edge) => `${edge.fromLabel} -> ${edge.toLabel}`)
      .join(", ");
    warnings.push(
      `${mainComponent.branchEdges.length} branch link(s) are not on the main chain (${branchPairs}${mainComponent.branchEdges.length > 4 ? ", ..." : ""}). They are listed under "Off-main branches"; mark them with a topology role to classify them.`,
    );
  }
  return warnings;
}

async function traceFromEndpointMappings(
  serviceCode: string,
): Promise<ServiceTraceResult | null> {
  const mappings = await loadMappingsForService(serviceCode);
  if (!mappings.length) return null;

  const byRole = new Map<TopologyRole, MappingTraceRecord[]>();
  for (const mapping of mappings) {
    const topology = topologyForMapping(mapping);
    const list = byRole.get(topology.role) ?? [];
    list.push(mapping);
    byRole.set(topology.role, list);
  }

  const mainMappings = byRole.get("MAIN_RING") ?? [];
  const singleHomedMappings = byRole.get("SINGLE_HOMED") ?? [];
  const subringMappings = byRole.get("SUBRING") ?? [];
  const spurMappings = byRole.get("SPUR") ?? [];
  const spurChainMappings = byRole.get("SPUR_CHAIN") ?? [];
  const interconnectMappings = byRole.get("INTERCONNECT") ?? [];
  const reviewMappings = byRole.get("REVIEW") ?? [];

  // SINGLE_HOMED FIX:
  // When a service has SINGLE_HOMED-tagged ODF mappings, those rows define the logical
  // service endpoints (e.g. BA2000-BA1000). The backbone MAIN_RING segments that carry
  // the fiber physically through backbone nodes are secondary and should not override the
  // primary trace. Treat SINGLE_HOMED as the primary path; move backbone to review.
  const hasSingleHomed = singleHomedMappings.length > 0;

  // Priority: SINGLE_HOMED (logical endpoint) > MAIN_RING > fallback all
  const primaryMappings = hasSingleHomed
    ? singleHomedMappings
    : mainMappings.length > 0
    ? mainMappings
    : mappings;
  const primaryRole: TopologyRole = hasSingleHomed ? "SINGLE_HOMED" : "MAIN_RING";

  const mainComponents = orderedMappingComponents(primaryMappings, serviceCode, { preserveParallelEdges: hasSingleHomed });
  // Pick the longest connected component as the primary trace
  const sortedMainComponents = mainComponents.slice().sort((a, b) => b.orderedEdges.length - a.orderedEdges.length);
  const mainComponent = sortedMainComponents[0];
  const mainRingPath = mainComponent ? topologyGroupFromComponent(primaryRole, mainComponent) : null;

  const topologyWarnings = topologyReviewWarnings(mappings, mainComponent);

  // Backbone = MAIN_RING segments demoted when SINGLE_HOMED is the primary path.
  const backboneComponents = hasSingleHomed && mainMappings.length > 0
    ? orderedMappingComponents(mainMappings, serviceCode)
    : [];
  // Only suppress the backbone review for a genuinely "clean local" single-homed
  // service: a short primary path whose backbone introduces NO new sites. If the
  // backbone reaches sites beyond the single-homed endpoints (a transit chain, or
  // a post-split A->X->B leg such as MU2587->SPLITTEST->MU1401), it carries real
  // topology and must stay visible as the second (review/backbone) graph instead
  // of being silently dropped.
  const mainNodeKeys = new Set((mainComponent?.nodeLabels ?? []).map((label) => siteKey(label)));
  const backboneAddsNodes = backboneComponents.some((component) =>
    component.nodeLabels.some((label) => !mainNodeKeys.has(siteKey(label))),
  );
  const suppressBackboneReview =
    hasSingleHomed && Boolean(mainRingPath) && (mainRingPath?.nodes.length ?? 0) <= 3 && !backboneAddsNodes;

  if (hasSingleHomed && !suppressBackboneReview) {
    topologyWarnings.unshift(
      "Single-homed service: SINGLE_HOMED rows define the logical endpoint path. Backbone segments are listed separately in the review section.",
    );
  } else if (!mainMappings.length) {
    topologyWarnings.push("No MAIN_RING child rows were found after topology role evaluation. The portal used all rows as a fallback; review topology role tags.");
  }
  if (sortedMainComponents.length > 1) {
    topologyWarnings.push(`${sortedMainComponents.length} disconnected ${primaryRole} groups found. The longest is shown as primary; others listed for review.`);
  }

  const hops: ServiceTraceResult["hops"] = [];
  const fullPathLabel = mainRingPath?.fullPathLabel ?? "";
  if (mainComponent) {
    mainComponent.nodeLabels.forEach((siteLabel, index) => {
      const incomingEdge = index > 0 ? (mainComponent.orderedEdges[index - 1] ?? null) : null;
      const outgoingEdge = index < mainComponent.orderedEdges.length ? (mainComponent.orderedEdges[index] ?? null) : null;
      const siteKeyValue = siteKey(siteLabel);
      hops.push({
        siteCode: normalizedSite(siteLabel),
        siteLabel,
        isJumper: /\(jumper\)/i.test(siteLabel),
        incoming: incomingEdge ? endpointForMappingKey(incomingEdge.ref, siteKeyValue) : null,
        outgoing: outgoingEdge ? endpointForMappingKey(outgoingEdge.ref, siteKeyValue) : null,
        segmentCode: cleanSegmentCode(outgoingEdge?.ref.segment.segmentCode ?? incomingEdge?.ref.segment.segmentCode),
        pathLabel: fullPathLabel,
        distanceKm: outgoingEdge?.ref.segment.distanceKm ?? incomingEdge?.ref.segment.distanceKm ?? null,
      });
    });
  }

  // Extra disconnected primary groups shown in review so nothing is silently dropped.
  const extraPrimaryGroups = sortedMainComponents.slice(1).map((component) => topologyGroupFromComponent(primaryRole, component));

  // When SINGLE_HOMED is primary, the backbone MAIN_RING segments become review items.
  const backboneReviewGroups: NonNullable<ServiceTraceResult["reviewItems"]> = hasSingleHomed && !suppressBackboneReview && backboneComponents.length > 0
    ? backboneComponents.map((component) => ({
        ...topologyGroupFromComponent("REVIEW", component),
        topologyLabel: "Backbone route (physical)",
      }))
    : [];

  // SINGLE_HOMED shown as attached group only when MAIN_RING is the primary path
  const attachedSingleHomed = !hasSingleHomed && singleHomedMappings.length > 0
    ? topologyGroupsFromMappings("SINGLE_HOMED", singleHomedMappings, serviceCode)
    : [];

  const attachedSubrings = topologyGroupsFromMappings("SUBRING", subringMappings, serviceCode);
  markSubringsClosedViaMainRing(attachedSubrings, mainRingPath);
  const attachedSpurs = topologyGroupsFromMappings("SPUR", spurMappings, serviceCode);
  const attachedSpurChains = topologyGroupsFromMappings("SPUR_CHAIN", spurChainMappings, serviceCode);
  const attachedInterconnects = topologyGroupsFromMappings("INTERCONNECT", interconnectMappings, serviceCode);
  const reviewItems = [
    ...extraPrimaryGroups,
    ...backboneReviewGroups,
    ...topologyGroupsFromMappings("REVIEW", reviewMappings, serviceCode),
  ];

  // The topology panels are ordered above; keep the operational detail rows in
  // the same physical order instead of leaking Prisma join order to the UI.
  const orderedAllMappingComponents = orderedMappingComponents(mappings, serviceCode);
  const orderedAllMappings = orderMappingsByTopology(mappings, orderedAllMappingComponents);

  return {
    serviceCode: normalizeServiceCodeExact(serviceCode) ?? serviceCode,
    serviceName: normalizeServiceCodeExact(serviceCode) ?? serviceCode,
    routeType: hasSingleHomed ? "SINGLE_HOMED" : "IMPORTED_MAPPING",
    fullPathLabel,
    totalDistanceKm: Math.round((mainRingPath?.totalDistanceKm ?? 0) * 100) / 100,
    hops,
    serviceLinks: dedupeServiceLinks(serviceLinksFromMappingsWithTopology(orderedAllMappings)),
    mainRingPath,
    attachedSingleHomed: attachedSingleHomed.length ? attachedSingleHomed : undefined,
    attachedSubrings,
    attachedSpurs,
    attachedSpurChains,
    attachedInterconnects,
    reviewItems,
    suppressReviewDashboard: suppressBackboneReview,
    topologyWarnings,
  };
}

// EDIT HERE: A splitter chain node must read as the PHYSICAL telecom exchange the
// splitter lives in (e.g. STSNDMQ) — never an internal office/room string such as
// "4th Floor/Office 407 ATP". The office text was skewing the trace feed mapping
// (issue: NIP14088 rendered "...-feed-1 (4th Floor/Office 407 ATP)-drop-..."). We
// prefer the splitter's input feeder exchange, then its local drop site, and only
// fall back to the raw room/location text when no site code is known. The office
// room is still surfaced separately via the panel's locationContext badge.
function splitterNodeLabel(splitter: {
  splitterCode: string;
  locationContext?: string | null;
  location?: string | null;
  primaryInputSiteCode?: string | null;
  localSiteCode?: string | null;
}): string {
  const exchange =
    purifyTransportSiteToken(splitter.primaryInputSiteCode) ||
    purifyTransportSiteToken(splitter.localSiteCode);
  if (exchange) return `${splitter.splitterCode} (${exchange})`;
  const context = splitter.locationContext ?? splitter.location;
  return context ? `${splitter.splitterCode} (${context})` : splitter.splitterCode;
}

function cleanOutputPort(value?: string | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.replace(/^\s*(output\s*)?(port\s*)?/i, "").trim() || raw;
}

/**
 * Context A — Active Service ID query (linear line view).
 * Looks up the explicit splitter output mapping rows matching this Service ID
 * and routes the graph through the single allocated port core only. All other
 * unassigned splitter output ports are filtered out, producing a clean
 * sequential chain: Site A -> Splitter Node -> Customer Site.
 */
async function splitterChainForService(serviceCode: string): Promise<SplitterTraceFork[]> {
  const outputs = await prisma.splitterOutput.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      OR: [
        { serviceCode },
        { sharingCustomerServiceId: serviceCode },
        { sharingCustomerServiceCode: serviceCode },
      ],
    },
    include: { splitter: true },
    orderBy: [{ outputPort: "asc" }, { createdAt: "asc" }],
  });

  return outputs.map((output) => {
    const splitter = output.splitter;
    const feederSite = splitter.primaryInputSiteCode;
    const nodeLabel = splitterNodeLabel(splitter);
    const customer = output.destinationSiteCode ?? output.destinationLabel ?? output.localSiteCode ?? null;
    const port = cleanOutputPort(output.outputPort ?? output.outputLabel);
    return {
      splitterId: splitter.id,
      splitterCode: splitter.splitterCode,
      splitterType: splitter.splitterType ?? `${splitter.scope}_SPL`,
      locationContext: splitter.locationContext ?? splitter.location,
      protectionMode: splitter.protectionMode,
      feederSite,
      inputFeed: {
        siteCode: splitter.primaryInputSiteCode,
        rackCode: splitter.primaryInputRackCode,
        odfCode: splitter.primaryInputOdfCode,
        portLabel: splitter.primaryInputPortLabel,
      },
      protectionFeed: splitter.protectionMode === "PROTECTED"
        ? {
            siteCode: splitter.secondaryInputSiteCode,
            rackCode: splitter.secondaryInputRackCode,
            odfCode: splitter.secondaryInputOdfCode,
            portLabel: splitter.secondaryInputPortLabel,
          }
        : null,
      groups: [
        {
          role: "MAIN_TRUNK",
          label: `Allocated output port ${port ?? "?"}`,
          pathLabel: [feederSite, nodeLabel, customer].filter(Boolean).join(" -> "),
          outputPort: port,
          serviceCode: output.serviceCode,
          sharingCustomerServiceId: output.sharingCustomerServiceId ?? output.sharingCustomerServiceCode,
          destinationSite: output.destinationSiteCode,
          destinationLabel: output.destinationLabel,
          localRackCode: output.localRackCode,
          localOdfCode: output.localOdfCode,
          localPortLabel: output.localPortLabel,
          status: output.status,
        },
      ],
    };
  });
}

/**
 * Context B — physical trail preview without a Service ID (fork view).
 * Reads the splitter input boundary against the traced path sites and splits
 * the result into topology groups: the main feeder trunk renders as Group 1,
 * and every other active output port becomes its own Spur group so the UI can
 * render each branch in a separate dashboard panel.
 */
async function splitterForksForSites(siteCodes: string[]): Promise<SplitterTraceFork[]> {
  const sites = [
    ...new Set(
      siteCodes
        .map((site) => normalizeAlias(purifyTransportSiteToken(site)) ?? purifyTransportSiteToken(site).trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!sites.length) return [];

  const splitters = await prisma.splitter.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      OR: [
        { primaryInputSiteCode: { in: sites } },
        { secondaryInputSiteCode: { in: sites } },
      ],
    },
    include: {
      outputs: {
        where: { status: { notIn: ["DECOMMISSIONED", "DUMMY"] } },
        orderBy: [{ outputPort: "asc" }, { outputLabel: "asc" }, { createdAt: "asc" }],
      },
    },
    orderBy: [{ splitterCode: "asc" }],
  });

  return splitters.map((splitter) => {
    const feederSite = splitter.primaryInputSiteCode;
    const nodeLabel = splitterNodeLabel(splitter);
    const groups: SplitterTraceGroup[] = [
      {
        role: "MAIN_TRUNK",
        label: "Group 1 — Main feeder trunk",
        pathLabel: [feederSite, nodeLabel].filter(Boolean).join(" -> "),
        localRackCode: splitter.primaryInputRackCode,
        localOdfCode: splitter.primaryInputOdfCode,
        localPortLabel: splitter.primaryInputPortLabel,
        status: splitter.status,
      },
    ];

    const activeOutputs = splitter.outputs.filter(
      (output) => Boolean(output.serviceCode?.trim()) || ["ACTIVE", "USED", "RESERVED"].includes(String(output.status).toUpperCase()),
    );
    for (const output of activeOutputs) {
      const port = cleanOutputPort(output.outputPort ?? output.outputLabel);
      const customer = output.destinationSiteCode ?? output.destinationLabel ?? output.localSiteCode ?? null;
      groups.push({
        role: "SPUR",
        label: `Spur — Output port ${port ?? "?"}`,
        pathLabel: [nodeLabel, customer].filter(Boolean).join(" -> "),
        outputPort: port,
        serviceCode: output.serviceCode,
        sharingCustomerServiceId: output.sharingCustomerServiceId ?? output.sharingCustomerServiceCode,
        destinationSite: output.destinationSiteCode,
        destinationLabel: output.destinationLabel,
        localRackCode: output.localRackCode,
        localOdfCode: output.localOdfCode,
        localPortLabel: output.localPortLabel,
        status: output.status,
      });
    }
    return {
      splitterId: splitter.id,
      splitterCode: splitter.splitterCode,
      splitterType: splitter.splitterType ?? `${splitter.scope}_SPL`,
      locationContext: splitter.locationContext ?? splitter.location,
      protectionMode: splitter.protectionMode,
      feederSite,
      inputFeed: {
        siteCode: splitter.primaryInputSiteCode,
        rackCode: splitter.primaryInputRackCode,
        odfCode: splitter.primaryInputOdfCode,
        portLabel: splitter.primaryInputPortLabel,
      },
      protectionFeed: splitter.protectionMode === "PROTECTED"
        ? {
            siteCode: splitter.secondaryInputSiteCode,
            rackCode: splitter.secondaryInputRackCode,
            odfCode: splitter.secondaryInputOdfCode,
            portLabel: splitter.secondaryInputPortLabel,
          }
        : null,
      groups,
    };
  });
}

/**
 * A service that terminates on a splitter output but has no segment/route data
 * still deserves a clean linear trace: Site A -> Splitter -> Customer Site.
 */
function traceFromSplitterChain(serviceCode: string, splitterPath: SplitterTraceFork[]): ServiceTraceResult {
  const first = splitterPath[0];
  const firstGroup = first.groups[0];
  const chainSites = firstGroup.pathLabel.split(" -> ").filter(Boolean);
  return {
    serviceCode,
    serviceName: serviceCode,
    routeType: "SPLITTER_PORT",
    fullPathLabel: firstGroup.pathLabel,
    totalDistanceKm: 0,
    hops: chainSites.map((siteLabel) => ({ siteCode: normalizedSite(siteLabel), siteLabel, pathLabel: firstGroup.pathLabel })),
    serviceLinks: [],
    mainRingPath: null,
    splitterPath,
    topologyWarnings: [],
  };
}

function endpointSideFilter(site: string) {
  const cleanSite = purifyTransportSiteToken(site);
  const normalized = normalizeAlias(cleanSite) ?? cleanSite.trim().toUpperCase();
  return {
    OR: [
      { rawSiteCode: normalized },
      { rawSiteCode: { contains: normalized } },
      { site: { code: normalized } },
    ],
  };
}

function mappingPairFilters(from: string, to: string) {
  const cleanFrom = purifyTransportSiteToken(from);
  const cleanTo = purifyTransportSiteToken(to);
  const fromNorm = normalizeAlias(cleanFrom) ?? cleanFrom.trim().toUpperCase();
  const toNorm = normalizeAlias(cleanTo) ?? cleanTo.trim().toUpperCase();
  return [
    {
      endpointMappings: {
        some: {
          localSiteCode: { contains: fromNorm },
          farSiteCode: { contains: toNorm },
        },
      },
    },
    {
      endpointMappings: {
        some: {
          localSiteCode: { contains: toNorm },
          farSiteCode: { contains: fromNorm },
        },
      },
    },
    {
      endpointMappings: {
        some: {
          localSiteCode: { contains: fromNorm },
          farEndpointLabel: { contains: toNorm },
        },
      },
    },
    {
      endpointMappings: {
        some: {
          localSiteCode: { contains: toNorm },
          farEndpointLabel: { contains: fromNorm },
        },
      },
    },
  ];
}

async function loadPreviewSegmentForPair(from: string, to: string): Promise<PreviewSegment | null> {
  const fromNorm = normalizeAlias(from) ?? from.toUpperCase();
  const toNorm = normalizeAlias(to) ?? to.toUpperCase();
  return prisma.linkSegment.findFirst({
    where: {
      status: { not: "DECOMMISSIONED" },
      OR: [
        {
          AND: [
            { endpointA: endpointSideFilter(from) },
            { endpointB: endpointSideFilter(to) },
          ],
        },
        {
          AND: [
            { endpointA: endpointSideFilter(to) },
            { endpointB: endpointSideFilter(from) },
          ],
        },
        { segmentGroupName: { contains: `${fromNorm}-${toNorm}` } },
        { segmentGroupName: { contains: `${toNorm}-${fromNorm}` } },
        { segmentCode: { contains: `${fromNorm}-${toNorm}` } },
        { segmentCode: { contains: `${toNorm}-${fromNorm}` } },
        ...mappingPairFilters(from, to),
      ],
      ...(process.env.FEATURE_DEMO_DATA === "true"
        ? {}
        : { NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }),
    },
    include: previewSegmentInclude,
  });
}

function serviceIdsForPreviewSegment(segment?: PreviewSegment | null): string[] {
  const mappingServices = segment?.endpointMappings
    .map((mapping) => mapping.serviceCode)
    .filter(Boolean) as string[] | undefined;
  const allocationServices = segment?.serviceAllocations
    .map((allocation) => allocation.service.serviceCode)
    .filter(Boolean) as string[] | undefined;
  return [
    ...new Set(
      [
        ...(mappingServices ?? []),
        ...(allocationServices ?? []),
        segment?.allocatedServiceCode,
      ].filter(Boolean) as string[],
    ),
  ];
}

function previewHopFromSegment(
  from: string,
  to: string,
  segment: PreviewSegment | null,
  cumulativeDistanceKm: number,
  oriented = false,
): TransportPreviewHop {
  const distanceKm = segment?.distanceKm ?? null;
  const capacity = segment
    ? segmentCapacityView(segment as unknown as CapacitySegmentLike)
    : null;
  return {
    from,
    to,
    matched: Boolean(segment),
    segmentCode: cleanSegmentCode(segment?.segmentCode),
    segmentGroupName: cleanSegmentCode(segment?.segmentGroupName),
    local: segment
      ? oriented
        ? endpointForSite(segment as unknown as TraceSegment, from, "A")
        : endpointView(
            segment as unknown as TraceSegment,
            segment.endpointA as unknown as TraceEndpoint,
          )
      : null,
    far: segment
      ? oriented
        ? endpointForSite(segment as unknown as TraceSegment, to, "B")
        : endpointView(
            segment as unknown as TraceSegment,
            segment.endpointB as unknown as TraceEndpoint,
          )
      : null,
    serviceIds: serviceIdsForPreviewSegment(segment).join(", ") || null,
    totalFibers: capacity?.totalFibers ?? null,
    usedFibers: capacity?.usedFibers ?? null,
    availableFibers: capacity?.availableFibers ?? null,
    status: segment?.status ?? null,
    distanceKm,
    cumulativeDistanceKm,
  };
}

function previewEndpointSiteCode(endpoint: PreviewSegment["endpointA"]): string | null {
  return endpoint.site?.code ?? endpoint.rawSiteCode ?? null;
}

function previewEndpointLabel(endpoint: PreviewSegment["endpointA"]): string {
  return siteDisplay(previewEndpointSiteCode(endpoint) ?? "UNKNOWN");
}

function segmentJumperKeys(segment: PreviewSegment): Set<string> {
  const keys = new Set<string>();
  for (const mapping of segment.endpointMappings ?? []) {
    for (const key of String(mapping.jumperSiteCode ?? "").split(",")) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return keys;
}

type IndirectRouteEdgeRef = {
  segment: PreviewSegment;
  availablePortsCount: number;
  distanceKm: number | null;
  jumperKeys: Set<string>;
};

type IndirectRouteEdge = WeightedTopoEdge<IndirectRouteEdgeRef>;

function previewSegmentToGraphEdge(segment: PreviewSegment): IndirectRouteEdge | null {
  const fromLabel = previewEndpointLabel(segment.endpointA);
  const toLabel = previewEndpointLabel(segment.endpointB);
  const fromKey = siteKey(fromLabel);
  const toKey = siteKey(toLabel);
  if (!fromKey || !toKey || fromKey === "UNKNOWN" || toKey === "UNKNOWN" || fromKey === toKey) return null;
  const capacity = segmentCapacityView(segment as unknown as CapacitySegmentLike);
  const availablePortsCount = Math.max(0, Number(capacity.availableFibers ?? 0));
  const distanceKm = segment.distanceKm ?? null;
  const baseWeight = typeof distanceKm === "number" && Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 1;
  return {
    fromKey,
    toKey,
    fromLabel,
    toLabel,
    ref: {
      segment,
      availablePortsCount,
      distanceKm,
      jumperKeys: segmentJumperKeys(segment),
    },
    // Prefer physically shorter paths, but avoid exhausted spans when another
    // connected path has available ports.
    weight: baseWeight + (availablePortsCount > 0 ? 0 : 100000),
    id: segment.id,
  };
}

type IndirectRoutePreview = {
  summary: IndirectRouteSummary;
  /** Indirect alternatives beyond the primary, ascending by hop count. */
  alternatives: IndirectRouteSummary[];
  hops: TransportPreviewHop[];
};

async function calculateIndirectRoute(siteAId: string, siteBId: string): Promise<IndirectRoutePreview | null> {
  const startKey = siteKey(siteAId);
  const endKey = siteKey(siteBId);
  if (!startKey || !endKey || startKey === "UNKNOWN" || endKey === "UNKNOWN" || startKey === endKey) return null;

  const segments = await prisma.linkSegment.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      ...(process.env.FEATURE_DEMO_DATA === "true"
        ? {}
        : { NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }),
    },
    include: previewSegmentInclude,
    orderBy: [{ segmentCode: "asc" }],
  });
  const edges = segments
    .map(previewSegmentToGraphEdge)
    .filter(Boolean) as IndirectRouteEdge[];
  // Route discovery is purely SEGMENT-based: the graph edges above are physical
  // LinkSegments joining immediate site boundaries — never Service IDs or child
  // row abstractions. Two complementary passes guarantee robustness:
  //   1. Dijkstra (findShortestPath) has NO hop limit, so a valid indirect route
  //      is ALWAYS found when segment continuity exists — even across very long
  //      chains (e.g. ZLA01 -> ZLA14 = 13 hops).
  //   2. Bounded enumeration (findAllSimplePaths) crawls adjacent intersecting
  //      segments for every alternative simple route.
  // Both result sets are merged, deduped and sorted fewest-hops-first.
  // Hop cap: indirect discovery is bounded to MAX_INDIRECT_HOPS segments. This
  // keeps the exhaustive simple-path enumeration tractable (avoids very large
  // combinatorial searches on dense graphs) and defines what "reachable" means —
  // a route needing more than this many hops is reported as unavailable, and the
  // UI notes "Max 25 indirect hops". Keep this in sync with that copy.
  const MAX_INDIRECT_HOPS = 25;
  const guaranteed = findShortestPath(edges, startKey, endKey);
  const enumerated = findAllSimplePaths(edges, startKey, endKey, { maxHops: MAX_INDIRECT_HOPS });
  const seenRoutes = new Set<string>();
  const routes: ShortestPathResult<IndirectRouteEdgeRef>[] = [];
  for (const route of [...(guaranteed ? [guaranteed] : []), ...enumerated]) {
    // Enforce the hop cap on BOTH passes (Dijkstra has no built-in limit).
    if (!route.edges.length || route.edges.length > MAX_INDIRECT_HOPS) continue;
    const routeKey = route.nodeKeys.join(">");
    if (seenRoutes.has(routeKey)) continue;
    seenRoutes.add(routeKey);
    routes.push(route);
  }
  routes.sort(
    (a, b) =>
      a.edges.length - b.edges.length ||
      a.totalWeight - b.totalWeight ||
      a.nodeKeys.join(">").localeCompare(b.nodeKeys.join(">")),
  );
  if (!routes.length) return null;

  const siteRows = await prisma.site.findMany({
    where: { code: { in: [...new Set(routes.flatMap((route) => route.nodeKeys))] } },
    select: { code: true, name: true, label: true },
  });
  const siteByCode = new Map(siteRows.map((site) => [site.code, site]));

  const summarizeRoute = (route: ShortestPathResult<IndirectRouteEdgeRef>): IndirectRouteSummary => {
    const path = route.nodeKeys.map((key, index) => {
      const label = route.nodeLabels[index] ?? key;
      const incoming = index > 0 ? route.edges[index - 1] : null;
      const outgoing = index < route.edges.length ? route.edges[index] : null;
      const adjacentAvailable = [incoming, outgoing]
        .filter(Boolean)
        .map((edge) => edge!.ref.availablePortsCount);
      const site = siteByCode.get(key);
      return {
        siteId: key,
        siteName: site?.name ?? site?.label ?? label,
        availablePortsCount: adjacentAvailable.length ? Math.min(...adjacentAvailable) : 0,
        segmentDistance: Math.round((incoming?.ref.distanceKm ?? 0) * 100) / 100,
        // Site-to-site trace is fully INDEPENDENT of service / A-MPLS memory:
        // jumper identity is purely positional. Every pass-through transit node
        // between origin and termination is a jumper; stored per-service jumper
        // marks (e.g. an A-MPLS ring's configured jumpers) are ignored here.
        isJumper: index > 0 && index < route.nodeKeys.length - 1,
      };
    });
    const cumulativeDistance = Math.round(route.edges.reduce((sum, edge) => sum + (edge.ref.distanceKm ?? 0), 0) * 100) / 100;
    return {
      path,
      totalJumpersInvolved: path.slice(1, -1).filter((hop) => hop.isJumper).length,
      cumulativeDistance,
    };
  };

  const primary = routes[0];
  let cumulativeDistanceKm = 0;
  const hops = primary.edges.map((edge) => {
    cumulativeDistanceKm += edge.ref.distanceKm ?? 0;
    return previewHopFromSegment(edge.fromLabel, edge.toLabel, edge.ref.segment, Math.round(cumulativeDistanceKm * 100) / 100, true);
  });

  return {
    summary: summarizeRoute(primary),
    alternatives: routes.slice(1).map(summarizeRoute),
    hops,
  };
}

// ── Jumper marking ───────────────────────────────────────────────────────────
// A jumper is a pass-through SITE in a chain (fibers cross-connect straight
// through, no local drop). Its identity is keyed by the same canonical siteKey()
// used for topology ordering, so a node renders as a jumper when its key is in
// the persisted jumper set OR it still carries legacy "(Jumper)" label text —
// which display purification would otherwise strip, the original reason the
// canvas never updated a configured jumper's shape.
function nodeIsJumper(label: string | null | undefined, jumperKeys: Set<string>): boolean {
  if (!label) return false;
  if (/\(\s*jumper\s*\)/i.test(label)) return true;
  return jumperKeys.has(siteKey(label));
}

function annotateGroupJumpers(group: ServiceTraceTopologyGroup | null | undefined, jumperKeys: Set<string>) {
  if (!group) return;
  const marked = group.nodes.filter((node) => nodeIsJumper(node, jumperKeys));
  group.jumpers = [...new Set([...(group.jumpers ?? []), ...marked])];
}

/** Annotate every rendered node/hop in a finished trace with jumper identity. */
function applyJumperMarks(trace: ServiceTraceResult, jumperKeys: Set<string>): ServiceTraceResult {
  annotateGroupJumpers(trace.mainRingPath, jumperKeys);
  for (const list of [
    trace.attachedSingleHomed,
    trace.attachedSubrings,
    trace.attachedSpurs,
    trace.attachedSpurChains,
    trace.attachedInterconnects,
    trace.reviewItems,
  ]) {
    for (const group of list ?? []) annotateGroupJumpers(group, jumperKeys);
  }
  for (const hop of trace.hops) hop.isJumper = nodeIsJumper(hop.siteLabel, jumperKeys);
  return trace;
}

async function loadServiceJumperKeys(serviceCode: string): Promise<Set<string>> {
  const normalized = normalizeServiceCodeExact(serviceCode);
  if (!normalized) return new Set();
  // Lightweight id-only lookup — getTrace runs inside the impact-analysis service
  // loop, so this must stay cheap and never re-pull the full mapping graph.
  const ids = await prisma.segmentEndpointMapping.findMany({
    where: { status: { not: "DECOMMISSIONED" }, serviceCode: { contains: normalized } },
    select: { id: true },
  });
  if (!ids.length) return new Set();
  const byMapping = await getJumperSiteCodes(prisma, ids.map((row) => row.id));
  const keys = new Set<string>();
  for (const list of byMapping.values()) for (const key of list) keys.add(key);
  return keys;
}

/**
 * Tag the node labels that resolve to core / datacenter sites on every topology
 * group of a trace result. The ring layout uses this to place a core site at the
 * top of the circle. One Site lookup for the whole result.
 */
async function annotateCoreNodes(result: ServiceTraceResult): Promise<void> {
  const groups = [
    result.mainRingPath,
    ...(result.attachedSingleHomed ?? []),
    ...(result.attachedSubrings ?? []),
    ...(result.attachedSpurs ?? []),
    ...(result.attachedSpurChains ?? []),
    ...(result.attachedInterconnects ?? []),
    ...(result.reviewItems ?? []),
  ].filter(Boolean) as ServiceTraceTopologyGroup[];
  if (!groups.length) return;

  const codeByNode = new Map<string, string>();
  for (const group of groups) {
    for (const node of group.nodes) {
      const code = normalizedSite(node);
      if (code) codeByNode.set(node, code);
    }
  }
  if (!codeByNode.size) return;

  const [sites, service] = await Promise.all([
    prisma.site.findMany({
      where: { code: { in: [...new Set(codeByNode.values())] } },
      select: {
        code: true,
        name: true,
        isCoreSite: true,
        isDatacenter: true,
        siteType: true,
        coreSiteType: true,
        criticalityTags: { include: { tag: true } },
      },
    }),
    prisma.service.findUnique({ where: { serviceCode: result.serviceCode }, select: { serviceType: true } }),
  ]);
  // Surface the Service record's type on the result — the chain views key
  // per-type iconography off it (e.g. "MPLS Core" chains draw PE artwork).
  if (service?.serviceType) result.serviceType = service.serviceType;
  // PE (Provider Edge) sites also bound A-MPLS rings — they may be standalone or
  // live inside a Core/DC. Treat Core, DC and PE all as ring-boundary nodes.
  const isPeType = (...values: Array<string | null | undefined>) =>
    values.some((value) => /\bpe\b|provider\s*edge/i.test(value ?? ""));
  const siteIsPe = (site: (typeof sites)[number]) =>
    isPeType(site.coreSiteType, site.siteType, site.name) ||
    site.criticalityTags.some((assignment) => isPeType(assignment.tag.code, assignment.tag.label));
  const boundaryCodes = new Set(
    sites.filter((site) => site.isCoreSite || site.isDatacenter || siteIsPe(site)).map((site) => site.code),
  );
  const peCodes = new Set(sites.filter((site) => siteIsPe(site)).map((site) => site.code));
  // Only an explicitly A-MPLS service bounded by ring-boundary (Core/DC/PE) sites
  // renders as a ring. Backbones / PtP / interconnects / untagged chains stay
  // straight (spec Rule C + "not A-MPLS unless explicitly tagged").
  const linkTags = result.serviceLinks?.map((link) => link.tag ?? "") ?? [];
  const isAmpls =
    /a-?mpls/i.test(service?.serviceType ?? "") ||
    /a-?mpls/i.test(result.serviceName ?? "") ||
    linkTags.some((tag) => /a-?mpls/i.test(tag));

  const inSet = (set: Set<string>, node?: string) => {
    const code = node ? codeByNode.get(node) : undefined;
    return Boolean(code && set.has(code));
  };
  for (const group of groups) {
    group.coreNodes = group.nodes.filter((node) => inSet(boundaryCodes, node));
    group.peNodes = group.nodes.filter((node) => inSet(peCodes, node));
    const terminalsBoundary =
      group.nodes.length >= 3 && inSet(boundaryCodes, group.nodes[0]) && inSet(boundaryCodes, group.nodes[group.nodes.length - 1]);
    // Case C (unchanged): a closed ring, or an A-MPLS path bounded by TWO
    // Core/DC/PE terminals, renders as the circular/horseshoe ring layout.
    group.renderAsRing = Boolean(group.isClosedRing) || (isAmpls && terminalsBoundary);
    // Cases A & B (degraded A-MPLS): the service is A-MPLS but the group is not a
    // full two-core ring — it has zero core endpoints (Case A) or exactly one
    // (Case B). Render it on the SVG canvas as a STRAIGHT LINEAR chain so the
    // operator still gets PE/ATN/jumper stencils instead of the plain text chain.
    group.renderAsLinearChain = isAmpls && !group.renderAsRing && group.nodes.length >= 2;
  }
}

export const serviceTraceService = {
  async previewTransportPath(pathInput: string) {
    const sites = pathSites(pathInput);
    if (sites.length < 2)
      throw new Error("Transport trail/path must contain at least two sites.");
    const pairs = sites
      .slice(0, -1)
      .map((site, index) => [site, sites[index + 1]] as const);
    let rows: TransportPreviewHop[] = [];
    let cumulativeDistanceKm = 0;
    let indirectRouteSummary: IndirectRouteSummary | null = null;
    let alternativeRouteSummaries: IndirectRouteSummary[] = [];
    let resolvedPathLabel = sites.join(" -> ");

    for (const [from, to] of pairs) {
      const segment = await loadPreviewSegmentForPair(from, to);
      const distanceKm = segment?.distanceKm ?? null;
      if (typeof distanceKm === "number") cumulativeDistanceKm += distanceKm;
      rows.push(previewHopFromSegment(from, to, segment, cumulativeDistanceKm));
    }

    if (sites.length === 2 && rows.length === 1 && !rows[0].matched) {
      const indirect = await calculateIndirectRoute(sites[0], sites[1]);
      if (indirect) {
        rows = indirect.hops;
        cumulativeDistanceKm = indirect.summary.cumulativeDistance;
        resolvedPathLabel = indirect.summary.path.map((hop) => hop.siteId).join(" -> ");
        indirectRouteSummary = indirect.hops.length > 1 ? indirect.summary : null;
        alternativeRouteSummaries = indirect.hops.length > 1 ? indirect.alternatives : [];
      }
    }

    // Context B fork view: read the ODF mapping table at the splitter input
    // boundary and split the result into topology groups (Group 1 trunk + spurs).
    const splitterSites = indirectRouteSummary?.path.map((hop) => hop.siteId) ?? sites;
    const splitterForks = await splitterForksForSites(splitterSites);

    return {
      path: resolvedPathLabel,
      hops: rows,
      matchedHops: rows.filter((row) => row.matched).length,
      missingHops: rows.filter((row) => !row.matched).length,
      totalDistanceKm: Math.round(cumulativeDistanceKm * 100) / 100,
      indirectRouteSummary,
      alternativeRouteSummaries,
      splitterForks,
    };
  },

  async previewDetailedTrace(input: {
    nearSite: string;
    farSite: string;
    nearRack?: string | null;
    nearOdf?: string | null;
    farRack?: string | null;
    farOdf?: string | null;
  }) {
    const near = input.nearSite.trim();
    const far = input.farSite.trim();
    const preview = await this.previewTransportPath(`${near}-${far}`);
    const nearRack = input.nearRack?.trim().toUpperCase();
    const nearOdf = input.nearOdf?.trim().toUpperCase();
    const farRack = input.farRack?.trim().toUpperCase();
    const farOdf = input.farOdf?.trim().toUpperCase();
    preview.hops = preview.hops.filter((hop: any) => {
      const localRack = String(hop.local?.rackCode ?? "").toUpperCase();
      const localOdf = String(hop.local?.odfCode ?? "").toUpperCase();
      const remoteRack = String(hop.far?.rackCode ?? "").toUpperCase();
      const remoteOdf = String(hop.far?.odfCode ?? "").toUpperCase();
      return (
        (!nearRack ||
          localRack.includes(nearRack) ||
          remoteRack.includes(nearRack)) &&
        (!nearOdf ||
          localOdf.includes(nearOdf) ||
          remoteOdf.includes(nearOdf)) &&
        (!farRack ||
          localRack.includes(farRack) ||
          remoteRack.includes(farRack)) &&
        (!farOdf || localOdf.includes(farOdf) || remoteOdf.includes(farOdf))
      );
    });
    preview.matchedHops = preview.hops.filter((row: any) => row.matched).length;
    preview.missingHops = preview.hops.filter(
      (row: any) => !row.matched,
    ).length;
    return preview;
  },

  async getTrace(serviceCode: string): Promise<ServiceTraceResult | null> {
    const normalized = normalizeServiceCodeExact(serviceCode);
    if (!normalized) return null;
    // Context A linear view: the explicit splitter output row allocated to this
    // Service ID is attached to the trace; unassigned splitter ports are ignored.
    const [core, splitterPath, jumperKeys] = await Promise.all([
      this.getTraceCore(normalized),
      splitterChainForService(normalized),
      loadServiceJumperKeys(normalized),
    ]);
    let result: ServiceTraceResult | null = null;
    if (core) result = splitterPath.length ? { ...core, splitterPath } : core;
    else if (splitterPath.length) result = traceFromSplitterChain(normalized, splitterPath);
    if (!result) return null;
    // Tag which nodes are core / datacenter sites so the ring layout can place a
    // core site at the top.
    await annotateCoreNodes(result);
    // Repaint configured/retroactively-marked jumper nodes by data, independent
    // of label purification.
    return applyJumperMarks(result, jumperKeys);
  },

  // Retroactive jumper marking. Flags (or clears) the given site as a passive
  // jumper for every live ODF mapping in this service's chain that touches it,
  // so the change persists and the trace canvas repaints on the next fetch.
  async markSiteAsJumper(
    serviceCode: string,
    siteCode: string,
    isJumper: boolean,
    changedById?: string | null,
  ): Promise<{ updated: number; siteKey: string }> {
    const normalized = normalizeServiceCodeExact(serviceCode);
    if (!normalized) throw new Error("A valid Service ID is required to mark a jumper.");
    const targetKey = siteKey(siteCode);
    if (!targetKey || targetKey === "UNKNOWN") throw new Error("Select a valid site to mark as a jumper.");

    const mappings = await loadMappingsForService(normalized);
    if (!mappings.length) throw new Error(`No live ODF mappings found for service ${normalized}.`);
    const touching = mappings.filter((mapping) => {
      const localKey = siteKey(localMappingLabel(mapping));
      const farKey = siteKey(farMappingLabel(mapping));
      return localKey === targetKey || farKey === targetKey;
    });
    if (!touching.length) throw new Error(`Site ${siteCode} is not part of the traced chain for ${normalized}.`);

    const existing = await getJumperSiteCodes(prisma, touching.map((mapping) => mapping.id));
    let updated = 0;
    for (const mapping of touching) {
      const current = new Set(existing.get(mapping.id) ?? []);
      if (isJumper) current.add(targetKey);
      else current.delete(targetKey);
      await setJumperSiteCodes(prisma, mapping.id, [...current]);
      updated += 1;
    }

    await writeAuditLog({
      entityType: "SegmentEndpointMapping",
      entityId: touching.map((mapping) => mapping.id).join(","),
      action: "MANUAL_OVERRIDE",
      fieldName: "jumperSiteCode",
      newValue: { service: normalized, site: targetKey, isJumper, mappings: updated },
      changedById: changedById ?? null,
      reason: `${isJumper ? "Marked" : "Cleared"} ${siteCode} as jumper on ${updated} mapping row(s) for ${normalized}`,
    });

    return { updated, siteKey: targetKey };
  },

  async getTraceCore(serviceCode: string): Promise<ServiceTraceResult | null> {
    const normalizedServiceCode = normalizeServiceCodeExact(serviceCode);
    if (!normalizedServiceCode) return null;
    const service = await serviceRepository.getTraceByServiceCode(
      normalizedServiceCode,
    );
    if (!service || service.routes.length === 0)
      return traceFromEndpointMappings(normalizedServiceCode);

    const route =
      service.routes.find(
        (candidate) =>
          candidate.allocations.some(
            (allocation) =>
              allocation.segment &&
              allocation.status !== "DECOMMISSIONED" &&
              allocation.segment.status !== "DECOMMISSIONED",
          ) ||
          candidate.hops.some(
            (hop) => hop.segment && hop.segment.status !== "DECOMMISSIONED",
          ),
      ) ?? service.routes[0];
    const allocations = route.allocations.filter(
      (allocation) =>
        Boolean(allocation.segment) &&
        allocation.status !== "DECOMMISSIONED" &&
        allocation.segment.status !== "DECOMMISSIONED" &&
        (process.env.FEATURE_DEMO_DATA === "true" ||
          allocation.segment.importBatch?.sourceSystem !== "DEMO_SEED"),
    );
    if (allocations.length > 0) {
      // Post-split chain-extension guard: a segment split rebuilds the service
      // route with only the two newly created segments (A->X, X->B). Imported
      // multi-segment chains keep their other hops as endpoint mappings without
      // allocations, so a route-only view would truncate the transport chain.
      // When live mappings span segments beyond this route, render the merged
      // mapping-based chain instead so the inserted site appears in the full path.
      const routeSegmentIds = new Set(allocations.map((allocation) => allocation.segment.id));
      const liveMappings = await loadMappingsForService(normalizedServiceCode);
      const mappingSegmentsBeyondRoute = liveMappings.filter((mapping) => !routeSegmentIds.has(mapping.segment.id));
      if (mappingSegmentsBeyondRoute.length > 0) {
        const mappingTrace = await traceFromEndpointMappings(normalizedServiceCode);
        if (mappingTrace) {
          return {
            ...mappingTrace,
            routeType: route.routeType,
            topologyWarnings: [
              ...(mappingTrace.topologyWarnings ?? []),
              "The active service route covers only part of this transport chain (for example after a segment split). The full imported chain is shown, including the rerouted hops.",
            ],
          };
        }
      }
      const components = orderedAllocationComponents(allocations, service.serviceCode);

      // CRITICAL FIX: Use the longest component as main, not just the first
      // Sort components by edge count (longest path first)
      const sortedComponents = components.slice().sort((a, b) =>
        b.orderedEdges.length - a.orderedEdges.length
      );

      const mainComponent = sortedComponents[0];
      const mainRingPath = mainComponent
        ? topologyGroupFromAllocationComponent("MAIN_RING", mainComponent, service.serviceCode)
        : null;
      const fullPathLabel = mainRingPath?.fullPathLabel ?? routeAllocationLabels(allocations).join(" -> ");
      const hops = mainComponent
        ? hopsFromAllocationComponent(mainComponent, fullPathLabel)
        : [];
      const orderedAllocations = orderAllocationsByTopology(allocations, sortedComponents);
      const reviewItems = sortedComponents
        .slice(1)
        .map((component) => topologyGroupFromAllocationComponent("REVIEW", component, service.serviceCode));
      const topologyWarnings = sortedComponents.length > 1
        ? [`${sortedComponents.length} disconnected service-allocation groups were found for this service. The longest group is shown as the primary path; the rest are listed for review.`]
        : [];

      return {
        serviceCode: service.serviceCode,
        serviceName: service.serviceName,
        routeType: route.routeType,
        fullPathLabel,
        totalDistanceKm: Math.round((mainRingPath?.totalDistanceKm ?? 0) * 100) / 100,
        hops,
        serviceLinks: dedupeServiceLinks(serviceLinksFromAllocations(
          service.serviceCode,
          orderedAllocations,
        )),
        mainRingPath,
        reviewItems,
        topologyWarnings,
      };
    }

    const segmentHops = route.hops.filter(
      (hop) =>
        Boolean(hop.segment) &&
        hop.segment?.status !== "DECOMMISSIONED" &&
        (process.env.FEATURE_DEMO_DATA === "true" ||
          hop.segment?.importBatch?.sourceSystem !== "DEMO_SEED"),
    );
    if (segmentHops.length === 0)
      return traceFromEndpointMappings(normalizedServiceCode);

    const components = orderedHopComponents(segmentHops, service.serviceCode);

    // CRITICAL FIX: Use the longest component as main, not just the first
    // Sort components by edge count (longest path first)
    const sortedComponents = components.slice().sort((a, b) =>
      b.orderedEdges.length - a.orderedEdges.length
    );

    const mainComponent = sortedComponents[0];
    const mainRingPath = mainComponent
      ? topologyGroupFromHopComponent("MAIN_RING", mainComponent, service.serviceCode)
      : null;
    const fullPathLabel = mainRingPath?.fullPathLabel ?? routeSegmentLabels(segmentHops).join(" -> ");
    const hops = mainComponent ? hopsFromHopComponent(mainComponent, fullPathLabel) : [];
    const orderedSegmentHops = orderHopsByTopology(segmentHops, sortedComponents);
    const reviewItems = sortedComponents
      .slice(1)
      .map((component) => topologyGroupFromHopComponent("REVIEW", component, service.serviceCode));
    const topologyWarnings = sortedComponents.length > 1
      ? [`${sortedComponents.length} disconnected service-hop groups were found for this service. The longest group is shown as the primary path; the rest are listed for review.`]
      : [];

    return {
      serviceCode: service.serviceCode,
      serviceName: service.serviceName,
      routeType: route.routeType,
      fullPathLabel,
      totalDistanceKm: Math.round((mainRingPath?.totalDistanceKm ?? 0) * 100) / 100,
      hops,
      serviceLinks: dedupeServiceLinks(serviceLinksFromRouteHops(service.serviceCode, orderedSegmentHops)),
      mainRingPath,
      reviewItems,
      topologyWarnings,
    };
  },
};
