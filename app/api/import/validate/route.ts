import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { importService } from "@/server/services/import.service";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to validate workbooks." }, { status: 403 });
    }

    const body = (await request.json()) as { batchId?: string };
    if (!body.batchId) {
      return NextResponse.json({ error: "Missing batchId." }, { status: 400 });
    }

    const result = await importService.validateBatch(body.batchId);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import validation failed." },
      { status: 500 },
    );
  }
}
