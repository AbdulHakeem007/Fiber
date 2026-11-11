import { prisma } from "@/lib/db/prisma";

export const serviceRepository = {
  getTraceByServiceCode: async (serviceCode: string) =>
    prisma.service.findUnique({
      where: { serviceCode },
      include: {
        routes: {
          include: {
            allocations: {
              include: {
                segment: {
                  include: {
                    importBatch: { select: { sourceSystem: true } },
                    endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
                    endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
                    endpointMappings: true,
                    serviceAllocations: true,
                    fibers: true,
                  },
                },
                fromSite: true,
                toSite: true,
                endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
                endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
                fibers: { orderBy: { fiberNumber: "asc" } },
              },
              orderBy: { pathOrder: "asc" },
            },
            hops: {
              include: {
                site: true,
                rack: true,
                odf: true,
                portGroup: true,
                segment: {
                  include: {
                    importBatch: { select: { sourceSystem: true } },
                    endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
                    endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
                    endpointMappings: true,
                    serviceAllocations: true,
                    fibers: true,
                  },
                },
              },
              orderBy: { hopOrder: "asc" },
            },
          },
          orderBy: [{ isActive: "desc" }, { priority: "asc" }],
        },
      },
    }),
};
