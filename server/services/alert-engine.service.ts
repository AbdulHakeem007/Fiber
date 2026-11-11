import { prisma } from "@/lib/db/prisma";
import { isClearedByHysteresis } from "@/lib/alerts/hysteresis";
import { isCooldownActive } from "@/lib/alerts/cooldown";
import { isSuppressed } from "@/lib/alerts/suppression";

export const alertEngineService = {
  async evaluateHighUtilizationPolicies() {
    const policies = await prisma.alertPolicy.findMany({
      where: {
        enabled: true,
        alertType: "HIGH_UTILIZATION",
      },
    });
    if (!policies.length) return;

    // Evaluate the latest reading for EVERY site pair. The previous take:200
    // cap silently skipped most of the network once metric history grew past
    // 200 rows (at 4,000 sites / 10,000 segments nearly everything was missed).
    const metricsDesc = await prisma.utilizationMetric.findMany({
      where: { metricType: "SITE_PAIR_UTILIZATION" },
      orderBy: { measuredAt: "desc" },
    });
    const latestPerSitePair = new Map<string, (typeof metricsDesc)[number]>();
    for (const metric of metricsDesc) {
      const key = metric.sitePairKey ?? metric.scopeSegmentId ?? metric.id;
      if (!latestPerSitePair.has(key)) latestPerSitePair.set(key, metric);
    }
    const latestMetrics = [...latestPerSitePair.values()];

    // Prefetch suppressions and open events once per run instead of issuing
    // two queries per policy×metric pair (the old N+1 pattern needed ~40k
    // queries per evaluation at enterprise densities).
    const policyIds = policies.map((policy) => policy.id);
    const [suppressions, openEvents] = await Promise.all([
      prisma.alertSuppression.findMany({
        where: { alertPolicyId: { in: policyIds } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.alertEvent.findMany({
        where: {
          alertPolicyId: { in: policyIds },
          state: { in: ["OPEN", "ACKNOWLEDGED", "SUPPRESSED"] },
        },
        orderBy: { lastSeenAt: "desc" },
      }),
    ]);

    const suppressionLookup = new Map<string, (typeof suppressions)[number]>();
    for (const suppression of suppressions) {
      for (const key of [suppression.sitePairKey, suppression.targetId]) {
        if (!key) continue;
        const mapKey = `${suppression.alertPolicyId}:${key}`;
        if (!suppressionLookup.has(mapKey)) suppressionLookup.set(mapKey, suppression);
      }
    }

    const eventLookup = new Map<string, (typeof openEvents)[number]>();
    for (const event of openEvents) {
      if (!event.sitePairKey) continue;
      const mapKey = `${event.alertPolicyId}:${event.sitePairKey}`;
      if (!eventLookup.has(mapKey)) eventLookup.set(mapKey, event);
    }

    for (const policy of policies) {
      for (const metric of latestMetrics) {
        const matchingSuppression =
          (metric.sitePairKey ? suppressionLookup.get(`${policy.id}:${metric.sitePairKey}`) : undefined) ??
          (metric.scopeSegmentId ? suppressionLookup.get(`${policy.id}:${metric.scopeSegmentId}`) : undefined) ??
          null;

        const suppressed = matchingSuppression
          ? isSuppressed(matchingSuppression.startsAt, matchingSuppression.endsAt)
          : false;

        const existing = metric.sitePairKey
          ? eventLookup.get(`${policy.id}:${metric.sitePairKey}`) ?? null
          : null;

        const critical = policy.criticalThresholdPct ?? 95;
        const warning = policy.warningThresholdPct ?? 85;

        if (metric.utilizationPct >= warning) {
          if (existing && isCooldownActive(existing.lastSeenAt, policy.cooldownMinutes)) continue;
          await prisma.alertEvent.create({
            data: {
              alertPolicyId: policy.id,
              alertType: "HIGH_UTILIZATION",
              severity: metric.utilizationPct >= critical ? "CRITICAL" : "WARNING",
              state: suppressed ? "SUPPRESSED" : "OPEN",
              metricId: metric.id,
              sitePairKey: metric.sitePairKey,
              suppressionId: matchingSuppression?.id,
              title: `High utilization on ${metric.sitePairKey}`,
              message: `Utilization ${metric.utilizationPct}%`,
              firstSeenAt: new Date(),
              lastSeenAt: new Date(),
            },
          });
        } else if (existing && isClearedByHysteresis(metric.utilizationPct, warning, policy.hysteresisPct)) {
          await prisma.alertEvent.update({
            where: { id: existing.id },
            data: { state: "CLEARED", clearedAt: new Date(), lastSeenAt: new Date() },
          });
        }
      }
    }
  },
};
