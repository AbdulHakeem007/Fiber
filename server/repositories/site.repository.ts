import { prisma } from "@/lib/db/prisma";

export const siteRepository = {
  listSummary: async () =>
    prisma.site.findMany({
      orderBy: { code: "asc" },
      include: {
        criticalityTags: { include: { tag: true } },
        _count: {
          select: {
            racks: true,
            odfs: true,
            portGroups: true,
            segmentEndpoints: true,
          },
        },
      },
    }),

  getByCode: async (code: string) =>
    prisma.site.findUnique({
      where: { code },
      include: {
        racks: { include: { odfs: true } },
        aliases: true,
        criticalityTags: { include: { tag: true } },
      },
    }),

  listSegmentsForSite: async (siteId: string) =>
    prisma.linkSegment.findMany({
      where: {
        AND: [
          { OR: [{ endpointA: { siteId } }, { endpointB: { siteId } }] },
          ...(process.env.FEATURE_DEMO_DATA === "true" ? [] : [{ NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }]),
        ],
      },
      include: {
        cable: true,
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
        serviceRouteHops: { include: { serviceRoute: { include: { service: true } } } },
      },
    }),
};
