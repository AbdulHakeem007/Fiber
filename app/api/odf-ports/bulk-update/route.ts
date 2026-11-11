import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { odfPortService } from "@/server/services/odf-port.service";

function optionalNumber(value: unknown): number | null {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to add ODF inventory." }, { status: 403 });
    }

    const body = await request.json();
    const result = await odfPortService.configureInventory({
      siteCode: String(body.siteCode ?? ""),
      siteName: typeof body.siteName === "string" ? body.siteName : null,
      rackCode: String(body.rackCode ?? ""),
      odfCode: String(body.odfCode ?? ""),
      totalPorts: optionalNumber(body.totalPorts),
      terminatedStartPort: optionalNumber(body.terminatedStartPort),
      terminatedEndPort: optionalNumber(body.terminatedEndPort),
      dummyStartPort: optionalNumber(body.dummyStartPort),
      dummyEndPort: optionalNumber(body.dummyEndPort),
      remarks: typeof body.remarks === "string" ? body.remarks : null,
    }, session?.id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk ODF inventory add failed." },
      { status: 400 },
    );
  }
}

function parsePortList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0);
  }
  // Also accept "1,3,5-8" range text for convenience / fast bulk selection.
  const ports = new Set<number>();
  for (const part of String(value ?? "").split(",")) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    for (let port = Math.min(start, end); port <= Math.max(start, end); port += 1) ports.add(port);
  }
  return [...ports];
}

// Manual DARK_STUB block/unblock for individual ODF ports.
export async function PUT(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to block ODF ports." }, { status: 403 });
    }

    const body = await request.json();
    const result = await odfPortService.setPortBlock({
      siteCode: String(body.siteCode ?? ""),
      rackCode: String(body.rackCode ?? ""),
      odfCode: String(body.odfCode ?? ""),
      ports: parsePortList(body.ports),
      blocked: body.blocked !== false,
      reason: typeof body.reason === "string" ? body.reason : null,
    }, session?.id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ODF port block update failed." },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to update ODF ports." }, { status: 403 });
    }

    const body = await request.json();
    const result = await odfPortService.bulkUpdate({
      siteCode: String(body.siteCode ?? ""),
      rackCode: String(body.rackCode ?? ""),
      odfCode: String(body.odfCode ?? ""),
      ranges: String(body.ranges ?? ""),
      status: typeof body.status === "string" ? body.status : undefined,
      remarks: typeof body.remarks === "string" ? body.remarks : null,
      tubeNumber: optionalNumber(body.tubeNumber),
      tubeColor: typeof body.tubeColor === "string" ? body.tubeColor : null,
      fiberPortStart: optionalNumber(body.fiberPortStart),
    }, session?.id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ODF port update failed." },
      { status: 400 },
    );
  }
}
