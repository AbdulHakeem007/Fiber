import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { inventoryService } from "@/server/services/inventory.service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const type = searchParams.get("type")?.trim();
  if (q || type) {
    const query = q?.toUpperCase() ?? "";
    const [sites, services, segments] = await Promise.all([
      !type || type === "site"
        ? prisma.site.findMany({
            where: query ? { OR: [{ code: { contains: query } }, { name: { contains: q ?? "" } }] } : undefined,
            select: { code: true, name: true, region: true, siteType: true },
            orderBy: { code: "asc" },
            take: 20,
          })
        : Promise.resolve([]),
      !type || type === "service"
        ? prisma.service.findMany({
            where: query ? { OR: [{ serviceCode: { contains: query } }, { serviceName: { contains: q ?? "" } }] } : undefined,
            select: { serviceCode: true, serviceName: true, serviceType: true },
            orderBy: { serviceCode: "asc" },
            take: 20,
          })
        : Promise.resolve([]),
      !type || type === "segment"
        ? prisma.linkSegment.findMany({
            where: query ? { segmentCode: { contains: query } } : undefined,
            select: { segmentCode: true, sitePairKey: true, status: true },
            orderBy: { segmentCode: "asc" },
            take: 20,
          })
        : Promise.resolve([]),
    ]);

    return NextResponse.json({ sites, services, segments });
  }

  const siteCode = searchParams.get("site") ?? undefined;
  const rows = await inventoryService.listInventory(siteCode);
  return NextResponse.json({ rows });
}
