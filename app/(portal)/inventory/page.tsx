import { inventoryService } from "@/server/services/inventory.service";
import { InventoryExplorer } from "@/components/inventory/inventory-explorer";
import { hasPermission } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";
import type { InventoryFilters } from "@/lib/filters/inventory-filters";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<InventoryFilters & { page?: string; pageSize?: string; siteId?: string }> }) {
  const params = { ...(await searchParams) };
  // Alias used by the consolidated ODF delete-blocker link (?siteId=&rackId=&odfId=).
  if (params.siteId && !params.site) params.site = params.siteId;
  const user = await getSessionUser();
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  // When any filter/search is active, default to pulling the full matching set
  // (capped at 1000) so the client can collapse pagination and show every match
  // inline. Unfiltered browsing keeps the lighter default page size. An explicit
  // pageSize (row-per-page selector, or the client >1000 step-down) always wins.
  const hasActiveFilter = Object.entries(params).some(
    ([key, value]) => !["page", "pageSize"].includes(key) && value != null && String(value).trim() !== "",
  );
  const defaultPageSize = hasActiveFilter ? 1000 : 100;
  const pageSize = Math.min(1000, Math.max(25, Number(params.pageSize ?? defaultPageSize) || defaultPageSize));
  const result = await inventoryService.listInventoryPage(params, { page, pageSize });

  return (
    <InventoryExplorer
      initialRows={result.rows}
      initialSearch={params.search ?? ""}
      initialFilters={params}
      canDelete={hasPermission(user?.roleCode, "childLinkDelete")}
      canBulkDelete={hasPermission(user?.roleCode, "bulkDelete")}
      serverPage={{ page: result.page, pageSize: result.pageSize, total: result.total }}
    />
  );
}
