import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { attachmentService } from "@/server/services/attachment.service";

// POST /api/admin/attachments/resync -> reconcile disk files with metadata rows.
// Reports metadata rows whose file is missing from disk, and orphan files on disk
// that have no metadata row. Admin-only utility; does not mutate anything.
export async function POST() {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Administrator access is required to resync attachments." }, { status: 403 });
    }
    const report = await attachmentService.resyncReport();
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Attachment resync failed." },
      { status: 400 },
    );
  }
}
