import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { segmentUpgradeService } from "@/server/services/segment-upgrade.service";

export async function GET(_request: Request, { params }: { params: Promise<{ segmentId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to upgrade capacity." }, { status: 403 });
    }
    const { segmentId } = await params;
    return NextResponse.json(await segmentUpgradeService.getContext(segmentId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load upgrade context." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ segmentId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to upgrade capacity." }, { status: 403 });
    }
    const { segmentId } = await params;
    const body = await request.json();
    const result = await segmentUpgradeService.upgradeCapacity(
      segmentId,
      { nearPorts: typeof body.nearPorts === "string" ? body.nearPorts : null, farPorts: typeof body.farPorts === "string" ? body.farPorts : null },
      session?.id,
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Capacity upgrade failed." },
      { status: 400 },
    );
  }
}
