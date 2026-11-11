import { NotificationSettings } from "@/components/admin/notification-settings";
import { WeeklyReportsSettings, type WeeklyScheduleRow } from "@/components/admin/weekly-reports-settings";
import { InventoryWriteOff } from "@/components/admin/inventory-writeoff";
import { adminService } from "@/server/services/admin.service";
import { weeklyReportService } from "@/server/services/weekly-report.service";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";

export default async function AdminNotificationsPage() {
  const [settings, schedules, session] = await Promise.all([
    adminService.getNotificationSettings(),
    weeklyReportService.listSchedules(),
    getSessionUser(),
  ]);

  // Expose only the active MEGA_ALERT schedule to the admin UI.
  // The four deprecated individual schedules are force-disabled by ensureDefaults()
  // and are not displayed — admins cannot re-enable them from this panel.
  const weeklyRows: WeeklyScheduleRow[] = schedules
    .filter((schedule) => schedule.reportKey === "MEGA_ALERT")
    .map((schedule) => ({
      reportKey: schedule.reportKey,
      name: schedule.name,
      enabled: schedule.enabled,
      dayOfWeek: schedule.dayOfWeek,
      sendHour: schedule.sendHour,
      sendMinute: schedule.sendMinute,
      warnThresholdPct: schedule.warnThresholdPct,
      critThresholdPct: schedule.critThresholdPct,
      minNodes: schedule.minNodes,
      recipients: schedule.recipients,
      recipientGroupCode: schedule.recipientGroupCode,
      includeConfigured: schedule.includeConfigured,
      emailSubject: schedule.emailSubject ?? null,
      emailBody: schedule.emailBody ?? null,
      lastSentAt: schedule.lastSentAt ? schedule.lastSentAt.toISOString() : null,
      lastStatus: schedule.lastStatus,
    }));

  const canSend = hasPermission(session?.roleCode, "inventoryWrite");
  const canPurge = hasPermission(session?.roleCode, "adminManage");

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">SMTP, Templates, Recipients</div>
        <div className="subtle mt-1">Email is live when SMTP is configured. SMS and mobile channels are modeled for future integration and clearly marked as readiness only.</div>
      </div>
      <NotificationSettings
        smtp={settings.smtp}
        templates={settings.templates}
        deploymentTemplates={settings.deploymentTemplates}
        recipientGroups={settings.recipientGroups}
      />
      <WeeklyReportsSettings
        schedules={weeklyRows}
        recipientGroups={settings.recipientGroups.map((group) => ({ code: group.code, name: group.name }))}
        canSend={canSend}
      />
      {canPurge ? <InventoryWriteOff /> : null}
      <div className="card p-5">
        <div className="section-title">Recent Notification Logs</div>
        <div className="table-shell mt-4">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Channel</th>
                <th>Recipient</th>
                <th>Status</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {settings.notificationLogs.map((log) => (
                <tr key={log.id}>
                  <td>{log.createdAt.toLocaleString()}</td>
                  <td>{log.channel}</td>
                  <td>{log.recipient}</td>
                  <td>{log.status}</td>
                  <td>{log.subject ?? "-"}</td>
                </tr>
              ))}
              {!settings.notificationLogs.length ? (
                <tr><td colSpan={5}>No notification events have been logged yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
