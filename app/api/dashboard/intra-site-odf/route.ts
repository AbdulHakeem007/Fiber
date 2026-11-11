import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getCachedIntraSiteDashboardPayload } from "@/server/services/intra-site-dashboard-cache.service";

export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "inventoryRead")) {
    return NextResponse.json(
      { error: "Inventory access is required to view intra-site dashboard metrics." },
      { status: 403 },
    );
  }

  const payload = await getCachedIntraSiteDashboardPayload();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Data-Refresh-Interval": "3600",
    },
  });
}
