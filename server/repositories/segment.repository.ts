import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import type { InventoryFilters } from "@/lib/filters/inventory-filters";

function baseLiveWhere(): Prisma.LinkSegmentWhereInput {
  return {
    AND: [
      ...(process.env.FEATURE_DEMO_DATA === "true" ? [] : [{ NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }]),
      { status: { not: "DECOMMISSIONED" } },
    ],
  };
}

function contains(value?: string): Prisma.StringFilter | undefined {
  const text = value?.trim();
  return text ? { contains: text } : undefined;
}

function inventoryWhere(filters: InventoryFilters = {}): Prisma.LinkSegmentWhereInput {
  const and: Prisma.LinkSegmentWhereInput[] = [baseLiveWhere()];
  const search = filters.search?.trim();
  if (search) {
    and.push({
      OR: [
        { segmentCode: contains(search) },
        { segmentGroupName: contains(search) },
        { sourceSegmentKey: contains(search) },
        { allocatedServiceCode: contains(search) },
        { cable: { OR: [{ cableCode: contains(search) }, { cableName: contains(search) }] } },
        { endpointA: { rawSiteCode: contains(search) } },
        { endpointB: { rawSiteCode: contains(search) } },
        { endpointMappings: { some: { OR: [
          { serviceCode: contains(search) },
          { localSiteCode: contains(search) },
          { farSiteCode: contains(search) },
          { farEndpointLabel: contains(search) },
          { localRackCode: contains(search) },
          { farRackCode: contains(search) },
          { localOdfCode: contains(search) },
          { farOdfCode: contains(search) },
          { localPortLabel: contains(search) },
          { farPortLabel: contains(search) },
        ] } } },
      ],
    });
  }
  if (filters.status?.trim() && filters.status !== "ALL") and.push({ status: filters.status.trim().toUpperCase() as any });
  if (filters.site?.trim()) {
    const site = filters.site.trim().toUpperCase();
    and.push({ OR: [
      { endpointA: { rawSiteCode: contains(site) } },
      { endpointB: { rawSiteCode: contains(site) } },
      { endpointA: { site: { code: contains(site) } } },
      { endpointB: { site: { code: contains(site) } } },
      { endpointMappings: { some: { OR: [{ localSiteCode: contains(site) }, { farSiteCode: contains(site) }, { farEndpointLabel: contains(site) }] } } },
    ] });
  }
  if (filters.connectedSite?.trim()) {
    const site = filters.connectedSite.trim().toUpperCase();
    and.push({ endpointMappings: { some: { OR: [{ localSiteCode: contains(site) }, { farSiteCode: contains(site) }, { farEndpointLabel: contains(site) }] } } });
  }
  if (filters.serviceId?.trim()) and.push({ endpointMappings: { some: { serviceCode: contains(filters.serviceId.trim()) } } });
  if (filters.rackId?.trim()) and.push({ endpointMappings: { some: { OR: [{ localRackCode: contains(filters.rackId) }, { farRackCode: contains(filters.rackId) }] } } });
  if (filters.odfId?.trim()) and.push({ endpointMappings: { some: { OR: [{ localOdfCode: contains(filters.odfId) }, { farOdfCode: contains(filters.odfId) }] } } });
  if (filters.portPair?.trim()) and.push({ endpointMappings: { some: { OR: [{ localPortLabel: contains(filters.portPair) }, { farPortLabel: contains(filters.portPair) }] } } });
  if (filters.cableId?.trim()) and.push({ cable: { OR: [{ cableCode: contains(filters.cableId) }, { cableName: contains(filters.cableId) }] } });
  return { AND: and };
}

