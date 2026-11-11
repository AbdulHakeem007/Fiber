import { prisma } from "@/lib/db/prisma";
import { matchesRegionPrefix } from "@/lib/config/regions";

export const alertRepository = {
  listOpenAlerts: async (regionPrefix?: string | null) => {
    const alerts = await prisma.alertEvent.findMany({
      where: { state: { in: ["OPEN", "ACKNOWLEDGED", "SUPPRESSED"] } },
      include: {
        segment: {
          include: {
            endpointA: { include: { site: true } },
            endpointB: { include: { site: true } },
          },
        },
        site: true,
      },
      orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
      take: 100,
    });
    return regionPrefix
      ? alerts.filter((alert) =>
          matchesRegionPrefix(alert.site?.code, regionPrefix) ||
          matchesRegionPrefix(alert.segment?.endpointA.site?.code, regionPrefix) ||
          matchesRegionPrefix(alert.segment?.endpointB.site?.code, regionPrefix),
        )
      : alerts;
  },
  listPolicies: async () => prisma.alertPolicy.findMany({ orderBy: { name: "asc" } }),
};
