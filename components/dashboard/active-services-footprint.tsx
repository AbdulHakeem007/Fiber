import type { ServiceFootprintBar } from "@/server/services/intra-site-saturation.service";

/**
 * "Active Services Footprint" — vertical bar chart of unique active service types
 * (ODF-mapping product tags) across the ENTIRE network. Pure CSS/flex, no chart
 * library, so it stays server-rendered and consistent with the rest of the
 * dashboard. Bars have rounded tips and integer data labels; long tag names wrap
 * under the axis so nothing clips outside the card.
 */

// Distinct, theme-legible bar colors cycled across the service tags.
const PALETTE = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#f43f5e", "#06b6d4", "#6366f1", "#84cc16"];

export function ActiveServicesFootprint({ bars }: { bars: ServiceFootprintBar[] }) {
  const max = Math.max(1, ...bars.map((bar) => bar.count));

  if (!bars.length) {
    return (
      <div className="subtle py-10 text-center text-sm">
        No active service tags found across the network yet.
      </div>
    );
  }

  return (
    <div>
      <div className="flex h-44 items-end justify-around gap-3 border-b border-[var(--border)] px-1 pt-6">
        {bars.map((bar, index) => {
          const heightPct = Math.max((bar.count / max) * 100, bar.count > 0 ? 6 : 0);
          return (
            <div
              key={bar.tag}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              title={`${bar.tag}: ${bar.count} unique active service(s)`}
            >
              <div className="mb-1 text-sm font-bold tabular-nums" style={{ color: "var(--text-strong)" }}>
                {bar.count.toLocaleString()}
              </div>
              <div
                className="w-full max-w-[56px] rounded-t-[7px] transition-[height]"
                style={{ height: `${heightPct}%`, minHeight: bar.count > 0 ? 8 : 0, background: PALETTE[index % PALETTE.length] }}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-around gap-3 px-1">
        {bars.map((bar) => (
          <div
            key={bar.tag}
            className="min-w-0 flex-1 break-words text-center text-[10px] font-semibold leading-tight"
            style={{ color: "var(--muted-text)" }}
            title={bar.tag}
          >
            {bar.tag}
          </div>
        ))}
      </div>
      <div className="subtle mt-3 text-center text-xs">
        {bars.length.toLocaleString()} unique active service type{bars.length === 1 ? "" : "s"} across the network.
      </div>
    </div>
  );
}