// Shared relation shape for the multi-row inventory list queries. Only the
// columns toInventoryRow / buildMappingRows / childCapacityStats / uniqueServiceIds
// actually read are selected, so a 100-row page no longer drags full SegmentFiber
// rows (≈3k rows) and full nested Service rows across the wire. Behaviour is
// identical — the same rows are fetched, just fewer columns. Kept type-safe via
// `satisfies`; because InventorySegmentRecord derives from listInventoryRows,
// dropping a still-used field would fail typecheck. Single-row lookups (getById /
// getBySegmentCode) intentionally keep full includes — their fiber count is tiny
// and other consumers may read wider fields.
const inventoryListInclude = {
  cable: true,
  endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
  endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
  fibers: {
    select: { fiberNumber: true, status: true, serviceCode: true, remarks: true },
    orderBy: { fiberNumber: "asc" },
  },
  serviceAllocations: {
    select: { service: { select: { serviceCode: true } } },
    orderBy: { pathOrder: "asc" },
  },
  serviceRouteHops: {
    select: { serviceRoute: { select: { service: { select: { serviceCode: true } } } } },
  },
  endpointMappings: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.LinkSegmentInclude;

export const segmentRepository = {
  listInventoryRows: async (siteCode?: string) => {
    const filters: any[] = [];
    if (process.env.FEATURE_DEMO_DATA !== "true") {
      filters.push({ NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } });
    }
    filters.push({ status: { not: "DECOMMISSIONED" } });
    if (siteCode) {
      const code = siteCode.trim().toUpperCase();
      filters.push({
        OR: [
          { endpointA: { site: { code } } },
          { endpointB: { site: { code } } },
          { endpointA: { rawSiteCode: code } },
          { endpointB: { rawSiteCode: code } },
          { endpointMappings: { some: { localSiteCode: code } } },
          { endpointMappings: { some: { farSiteCode: code } } },
          { endpointMappings: { some: { farEndpointLabel: { contains: code } } } },
        ],
      });
    }

    return prisma.linkSegment.findMany({
      where: filters.length ? { AND: filters } : undefined,
      include: inventoryListInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  },

  listInventoryRowsPage: async (filters: InventoryFilters = {}, page = 1, pageSize = 100) => {
    const where = inventoryWhere(filters);
    const take = Math.min(Math.max(pageSize, 25), 1000);
    const skip = Math.max(0, (Math.max(1, page) - 1) * take);
    const [rows, total] = await Promise.all([
      prisma.linkSegment.findMany({
        where,
        // The child mappings/fibers MUST be loaded so toInventoryRow derives the
        // capacity/used/available from the INDIVIDUAL FIBER NUMBERS in the ODF
        // mappings (childCapacityStats) rather than the stale cable fiber count.
        // inventoryListInclude selects only the fiber/service columns actually
        // read, so the bounded page stays light. One page is a bounded set.
        include: { ...inventoryListInclude, _count: { select: { endpointMappings: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      prisma.linkSegment.count({ where }),
    ]);
    return {
      rows,
      total,
      page: Math.max(1, page),
      pageSize: take,
    };
  },

  listInventoryRowsUnfiltered: async () =>
    prisma.linkSegment.findMany({
      include: inventoryListInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),

  listInventoryRowsCursor: async (filters: InventoryFilters = {}, options: { cursor?: string | null; pageSize?: number } = {}) => {
    const where = inventoryWhere(filters);
    const take = Math.min(Math.max(options.pageSize ?? 250, 25), 1000);
    const rows = await prisma.linkSegment.findMany({
      where,
      include: inventoryListInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const pageRows = hasMore ? rows.slice(0, take) : rows;
    return {
      rows: pageRows,
      nextCursor: hasMore ? pageRows[pageRows.length - 1]?.id ?? null : null,
      pageSize: take,
    };
  },

  getById: async (id: string) =>
    prisma.linkSegment.findUnique({
      where: { id },
      include: {
        cable: true,
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
        fibers: { orderBy: { fiberNumber: "asc" } },
        serviceAllocations: { include: { service: true }, orderBy: { pathOrder: "asc" } },
        serviceRouteHops: { include: { serviceRoute: { include: { service: true } } } },
        endpointMappings: { orderBy: { createdAt: "asc" } },
      },
    }),

  getBySegmentCode: async (segmentCode: string) =>
    prisma.linkSegment.findUnique({
      where: { segmentCode },
      include: {
        cable: true,
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
        fibers: { orderBy: { fiberNumber: "asc" } },
        serviceAllocations: { include: { service: true }, orderBy: { pathOrder: "asc" } },
        serviceRouteHops: { include: { serviceRoute: { include: { service: true } } } },
        endpointMappings: { orderBy: { createdAt: "asc" } },
      },
    }),

  create: async (data: Parameters<typeof prisma.linkSegment.create>[0]["data"]) => prisma.linkSegment.create({ data }),

  update: async (id: string, data: Parameters<typeof prisma.linkSegment.update>[0]["data"]) =>
    prisma.linkSegment.update({ where: { id }, data }),
};
