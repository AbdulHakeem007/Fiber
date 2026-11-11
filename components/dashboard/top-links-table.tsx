import Link from "next/link";
import type { Route } from "next";

export interface TopLinkRow {
  sitePair: string;
  utilizationPct: number;
  used: number;
  total: number;
  status: string;
  /** Endpoint site codes used to deep-link into the ODF Mappings view. */
  nearSiteCode?: string;
  farSiteCode?: string;
}

export function TopLinksTable({ rows }: { rows: TopLinkRow[] }) {
  function barColor(status: string) {
    if (status === "Critical") return "bg-red-500";
    if (status === "High") return "bg-orange-500";
    if (status === "Moderate") return "bg-amber-400";
    return "bg-emerald-500";
  }

  // Route a link row into the ODF Mappings (inventory) view, filtered to the
  // mappings configured between exactly the two endpoints of that segment. Falls
  // back to a free-text search on the site-pair label when codes are unavailable.
  function inventoryHref(row: TopLinkRow): Route {
    if (row.nearSiteCode && row.farSiteCode) {
      const params = new URLSearchParams({ site: row.nearSiteCode, connectedSite: row.farSiteCode });
      return `/inventory?${params.toString()}` as Route;
    }
    return `/inventory?search=${encodeURIComponent(row.sitePair)}` as Route;
  }

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Site Pair</th>
            <th>Utilization</th>
            <th>Active / Total Fibers</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sitePair}>
              <td>
                <Link
                  href={inventoryHref(row)}
                  className="font-medium text-red-700 hover:text-red-900 hover:underline dark:text-red-200 dark:hover:text-white"
                  title={`Open ODF mappings for ${row.sitePair}`}
                >
                  {row.sitePair}
                </Link>
              </td>
              <td>
                <div className="flex items-center gap-3">
                  <div className="h-2 w-28 rounded-full bg-white/10">
                    <div className={`h-2 rounded-full ${barColor(row.status)}`} style={{ width: `${Math.min(row.utilizationPct, 100)}%` }} />
                  </div>
                  <span>{row.utilizationPct}%</span>
                </div>
              </td>
              <td>{row.used} / {row.total}</td>
              <td>{row.status}</td>
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td colSpan={4}>No utilization rows match the current filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
