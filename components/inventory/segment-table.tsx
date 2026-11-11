import { badgeClassForStatus } from "@/lib/utils/status";
import type { InventorySegmentRow } from "@/types/telecom";

function capacityLabel(row: InventorySegmentRow) {
  const capacity = row.segmentCapacityFibers ?? row.totalFibers ?? null;
  return capacity === 0 || capacity ? `${capacity} fibers` : "-";
}

function portRangeLabel(value?: string | null) {
  return value?.trim() || "-";
}

export function SegmentTable({ rows }: { rows: InventorySegmentRow[] }) {
  return (
    <div className="table-shell">
      <table className="min-w-[1320px]">
        <thead>
          <tr>
            <th>Segment</th>
            <th>Segment Group</th>
            <th>Near Site</th>
            <th>Near ODF</th>
            <th>Near ODF Port Range</th>
            <th>Far Site</th>
            <th>Far ODF</th>
            <th>Far ODF Port Range</th>
            <th>Segment Capacity</th>
            <th>Active</th>
            <th>Available</th>
            <th>Utilization</th>
            <th>Cable</th>
            <th>Distance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.segmentId}>
              <td>{row.segmentCode}</td>
              <td>{row.segmentGroupName ?? "-"}</td>
              <td>{row.nearSite}</td>
              <td>{row.nearOdf ?? "-"}</td>
              <td>{portRangeLabel(row.nearPortGroup)}</td>
              <td>{row.farSite ?? "-"}</td>
              <td>{row.farOdf ?? "-"}</td>
              <td>{portRangeLabel(row.farPortGroup)}</td>
              <td>{capacityLabel(row)}</td>
              <td>{row.usedFibers ?? 0}</td>
              <td>{row.availableFibers === 0 || row.availableFibers ? row.availableFibers : "-"}</td>
              <td>{row.utilizationPct === 0 || row.utilizationPct ? `${row.utilizationPct}%` : "-"}</td>
              <td>{row.cableLabel ?? "-"}</td>
              <td>{row.distanceKm === 0 || row.distanceKm ? `${row.distanceKm} km` : "-"}</td>
              <td><span className={`badge ${badgeClassForStatus(row.status)}`}>{row.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
