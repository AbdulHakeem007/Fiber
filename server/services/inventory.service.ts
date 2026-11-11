import type { InventoryMappingRow, InventorySegmentRow } from "@/types/telecom";
import { resolveNearFarView } from "@/lib/telecom/endpoint-display";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { fiberCountFromUnit } from "@/lib/telecom/fiber-unit";
import { segmentRepository } from "@/server/repositories/segment.repository";
import { isRehomedOutRemark } from "@/lib/telecom/rehome";
import { effectiveTopologyRole } from "@/lib/telecom/topology-role";
import { createReadThroughCache } from "@/lib/cache/read-through-cache";

type InventorySegmentRecord = Awaited<ReturnType<typeof segmentRepository.listInventoryRows>>[number];
type InventoryCursorResult = {
  rows: InventorySegmentRow[];
  nextCursor: string | null;
  pageSize: number;
};

const inventoryCursorCache = createReadThroughCache<InventoryCursorResult>({
  ttlMs: 120_000,
  maxEntries: 80,
});

function inventoryCursorCacheKey(
  filters: import("@/lib/filters/inventory-filters").InventoryFilters,
  options: { cursor?: string | null; pageSize?: number },
): string {
  const normalizedFilters = Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => String(value ?? "").trim())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, String(value).trim().toUpperCase()]),
  );
  return JSON.stringify({
    filters: normalizedFilters,
    cursor: options.cursor ?? "",
    pageSize: Math.min(Math.max(options.pageSize ?? 250, 25), 1000),
  });
}

function endpointSiteCode(endpoint: InventorySegmentRecord["endpointA"]): string | null {
  return endpoint.site?.code ?? endpoint.rawSiteCode ?? null;
}

function endpointForSite(segment: InventorySegmentRecord, siteCode?: string | null) {
  const code = siteCode?.trim().toUpperCase();
  if (!code) return null;
  if (endpointSiteCode(segment.endpointA)?.trim().toUpperCase() === code) return segment.endpointA;
  if (endpointSiteCode(segment.endpointB)?.trim().toUpperCase() === code) return segment.endpointB;
  return null;
}

function uniqueServiceIds(segment: InventorySegmentRecord): string | null {
  const serviceCodes = [
    segment.allocatedServiceCode,
    ...(segment.endpointMappings ?? []).map((mapping) => mapping.serviceCode),
    ...(segment.fibers ?? []).map((fiber) => fiber.serviceCode),
    ...(segment.serviceAllocations ?? []).map((allocation) => allocation.service?.serviceCode),
    ...(segment.serviceRouteHops ?? []).map((hop) => hop.serviceRoute.service.serviceCode),
  ].filter(Boolean) as string[];

  const unique = [...new Set(serviceCodes.map((value) => value.trim()).filter(Boolean))];
  return unique.length ? unique.join(", ") : null;
}

function portNumbersFromLabel(label?: string | null): number[] {
  return String(label ?? "")
    .match(/\d+/g)
    ?.map(Number)
    .filter((value) => Number.isFinite(value)) ?? [];
}

function portRangeFromLabels(labels: Array<string | null | undefined>): { label: string | null; start: number | null; end: number | null; count: number | null } {
  const ports = new Set<number>();

  for (const label of labels) {
    const numbers = portNumbersFromLabel(label);
    if (numbers.length >= 2) {
      const start = Math.min(numbers[0], numbers[1]);
      const end = Math.max(numbers[0], numbers[1]);
      for (let port = start; port <= end; port += 1) ports.add(port);
    } else if (numbers.length === 1) {
      ports.add(numbers[0]);
    }
  }

  const sorted = [...ports].sort((a, b) => a - b);
  if (!sorted.length) return { label: null, start: null, end: null, count: null };

  const start = sorted[0];
  const end = sorted[sorted.length - 1];
  return {
    label: start === end ? String(start) : `${start}-${end}`,
    start,
    end,
    count: sorted.length,
  };
}

