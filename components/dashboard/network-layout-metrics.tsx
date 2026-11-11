import { GitBranch, GitFork, Share2, RefreshCcw, CircleDashed, Network } from "lucide-react";
import type { NetworkLayoutMetrics } from "@/lib/telecom/network-layout-metrics";
import { MAIN_RING_LABEL_NODES } from "@/lib/telecom/network-layout-metrics";

/**
 * Engine topology card: graphic counts of the network's structural layout.
 * Per the layout rule, spurs and spur chains surface the aggregated number of
 * unique sites within those branches, while ring systems surface only their
 * total count (no per-site listing) to keep the panel uncluttered.
 */
export function NetworkLayoutMetricsCard({ metrics }: { metrics: NetworkLayoutMetrics }) {
  const tiles = [
    {
      key: "spurs",
      label: "Configured Spurs",
      value: metrics.spurs.uniqueSites,
      caption: `${metrics.spurs.systems} spur branch${metrics.spurs.systems === 1 ? "" : "es"} · unique sites`,
      icon: GitBranch,
      tone: "amber",
    },
    {
      key: "spur-chains",
      label: "Spur Chains",
      value: metrics.spurChains.uniqueSites,
      caption: `${metrics.spurChains.systems} chain${metrics.spurChains.systems === 1 ? "" : "s"} · unique sites`,
      icon: GitFork,
      tone: "orange",
    },
    {
      key: "single-homed",
      label: "Single-Homed Paths",
      value: metrics.singleHomed.systems,
      caption: `${metrics.singleHomed.uniqueSites} sites on single-homed paths`,
      icon: Share2,
      tone: "sky",
    },
    {
      key: "subrings",
      label: "Subrings",
      value: metrics.subrings.systems,
      caption: "ring systems",
      icon: RefreshCcw,
      tone: "violet",
    },
    {
      key: "main-rings",
      label: `Main Rings > ${MAIN_RING_LABEL_NODES} nodes`,
      value: metrics.mainRingsOver8Nodes.systems,
      caption: "ring systems",
      icon: CircleDashed,
      tone: "emerald",
    },
  ] as const;

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-emerald-500" />
        <div className="section-title">Network Layout Topology</div>
      </div>
      <div className="subtle mt-1">
        Structural breakdown of the live transport graph. Spurs and spur chains show aggregated unique
        sites within those branches; ring systems show total counts only.
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <div key={tile.key} className={`net-layout-tile net-layout-${tile.tone}`}>
              <Icon className="net-layout-icon" aria-hidden="true" />
              <div className="net-layout-value">{tile.value.toLocaleString()}</div>
              <div className="net-layout-label">{tile.label}</div>
              <div className="net-layout-caption">{tile.caption}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
