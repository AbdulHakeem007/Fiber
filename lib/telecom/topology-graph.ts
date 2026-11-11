// EDIT HERE: Pure, dependency-free topology graph engine.
// This module knows nothing about Prisma, Next, or the database. It only works on
// abstract edges so it can be unit-tested in isolation and reused by the service
// trace, impact analysis, and connectivity views.
//
// It answers the three questions the portal keeps getting wrong:
//   1. Is this group of fiber rows a closed RING, an open PATH (spur), or a
//      COMPLEX shape with junctions (subring / spur-chain attachment points)?
//   2. What is the correct ordered node sequence for the main walk?
//   3. Which edges are NOT on the main walk (branches that should be shown
//      separately instead of jumbling the main chain)?

export type TopologyShape = "SINGLE" | "PATH" | "RING" | "COMPLEX";

export interface TopoEdge<TRef = unknown> {
  /** Stable key for the "from" node after site-alias normalization. */
  fromKey: string;
  /** Stable key for the "to" node after site-alias normalization. */
  toKey: string;
  /** Human-readable label for the "from" node. */
  fromLabel: string;
  /** Human-readable label for the "to" node. */
  toLabel: string;
  /** Caller payload (e.g. the original mapping row). */
  ref: TRef;
  /** Stable identity used for de-duplication of physically identical rows. */
  id: string;
}

export interface OrderedTopology<TRef = unknown> {
  /** Ordered node keys of the longest simple walk through the component. */
  nodeKeys: string[];
  /** Ordered node labels aligned 1:1 with nodeKeys. */
  nodeLabels: string[];
  /**
   * Edges oriented along the walk. orderedEdges[i] connects nodeKeys[i] to
   * nodeKeys[i+1], so orderedEdges.length === nodeKeys.length - 1 for an open
   * walk. This 1:1 alignment is what lets the UI label each hop's distance
   * correctly.
   */
  orderedEdges: TopoEdge<TRef>[];
  /** True when a closing edge joins the last node back to the first (a ring). */
  isClosedRing: boolean;
  /** The closing edge for a ring, oriented last-node -> first-node. */
  closingEdge: TopoEdge<TRef> | null;
  /** Edges in this component that are not part of the main walk. */
  branchEdges: TopoEdge<TRef>[];
  /** Detected shape of the whole component. */
  shape: TopologyShape;
  /** Node keys whose degree is >= 3 (subring / spur attachment points). */
  junctionKeys: string[];
  /** Node keys whose degree is exactly 1 (true terminals / spur ends). */
  endpointKeys: string[];
  /** Lookup of node key -> label for everything in this component. */
  labelByKey: Map<string, string>;
}

export interface TopologyJunction {
  key: string;
  label: string;
  degree: number;
}

export interface WeightedTopoEdge<TRef = unknown> extends TopoEdge<TRef> {
  /** Non-negative path cost. Defaults to 1 when omitted or invalid. */
  weight?: number | null;
}

export interface ShortestPathResult<TRef = unknown> {
  /** Ordered node keys from start to end. */
  nodeKeys: string[];
  /** Ordered node labels aligned with nodeKeys. */
  nodeLabels: string[];
  /** Edges oriented from nodeKeys[i] to nodeKeys[i + 1]. */
  edges: WeightedTopoEdge<TRef>[];
  /** Sum of the edge weights used by the route. */
  totalWeight: number;
}

/** Remove edges that are self-loops or have no usable endpoints. */
function isUsableEdge(edge: TopoEdge): boolean {
  return Boolean(
    edge.fromKey &&
      edge.toKey &&
      edge.fromKey !== "UNKNOWN" &&
      edge.toKey !== "UNKNOWN" &&
      edge.fromKey !== edge.toKey,
  );
}

function stableText(value?: string | null): string {
  return String(value ?? "").trim().toUpperCase();
}

function stableEdgeSortKey(edge: TopoEdge): string {
  const pair = [edge.fromKey, edge.toKey].sort().join("<>");
  return [pair, stableText(edge.fromLabel), stableText(edge.toLabel), stableText(edge.id)].join("|");
}

function compareText(a?: string | null, b?: string | null): number {
  return stableText(a).localeCompare(stableText(b));
}

