import type { ImportStagingReviewRow } from "@/types/import";

export function StagingReviewTable({ rows }: { rows: ImportStagingReviewRow[] }) {
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Row #</th>
            <th>Normalized A</th>
            <th>Normalized B</th>
            <th>Proposed Segment</th>
            <th>Status</th>
            <th>Reviewer Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rowNumber}>
              <td>{row.rowNumber}</td>
              <td>{row.normalizedSiteA ?? "—"}</td>
              <td>{row.normalizedSiteB ?? "—"}</td>
              <td>{row.proposedSegmentCode ?? "—"}</td>
              <td>{row.status}</td>
              <td>{row.reviewerComment ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
