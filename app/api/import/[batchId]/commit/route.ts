import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { importService } from "@/server/services/import.service";

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await params;
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to commit inventory." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const result = await importService.commitBatch(batchId, session!.id, {
      sheetName: typeof body.sheetName === "string" && body.sheetName.trim() ? body.sheetName.trim() : null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import commit failed." },
      { status: 500 },
    );
  }
}
