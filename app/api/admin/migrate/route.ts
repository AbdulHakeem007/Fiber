import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { dataMigrationService } from "@/server/services/data-migration.service";

export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required to view migration status." }, { status: 403 });
  }
  return NextResponse.json({ job: dataMigrationService.get() });
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to run the data migration." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const inputWorkbook = typeof body.inputWorkbook === "string" ? body.inputWorkbook : null;

    // start() takes a verified backup BEFORE launching the Python migration.
    const job = await dataMigrationService.start({
      inputWorkbook,
      triggeredBy: session?.name ?? session?.email ?? session?.id ?? null,
    });

    await writeAuditLog({
      entityType: "DataMigration",
      entityId: job.backup?.fileName ?? "migration",
      action: "IMPORT",
      newValue: {
        state: job.state,
        backup: job.backup?.fileName ?? null,
        backupVerified: job.backupVerified,
        inputWorkbook: job.inputWorkbook,
        error: job.error,
      },
      changedById: session?.id ?? null,
      reason: "Admin Python data migration trigger (backup-guarded)",
    });

    // A failed guardrail (backup or input validation) is a client-actionable 400.
    return NextResponse.json({ job }, { status: job.state === "FAILED" ? 400 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Migration trigger failed." }, { status: 500 });
  }
}