/**
 * Collapse physically identical neighbour pairs to a single edge. ODF imports
 * frequently repeat the same site pair across many fibers; for shape detection
 * each undirected neighbour pair should count once.
 */
export function dedupeEdges<TRef>(edges: TopoEdge<TRef>[]): TopoEdge<TRef>[] {
  const seen = new Set<string>();
  const result: TopoEdge<TRef>[] = [];

  // Database joins can return physically identical neighbour pairs in different
  // orders across requests. Sort before dedupe so the representative edge is
  // deterministic, not whichever row Prisma happened to hand us first.
  const sorted = edges.slice().sort((a, b) => stableEdgeSortKey(a).localeCompare(stableEdgeSortKey(b)));

  for (const edge of sorted) {
    if (!isUsableEdge(edge)) continue;
    const undirected = [edge.fromKey, edge.toKey].sort().join("<>");
    if (seen.has(undirected)) continue;
    seen.add(undirected);
    result.push(edge);
  }
  return result;
}


export function dedupeEdgesById<TRef>(edges: TopoEdge<TRef>[]): TopoEdge<TRef>[] {
  const seen = new Set<string>();
  const result: TopoEdge<TRef>[] = [];
  const sorted = edges.slice().sort((a, b) => stableEdgeSortKey(a).localeCompare(stableEdgeSortKey(b)));
  for (const edge of sorted) {
    if (!isUsableEdge(edge)) continue;
    const key = [edge.fromKey, edge.toKey].sort().join("<>") + "|" + stableText(edge.id);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

interface ComponentInternal<TRef> {
  edges: TopoEdge<TRef>[];
  nodeKeys: Set<string>;
}

/** Split a deduped edge list into connected components. */
export function connectedComponents<TRef>(
  edges: TopoEdge<TRef>[],
): ComponentInternal<TRef>[] {
  const adjacency = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    adjacency.set(edge.fromKey, [...(adjacency.get(edge.fromKey) ?? []), index]);
    adjacency.set(edge.toKey, [...(adjacency.get(edge.toKey) ?? []), index]);
  });

  const unused = new Set(edges.map((_, index) => index));
  const components: ComponentInternal<TRef>[] = [];

  while (unused.size) {
    const start = unused.values().next().value as number;
    const queue = [start];
    const edgeIndexes = new Set<number>();
    const nodeKeys = new Set<string>();

    while (queue.length) {
      const edgeIndex = queue.pop() as number;
      if (edgeIndexes.has(edgeIndex)) continue;
      edgeIndexes.add(edgeIndex);
      const edge = edges[edgeIndex];
      nodeKeys.add(edge.fromKey);
      nodeKeys.add(edge.toKey);
      for (const next of [
        ...(adjacency.get(edge.fromKey) ?? []),
        ...(adjacency.get(edge.toKey) ?? []),
      ]) {
        if (!edgeIndexes.has(next)) queue.push(next);
      }
    }

    for (const edgeIndex of edgeIndexes) unused.delete(edgeIndex);
    components.push({
      edges: [...edgeIndexes].map((index) => edges[index]),
      nodeKeys,
    });
  }

  return components;
}

function degreeMap(edges: TopoEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.fromKey, (degree.get(edge.fromKey) ?? 0) + 1);
    degree.set(edge.toKey, (degree.get(edge.toKey) ?? 0) + 1);
  }
  return degree;
}

function otherEnd(edge: TopoEdge, key: string): string {
  return edge.fromKey === key ? edge.toKey : edge.fromKey;
}

function orientEdge<TRef>(edge: TopoEdge<TRef>, fromKey: string): TopoEdge<TRef> {
  if (edge.fromKey === fromKey) return edge;
  return {
    ...edge,
    fromKey: edge.toKey,
    toKey: edge.fromKey,
    fromLabel: edge.toLabel,
    toLabel: edge.fromLabel,
  };
}

function orientWeightedEdge<TRef>(edge: WeightedTopoEdge<TRef>, fromKey: string): WeightedTopoEdge<TRef> {
  return orientEdge(edge, fromKey) as WeightedTopoEdge<TRef>;
}

