import { LucideIcon } from "lucide-react";

export function StatCard({
  title,
  value,
  delta,
  icon: Icon,
}: {
  title: string;
  value: string;
  delta?: string;
  icon: LucideIcon;
}) {
  return (
    <div className="kpi-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="subtle">{title}</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--text-strong)" }}>{value}</div>
          {delta ? <div className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">{delta}</div> : null}
        </div>
        <div className="rounded-xl border p-3" style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)", color: "var(--accent-text)" }}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
