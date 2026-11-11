import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { getMonthlyInfrastructureGrowthMetrics } from "@/server/services/monthly-infrastructure-growth.service";

export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "inventoryRead")) {
    return NextResponse.json({ error: "Inventory access is required to view dashboard stats." }, { status: 403 });
  }

  const [ospCount, ispCount, monthlyInfrastructureGrowth] = await Promise.all([
    prisma.splitter.count({ where: { scope: "OSP", status: { not: "DECOMMISSIONED" } } }),
    prisma.splitter.count({ where: { scope: "ISP", status: { not: "DECOMMISSIONED" } } }),
    getMonthlyInfrastructureGrowthMetrics(),
  ]);

  return NextResponse.json({
    osp_count: ospCount,
    isp_count: ispCount,
    monthlyInfrastructureGrowth,
  });
}
