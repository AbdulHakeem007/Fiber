import { ImpactWorkbench } from "@/components/impact/impact-workbench";
import { activeInventoryFilterEntries, parseInventoryFilters } from "@/lib/filters/inventory-filters";
import { impactAnalysisService } from "@/server/services/impact-analysis.service";

export default async function ImpactPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const resolvedParams = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams ?? {})) {
    if (Array.isArray(value)) {
      if (value[0]) params.set(key, value[0]);
    } else if (value) {
      params.set(key, value);
    }
  }
  const filters = parseInventoryFilters(params);

  // Deferred on-demand execution: the heavy graph traversal / relational segment
  // scan only runs when the operator deep-links with active filters. A plain
  // visit renders an instant neutral workbench and waits for the explicit
  // "Analyze" action instead of recomputing the whole network on every mount.
  const hasActiveFilters = activeInventoryFilterEntries(filters).length > 0;
  const initialSummary = hasActiveFilters
    ? await impactAnalysisService.analyze(filters)
    : impactAnalysisService.emptySummary(filters);

  return <ImpactWorkbench initialSummary={initialSummary} initialAnalyzed={hasActiveFilters} />;
}
