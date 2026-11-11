import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { weeklyReportService } from "@/server/services/weekly-report.service";
import { isWeeklyReportKey } from "@/lib/reports/report-meta";

/**
 * Manual "send now" for a weekly alert report. Available to admin + manager
 * (READ_WRITE) tiers — the same privileged levels allowed to write inventory.
 *
 * Body: { reportKey: string, recipients?: string[] }
 *   recipients overrides the schedule's configured recipient list when provided.
 */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "inventoryWrite")) {
    return NextResponse.json({ error: "Write access is required to send reports." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const reportKey = String(body.reportKey ?? "");
  if (!isWeeklyReportKey(reportKey)) {
    return NextResponse.json({ error: "Unknown report key." }, { status: 400 });
  }
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((value: unknown) => String(value).trim()).filter(Boolean)
    : undefined;

  try {
    const result = await weeklyReportService.sendReport(reportKey, {
      recipients,
      trigger: "manual",
      userId: session?.id ?? null,
    });
    const message =
      result.status === "SENT"
        ? `Report sent to ${result.recipients.length} recipient(s).`
        : result.status === "NO_RECIPIENTS"
          ? "No recipients configured for this report. Add recipients in the schedule or pass them explicitly."
          : result.status === "NOT_CONFIGURED"
            ? "Report was logged because SMTP is not configured."
            : `Report send failed: ${result.error ?? "unknown error"}.`;
    return NextResponse.json({ ...result, message });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Weekly report send failed." },
      { status: 500 },
    );
  }
}