function fiberCountFromPortLabel(label?: string | null, fiberNumbersJson?: string | null): number {
  const json = String(fiberNumbersJson ?? "").match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (json.length > 0) return new Set(json).size;

  const cleaned = String(label ?? "").replace(/\([^)]*\)/g, " ").trim();
  const numbers = cleaned.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (numbers.length >= 2) {
    const start = Math.min(numbers[0], numbers[1]);
    const end = Math.max(numbers[0], numbers[1]);
    return Math.max(1, end - start + 1);
  }
  if (numbers.length === 1) return 1;
  return 0;
}

function statusConsumesCapacity(status?: string | null, serviceId?: string | null): boolean {
  const normalized = String(status ?? "").toUpperCase();
  return Boolean(serviceId?.trim()) || ["USED", "ACTIVE", "RESERVED", "FAULTY", "BLOCKED", "DUMMY"].includes(normalized);
}

function childCapacityStats(mappings: InventoryMappingRow[], fibers: InventorySegmentRecord["fibers"]) {
  let total = 0;
  let used = 0;
  let reserved = 0;
  let faulty = 0;
  let blocked = 0;
  let dummy = 0;
  let rehomed = 0;

  if (mappings.length) {
    for (const mapping of mappings) {
      const count = fiberCountFromUnit(mapping.localPort ?? mapping.farPort, mapping.fiberNumbers);
      const normalizedStatus = String(mapping.status ?? "").toUpperCase();
      // EDIT HERE: Live parent capacity after partial split.
      // Re-homed rows are still live in the network, but not as direct parent X-Z capacity.
      // Exclude them from parent total while tracking them separately for UI/audit.
      if (isRehomedOutRemark(mapping.remarks)) {
        rehomed += count;
        continue;
      }
      if (["DUMMY", "DECOMMISSIONED"].includes(normalizedStatus)) {
        dummy += count;
        continue;
      }
      total += count;
      if (mapping.serviceId?.trim() || normalizedStatus === "USED" || normalizedStatus === "ACTIVE") used += count;
      else if (normalizedStatus === "RESERVED") reserved += count;
      else if (normalizedStatus === "FAULTY") faulty += count;
      else if (normalizedStatus === "BLOCKED") blocked += count;
    }
  } else if (fibers.length) {
    for (const fiber of fibers) {
      const normalizedStatus = String(fiber.status ?? "").toUpperCase();
      if (isRehomedOutRemark(fiber.remarks)) {
        rehomed += 1;
        continue;
      }
      if (["DUMMY", "DECOMMISSIONED"].includes(normalizedStatus)) {
        dummy += 1;
        continue;
      }
      total += 1;
      if (fiber.serviceCode?.trim() || normalizedStatus === "USED" || normalizedStatus === "ACTIVE") used += 1;
      else if (normalizedStatus === "RESERVED") reserved += 1;
      else if (normalizedStatus === "FAULTY") faulty += 1;
      else if (normalizedStatus === "BLOCKED") blocked += 1;
    }
  }

  const consumedForAvailability = used + reserved + faulty + blocked;
  return {
    total: total || null,
    used,
    reserved,
    faulty,
    blocked,
    dummy,
    rehomed,
    // EDIT HERE: Parent partial-split live availability.
    // Re-homed rows are borrowed/lent rows already excluded from direct total, so do not
    // subtract them again or the parent appears to lose capacity twice.
    available: total ? Math.max(0, total - consumedForAvailability) : null,
    utilizationPct: total ? Math.round((used / total) * 100) : null,
  };
}

