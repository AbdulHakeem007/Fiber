import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { backupService } from "@/server/services/backup.service";

export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required to view database backups." }, { status: 403 });
  }
  return NextResponse.json(await backupService.listBackups());
}

export async function POST() {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to run database backups." }, { status: 403 });
    }

    const backup = await backupService.runBackup("manual admin trigger");
    await writeAuditLog({
      entityType: "Database",
      entityId: backup.fileName,
      action: "EXPORT",
      newValue: backup,
      changedById: session?.id ?? null,
      reason: "Manual database backup",
    });
    return NextResponse.json({ backup });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Database backup failed." }, { status: 500 });
  }
}
