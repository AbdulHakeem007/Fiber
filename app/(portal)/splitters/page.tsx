import { SplitterInventory } from "@/components/splitters/splitter-inventory";
import { hasPermission } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";
import { splitterService } from "@/server/services/splitter.service";

export default async function SplittersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; splitterType?: string; status?: string; page?: string; pageSize?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const filters = {
    search: params.search ?? undefined,
    splitterType: params.splitterType ?? undefined,
    status: params.status ?? undefined,
  };
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const pageSize = Math.min(1000, Math.max(25, Number(params.pageSize ?? 100) || 100));
  const [result, summary] = await Promise.all([
    splitterService.listSplittersPage(filters, { page, pageSize }),
    splitterService.getSummary(filters),
  ]);

  return (
    <SplitterInventory
      rows={result.rows}
      summary={summary}
      serverPage={{ page: result.page, pageSize: result.pageSize, total: result.total }}
      initialFilters={filters}
      canWrite={hasPermission(user?.roleCode, "inventoryWrite")}
      canDelete={hasPermission(user?.roleCode, "childLinkDelete")}
      canBulkDelete={hasPermission(user?.roleCode, "bulkDelete")}
    />
  );
}
