import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { inventoryResetService } from "@/server/services/inventory-reset.service";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to reset live inventory." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const result = await inventoryResetService.resetLiveInventory({
      requestedById: session!.id,
      confirmation: typeof body.confirmation === "string" ? body.confirmation : "",
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Live inventory reset failed." },
      { status: 400 },
    );
  }
}
