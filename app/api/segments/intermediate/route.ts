import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { intermediateSiteService } from "@/server/services/intermediate-site.service";

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function optionalString(value: unknown): string | null {
  const text = str(value).trim();
  return text ? text : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const VALID_MODES = new Set(["FULL_SPLIT", "PARTIAL_BRANCH", "STUB_INTERCEPT"]);

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required for intermediate-site changes." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "A JSON body describing the intermediate-site change is required." }, { status: 400 });
    }

    const mode = str(body.mode).trim().toUpperCase();
    if (!VALID_MODES.has(mode)) {
      return NextResponse.json(
        { error: "mode must be one of FULL_SPLIT (full termination), PARTIAL_BRANCH (branch breakout), or STUB_INTERCEPT (dead-end stub)." },
        { status: 400 },
      );
    }

    const result = await intermediateSiteService.apply(
      {
        mode: mode as "FULL_SPLIT" | "PARTIAL_BRANCH" | "STUB_INTERCEPT",
        nearSite: str(body.nearSite),
        nearRack: str(body.nearRack),
        nearOdf: str(body.nearOdf),
        nearPortGroup: optionalString(body.nearPortGroup),
        farSite: str(body.farSite),
        farRack: str(body.farRack),
        farOdf: str(body.farOdf),
        farPortGroup: optionalString(body.farPortGroup),
        insertedSite: str(body.insertedSite),
        insertedRack: str(body.insertedRack),
        insertedOdf: str(body.insertedOdf),
        insertedPortGroup: optionalString(body.insertedPortGroup),
        insertedNearRack: optionalString(body.insertedNearRack),
        insertedNearOdf: optionalString(body.insertedNearOdf),
        insertedNearPortGroup: optionalString(body.insertedNearPortGroup),
        insertedFarRack: optionalString(body.insertedFarRack),
        insertedFarOdf: optionalString(body.insertedFarOdf),
        insertedFarPortGroup: optionalString(body.insertedFarPortGroup),
        borrowedPortGroup: optionalString(body.borrowedPortGroup),
        segmentCapacity: optionalNumber(body.segmentCapacity),
        borrowedFibers: optionalNumber(body.borrowedFibers),
        carryServices: body.carryServices === true,
        distanceKm: optionalNumber(body.distanceKm),
        comments: optionalString(body.comments),
      },
      session?.id,
    );

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Intermediate-site operation failed." },
      { status: 400 },
    );
  }
}
