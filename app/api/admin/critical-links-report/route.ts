import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { criticalLinksReportService } from "@/server/services/critical-links-report.service";

/**
 * Manual trigger + preview for the weekly Critical Links email report.
 *
 *   GET  → preview: how many critical links exist right now (no email sent).
 *   POST → send the report immediately. Body (optional):
 *            { "recipients": ["ops@example.com"] }  // overrides configured list
 *
 * Test instantly:
 *   curl -X POST http://localhost:3000/api/admin/critical-links-report \
 *        -H "Content-Type: application/json" \
 *        -b "fiber_inventory_session=<your-session-cookie>" \
 *        -d '{"recipients":["you@example.com"]}'
 */
export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const links = await criticalLinksReportService.getCriticalLinks();
  return NextResponse.json({
    criticalLinkCount: links.length,
    sample: links.slice(0, 10).map((link) => ({
      segmentCode: link.segmentCode,
      utilizationPct: link.utilizationPct,
      faultyFiberCount: link.faultyFiberCount,
      status: link.status,
    })),
  });
}

export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((value: unknown) => String(value).trim()).filter(Boolean)
    : undefined;

  const result = await criticalLinksReportService.sendCriticalLinksReport({
    recipients,
    trigger: "manual",
    userId: session?.id ?? null,
  });
  return NextResponse.json(result);
}
