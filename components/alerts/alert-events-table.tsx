import type { AlertRow } from "@/types/alerts";

export function AlertEventsTable({ rows }: { rows: AlertRow[] }) {
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Severity</th>
            <th>State</th>
            <th>Scope</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.title}</td>
              <td>{row.severity}</td>
              <td>{row.state}</td>
              <td>{row.scopeLabel}</td>
              <td>{row.lastSeenAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