function pathWeight(value?: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Dijkstra shortest path over an undirected weighted graph. Parallel edges are
 * preserved so callers can choose the shortest/least-cost physical segment
 * between the same pair of sites.
 */
export function findShortestPath<TRef>(
  edges: WeightedTopoEdge<TRef>[],
  startKey: string,
  endKey: string,
): ShortestPathResult<TRef> | null {
  const start = stableText(startKey);
  const end = stableText(endKey);
  if (!start || !end || start === "UNKNOWN" || end === "UNKNOWN") return null;

  const usable = edges
    .filter(isUsableEdge)
    .slice()
    .sort((a, b) => stableEdgeSortKey(a).localeCompare(stableEdgeSortKey(b)));
  if (!usable.length) return null;

  const labels = new Map<string, string>();
  const adjacency = new Map<string, Array<{ to: string; edge: WeightedTopoEdge<TRef>; cost: number }>>();
  const addAdjacency = (from: string, to: string, edge: WeightedTopoEdge<TRef>) => {
    adjacency.set(from, [...(adjacency.get(from) ?? []), { to, edge: orientWeightedEdge(edge, from), cost: pathWeight(edge.weight) }]);
  };

  for (const edge of usable) {
    labels.set(edge.fromKey, edge.fromLabel);
    labels.set(edge.toKey, edge.toLabel);
    addAdjacency(edge.fromKey, edge.toKey, edge);
    addAdjacency(edge.toKey, edge.fromKey, edge);
  }
  if (!adjacency.has(start) || !adjacency.has(end)) return null;
  if (start === end) {
    return { nodeKeys: [start], nodeLabels: [labels.get(start) ?? start], edges: [], totalWeight: 0 };
  }

  const distances = new Map<string, number>();
  const previous = new Map<string, { from: string; edge: WeightedTopoEdge<TRef> }>();
  const unsettled = new Set(adjacency.keys());
  for (const key of unsettled) distances.set(key, Number.POSITIVE_INFINITY);
  distances.set(start, 0);

  while (unsettled.size) {
    let current: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const key of unsettled) {
      const distance = distances.get(key) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance || (distance === currentDistance && key.localeCompare(current ?? "") < 0)) {
        current = key;
        currentDistance = distance;
      }
    }
    if (!current || currentDistance === Number.POSITIVE_INFINITY) break;
    unsettled.delete(current);
    if (current === end) break;

    const neighbours = (adjacency.get(current) ?? []).slice().sort((a, b) =>
      a.cost - b.cost ||
      stableEdgeSortKey(a.edge).localeCompare(stableEdgeSortKey(b.edge)) ||
      a.to.localeCompare(b.to),
    );
    for (const next of neighbours) {
      if (!unsettled.has(next.to)) continue;
      const candidate = currentDistance + next.cost;
      const existing = distances.get(next.to) ?? Number.POSITIVE_INFINITY;
      if (candidate < existing || (candidate === existing && current.localeCompare(previous.get(next.to)?.from ?? "") < 0)) {
        distances.set(next.to, candidate);
        previous.set(next.to, { from: current, edge: next.edge });
      }
    }
  }

  if (!previous.has(end)) return null;

  const nodeKeys = [end];
  const routeEdges: WeightedTopoEdge<TRef>[] = [];
  let cursor = end;
  while (cursor !== start) {
    const step = previous.get(cursor);
    if (!step) return null;
    routeEdges.unshift(step.edge);
    nodeKeys.unshift(step.from);
    cursor = step.from;
  }

  return {
    nodeKeys,
    nodeLabels: nodeKeys.map((key) => labels.get(key) ?? key),
    edges: routeEdges,
    totalWeight: Math.round((distances.get(end) ?? 0) * 100) / 100,
  };
}

/**
 * Enumerate EVERY simple (loop-free) path between two sites, sorted shortest to
 * longest: primary = fewest hops (ties broken by lowest total weight), then all
 * indirect alternatives ascending by hop count. Parallel edges between the same
 * site pair collapse to the cheapest physical segment (route discovery is a
 * site-level question). Bounded by maxHops / maxDfsCalls / maxPaths so dirty or
 * dense meshes can never freeze a request.
 */
