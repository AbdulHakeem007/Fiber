import { AlertPolicyEditor } from "@/components/admin/alert-policy-editor";
import { TopologyDefinitionsEditor } from "@/components/admin/topology-definitions-editor";
import { adminService } from "@/server/services/admin.service";
import { prisma } from "@/lib/db/prisma";
import { getTopologyDefinitions } from "@/lib/telecom/alert-definitions-db";

export default async function AdminAlertPoliciesPage() {
  // First-run bootstrap so the page always has policies to manage/suspend.
  await adminService.ensureDefaultAlertPolicies();
  const [policies, definitions, dispatchLogs] = await Promise.all([
    adminService.listPolicies(),
    getTopologyDefinitions(),
    // Automated alert dispatch history: EMAIL notification logs that are not
    // ad-hoc exports or SMTP tests (i.e. alert + scheduled-report emails).
    prisma.notificationLog.findMany({
      where: {
        channel: "EMAIL",
        NOT: [
          { metadataJson: { contains: "exportType" } },
          { metadataJson: { contains: "SMTP_TEST" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return (
    <div className="space-y-6">
      <AlertPolicyEditor
        rows={policies.map((policy) => ({
          id: policy.id,
          name: policy.name,
          alertType: policy.alertType,
          enabled: policy.enabled,
          warningThresholdPct: policy.warningThresholdPct,
          criticalThresholdPct: policy.criticalThresholdPct,
          cooldownMinutes: policy.cooldownMinutes,
          consecutiveHits: policy.consecutiveHits,
          notifyEmails: policy.notifyEmails,
        }))}
      />

      <TopologyDefinitionsEditor definitions={definitions} />

      <div className="card p-5">
        <div className="section-title">Automated alert dispatch history</div>
        <div className="subtle mt-1">Historical timestamps of when automated alert emails were actually dispatched to recipients.</div>
        <div className="table-shell mt-4">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Recipient</th>
                <th>Status</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {dispatchLogs.map((log) => (
                <tr key={log.id}>
                  <td>{log.createdAt.toLocaleString()}</td>
                  <td>{log.recipient}</td>
                  <td>{log.status}</td>
                  <td>{log.subject ?? "-"}</td>
                </tr>
              ))}
              {!dispatchLogs.length ? (
                <tr><td colSpan={4}>No automated alert dispatches have been recorded yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
