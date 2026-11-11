import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { intermediateSiteService, MappedFiberConflictError } from "@/server/services/intermediate-site.service";

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ segmentId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to split segments." }, { status: 403 });
    }

    const { segmentId } = await params;
    const body = await request.json();
    const result = await intermediateSiteService.splitSegment(segmentId, {
      mode: body.mode,
      insertedSite: body.insertedSite,
      insertedNearRack: body.insertedNearRack,
      insertedNearOdf: body.insertedNearOdf,
      insertedNearPortGroup: body.insertedNearPortGroup,
      insertedFarRack: body.insertedFarRack,
      insertedFarOdf: body.insertedFarOdf,
      insertedFarPortGroup: body.insertedFarPortGroup,
      selectedFiberNumbers: Array.isArray(body.selectedFiberNumbers) ? body.selectedFiberNumbers : [],
      selectedMappingIds: Array.isArray(body.selectedMappingIds) ? body.selectedMappingIds.map(String).filter(Boolean) : [],
      distanceKmNear: optionalNumber(body.distanceKmNear),
      distanceKmFar: optionalNumber(body.distanceKmFar),
      comments: typeof body.comments === "string" ? body.comments : null,
      overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : null,
      acknowledgeMappedConflict: body.acknowledgeMappedConflict === true,
    }, session?.id);

    return NextResponse.json(result);
  } catch (error) {
    // Pre-split infrastructure mapping warning: confirmable, not a failure.
    if (error instanceof MappedFiberConflictError) {
      return NextResponse.json(
        { requiresAcknowledgement: true, warning: error.message, conflictSites: error.conflictSites },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Segment split failed." },
      { status: 400 },
    );
  }
}
