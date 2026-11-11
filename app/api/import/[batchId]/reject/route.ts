import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { importService } from "@/server/services/import.service";

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await params;
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to reject staged rows." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const rowIds = Array.isArray(body.rowIds) ? body.rowIds.filter((value: unknown) => typeof value === "string") : [];
    const result = await importService.rejectRows(batchId, session!.id, {
      rowIds,
      reviewerComment: typeof body.reviewerComment === "string" ? body.reviewerComment : null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import row rejection failed." },
      { status: 500 },
    );
  }
}
