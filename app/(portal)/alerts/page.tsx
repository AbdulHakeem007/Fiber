import { AlertsConsole } from "@/components/alerts/alerts-console";
import { alertRepository } from "@/server/repositories/alert.repository";

export default async function AlertsPage({ searchParams }: { searchParams?: Promise<{ regionPrefix?: string }> }) {
  const params = await searchParams;
  const alerts = await alertRepository.listOpenAlerts(params?.regionPrefix);

  return (
    <AlertsConsole
      initialRows={alerts.map((alert) => ({
        id: alert.id,
        title: alert.title,
        severity: alert.severity,
        state: alert.state,
        scopeLabel: alert.sitePairKey ?? alert.siteId ?? alert.linkSegmentId ?? "GLOBAL",
        lastSeenAt: alert.lastSeenAt.toISOString(),
      }))}
    />
  );
}