export function findAllSimplePaths<TRef>(
  edges: WeightedTopoEdge<TRef>[],
  startKey: string,
  endKey: string,
  options: { maxPaths?: number; maxDfsCalls?: number; maxHops?: number } = {},
): ShortestPathResult<TRef>[] {
  const start = stableText(startKey);
  const end = stableText(endKey);
  if (!start || !end || start === "UNKNOWN" || end === "UNKNOWN" || start === end) return [];

  const maxPaths = options.maxPaths ?? 6;
  const maxHops = options.maxHops ?? 12;
  const maxDfsCalls = options.maxDfsCalls ?? 60000;

  // Cheapest representative per undirected site pair (deterministic on ties).
  const byPair = new Map<string, WeightedTopoEdge<TRef>>();
  for (const edge of edges.filter(isUsableEdge)) {
    const pairKey = [edge.fromKey, edge.toKey].sort().join("<>");
    const existing = byPair.get(pairKey);
    if (
      !existing ||
      pathWeight(edge.weight) < pathWeight(existing.weight) ||
      (pathWeight(edge.weight) === pathWeight(existing.weight) &&
        stableEdgeSortKey(edge).localeCompare(stableEdgeSortKey(existing)) < 0)
    ) {
      byPair.set(pairKey, edge);
    }
  }
  const usable = [...byPair.values()].sort((a, b) => stableEdgeSortKey(a).localeCompare(stableEdgeSortKey(b)));
  if (!usable.length) return [];

  const labels = new Map<string, string>();
  const adjacency = new Map<string, Array<{ to: string; edge: WeightedTopoEdge<TRef> }>>();
  const addAdjacency = (from: string, to: string, edge: WeightedTopoEdge<TRef>) => {
    adjacency.set(from, [...(adjacency.get(from) ?? []), { to, edge: orientWeightedEdge(edge, from) }]);
  };
  for (const edge of usable) {
    labels.set(edge.fromKey, edge.fromLabel);
    labels.set(edge.toKey, edge.toLabel);
    addAdjacency(edge.fromKey, edge.toKey, edge);
    addAdjacency(edge.toKey, edge.fromKey, edge);
  }
  if (!adjacency.has(start) || !adjacency.has(end)) return [];
  for (const [, neighbours] of adjacency) {
    neighbours.sort((a, b) => a.to.localeCompare(b.to) || stableEdgeSortKey(a.edge).localeCompare(stableEdgeSortKey(b.edge)));
  }

  const found: Array<{ nodeKeys: string[]; edges: WeightedTopoEdge<TRef>[]; totalWeight: number }> = [];
  let calls = 0;
  const visited = new Set<string>([start]);
  const nodePath: string[] = [start];
  const edgePath: WeightedTopoEdge<TRef>[] = [];

  const dfs = (currentKey: string, weightSoFar: number) => {
    calls += 1;
    if (calls > maxDfsCalls) return;
    if (edgePath.length >= maxHops) return;
    for (const next of adjacency.get(currentKey) ?? []) {
      if (next.to === end) {
        found.push({
          nodeKeys: [...nodePath, end],
          edges: [...edgePath, next.edge],
          totalWeight: Math.round((weightSoFar + pathWeight(next.edge.weight)) * 100) / 100,
        });
        continue;
      }
      if (visited.has(next.to)) continue;
      visited.add(next.to);
      nodePath.push(next.to);
      edgePath.push(next.edge);
      dfs(next.to, weightSoFar + pathWeight(next.edge.weight));
      visited.delete(next.to);
      nodePath.pop();
      edgePath.pop();
      if (calls > maxDfsCalls) return;
    }
  };
  dfs(start, 0);

  // Shortest -> longest: fewest hops first, then lowest cost, then stable label order.
  found.sort(
    (a, b) =>
      a.edges.length - b.edges.length ||
      a.totalWeight - b.totalWeight ||
      a.nodeKeys.join("->").localeCompare(b.nodeKeys.join("->")),
  );

  return found.slice(0, maxPaths).map((route) => ({
    nodeKeys: route.nodeKeys,
    nodeLabels: route.nodeKeys.map((key) => labels.get(key) ?? key),
    edges: route.edges,
    totalWeight: route.totalWeight,
  }));
}

