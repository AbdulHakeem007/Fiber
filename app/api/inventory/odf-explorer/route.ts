import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { inventoryService } from "@/server/services/inventory.service";
import type { InventoryFilters } from "@/lib/filters/inventory-filters";
import { createReadThroughCache } from "@/lib/cache/read-through-cache";

const odfExplorerResponseCache = createReadThroughCache<string>({
  ttlMs: 120_000,
  maxEntries: 80,
});

function filtersFromSearchParams(searchParams: URLSearchParams): InventoryFilters {
  return {
    search: searchParams.get("search") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    site: searchParams.get("site") ?? searchParams.get("siteCode") ?? undefined,
    connectedSite: searchParams.get("connectedSite") ?? undefined,
    serviceId: searchParams.get("serviceId") ?? undefined,
    rackId: searchParams.get("rackId") ?? undefined,
    odfId: searchParams.get("odfId") ?? undefined,
    portPair: searchParams.get("portPair") ?? undefined,
    cableId: searchParams.get("cableId") ?? undefined,
  };
}

export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryRead")) {
      return NextResponse.json({ error: "Inventory read access is required to view ODF mappings." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const pageSize = Number(searchParams.get("pageSize") ?? searchParams.get("limit") ?? 50);
    const cursor = searchParams.get("cursor");
    const cacheKey = `${searchParams.toString() || "default"}:pageSize=${pageSize}:cursor=${cursor ?? ""}`;
    const body = await odfExplorerResponseCache.get(cacheKey, async () => {
      const result = await inventoryService.listInventoryCursor(filtersFromSearchParams(searchParams), { cursor, pageSize });
      return JSON.stringify({
        rows: result.rows,
        pageSize: result.pageSize,
        nextCursor: result.nextCursor,
        hasMore: Boolean(result.nextCursor),
      });
    });

    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=30",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ODF explorer payload load failed." },
      { status: 500 },
    );
  }
}
