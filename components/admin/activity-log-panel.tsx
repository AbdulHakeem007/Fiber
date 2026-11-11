import { Download } from "lucide-react";
import { prisma } from "@/lib/db/prisma";
import { LOG_RETENTION_MONTHS, LOG_VIEW_DAYS, logViewCutoff } from "@/lib/config/log-retention";

/**
 * Online activity panel. Per the retention policy it only queries the most
 * recent {LOG_VIEW_DAYS} days so the page load stays bounded, while the full
 * {LOG_RETENTION_MONTHS}-month ledger stays exportable via the button below.
 */
export async function ActivityLogPanel() {
  const cutoff = logViewCutoff();
  const logs = await prisma.auditLog.findMany({
    where: { createdAt: { gte: cutoff } },
    include: { changedBy: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-title">Activity Logs</div>
          <div className="subtle mt-1">
            Showing the most recent {LOG_VIEW_DAYS} days of system activity. The full {LOG_RETENTION_MONTHS}-month
            ledger is retained in storage and available via Export Logs.
          </div>
        </div>
        <a
          className="btn btn-primary"
          href="/api/export?type=audit-logs&format=csv"
          // Streams the full retained ledger as a row-delimited CSV. CSV has no
          // per-cell length ceiling, so large old/new-value diagnostic payloads
          // export intact instead of tripping Excel's 32,767-char cell limit.
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export Logs
        </a>
      </div>
      <div className="table-shell mt-4 max-h-[520px] overflow-auto">
        <table className="min-w-[920px]">
          <thead>
            <tr>
              <th>When</th>
              <th>Operator</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Field</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{log.createdAt.toLocaleString()}</td>
                <td>{log.changedBy?.name ?? log.changedBy?.email ?? "System"}</td>
                <td>{log.action}</td>
                <td>{log.entityType} · {log.entityId}</td>
                <td>{log.fieldName ?? "-"}</td>
                <td>
                  {log.fieldName
                    ? `${log.oldValue ?? "-"} → ${log.newValue ?? "-"}`
                    : log.comment ?? log.reason ?? "-"}
                </td>
              </tr>
            ))}
            {!logs.length ? (
              <tr><td colSpan={6}>No activity recorded in the last {LOG_VIEW_DAYS} days.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
