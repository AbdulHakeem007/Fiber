import { NextResponse } from "next/server";
import { serviceAllocationService } from "@/server/services/service-allocation.service";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";

export async function POST(request: Request) {
  try {
    // Authorization: service allocation mutates inventory, so it must require
    // inventoryWrite — like every other mutation route. Middleware only proves
    // the caller is logged in (valid session signature); it does NOT enforce
    // role, so without this check any authenticated read-only user could
    // allocate services (broken access control / privilege escalation).
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json(
        { error: "Read/write inventory access is required to allocate services." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const result = await serviceAllocationService.allocate({
      pathInput: String(body.pathInput ?? body.path ?? ""),
      serviceCode: typeof body.serviceCode === "string" ? body.serviceCode : null,
      serviceName: typeof body.serviceName === "string" ? body.serviceName : null,
      // Audit trail: stamp the real allocator (username + id) so allocation
      // comments and the audit log attribute the action to this user.
      actor: { id: session?.id ?? null, name: session?.name ?? session?.email ?? null },
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Service allocation failed." },
      { status: 400 },
    );
  }
}
