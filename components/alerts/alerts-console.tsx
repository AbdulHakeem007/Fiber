"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { AlertRow } from "@/types/alerts";

export function AlertsConsole({ initialRows }: { initialRows: AlertRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState("OPEN");
  const [message, setMessage] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    if (filter === "ALL") return rows;
    return rows.filter((row) => row.state === filter || (filter === "OPEN" && ["OPEN", "ACKNOWLEDGED", "SUPPRESSED"].includes(row.state)));
  }, [rows, filter]);

  async function runAction(alertId: string, action: "acknowledge" | "suppress" | "clear") {
    setMessage(null);
    try {
      const response = await fetch(`/api/alerts/${alertId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.row) throw new Error(payload.error ?? "Alert update failed.");
      setRows((current) => current.map((row) => (row.id === alertId ? payload.row : row)));
      setMessage(`Alert ${action} complete.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Alert update failed.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="section-title">Alerts center</div>
            <div className="subtle mt-1">Acknowledge, suppress, clear, and export operational alert history.</div>
          </div>
          <div className="flex flex-wrap gap-3">
            <select className="input-dark" value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="OPEN">Open / Active</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="SUPPRESSED">Suppressed</option>
              <option value="CLEARED">Cleared</option>
              <option value="ALL">All</option>
            </select>
            <button className="btn bg-cyan-600 text-white" onClick={() => { window.location.href = "/api/export?type=alerts&format=xlsx"; }}>
              <Download className="h-4 w-4" />
              Export Excel
            </button>
          </div>
        </div>
        {message ? <div className="mt-3 text-sm text-cyan-700 dark:text-cyan-200">{message}</div> : null}
      </div>

      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Severity</th>
              <th>State</th>
              <th>Scope</th>
              <th>Last Seen</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id}>
                <td>{row.title}</td>
                <td>{row.severity}</td>
                <td>{row.state}</td>
                <td>{row.scopeLabel}</td>
                <td>{row.lastSeenAt}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn btn-ghost btn-compact" onClick={() => runAction(row.id, "acknowledge")}>Acknowledge</button>
                    <button className="btn btn-ghost btn-compact" onClick={() => runAction(row.id, "suppress")}>Suppress</button>
                    <button className="btn btn-ghost btn-compact" onClick={() => runAction(row.id, "clear")}>Clear</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
