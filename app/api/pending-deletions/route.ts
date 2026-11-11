import { NextResponse } from "next/server";
import { PendingDeletionEntityType } from "@prisma/client";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { pendingDeletionService } from "@/server/services/pending-deletion.service";

/**
 * Lists the PENDING soft-delete holds (24 working-hour reversal windows) and
 * lazily sweeps any hold whose window has fully elapsed. Every page that shows
 * an "Undo Delete (Xh Ym remaining)" countdown polls this endpoint, so expired
 * holds are purged even without a dedicated background worker.
 */
export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryRead")) {
      return NextResponse.json({ error: "A valid portal session is required." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const rawType = String(searchParams.get("entityType") ?? "").toUpperCase();
    const entityType = rawType === "ODF" || rawType === "SEGMENT"
      ? (rawType as PendingDeletionEntityType)
      : undefined;

    const result = await pendingDeletionService.listPending(entityType);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load scheduled deletions." },
      { status: 500 },
    );
  }
}
