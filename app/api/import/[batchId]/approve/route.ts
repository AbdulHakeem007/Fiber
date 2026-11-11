import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { importService } from "@/server/services/import.service";
import { importBackgroundService } from "@/server/services/import-background.service";

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await params;
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to approve staged rows." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const sharedOptions = {
      rowIds: Array.isArray(body.rowIds) ? body.rowIds.filter((value: unknown) => typeof value === "string") : undefined,
      sheetName: typeof body.sheetName === "string" && body.sheetName.trim() ? body.sheetName.trim() : null,
      approveCleanOnly: body.approveCleanOnly !== false,
      reviewerComment: typeof body.reviewerComment === "string" ? body.reviewerComment : null,
    };

    // Asynchronous batching mode: the whole upload is approved in one click,
    // the server walks the batch in resumable windows, and the operator is
    // free to navigate the portal while the commit completes.
    if (body.background === true) {
      const job = importBackgroundService.start(batchId, session!.id, sharedOptions);
      return NextResponse.json({ backgroundJob: job }, { status: 202 });
    }

    const result = await importService.approveBatchRows(batchId, session!.id, {
      ...sharedOptions,
      maxRows: Number.isInteger(body.maxRows) && body.maxRows > 0 ? body.maxRows : undefined,
      afterRowNumber: Number.isInteger(body.afterRowNumber) && body.afterRowNumber >= 0 ? body.afterRowNumber : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import approval failed." },
      { status: 500 },
    );
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await params;
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to read commit progress." }, { status: 403 });
    }
    return NextResponse.json({ backgroundJob: importBackgroundService.get(batchId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Commit progress lookup failed." },
      { status: 500 },
    );
  }
}
