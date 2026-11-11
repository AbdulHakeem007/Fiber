// Pure network-layout metrics for the dashboard "Engine Topology" card.
// Classifies every live segment by its effective topology role, then groups
// each role's edges into connected systems using the shared topology graph
// engine. Knows nothing about Prisma/Next so it stays unit-testable.

import { connectedComponents, dedupeEdges, type TopoEdge } from "./topology-graph";
import { effectiveTopologyRole } from "./topology-role";

export interface LayoutSegmentInput {
  id: string;
  fromKey: string;
  fromLabel: string;
  toKey: string;
  toLabel: string;
  /** Segment-level default role (LinkSegment.segmentDefaultRole). */
  segmentDefaultRole?: string | null;
  /** Optional child override (SegmentEndpointMapping.childTopologyRole). */
  childTopologyRole?: string | null;
}

export interface NetworkLayoutMetrics {
  /** Spurs/spur-chains report aggregated unique sites within those branches. */
  spurs: { systems: number; uniqueSites: number };
  spurChains: { systems: number; uniqueSites: number };
  singleHomed: { systems: number; uniqueSites: number };
  /** Rings report only system counts (no per-site listing). */
  subrings: { systems: number };
  mainRingsOver8Nodes: { systems: number };
}

/** Main rings are only counted when they exceed this node threshold. */
export const MAIN_RING_MIN_NODES = 10;

/**
 * Display-only label threshold for the dashboard "Main Rings" tile. The COUNTING
 * threshold (MAIN_RING_MIN_NODES) is intentionally left unchanged — this constant
 * governs ONLY the ">N nodes" text shown to operators, per the requested relabel.
 */
export const MAIN_RING_LABEL_NODES = 8;

function uniqueSiteCount(components: ReturnType<typeof connectedComponents>): number {
  const sites = new Set<string>();
  for (const component of components) {
    for (const key of component.nodeKeys) sites.add(key);
  }
  return sites.size;
}

export function computeNetworkLayoutMetrics(segments: LayoutSegmentInput[]): NetworkLayoutMetrics {
  const edgesByRole = new Map<string, TopoEdge<string>[]>();

  for (const segment of segments) {
    const { role } = effectiveTopologyRole({
      childTopologyRole: segment.childTopologyRole,
      segmentDefaultRole: segment.segmentDefaultRole,
    });
    const edge: TopoEdge<string> = {
      id: segment.id,
      fromKey: segment.fromKey,
      toKey: segment.toKey,
      fromLabel: segment.fromLabel,
      toLabel: segment.toLabel,
      ref: segment.id,
    };
    edgesByRole.set(role, [...(edgesByRole.get(role) ?? []), edge]);
  }

  const componentsFor = (role: string) =>
    connectedComponents(dedupeEdges(edgesByRole.get(role) ?? []));

  const spur = componentsFor("SPUR");
  const spurChain = componentsFor("SPUR_CHAIN");
  const singleHomed = componentsFor("SINGLE_HOMED");
  const subring = componentsFor("SUBRING");
  const mainRing = componentsFor("MAIN_RING");

  return {
    spurs: { systems: spur.length, uniqueSites: uniqueSiteCount(spur) },
    spurChains: { systems: spurChain.length, uniqueSites: uniqueSiteCount(spurChain) },
    singleHomed: { systems: singleHomed.length, uniqueSites: uniqueSiteCount(singleHomed) },
    subrings: { systems: subring.length },
    mainRingsOver8Nodes: {
      systems: mainRing.filter((component) => component.nodeKeys.size > MAIN_RING_MIN_NODES).length,
    },
  };
}
