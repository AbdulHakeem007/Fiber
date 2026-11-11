import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { pendingDeletionService } from "@/server/services/pending-deletion.service";

/** Reverses a scheduled deletion while its 24 working-hour hold is still open. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "childLinkDelete")) {
      return NextResponse.json({ error: "Read/write or admin access is required to undo a scheduled deletion." }, { status: 403 });
    }

    const { id } = await params;
    const result = await pendingDeletionService.undoPendingDeletion(id, session?.id);
    return NextResponse.json({
      undone: result.undone,
      message: `Scheduled deletion of ${result.entityLabel ?? "the selected record"} was undone.`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Undo failed." },
      { status: 400 },
    );
  }
}
