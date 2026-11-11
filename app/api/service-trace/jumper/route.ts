import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { serviceTraceService } from "@/server/services/service-trace.service";

// Retroactive jumper marking from the Service Trace canvas. The operator clicks
// a rendered site node and toggles it as a passive jumper for the active service
// chain; the mutation is written back to the ODF mapping rows that touch the
// site, then the client re-fetches the trace to repaint the topology.
export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json(
        { error: "Read/write inventory access is required to mark a site as a jumper." },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const serviceCode = String(body.serviceCode ?? body.service ?? "").trim();
    const siteCode = String(body.siteCode ?? body.site ?? "").trim();
    const isJumper = body.isJumper !== false; // default to marking unless explicitly cleared

    if (!serviceCode) return NextResponse.json({ error: "A Service ID is required." }, { status: 400 });
    if (!siteCode) return NextResponse.json({ error: "Select a site node to mark as a jumper." }, { status: 400 });

    const result = await serviceTraceService.markSiteAsJumper(serviceCode, siteCode, isJumper, session?.id ?? null);
    const trace = await serviceTraceService.getTrace(serviceCode);

    return NextResponse.json({
      message: `${isJumper ? "Marked" : "Cleared"} ${siteCode} as a jumper on ${result.updated} mapping row(s).`,
      updated: result.updated,
      isJumper,
      trace,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update jumper marking." },
      { status: 400 },
    );
  }
}
