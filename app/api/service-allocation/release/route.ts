import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { serviceAllocationService } from "@/server/services/service-allocation.service";

// POST /api/service-allocation/release -> release a service by its Service ID.
// Purges the service record, frees its ports/fibers (Active -> Available), and
// stamps the release comment on every child ODF mapping link.
export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write access is required to release a service." }, { status: 403 });
    }
    const body = await request.json().catch(() => ({}));
    const serviceCode = String(body.serviceCode ?? body.service ?? "").trim();
    if (!serviceCode) {
      return NextResponse.json({ error: "A Service ID is required." }, { status: 400 });
    }
    const result = await serviceAllocationService.releaseService(serviceCode, {
      id: session?.id ?? null,
      name: session?.name ?? session?.email ?? null,
    });
    return NextResponse.json({
      message: `Released ${result.serviceCode}: ${result.releasedChildLinks} child link(s) freed${result.purgedService ? " and the service record was purged." : "."}`,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Service release failed." },
      { status: 400 },
    );
  }
}
