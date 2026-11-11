import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { manualSegmentService } from "@/server/services/manual-segment.service";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to create mappings." }, { status: 403 });
    }

    const body = await request.json();
    const endpointA = body.endpointA ?? {};
    const endpointB = body.endpointB ?? {};
    // Full physical identity is required on both ends: Site + Rack + ODF + Port.
    // A mapping is only created when a clear direction (near -> far) is given, so
    // the far end must be fully specified too, including its port.
    const required = [
      ["Near site", endpointA.rawSiteCode],
      ["Near rack", endpointA.rawRackCode],
      ["Near ODF", endpointA.rawOdfCode],
      ["Near port", endpointA.rawPortText],
      ["Far site", endpointB.rawSiteCode],
      ["Far rack", endpointB.rawRackCode],
      ["Far ODF", endpointB.rawOdfCode],
      ["Far port", endpointB.rawPortText],
    ];
    const missing = required.filter(([, value]) => !String(value ?? "").trim()).map(([label]) => label);
    if (missing.length) {
      return NextResponse.json({ error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for manual mapping.` }, { status: 400 });
    }

    const row = await manualSegmentService.create(
      {
        ...body,
        childUnitMode: body.childUnitMode === "SINGLE" ? "SINGLE" : "PAIR",
        endpointA,
        endpointB,
      },
      session?.id,
    );
    return NextResponse.json({ row }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Manual mapping creation failed." },
      { status: 500 },
    );
  }
}
