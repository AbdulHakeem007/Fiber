import { prisma } from "@/lib/db/prisma";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";

export const utilizationService = {
  async recalculateSitePairMetrics() {
    const segments = await prisma.linkSegment.findMany({
      include: {
        fibers: true,
      },
    });

    const grouped = new Map<string, Array<{ status: string }>>();

    for (const segment of segments) {
      await prisma.$transaction((tx) => segmentCapacityService.refreshSegmentCapacity(tx, segment.id));
      const arr = grouped.get(segment.sitePairKey) ?? [];
      for (const fiber of segment.fibers) arr.push({ status: fiber.status });
      grouped.set(segment.sitePairKey, arr);
    }

    const measuredAt = new Date();
    for (const [sitePairKey, groups] of grouped.entries()) {
      const totalGroups = groups.length;
      const usedGroups = groups.filter((group) => ["ACTIVE", "USED"].includes(group.status)).length;
      const spareGroups = groups.filter((group) => group.status === "AVAILABLE" || group.status === "SPARE" || group.status === "ACTIVE").length;
      const reservedGroups = groups.filter((group) => group.status === "RESERVED").length;
      const faultyGroups = groups.filter((group) => group.status === "FAULTY").length;
      const denominator = Math.max(1, totalGroups - faultyGroups);
      const utilizationPct = Math.round(((usedGroups + reservedGroups) / denominator) * 1000) / 10;
      await prisma.utilizationMetric.create({
        data: {
          metricType: "SITE_PAIR_UTILIZATION",
          sitePairKey,
          totalGroups,
          usedGroups,
          spareGroups,
          reservedGroups,
          faultyGroups,
          utilizationPct,
          denominatorNote: "Fiber-level metric; faulty fibers excluded from denominator",
          measuredAt,
          source: "SYSTEM",
        },
      });
    }
  },
};