function effectiveCount(value?: number | null): number {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

function clampAvailability(capacity: number | null, used: number, reserved: number, faulty: number, blocked: number, dummy: number, fallback?: number | null): number | null {
  if (!capacity || capacity <= 0) return fallback ?? null;
  return Math.max(0, capacity - used - reserved - faulty - blocked - dummy);
}

function mappingFiberSortKey(row: InventoryMappingRow): number {
  // Ascending fiber sequencing: order child ODF-mapping rows by their LOWEST
  // referenced fiber number (from fiberNumbersJson, else the port label) so the
  // parent's child table reads 1, 2, 3 … instead of import/creation order. This is
  // a presentation-order change only — the rows themselves and every split/child
  // derivation are left exactly as built. Rows with no parseable fiber number sink
  // to the bottom in a stable position.
  const numbers = [
    ...(String(row.fiberNumbers ?? "").match(/\d+/g) ?? []),
    ...(String(row.localPort ?? row.farPort ?? "").match(/\d+/g) ?? []),
  ]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length ? Math.min(...numbers) : Number.MAX_SAFE_INTEGER;
}

function buildMappingRows(segment: InventorySegmentRecord): InventoryMappingRow[] {
  return (segment.endpointMappings ?? []).map((mapping) => ({
    id: mapping.id,
    serviceId: mapping.serviceCode,
    tag: mapping.tag ?? null,
    childTopologyRole: mapping.childTopologyRole ?? null,
    effectiveTopologyRole: effectiveTopologyRole({ childTopologyRole: mapping.childTopologyRole, segmentDefaultRole: segment.segmentDefaultRole }).role,
    topologyRoleSource: effectiveTopologyRole({ childTopologyRole: mapping.childTopologyRole, segmentDefaultRole: segment.segmentDefaultRole }).source,
    localSite: displaySiteLabel(mapping.localSiteCode, segment.segmentGroupName ?? segment.segmentCode),
    localRack: mapping.localRackCode,
    localOdf: mapping.localOdfCode,
    localPort: mapping.localPortLabel,
    farSite: mapping.farSiteCode ? displaySiteLabel(mapping.farSiteCode, segment.segmentGroupName ?? segment.segmentCode) : null,
    farEndpoint: mapping.farEndpointLabel ? displaySiteLabel(mapping.farEndpointLabel, segment.segmentGroupName ?? segment.segmentCode) : null,
    farRack: mapping.farRackCode,
    farOdf: mapping.farOdfCode,
    farPort: mapping.farPortLabel,
    cableId: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
    fiberNumbers: mapping.fiberNumbersJson,
    fiberCount: fiberCountFromUnit(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson),
    status: (isRehomedOutRemark(mapping.remarks) ? "REHOMED" : mapping.status) as InventorySegmentRow["status"],
    remarks: mapping.remarks,
  }))
    .sort((a, b) => mappingFiberSortKey(a) - mappingFiberSortKey(b) || a.id.localeCompare(b.id));
}


function isLiveDisplayMapping(mapping: InventoryMappingRow): boolean {
  const status = String(mapping.status ?? "").toUpperCase();
  // REHOMED rows are intentionally displayed in the parent child table as live-but-moved.
  return !["DUMMY", "DECOMMISSIONED"].includes(status);
}

function toInventoryRow(segment: InventorySegmentRecord, contextSiteCode?: string): InventorySegmentRow {
  const relationCounts = (segment as any)._count as { endpointMappings?: number } | undefined;
  const serviceIds = uniqueServiceIds(segment);

  const view = resolveNearFarView({
    contextSiteCode,
    endpointA: {
      siteCode: segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode,
      rackCode: segment.endpointA.rack?.rackCode ?? segment.endpointA.rawRackCode,
      odfCode: segment.endpointA.odf?.odfCode ?? segment.endpointA.rawOdfCode,
      portLabel: segment.endpointA.portGroup?.displayLabel ?? segment.endpointA.displayPortText ?? segment.endpointA.rawPortText,
    },
    endpointB: {
      siteCode: segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode,
      rackCode: segment.endpointB.rack?.rackCode ?? segment.endpointB.rawRackCode,
      odfCode: segment.endpointB.odf?.odfCode ?? segment.endpointB.rawOdfCode,
      portLabel: segment.endpointB.portGroup?.displayLabel ?? segment.endpointB.displayPortText ?? segment.endpointB.rawPortText,
    },
  });

  const nearEndpoint = endpointForSite(segment, view.near.siteCode) ?? segment.endpointA;
  const farEndpoint = endpointForSite(segment, view.far.siteCode) ?? segment.endpointB;
  const allMappings = buildMappingRows(segment);
  const mappings = allMappings.filter(isLiveDisplayMapping);

  // Parent segment must show the remaining live ODF range/chunk after a partial split.
  // Re-homed rows stay visible as live-but-moved parent port definitions, while
  // DUMMY/DECOMMISSIONED rows stay hidden from live operations.
  const nearRange = portRangeFromLabels(mappings.map((mapping) => mapping.localPort));
  const farRange = portRangeFromLabels(mappings.map((mapping) => mapping.farPort));
  const endpointNearRange = portRangeFromLabels([view.near.portLabel]);
  const endpointFarRange = portRangeFromLabels([view.far.portLabel]);

  const childStats = childCapacityStats(allMappings, segment.fibers ?? []);
  // Operational rule: parent capacity must come from the actual child fiber/port rows
  // facing the far end. A port label such as 1-2 means two fibers; label 1 means one fiber.
  // Imported parent capacity can be stale, and ODF totals can represent both sides/mirror data,
  // so the parent available count must be calculated from child rows whenever they exist.
  const totalOdfPorts = childStats.total ?? segment.segmentCapacityFibers ?? segment.totalFiberCapacity ?? nearRange.count ?? endpointNearRange.count ?? null;
  const usedCount = childStats.total ? childStats.used : effectiveCount(segment.usedFiberCount);
  const reservedCount = childStats.total ? childStats.reserved : effectiveCount(segment.reservedFiberCount);
  const faultyCount = childStats.total ? childStats.faulty : effectiveCount(segment.faultyFiberCount);
  const blockedCount = childStats.total ? childStats.blocked : effectiveCount(segment.inactiveFiberCount);
  const dummyCount = childStats.total ? childStats.dummy : effectiveCount(segment.dummyFiberCount);
  const rehomedCount = childStats.total ? childStats.rehomed : 0;
  const availableCount = childStats.total
    ? childStats.available
    : totalOdfPorts
      ? Math.max(0, totalOdfPorts - usedCount - reservedCount - faultyCount)
      : segment.availableFiberCount ?? null;
  const contextLabel = segment.segmentGroupName ?? segment.segmentCode;

  return {
    segmentId: segment.id,
    segmentCode: segment.segmentCode,
    segmentGroupName: segment.segmentGroupName,
    segmentSequence: segment.segmentSequence,
    segmentCapacityFibers: segment.segmentCapacityFibers,
    segmentDefaultRole: segment.segmentDefaultRole ?? null,
    serviceIds,
    nearSite: displaySiteLabel(view.near.siteCode ?? "UNKNOWN", contextLabel),
    nearSiteCode: view.near.siteCode ?? null,
    nearSiteType: nearEndpoint.site?.siteType ?? null,
    nearCoreSiteType: nearEndpoint.site?.coreSiteType ?? null,
    nearRack: view.near.rackCode ?? null,
    nearOdf: view.near.odfCode ?? null,
    nearPortGroup: nearRange.label ?? endpointNearRange.label ?? view.near.portLabel ?? null,
    nearPortRangeStart: nearRange.start ?? endpointNearRange.start,
    nearPortRangeEnd: nearRange.end ?? endpointNearRange.end,
    farSite: view.far.siteCode ? displaySiteLabel(view.far.siteCode, contextLabel) : null,
    farSiteCode: view.far.siteCode ?? null,
    farSiteType: farEndpoint.site?.siteType ?? null,
    farCoreSiteType: farEndpoint.site?.coreSiteType ?? null,
    farRack: view.far.rackCode ?? null,
    farOdf: view.far.odfCode ?? null,
    farPortGroup: farRange.label ?? endpointFarRange.label ?? view.far.portLabel ?? null,
    farPortRangeStart: farRange.start ?? endpointFarRange.start,
    farPortRangeEnd: farRange.end ?? endpointFarRange.end,
    cableLabel: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
    tubeNumber: segment.tubeNumber ?? nearEndpoint.portGroup?.tubeNumber ?? farEndpoint.portGroup?.tubeNumber ?? null,
    tubeColor: segment.tubeColor ?? nearEndpoint.portGroup?.tubeColor ?? farEndpoint.portGroup?.tubeColor ?? null,
    tubeLabel: segment.tubeLabel,
    fiberPortNumber: segment.fiberPortNumber ?? nearEndpoint.portGroup?.fiberPortNumber ?? farEndpoint.portGroup?.fiberPortNumber ?? null,
    fiberNumber: segment.fiberNumber ?? segment.fibers[0]?.fiberNumber ?? nearEndpoint.portGroup?.fiberNumber ?? farEndpoint.portGroup?.fiberNumber ?? null,
    fiberLabel: segment.fibers.length ? segment.fibers.map((fiber) => fiber.fiberNumber).join(", ") : segment.fiberLabel,

    // Backward-compatible names currently used by some UI components.
    totalFibers: totalOdfPorts,
    usedFibers: usedCount,
    reservedFibers: reservedCount,
    faultyFibers: faultyCount,
    blockedFibers: blockedCount,
    dummyFibers: dummyCount,
    rehomedFibers: rehomedCount,
    availableFibers: availableCount,

    // Preferred names for corrected UI copy: ODF ports, not cable fibers.
    totalOdfPorts,
    usedOdfPorts: usedCount,
    reservedOdfPorts: reservedCount,
    faultyOdfPorts: faultyCount,
    blockedOdfPorts: blockedCount,
    dummyOdfPorts: dummyCount,
    rehomedOdfPorts: rehomedCount,
    availableOdfPorts: availableCount,

    utilizationPct: totalOdfPorts ? Math.round((usedCount / totalOdfPorts) * 10000) / 100 : segment.utilizationPct,
    distanceKm: segment.distanceKm,
    status: segment.status as InventorySegmentRow["status"],
    createdAt: segment.createdAt.toISOString(),
    updatedAt: segment.updatedAt.toISOString(),
    mappings,
    childLinkCount: relationCounts?.endpointMappings ?? mappings.length,
  };
}

export const inventoryService = {
  async listInventory(contextSiteCode?: string): Promise<InventorySegmentRow[]> {
    const rows = await segmentRepository.listInventoryRows(contextSiteCode);
    return rows.map((segment) => toInventoryRow(segment, contextSiteCode));
  },

  async getInventoryRowById(segmentId: string, contextSiteCode?: string): Promise<InventorySegmentRow | null> {
    const segment = await segmentRepository.getById(segmentId);
    return segment ? toInventoryRow(segment, contextSiteCode) : null;
  },

  async listInventoryPage(filters: import("@/lib/filters/inventory-filters").InventoryFilters = {}, options: { page?: number; pageSize?: number } = {}) {
    const result = await segmentRepository.listInventoryRowsPage(filters, options.page ?? 1, options.pageSize ?? 100);
    return {
      ...result,
      rows: result.rows.map((segment) => toInventoryRow(segment as any)),
    };
  },

  async listInventoryCursor(filters: import("@/lib/filters/inventory-filters").InventoryFilters = {}, options: { cursor?: string | null; pageSize?: number } = {}) {
    return inventoryCursorCache.get(
      inventoryCursorCacheKey(filters, options),
      async () => {
        const result = await segmentRepository.listInventoryRowsCursor(filters, options);
        return {
          ...result,
          rows: result.rows.map((segment) => toInventoryRow(segment as any)),
        };
      },
    );
  },
};