export interface StartScoreInput {
  key: string;
  degree: number;
  inDegree: number;
  outDegree: number;
  label: string;
  serviceCode?: string;
}

/**
 * Score a node as a potential start of the walk. Telecom trails normally start
 * at a degree-1 terminal that is written as outgoing-only in the imported ODF
 * rows, and the service is often named after one of its endpoints.
 */
export function scoreStartCandidate(input: StartScoreInput): number {
  let score = 0;
  if (input.degree === 1) score += 100;
  if (input.outDegree > 0 && input.inDegree === 0) score += 60;
  if (input.outDegree + input.inDegree === 1) score += 30;
  const service = (input.serviceCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const label = input.label.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (service && label && service.includes(label)) score += 20;
  return score;
}

/**
 * Build the ordered topology for one connected component. Pure and bounded:
 * the DFS is capped so dirty data can never freeze the request.
 */
export function orderComponent<TRef>(
  component: ComponentInternal<TRef>,
  options: { serviceCode?: string; maxDfsCalls?: number } = {},
): OrderedTopology<TRef> {
  const edges = component.edges;
  const labelByKey = new Map<string, string>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const adjacency = new Map<string, number[]>();

  edges.forEach((edge, index) => {
    labelByKey.set(edge.fromKey, edge.fromLabel);
    labelByKey.set(edge.toKey, edge.toLabel);
    adjacency.set(edge.fromKey, [...(adjacency.get(edge.fromKey) ?? []), index]);
    adjacency.set(edge.toKey, [...(adjacency.get(edge.toKey) ?? []), index]);
    outDegree.set(edge.fromKey, (outDegree.get(edge.fromKey) ?? 0) + 1);
    inDegree.set(edge.toKey, (inDegree.get(edge.toKey) ?? 0) + 1);
    if (!inDegree.has(edge.fromKey)) inDegree.set(edge.fromKey, 0);
    if (!outDegree.has(edge.toKey)) outDegree.set(edge.toKey, 0);
  });

  const degree = degreeMap(edges);
  const allKeys = [...component.nodeKeys];
  const junctionKeys = allKeys.filter((key) => (degree.get(key) ?? 0) >= 3).sort();
  const endpointKeys = allKeys.filter((key) => (degree.get(key) ?? 0) === 1).sort();

  // Shape detection.
  let shape: TopologyShape;
  if (edges.length === 1) {
    shape = "SINGLE";
  } else if (junctionKeys.length > 0) {
    shape = "COMPLEX";
  } else if (endpointKeys.length === 0) {
    // Every node degree 2 and connected => single cycle => ring.
    shape = "RING";
  } else {
    shape = "PATH";
  }

  if (allKeys.length === 2 && edges.length >= 2 && endpointKeys.length === 0) {
    const sortedKeys = allKeys.slice().sort((a, b) =>
      compareText(labelByKey.get(a) ?? a, labelByKey.get(b) ?? b) || compareText(a, b),
    );
    const serviceCompact = stableText(options.serviceCode).replace(/[^A-Z0-9]/g, "");
    const serviceMiddleKeys = serviceCompact
      ? sortedKeys.filter((key) => {
          const label = stableText(labelByKey.get(key) ?? key).replace(/[^A-Z0-9]/g, "");
          const compactKey = stableText(key).replace(/[^A-Z0-9]/g, "");
          return (label && serviceCompact.includes(label)) || (compactKey && serviceCompact.includes(compactKey));
        })
      : [];
    // For a single-homed two-leg loop named after the local core (BA1000 ATN
    // SubRing), repeat the remote gateway instead of alphabetically starting at
    // the core. This renders BA2000 -> BA1000 -> BA2000, showing the inbound and
    // outbound physical interfaces clearly.
    const serviceMiddleKey = serviceMiddleKeys.length === 1 ? serviceMiddleKeys[0] : null;
    const startKey = serviceMiddleKey ? (sortedKeys.find((key) => key !== serviceMiddleKey) ?? sortedKeys[0]) : sortedKeys[0];
    const otherKeyValue = serviceMiddleKey ?? (sortedKeys.find((key) => key !== startKey) ?? sortedKeys[1]);
    const pairEdges = edges
      .slice()
      .sort((a, b) => stableEdgeSortKey(a).localeCompare(stableEdgeSortKey(b)));
    const firstEdge = orientEdge(pairEdges[0], startKey);
    const secondEdge = orientEdge(pairEdges[1], otherKeyValue);
    return {
      nodeKeys: [startKey, otherKeyValue, startKey],
      nodeLabels: [labelByKey.get(startKey) ?? startKey, labelByKey.get(otherKeyValue) ?? otherKeyValue, labelByKey.get(startKey) ?? startKey],
      orderedEdges: [firstEdge, secondEdge],
      isClosedRing: true,
      closingEdge: null,
      branchEdges: pairEdges.slice(2),
      shape: "RING",
      junctionKeys,
      endpointKeys,
      labelByKey,
    };
  }

  const startCandidates = (endpointKeys.length ? endpointKeys : allKeys)
    .slice()
    .sort((a, b) => {
      const scoreB = scoreStartCandidate({
        key: b,
        degree: degree.get(b) ?? 0,
        inDegree: inDegree.get(b) ?? 0,
        outDegree: outDegree.get(b) ?? 0,
        label: labelByKey.get(b) ?? b,
        serviceCode: options.serviceCode,
      });
      const scoreA = scoreStartCandidate({
        key: a,
        degree: degree.get(a) ?? 0,
        inDegree: inDegree.get(a) ?? 0,
        outDegree: outDegree.get(a) ?? 0,
        label: labelByKey.get(a) ?? a,
        serviceCode: options.serviceCode,
      });
      if (scoreA !== scoreB) return scoreB - scoreA;

      // Critical for closed rings: when every node has the same degree, there is
      // no natural terminal. Fall back to a stable label/key order so the ring
      // does not visually rotate/randomize whenever DB row order changes.
      return (
        compareText(labelByKey.get(a) ?? a, labelByKey.get(b) ?? b) ||
        compareText(a, b)
      );
    });

  // Longest SIMPLE path search (bounded). A simple path never revisits a node,
  // except that stepping back onto the start node is allowed once and closes a
  // ring (we record the closing edge separately rather than duplicating the
  // start node in the walk).
  let bestKeys: string[] = [];
  let bestEdgeIndexes: number[] = [];
  let bestClosingEdge = -1; // edge index that closes the ring, or -1
  let calls = 0;
  const cap = options.maxDfsCalls ?? 30000;
  const edgeIndexById = new Map(edges.map((edge, index) => [index, edge] as const));

  const considerBest = (keyPath: string[], edgePath: number[], closing: number) => {
    // Prefer more edges; on a tie prefer the walk that closes into a ring.
    const score = edgePath.length * 2 + (closing >= 0 ? 1 : 0);
    const bestScore = bestEdgeIndexes.length * 2 + (bestClosingEdge >= 0 ? 1 : 0);
    if (score > bestScore) {
      bestKeys = [...keyPath];
      bestEdgeIndexes = [...edgePath];
      bestClosingEdge = closing;
    }
  };

  const dfs = (
    startKey: string,
    currentKey: string,
    usedEdges: Set<number>,
    visited: Set<string>,
    keyPath: string[],
    edgePath: number[],
  ) => {
    calls += 1;
    considerBest(keyPath, edgePath, -1);
    if (calls > cap) return;

    const candidates = (adjacency.get(currentKey) ?? [])
      .filter((index) => !usedEdges.has(index))
      .sort((a, b) => {
        const edgeA = edgeIndexById.get(a)!;
        const edgeB = edgeIndexById.get(b)!;
        // Prefer following the real imported local->far direction.
        const aOutgoing = edgeA.fromKey === currentKey ? 0 : 1;
        const bOutgoing = edgeB.fromKey === currentKey ? 0 : 1;
        if (aOutgoing !== bOutgoing) return aOutgoing - bOutgoing;
        return (
          compareText(
            labelByKey.get(otherEnd(edgeA, currentKey)) ?? otherEnd(edgeA, currentKey),
            labelByKey.get(otherEnd(edgeB, currentKey)) ?? otherEnd(edgeB, currentKey),
          ) || compareText(edgeA.id, edgeB.id)
        );
      });

    for (const edgeIndex of candidates) {
      const edge = edges[edgeIndex];
      const nextKey = otherEnd(edge, currentKey);

      if (nextKey === startKey && edgePath.length >= 2) {
        // Closing the ring: record but do not extend the node walk.
        considerBest(keyPath, [...edgePath, edgeIndex], edgeIndex);
        continue;
      }
      if (visited.has(nextKey)) continue; // keep the path simple

      usedEdges.add(edgeIndex);
      visited.add(nextKey);
      dfs(
        startKey,
        nextKey,
        usedEdges,
        visited,
        [...keyPath, nextKey],
        [...edgePath, edgeIndex],
      );
      visited.delete(nextKey);
      usedEdges.delete(edgeIndex);
      if (calls > cap) return;
    }
  };

  for (const startKey of startCandidates) {
    dfs(startKey, startKey, new Set<number>(), new Set([startKey]), [startKey], []);
    if (calls > cap) break;
  }

  if (!bestKeys.length) {
    const fallback = edges[0];
    bestKeys = [fallback.fromKey, fallback.toKey];
    bestEdgeIndexes = [0];
  }

  // The closing edge index (if any) is the last entry of bestEdgeIndexes when
  // bestClosingEdge is set; separate it from the open-walk edges.
  let isClosedRing = false;
  let closingEdge: TopoEdge<TRef> | null = null;
  let openEdgeIndexes = bestEdgeIndexes;
  if (bestClosingEdge >= 0 && bestEdgeIndexes[bestEdgeIndexes.length - 1] === bestClosingEdge) {
    isClosedRing = true;
    openEdgeIndexes = bestEdgeIndexes.slice(0, -1);
    const lastKey = bestKeys[bestKeys.length - 1];
    closingEdge = orientEdge(edges[bestClosingEdge], lastKey);
  }

  const usedEdgeSet = new Set(bestEdgeIndexes);
  const orderedEdges: TopoEdge<TRef>[] = openEdgeIndexes.map((edgeIndex, position) =>
    orientEdge(edges[edgeIndex], bestKeys[position]),
  );
  const nodeLabels = bestKeys.map((key) => labelByKey.get(key) ?? key);

  const branchEdges = edges.filter((_, index) => !usedEdgeSet.has(index));

  // A pure cycle that we walked open is still a RING even if shape detection
  // saw all-degree-2; keep them consistent.
  if (isClosedRing && shape === "PATH") shape = "RING";

  return {
    nodeKeys: bestKeys,
    nodeLabels,
    orderedEdges,
    isClosedRing,
    closingEdge,
    branchEdges,
    shape,
    junctionKeys,
    endpointKeys,
    labelByKey,
  };
}

/** Order every component of an edge set, longest (most edges) first. */
export function orderTopology<TRef>(
  edges: TopoEdge<TRef>[],
  options: { serviceCode?: string; maxDfsCalls?: number; preserveParallelEdges?: boolean } = {},
): OrderedTopology<TRef>[] {
  const deduped = options.preserveParallelEdges ? dedupeEdgesById(edges) : dedupeEdges(edges);
  if (!deduped.length) return [];
  return connectedComponents(deduped)
    .map((component) => orderComponent(component, options))
    .sort(
      (a, b) =>
        b.orderedEdges.length - a.orderedEdges.length ||
        a.nodeLabels.join("->").localeCompare(b.nodeLabels.join("->")),
    );
}

/**
 * Junctions (degree >= 3) across the whole edge set. These are the sites where
 * a subring or spur attaches to the main ring, and are the basis of the
 * "please mark this exception" review warnings.
 */
export function findJunctions(edges: TopoEdge[]): TopologyJunction[] {
  const deduped = dedupeEdges(edges);
  const degree = degreeMap(deduped);
  const label = new Map<string, string>();
  for (const edge of deduped) {
    label.set(edge.fromKey, edge.fromLabel);
    label.set(edge.toKey, edge.toLabel);
  }
  return [...degree.entries()]
    .filter(([, count]) => count >= 3)
    .map(([key, count]) => ({ key, label: label.get(key) ?? key, degree: count }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
}
