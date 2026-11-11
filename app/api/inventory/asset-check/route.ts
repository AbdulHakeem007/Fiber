import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { checkEndpointRegistration } from "@/server/services/inventory-asset-validation.service";

/**
 * Read-only endpoint backing the live Site/Rack/ODF registration indicators in
 * the segment editor. Returns per-level booleans via the shared lenient
 * resolver, so the check-marks always agree with what a segment save accepts.
 * Purely informational — it never mutates inventory.
 */
export async function GET(request: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "A valid portal session is required." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = await checkEndpointRegistration(prisma, {
    siteCode: searchParams.get("site"),
    rackCode: searchParams.get("rack"),
    odfCode: searchParams.get("odf"),
  });

  return NextResponse.json(status);
}
