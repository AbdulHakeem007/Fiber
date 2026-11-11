import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";

// POST /api/admin/recalculate-capacity
//   { segmentId }  -> targeted single-segment recompute (the "dynamic
//                     recalculation" trigger; requires inventory write).
//   {}             -> network-wide drift-correction backfill (requires admin).
// Recomputes the cached LinkSegment capacity counters from the authoritative
// child ODF-mapping rows. Read-correcting only; never creates fibers.
export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    const body = await request.json().catch(() => ({}));
    const segmentId = String(body.segmentId ?? "").trim();

    if (segmentId) {
      if (!hasPermission(session?.roleCode, "inventoryWrite")) {
        return NextResponse.json({ error: "Read/write access is required to recalculate a segment." }, { status: 403 });
      }
      const segment = await segmentCapacityService.recalculateSegment(segmentId);
      return NextResponse.json({
        success: true,
        scope: "segment",
        segmentId,
        segmentCode: segment.segmentCode,
        totalFiberCapacity: segment.totalFiberCapacity,
        usedFiberCount: segment.usedFiberCount,
        availableFiberCount: segment.availableFiberCount,
        utilizationPct: segment.utilizationPct,
      });
    }

    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to run the network-wide capacity backfill." }, { status: 403 });
    }
    const result = await segmentCapacityService.backfillAllSegmentCapacity({
      includeDecommissioned: Boolean(body.includeDecommissioned),
    });
    return NextResponse.json({ success: true, scope: "all", ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Capacity recalculation failed." }, { status: 500 });
  }
}
