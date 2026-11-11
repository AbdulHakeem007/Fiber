import { GitBranch } from "lucide-react";

export function DashboardSplitterCards({ ospCount, ispCount }: { ospCount: number; ispCount: number }) {
  const cards = [
    ["OSP Splitters", ospCount],
    ["ISP Splitters", ispCount],
  ] as const;

  return (
    <>
      {cards.map(([title, value]) => (
        <div key={title} className="kpi-card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="subtle">{title}</div>
              <div className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--text-strong)" }}>{value}</div>
            </div>
            <div className="rounded-xl border p-2.5" style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)", color: "var(--accent-text)" }}>
              <GitBranch className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
