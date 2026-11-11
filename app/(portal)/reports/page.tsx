import { Activity } from "lucide-react";
import { ReportsCenter } from "@/components/reports/reports-center";
import { WorkerQueueWidget } from "@/components/dashboard/dashboard-telemetry";
import { ProvisioningFlow, type FlowStage } from "@/components/dashboard/dashboard-overview";
import { prisma } from "@/lib/db/prisma";
import { importBackgroundService } from "@/server/services/import-background.service";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * Reports tab. The Background Worker Queue and Provisioning Flow Matrix were
 * moved off the main dashboard and live here, as they are mainly needed during
 * early network migration phases.
 */
export default async function ReportsPage() {
  const session = await getSessionUser();
  const canSendReports = hasPermission(session?.roleCode, "inventoryWrite");
  const [importAgg, liveSegmentCount, openIssueCount, recipientAliases, templates] = await Promise.all([
    prisma.importBatch.aggregate({ _sum: { totalRows: true, validRows: true, warningRows: true, committedRows: true } }),
    prisma.linkSegment.count({ where: { status: { not: "DECOMMISSIONED" } } }),
    prisma.importIssue.count({ where: { resolved: false, severity: { in: ["WARNING", "ERROR", "CRITICAL"] } } }),
    // Recipient aliases (recipient groups) + predefined templates power the email-export modal.
    prisma.recipientGroup.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { code: true, name: true, members: { select: { email: true } } },
    }),
    prisma.notificationTemplate.findMany({
      where: { isActive: true, channel: "EMAIL" },
      orderBy: { name: "asc" },
      select: { code: true, name: true, subject: true, body: true },
    }),
  ]);

  const workerQueue = {
    ...importBackgroundService.queueSummary(),
    jobs: importBackgroundService.list(),
  };

  const flowStages: FlowStage[] = [
    { label: "Staged rows", count: importAgg._sum.totalRows ?? 0, tone: "neutral" },
    { label: "Validated", count: (importAgg._sum.validRows ?? 0) + (importAgg._sum.warningRows ?? 0), tone: "ready" },
    { label: "Committed", count: importAgg._sum.committedRows ?? 0, tone: "committed" },
    { label: "Live segments", count: liveSegmentCount, tone: "warning" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-500" />
            <div className="section-title">Provisioning Flow Matrix</div>
          </div>
          <div className="subtle mt-1">Ingestion lifecycle from staged rows to live segments — relevant during early network migration phases.</div>
          <div className="mt-4">
            <ProvisioningFlow stages={flowStages} backlog={openIssueCount} />
          </div>
        </div>
        <WorkerQueueWidget snapshot={workerQueue} />
      </div>
      <ReportsCenter recipientAliases={recipientAliases} templates={templates} canSendReports={canSendReports} />
    </div>
  );
}
