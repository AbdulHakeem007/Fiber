import Link from "next/link";
import { Download, Radar } from "lucide-react";
import type { SiteConnectivityRow } from "@/types/site-connectivity";

export function SiteConnectivityTable({ centerSite, rows }: { centerSite: string; rows: SiteConnectivityRow[] }) {
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="section-title">Connected-site details</div>
          <div className="subtle mt-1">Direct physical segments and utilization status for {centerSite}. Child port details stay in ODF Mappings.</div>
        </div>
        <Link
          className="btn btn-ghost"
          href={`/api/export?type=site-connectivity&format=xlsx&site=${encodeURIComponent(centerSite)}`}
        >
          <Download className="h-4 w-4" />
          Export Summary
        </Link>
      </div>

      <div className="table-shell mt-5 max-h-[620px] overflow-auto">
        <table>
          <thead>
            <tr>
              <th>Searched Site</th>
              <th>Connected Site</th>
              <th>Segments</th>
              <th>Near Rack / ODF / Ports</th>
              <th>Far Rack / ODF / Ports</th>
              <th>Cable</th>
              <th>Fiber summary</th>
              <th>Distance</th>
              <th>Utilization</th>
              <th>Services</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.segmentId}>
                <td>{row.searchedSite}</td>
                <td>
                  <Link className="font-medium text-red-700 hover:text-red-900 dark:text-red-200 dark:hover:text-white" href={`/sites/${row.connectedSite}`}>
                    {row.connectedSite}
                  </Link>
                </td>
                <td>{row.directSegmentCount}</td>
                <td>{[row.rackId, row.odfId, row.portPair].filter(Boolean).join(" / ") || "-"}</td>
                <td>{[row.farRackId, row.farOdfId, row.farPortPair].filter(Boolean).join(" / ") || "-"}</td>
                <td>{row.cableId ?? "-"}</td>
                <td>{[row.tubeNumber ? `T${row.tubeNumber}` : null, row.tubeColor, row.fiberPortNumber ? `FP${row.fiberPortNumber}` : null, row.fiberNumber ? `F${row.fiberNumber}` : row.fiberLabel].filter(Boolean).join(" / ") || "-"}</td>
                <td>{row.distanceKm ? `${row.distanceKm} km` : "-"}</td>
                <td>{row.utilizationPct !== null && row.utilizationPct !== undefined ? `${row.utilizationPct}%` : "-"}</td>
                <td>{row.serviceIds ?? (row.serviceCount ? `${row.serviceCount} service(s)` : "-")}</td>
                <td>{row.status}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <Link className="btn btn-ghost btn-compact" href={`/inventory?search=${encodeURIComponent(row.connectedSite)}` as any}>
                      Inventory
                    </Link>
                    <Link className="btn btn-danger-soft btn-compact" href={`/impact?site=${encodeURIComponent(centerSite)}&connectedSite=${encodeURIComponent(row.connectedSite)}&odfId=${encodeURIComponent(row.odfId ?? "")}&portPair=${encodeURIComponent(row.portPair ?? "")}`}>
                      <Radar className="h-3 w-3" />
                      Impact
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={12}>No direct connections found for this site</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
