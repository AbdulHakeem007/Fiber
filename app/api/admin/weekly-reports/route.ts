import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { weeklyReportService } from "@/server/services/weekly-report.service";
import { writeAuditLog } from "@/lib/audit/audit-log";

/**
 * Admin management of the Mega Alert weekly schedule.
 *   GET  → list all schedules (creates MEGA_ALERT default on first call).
 *   POST → upsert one schedule. Body: { reportKey, enabled, dayOfWeek, sendHour,
 *          sendMinute, warnThresholdPct?, critThresholdPct?, minNodes?, recipients?,
 *          recipientGroupCode?, includeConfigured?, emailSubject?, emailBody? }
 */
export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const schedules = await weeklyReportService.listSchedules();
  return NextResponse.json({ schedules });
}

export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const body = await request.json();
    const schedule = await weeklyReportService.saveSchedule(body);
    await writeAuditLog({
      entityType: "WeeklyReportSchedule",
      entityId: schedule.reportKey,
      action: "UPDATE",
      changedById: session?.id ?? null,
      reason: "Weekly report schedule updated.",
      newValue: {
        enabled: schedule.enabled,
        dayOfWeek: schedule.dayOfWeek,
        sendHour: schedule.sendHour,
        sendMinute: schedule.sendMinute,
        warnThresholdPct: schedule.warnThresholdPct,
        critThresholdPct: schedule.critThresholdPct,
        minNodes: schedule.minNodes,
        includeConfigured: schedule.includeConfigured,
        emailSubject: schedule.emailSubject ?? null,
        emailBody: schedule.emailBody != null ? "[configured]" : null,
      },
    });
    return NextResponse.json({ schedule });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Weekly report schedule update failed." },
      { status: 400 },
    );
  }
}
