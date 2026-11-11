import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { pendingDeletionService } from "@/server/services/pending-deletion.service";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to delete inventory mappings." }, { status: 403 });
    }

    const body = await request.json();
    const ids: string[] = Array.isArray(body.ids)
      ? Array.from(new Set<string>(body.ids.map((id: unknown) => String(id)).filter((id: string) => Boolean(id))))
      : [];
    if (!ids.length) {
      return NextResponse.json({ error: "No inventory mappings selected." }, { status: 400 });
    }

    // Delayed deletion: the selection is parked on a 24 working-hour hold (GCC
    // calendar — weekends/holidays pause the countdown) instead of purging
    // immediately. Two adjacent segments sharing one transit site purge as a
    // Reverse Split (shared site removed, outer endpoints stitched together).
    const result = await pendingDeletionService.markSegmentsForDeletion(ids, session?.id);
    const scheduledCount = result.holds.length + result.alreadyHeld.length;
    const reverseSplitNote = result.mergeTopology && result.sharedSiteCode
      ? ` The two adjacent segments will be merged by removing shared site ${result.sharedSiteCode} (Reverse Split) once the hold expires.`
      : "";

    return NextResponse.json(
      {
        pending: true,
        holds: [...result.holds, ...result.alreadyHeld],
        mergeTopology: result.mergeTopology,
        sharedSiteCode: result.sharedSiteCode,
        deletedIds: [],
        deletedCount: 0,
        retiredCount: 0,
        mergedRow: null,
        message: `${scheduledCount} ODF Mapping row(s) scheduled for deletion. You can undo for the next 24 working hours.${reverseSplitNote}`,
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk delete failed." },
      { status: 500 },
    );
  }
}
