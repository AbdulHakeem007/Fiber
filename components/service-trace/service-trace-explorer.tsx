"use client";

import { Fragment, memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { Activity, Cable, CheckCircle2, Download, GitBranch, Loader2, Mail, MapPin, Network, Search, Split, Unplug, Wifi, X } from "lucide-react";
import { TraceDetailsTable } from "@/components/service-trace/trace-details-table";
import { SuggestionInput } from "@/components/ui/suggestion-input";
import {
  type Point,
  type RingRole,
  type TopologyRenderNode,
  JUMPER_LABEL_RE,
  SVG_STENCILS,
  SITE_STENCIL_DARK_HREF,
  StencilNode,
  cleanNodeLabel,
  normalizedNodeLabel,
  selectStencil,
  siteStencilForTheme,
} from "@/components/service-trace/topology-stencils";
import { useIsDarkMode } from "@/lib/hooks/use-is-dark-mode";
import { UnifiedTopologyCanvas } from "@/components/service-trace/unified-topology-canvas";
import { TraceEmailReport } from "@/components/service-trace/trace-email-report";
import { svgToPngDataUrl, pickTopologySvg } from "@/lib/canvas/canvas-raster";
import { formatSelectedSiteIds, normalizeSelectedSiteIds, parseSelectedSiteIds } from "@/lib/telecom/site-list-format";
import type { IndirectRouteSummary, RouteHop, ServiceTraceResult, ServiceTraceTopologyGroup, SplitterTraceFork } from "@/types/telecom";

type PathPreview = {
  path: string;
  matchedHops: number;
  missingHops: number;
  hops: Array<{
    from: string;
    to: string;
    matched: boolean;
    segmentCode?: string | null;
    serviceIds?: string | null;
    totalFibers?: number | null;
    usedFibers?: number | null;
    availableFibers?: number | null;
    status?: string | null;
    distanceKm?: number | null;
    cumulativeDistanceKm?: number | null;
  }>;
  totalDistanceKm?: number;
  indirectRouteSummary?: IndirectRouteSummary | null;
  /** Indirect alternatives beyond the primary route, ascending by hop count. */
  alternativeRouteSummaries?: IndirectRouteSummary[];
  splitterForks?: SplitterTraceFork[];
};

function serviceSearchKey(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

const SHAPE_META: Record<string, { label: string; icon: string; tone: string; bg: string }> = {
  RECTANGULAR_TRACK: { label: "A-MPLS PE to PE", icon: "PE", tone: "text-emerald-600 dark:text-emerald-300", bg: "border-emerald-500/30 bg-emerald-500/10" },
  RING:    { label: "Closed ring",  icon: "◯", tone: "text-emerald-600 dark:text-emerald-300", bg: "border-emerald-500/30 bg-emerald-500/10" },
  PATH:    { label: "Open chain",   icon: "⇢", tone: "text-sky-600 dark:text-sky-300",         bg: "border-sky-500/30 bg-sky-500/10" },
  COMPLEX: { label: "Has junction", icon: "⤴", tone: "text-amber-600 dark:text-amber-300",     bg: "border-amber-500/30 bg-amber-500/10" },
  SINGLE:  { label: "Single link",  icon: "—", tone: "text-slate-500 dark:text-slate-300",     bg: "border-slate-500/20 bg-slate-500/08" },
};

const ROLE_TONES: Record<string, { panel: string; badge: string; accent: string }> = {
  SINGLE_HOMED: { panel: "border-emerald-500/25 bg-emerald-500/5",  badge: "topology-role-single-homed", accent: "text-emerald-400" },
  SUBRING:      { panel: "border-violet-500/25 bg-violet-500/5",    badge: "topology-role-subring",      accent: "text-violet-300" },
  SPUR:         { panel: "border-amber-500/25 bg-amber-500/5",      badge: "topology-role-spur",         accent: "text-amber-300"  },
  SPUR_CHAIN:   { panel: "border-orange-500/25 bg-orange-500/5",    badge: "topology-role-spur-chain",   accent: "text-orange-300" },
  INTERCONNECT: { panel: "border-teal-500/25 bg-teal-500/5",        badge: "topology-role-interconnect", accent: "text-teal-300"   },
  REVIEW:       { panel: "border-red-500/20 bg-red-500/5",          badge: "topology-role-review",       accent: "text-red-300"    },
};

function ShapeBadge({ group }: { group: ServiceTraceTopologyGroup }) {
  const shapeKey = group.renderAsRing && !group.isClosedRing ? "RECTANGULAR_TRACK" : String(group.shape ?? "PATH");
  const meta = SHAPE_META[shapeKey] ?? SHAPE_META.PATH;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${meta.bg} ${meta.tone}`}>
      <span aria-hidden>{meta.icon}</span> {meta.label}
    </span>
  );
}

// Stencil primitives (RingRole, Point, TopologyRenderNode, SVG_STENCILS,
// StencilNode, selectStencil, cleanNodeLabel, normalizedNodeLabel, JUMPER_LABEL_RE)
// now live in ./topology-stencils so the unified canvas can share them.

function pointOnThreeSegmentTrack(
  index: number,
  total: number,
  width: number,
  height: number,
  padding: number,
  includeCorners: boolean,
): Point {
  const left = padding;
  const right = width - padding;
  const top = padding;
  const bottom = height - padding;
  const vertical = bottom - top;
  const horizontal = right - left;
  const trackLength = vertical + horizontal + vertical;
  const denominator = includeCorners ? Math.max(1, total - 1) : total + 1;
  const position = includeCorners
    ? (total <= 1 ? trackLength / 2 : (index / denominator) * trackLength)
    : ((index + 1) / denominator) * trackLength;

  if (position <= vertical) return { x: left, y: top + position };
  if (position <= vertical + horizontal) return { x: left + (position - vertical), y: bottom };
  return { x: right, y: bottom - (position - vertical - horizontal) };
}

function calculateSingleHomedCoordinates(nodes: TopologyRenderNode[], width: number, height: number): Point[] {
  const padding = 96;
  if (!nodes.length) return [];
  const points: Point[] = [{ x: width / 2, y: padding }];
  const transitCount = nodes.length - 1;
  for (let index = 0; index < transitCount; index += 1) {
    points.push(pointOnThreeSegmentTrack(index, transitCount, width, height, padding, true));
  }
  return points;
}

function calculateDualHomedCoordinates(nodes: TopologyRenderNode[], width: number, height: number): Point[] {
  const padding = 96;
  if (!nodes.length) return [];
  const points: Point[] = Array.from({ length: nodes.length }, () => ({ x: width / 2, y: height / 2 }));
  const coreIndexes = nodes.map((node, index) => (node.isCore ? index : -1)).filter((index) => index >= 0);
  const core1 = coreIndexes[0] ?? 0;
  const core2 = coreIndexes[1] ?? (nodes.length > 1 ? nodes.length - 1 : core1);
  points[core1] = { x: padding, y: padding };
  points[core2] = { x: width - padding, y: padding };

  const transitIndexes = nodes.map((_, index) => index).filter((index) => index !== core1 && index !== core2);
  transitIndexes.forEach((nodeIndex, sequence) => {
    points[nodeIndex] = pointOnThreeSegmentTrack(sequence, transitIndexes.length, width, height, padding, false);
  });
  return points;
}

// Straight horizontal layout for the degraded A-MPLS chain (Cases A & B). Nodes
// are evenly spaced left-to-right on the vertical centre line — never bent into a
// ring. Spacing comes from the caller-sized viewBox so nodes can never overlap.
function calculateLinearChainCoordinates(count: number, width: number, height: number, padding: number): Point[] {
  if (count <= 0) return [];
  const y = height / 2;
  if (count === 1) return [{ x: width / 2, y }];
  const left = padding;
  const step = (width - padding * 2) / (count - 1);
  return Array.from({ length: count }, (_, index) => ({ x: left + step * index, y }));
}

function patchGroupJumperState(
  group: ServiceTraceTopologyGroup | null | undefined,
  node: string,
  isJumper: boolean,
): ServiceTraceTopologyGroup | null | undefined {
  if (!group) return group;
  const target = normalizedNodeLabel(node);
  const displayNode = group.nodes.find((candidate) => normalizedNodeLabel(candidate) === target) ?? node;
  const hasNode = group.nodes.some((candidate) => normalizedNodeLabel(candidate) === target);
  const hasJumper = (group.jumpers ?? []).some((jumper) => normalizedNodeLabel(jumper) === target);
  if (!hasNode && !hasJumper) return group;
  const jumpers = new Set(group.jumpers ?? []);
  for (const jumper of group.jumpers ?? []) {
    if (normalizedNodeLabel(jumper) === target) jumpers.delete(jumper);
  }
  if (isJumper) jumpers.add(displayNode);
  return { ...group, jumpers: [...jumpers] };
}

function patchGroupsJumperState(
  groups: ServiceTraceTopologyGroup[] | undefined,
  node: string,
  isJumper: boolean,
): ServiceTraceTopologyGroup[] | undefined {
  return groups?.map((group) => patchGroupJumperState(group, node, isJumper)!);
}

function patchTraceJumperState(trace: ServiceTraceResult, node: string, isJumper: boolean): ServiceTraceResult {
  const target = normalizedNodeLabel(node);
  return {
    ...trace,
    hops: trace.hops.map((hop) => {
      const hopKey = normalizedNodeLabel(hop.siteLabel ?? hop.siteCode ?? "");
      return hopKey === target ? { ...hop, isJumper } : hop;
    }),
    mainRingPath: patchGroupJumperState(trace.mainRingPath, node, isJumper) ?? null,
    attachedSingleHomed: patchGroupsJumperState(trace.attachedSingleHomed, node, isJumper),
    attachedSubrings: patchGroupsJumperState(trace.attachedSubrings, node, isJumper),
    attachedSpurs: patchGroupsJumperState(trace.attachedSpurs, node, isJumper),
    attachedSpurChains: patchGroupsJumperState(trace.attachedSpurChains, node, isJumper),
    attachedInterconnects: patchGroupsJumperState(trace.attachedInterconnects, node, isJumper),
    reviewItems: patchGroupsJumperState(trace.reviewItems, node, isJumper),
  };
}

// Horizontal rectangular "racetrack" layout. Boundary (PE/Core/DC) nodes sit at the
// top corners; the path runs down the left side, across the bottom, and up the right
// side — open at the top for an A-MPLS horseshoe, a closed rectangle for a real ring.
// Stretches along X and compresses Y to use wide-desktop real estate. Double-click a
// node to flag it (solid red) as "Ready for Integration".
function RingTopology({
  group,
  onToggleJumper,
  busyNode,
}: {
  group: ServiceTraceTopologyGroup;
  onToggleJumper?: (node: string, currentlyJumper: boolean) => void;
  busyNode?: string | null;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [contextNode, setContextNode] = useState<{ node: string; isJumper: boolean; point: Point } | null>(null);
  const clickTimer = useRef<number | null>(null);
  const raw = group.nodes;
  const closed = Boolean(group.isClosedRing);
  const nodes = closed && raw.length > 1 && raw[0] === raw[raw.length - 1] ? raw.slice(0, -1) : raw;
  const n = nodes.length;
  const coreSet = new Set([...(group.coreNodes ?? []), ...(group.peNodes ?? [])].map(normalizedNodeLabel));
  const jumperSet = new Set((group.jumpers ?? []).map(normalizedNodeLabel));
  const renderNodes: TopologyRenderNode[] = nodes.map((node) => {
    const clean = cleanNodeLabel(node);
    const key = normalizedNodeLabel(node);
    return { raw: node, clean, isCore: coreSet.has(key), isJumper: jumperSet.has(key) || JUMPER_LABEL_RE.test(node) };
  });
  const vbW = Math.max(700, Math.min(1700, 420 + Math.max(0, n - 2) * 128));
  const vbH = Math.max(310, Math.min(520, 250 + Math.ceil(Math.max(0, n - 4) / 4) * 42));
  const coreCount = renderNodes.filter((node) => node.isCore).length;
  // Subring panels: the rectangle is anchored by the MAIN-RING uplink node(s)
  // (delivered as group.junctions), not by core-ness — subring anchors are plain
  // ATNs. Dual-anchor: both anchors pin to the TOP line corners and the closing
  // top edge is the main-ring arc. Single-anchor: the lone main-ring node takes
  // the top-line slot. Downlink nodes settle on the remaining three sides.
  const isSubringPanel = String(group.topologyRole) === "SUBRING";
  const anchorKeys = new Set((group.junctions ?? []).map(normalizedNodeLabel));
  const anchorIndexes = isSubringPanel
    ? renderNodes.map((node, index) => (anchorKeys.has(normalizedNodeLabel(node.raw)) ? index : -1)).filter((index) => index >= 0)
    : [];
  const useDualHomed = anchorIndexes.length >= 2 || (coreCount >= 2 && String(group.topologyRole) !== "SINGLE_HOMED");
  const layoutNodes = anchorIndexes.length
    ? renderNodes.map((node, index) => ({ ...node, isCore: anchorIndexes.includes(index) }))
    : renderNodes;
  let coordinates = useDualHomed
    ? calculateDualHomedCoordinates(layoutNodes, vbW, vbH)
    : calculateSingleHomedCoordinates(layoutNodes, vbW, vbH);
  if (!useDualHomed && anchorIndexes.length === 1) {
    // Single-anchor subring: the lone main-ring node holds the TOP line alone;
    // downlinks run a left-bottom-right loop that starts BELOW the top corners,
    // so no downlink ever shares the top line. The first/last hop edges form a
    // short shared neck under the anchor before splitting left/right — the same
    // visual language as the unified canvas' closed single-anchor subring.
    const anchor = anchorIndexes[0];
    const padding = 96;
    const sideInset = 40;
    const left = padding;
    const right = vbW - padding;
    const top = padding;
    const bottom = vbH - padding;
    const sideTop = top + sideInset;
    const vertical = Math.max(0, bottom - sideTop);
    const horizontal = right - left;
    const trackLength = vertical + horizontal + vertical;
    const transitCount = n - 1;
    const pointAt = (position: number): Point => {
      if (position <= vertical) return { x: left, y: sideTop + position };
      if (position <= vertical + horizontal) return { x: left + (position - vertical), y: bottom };
      return { x: right, y: bottom - (position - vertical - horizontal) };
    };
    coordinates = renderNodes.map((_, index) => {
      if (index === anchor) return { x: vbW / 2, y: top };
      const seq = ((index - anchor - 1) % n + n) % n;
      const position = transitCount <= 1 ? trackLength / 2 : (seq / (transitCount - 1)) * trackLength;
      return pointAt(position);
    });
  }
  const pos = (i: number) => coordinates[i] ?? { x: vbW / 2, y: vbH / 2 };
  const edgeCount = closed ? n : Math.max(0, n - 1);
  const edgeKm = (i: number): number | null =>
    (i < n - 1 ? group.segments[i]?.distanceKm : group.segments[n - 1]?.distanceKm) ?? null;
  const editable = Boolean(onToggleJumper);
  const openContext = (node: string, isJumper: boolean, point: Point) => {
    if (!editable) return;
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      setContextNode({ node, isJumper, point });
      clickTimer.current = null;
    }, 180);
  };
  const toggleProvisionTarget = (node: string) => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
    setContextNode(null);
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  };
  const menuW = 172;
  const menuH = 66;
  const menuX = contextNode ? Math.min(Math.max(contextNode.point.x + 16, 8), vbW - menuW - 8) : 0;
  const menuY = contextNode ? Math.min(Math.max(contextNode.point.y - menuH / 2, 8), vbH - menuH - 8) : 0;

  return (
    <div className="service-topology-ring mt-3 overflow-x-auto">
      <svg
        viewBox={`0 0 ${vbW} ${vbH}`}
        width="100%"
        style={{ maxWidth: Math.min(vbW, 1240), height: "auto" }}
        role="img"
        aria-label={`Ring topology ${group.fullPathLabel}`}
        onClick={() => setContextNode(null)}
      >
        {Array.from({ length: edgeCount }).map((_, i) => {
          const a = pos(i);
          const b = pos((i + 1) % n);
          const km = edgeKm(i);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={`edge-${i}`}>
              <path
                d={
                  Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1
                    ? `M ${a.x} ${a.y} L ${b.x} ${b.y}`
                    : a.y < b.y
                      ? `M ${a.x} ${a.y} V ${b.y} H ${b.x}`
                      : `M ${a.x} ${a.y} H ${b.x} V ${b.y}`
                }
                fill="none"
                stroke="#22c55e"
                strokeWidth={2.25}
                opacity={0.85}
                strokeLinecap="butt"
                strokeLinejoin="miter"
              />
              <rect x={mx - 24} y={my - 8} width={48} height={15} rx={4} fill="var(--surface, #ffffff)" opacity={0.92} />
              <text x={mx} y={my + 3} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--muted-text, #64748b)">
                {km != null ? `${km} km` : "–"}
              </text>
            </g>
          );
        })}
        {renderNodes.map((node, i) => {
          const p = pos(i);
          const role = selectStencil(node);
          const isFlagged = flagged.has(node.clean);
          return (
            <StencilNode
              key={`node-${node.raw}-${i}`}
              node={node}
              point={p}
              role={role}
              clipId={`${gid}-label-${i}`}
              busy={busyNode === node.clean}
              flagged={isFlagged}
              editable={editable}
              onClick={(event) => {
                event.stopPropagation();
                openContext(node.clean, node.isJumper, p);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                toggleProvisionTarget(node.clean);
              }}
            />
          );
        })}
        {contextNode ? (
          <g transform={`translate(${menuX} ${menuY})`} onClick={(event) => event.stopPropagation()}>
            <rect width={menuW} height={menuH} rx={8} fill="#0f172a" stroke="#38bdf8" strokeWidth={1.4} opacity={0.97} />
            <text x={12} y={19} fontSize={11} fontWeight={800} fill="#e2e8f0">
              {contextNode.node}
            </text>
            <g
              role="button"
              tabIndex={0}
              onClick={() => {
                onToggleJumper?.(contextNode.node, contextNode.isJumper);
                setContextNode(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggleJumper?.(contextNode.node, contextNode.isJumper);
                  setContextNode(null);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <rect x={10} y={29} width={108} height={24} rx={6} fill="#2563eb" />
              <text x={64} y={45} textAnchor="middle" fontSize={11} fontWeight={800} fill="#ffffff">
                Toggle Jumper
              </text>
            </g>
            <g onClick={() => setContextNode(null)} style={{ cursor: "pointer" }}>
              <rect x={126} y={29} width={36} height={24} rx={6} fill="#334155" />
              <text x={144} y={45} textAnchor="middle" fontSize={11} fontWeight={800} fill="#ffffff">
                Close
              </text>
            </g>
          </g>
        ) : null}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
        <span>{closed ? "Closed ring" : "A-MPLS PE to PE"} / {n} sites / rectangular track</span>
        <span>PE/Core/DC = blue stencil / ATN = access stencil / jumper = Jumper stencil</span>
        <span className="text-red-600 dark:text-red-400">single-click = configure / double-click = Ready for Integration</span>
      </div>
    </div>
  );
}

// Straight linear chain on the SVG canvas for the DEGRADED A-MPLS cases:
//   • Case A — zero Core/DC/PE endpoints: every node draws with the ATN stencil
//     (jumper stencil for intermediate jumper hops).
//   • Case B — exactly one Core/DC/PE endpoint: that node draws with the PE
//     stencil; all others use ATN / jumper stencils.
// Stencil choice is delegated entirely to selectStencil() so the rules stay
// centralized. Layout is always a horizontal line (never a ring). Same
// single-click "Toggle Jumper" interaction as the ring layout for parity.
function LinearChainTopology({
  group,
  onToggleJumper,
  busyNode,
}: {
  group: ServiceTraceTopologyGroup;
  onToggleJumper?: (node: string, currentlyJumper: boolean) => void;
  busyNode?: string | null;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [contextNode, setContextNode] = useState<{ node: string; isJumper: boolean; point: Point } | null>(null);
  const clickTimer = useRef<number | null>(null);
  const nodes = group.nodes;
  const n = nodes.length;
  const coreSet = new Set([...(group.coreNodes ?? []), ...(group.peNodes ?? [])].map(normalizedNodeLabel));
  const jumperSet = new Set((group.jumpers ?? []).map(normalizedNodeLabel));
  const renderNodes: TopologyRenderNode[] = nodes.map((node) => {
    const clean = cleanNodeLabel(node);
    const key = normalizedNodeLabel(node);
    return { raw: node, clean, isCore: coreSet.has(key), isJumper: jumperSet.has(key) || JUMPER_LABEL_RE.test(node) };
  });
  // Width scales with node count so stencils never collide; container scrolls
  // horizontally for long chains (same pattern as the ring layout).
  const padding = 90;
  const spacing = 168;
  const vbW = Math.max(560, padding * 2 + (n - 1) * spacing);
  const vbH = 230;
  const coordinates = calculateLinearChainCoordinates(n, vbW, vbH, padding);
  const pos = (i: number) => coordinates[i] ?? { x: vbW / 2, y: vbH / 2 };
  const edgeKm = (i: number): number | null => group.segments[i]?.distanceKm ?? null;
  const editable = Boolean(onToggleJumper);
  const openContext = (node: string, isJumper: boolean, point: Point) => {
    if (!editable) return;
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      setContextNode({ node, isJumper, point });
      clickTimer.current = null;
    }, 180);
  };
  const toggleProvisionTarget = (node: string) => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
    setContextNode(null);
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  };
  const coreCount = renderNodes.filter((node) => node.isCore).length;
  const caseLabel = coreCount === 0 ? "Case A — no core endpoint" : "Case B — one core/DC/PE endpoint";
  const menuW = 172;
  const menuH = 66;
  const menuX = contextNode ? Math.min(Math.max(contextNode.point.x + 16, 8), vbW - menuW - 8) : 0;
  const menuY = contextNode ? Math.min(Math.max(contextNode.point.y - menuH / 2, 8), vbH - menuH - 8) : 0;

  return (
    <div className="service-topology-ring mt-3 overflow-x-auto">
      <svg
        viewBox={`0 0 ${vbW} ${vbH}`}
        width="100%"
        style={{ maxWidth: Math.min(vbW, 1240), height: "auto" }}
        role="img"
        aria-label={`A-MPLS linear chain ${group.fullPathLabel}`}
        onClick={() => setContextNode(null)}
      >
        {Array.from({ length: Math.max(0, n - 1) }).map((_, i) => {
          const a = pos(i);
          const b = pos(i + 1);
          const km = edgeKm(i);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={`edge-${i}`}>
              <path d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} fill="none" stroke="#22c55e" strokeWidth={2.25} opacity={0.85} strokeLinecap="butt" />
              <rect x={mx - 24} y={my - 18} width={48} height={15} rx={4} fill="var(--surface, #ffffff)" opacity={0.92} />
              <text x={mx} y={my - 7} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--muted-text, #64748b)">
                {km != null ? `${km} km` : "–"}
              </text>
            </g>
          );
        })}
        {renderNodes.map((node, i) => {
          const p = pos(i);
          const role = selectStencil(node); // centralized PE / ATN / jumper rule
          const isFlagged = flagged.has(node.clean);
          return (
            <StencilNode
              key={`node-${node.raw}-${i}`}
              node={node}
              point={p}
              role={role}
              clipId={`${gid}-label-${i}`}
              busy={busyNode === node.clean}
              flagged={isFlagged}
              editable={editable}
              onClick={(event) => {
                event.stopPropagation();
                openContext(node.clean, node.isJumper, p);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                toggleProvisionTarget(node.clean);
              }}
            />
          );
        })}
        {contextNode ? (
          <g transform={`translate(${menuX} ${menuY})`} onClick={(event) => event.stopPropagation()}>
            <rect width={menuW} height={menuH} rx={8} fill="#0f172a" stroke="#38bdf8" strokeWidth={1.4} opacity={0.97} />
            <text x={12} y={19} fontSize={11} fontWeight={800} fill="#e2e8f0">
              {contextNode.node}
            </text>
            <g
              role="button"
              tabIndex={0}
              onClick={() => {
                onToggleJumper?.(contextNode.node, contextNode.isJumper);
                setContextNode(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggleJumper?.(contextNode.node, contextNode.isJumper);
                  setContextNode(null);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <rect x={10} y={29} width={108} height={24} rx={6} fill="#2563eb" />
              <text x={64} y={45} textAnchor="middle" fontSize={11} fontWeight={800} fill="#ffffff">
                Toggle Jumper
              </text>
            </g>
            <g onClick={() => setContextNode(null)} style={{ cursor: "pointer" }}>
              <rect x={126} y={29} width={36} height={24} rx={6} fill="#334155" />
              <text x={144} y={45} textAnchor="middle" fontSize={11} fontWeight={800} fill="#ffffff">
                Close
              </text>
            </g>
          </g>
        ) : null}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
        <span>A-MPLS linear chain / {n} sites / {caseLabel}</span>
        <span>PE/Core/DC = blue stencil / ATN = access stencil / jumper = Jumper stencil</span>
        <span className="text-red-600 dark:text-red-400">single-click = configure / double-click = Ready for Integration</span>
      </div>
    </div>
  );
}

// Site SVG icon used for the plain (non-A-MPLS-canvas) trace chains. Sourced from
// the portable site-stencil dir so it moves with the app. The locked A-MPLS SVG
// canvases (RingTopology / LinearChainTopology / UnifiedTopologyCanvas) keep
// their PE / ATN / Jumper Canvas Icons — only the "normal box" chains use this.
const SITE_CHAIN_ICON = SVG_STENCILS.site.href;

// Enlarged tower / reduced jumper footprints for the secondary trace-search
// canvas (TraceCanvasTrailRenderer). Passed as StencilNode size overrides so the
// A-MPLS MAX_STENCIL_* geometry constants (and the locked canvas) are untouched.
const TRACE_TOWER_SIZE = { w: 132, h: 132 };
const TRACE_JUMPER_SIZE = { w: 84, h: 58 };

/**
 * A single node in a plain trace chain, rendered as the Site SVG icon with the
 * site name beneath (replacing the former dark box). Presentational only — it
 * carries through the same click / keyboard / title affordances the boxes had,
 * so jumper toggling and tooltips are unchanged.
 *
 * Artwork rule (non-A-MPLS chains only — the A-MPLS canvases keep their own
 * stencil selection): a jumper-toggled site swaps to Jumper.svg, drawn smaller
 * than the telecom tower (the tower must always read bigger). MPLS-core chains
 * pass icon="pe" so untoggled sites draw the PE artwork instead of the tower.
 */
function SiteChainNode({
  label,
  isJumper = false,
  isJunction = false,
  icon = "site",
  editable = false,
  busy = false,
  onClick,
  onKeyDown,
  title,
}: {
  label: string;
  isJumper?: boolean;
  isJunction?: boolean;
  /** Base artwork when the site is NOT a jumper: telecom tower or PE (MPLS core). */
  icon?: "site" | "pe";
  editable?: boolean;
  busy?: boolean;
  onClick?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  title?: string;
}) {
  // Dark mode uses the hard-wired dark tower artwork (the default is low-contrast
  // on the deep-navy surface); light mode keeps the standard Site.svg.
  const isDark = useIsDarkMode();
  const iconSrc = isJumper
    ? SVG_STENCILS.jumper.href
    : icon === "pe"
      ? SVG_STENCILS.pe.href
      : isDark ? SITE_STENCIL_DARK_HREF : SITE_CHAIN_ICON;
  const iconClass = isJumper
    ? "topology-site-node-icon topology-site-node-icon-jumper"
    : icon === "pe"
      ? "topology-site-node-icon topology-site-node-icon-pe"
      : "topology-site-node-icon";
  return (
    <div
      className={`topology-site-node ${editable ? "topology-site-node-editable" : ""} ${busy ? "topology-site-node-busy" : ""}`}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
    >
      <span className="topology-site-node-icon-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={iconClass} src={iconSrc} alt="" draggable={false} />
        {isJumper ? <span className="topology-site-node-badge" aria-label="Jumper">⤧</span> : null}
        {isJunction ? <span className="topology-site-node-badge topology-site-node-badge-junction" aria-hidden>⤴</span> : null}
      </span>
      <span className="topology-site-node-label">{label}</span>
    </div>
  );
}

/**
 * MPLS CORE link/service detection for the plain chip chains. Matches an "MPLS"
 * link tag while explicitly excluding A-MPLS — the A-MPLS canvases and rules are
 * a separate, locked surface. Core-MPLS chains draw PE artwork on their sites.
 */
function isMplsCoreTag(tag?: string | null): boolean {
  const value = String(tag ?? "");
  return /mpls/i.test(value) && !/a[\s_-]?mpls/i.test(value);
}

function linksAreMplsCore(links?: Array<{ tag?: string | null }> | null): boolean {
  return Boolean(links?.some((link) => isMplsCoreTag(link.tag)));
}

function TopologyChain({
  group,
  onToggleJumper,
  busyNode,
  mplsCore = false,
}: {
  group: ServiceTraceTopologyGroup;
  /** When provided, each node becomes an interactive jumper toggle. */
  onToggleJumper?: (node: string, currentlyJumper: boolean) => void;
  busyNode?: string | null;
  /** True when the traced service is MPLS core — chain sites draw PE artwork. */
  mplsCore?: boolean;
}) {
  // Ring-style groups (a real closed ring, or an A-MPLS core<->core path — Case C)
  // render as a circle/horseshoe instead of a horizontal line.
  if ((group.renderAsRing || String(group.topologyRole) === "SINGLE_HOMED") && group.nodes.length >= 3) {
    return <RingTopology group={group} onToggleJumper={onToggleJumper} busyNode={busyNode} />;
  }
  // Degraded A-MPLS chain (Case A: no core endpoint / Case B: one core endpoint).
  // Still rendered on the SVG canvas, but as a STRAIGHT LINEAR chain with PE/ATN/
  // jumper stencils instead of falling back to the plain text chain below.
  if (group.renderAsLinearChain && group.nodes.length >= 2) {
    return <LinearChainTopology group={group} onToggleJumper={onToggleJumper} busyNode={busyNode} />;
  }
  const isSingleHomed = String(group.topologyRole) === "SINGLE_HOMED";
  const showClosure = Boolean(group.isClosedRing && group.nodes[0] !== group.nodes[group.nodes.length - 1]);
  // MPLS-core chains draw the PE artwork on every (non-jumper) site.
  const baseIcon = mplsCore || linksAreMplsCore(group.links) ? "pe" as const : "site" as const;
  return (
    <div className={`service-topology-line mt-3 ${isSingleHomed ? "topology-single-homed" : ""}`}>
      {group.nodes.map((node, nodeIndex) => {
        const isJumper = group.jumpers?.includes(node) ?? /\(\s*jumper\s*\)/i.test(node);
        const isJunction = group.junctions?.includes(node);
        const cleanNode = node.replace(/\s*\(\s*jumper\s*\)/i, "").trim();
        const editable = Boolean(onToggleJumper);
        const isBusy = busyNode === cleanNode;
        return (
        <Fragment key={`${node}-${nodeIndex}`}>
          <SiteChainNode
            label={cleanNode}
            isJumper={isJumper}
            isJunction={isJunction}
            icon={baseIcon}
            editable={editable}
            busy={isBusy}
            onClick={editable ? () => onToggleJumper!(cleanNode, isJumper) : undefined}
            onKeyDown={editable ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleJumper!(cleanNode, isJumper); } } : undefined}
            title={
              editable
                ? `${isJumper ? "Clear jumper on" : "Mark as jumper:"} ${cleanNode}`
                : isJumper
                ? `Passive jumper — fibers cross-connect straight through ${cleanNode}; no local drop`
                : isJunction
                  ? `Junction — subring/spur attaches at ${cleanNode}`
                  : cleanNode
            }
          />
          {nodeIndex < group.nodes.length - 1 ? (
            <div className="service-topology-edge">
              <span>{group.segments[nodeIndex]?.distanceKm != null ? `${group.segments[nodeIndex]!.distanceKm} km` : "–"}</span>
            </div>
          ) : null}
        </Fragment>
        );
      })}
      {showClosure ? (
        <>
          <div className="service-topology-edge service-topology-edge-closing"><span>closes</span></div>
          <SiteChainNode label={`↺ ${group.ringClosesAt}`} icon={baseIcon} title={`Ring closes back to ${group.ringClosesAt}`} />
        </>
      ) : null}
    </div>
  );
}

function feedSummary(feed?: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null; portLabel?: string | null } | null): string {
  if (!feed) return "-";
  return [feed.siteCode, feed.rackCode, feed.odfCode, feed.portLabel].filter(Boolean).join(" / ") || "-";
}

/**
 * Context A panel — linear line view. The trace runs through the single
 * allocated splitter output port: Site A -> Splitter Node -> Customer Site.
 */
function SplitterLinearPath({ forks }: { forks?: SplitterTraceFork[] }) {
  if (!forks?.length) return null;
  return (
    <div className="card border-cyan-500/25 bg-cyan-500/5 p-5">
      <div className="flex items-center gap-2">
        <Split className="h-5 w-5 text-cyan-500" />
        <div className="section-title">Splitter Path — Allocated Port</div>
      </div>
      <div className="subtle mt-1">Routed through the single allocated splitter output port. Unassigned output ports are not shown.</div>
      <div className="mt-4 space-y-4">
        {forks.map((fork) => {
          const group = fork.groups[0];
          const chainNodes = group?.pathLabel.split(" -> ").filter(Boolean) ?? [];
          return (
            <div key={fork.splitterId} className="topology-attachment-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge topology-role-main-ring">{fork.splitterType}</span>
                <span className="text-sm font-semibold text-slate-950 dark:text-white">{fork.splitterCode}</span>
                {fork.locationContext ? <span className="subtle text-xs">{fork.locationContext}</span> : null}
                {group?.outputPort ? <span className="badge badge-active">Port {group.outputPort}</span> : null}
                {group?.serviceCode ? <span className="badge badge-spare">{group.serviceCode}</span> : null}
              </div>
              <div className="service-topology-line mt-3">
                {chainNodes.map((node, index) => (
                  <Fragment key={`${node}-${index}`}>
                    <SiteChainNode label={node} isJunction={index === 1 && chainNodes.length >= 2} title={node} />
                    {index < chainNodes.length - 1 ? <div className="service-topology-edge"><span>{index === 0 ? "feed" : "drop"}</span></div> : null}
                  </Fragment>
                ))}
              </div>
              <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                <div><span className="subtle">Input feed:</span> <span className="font-medium">{feedSummary(fork.inputFeed)}</span></div>
                {fork.protectionFeed ? <div><span className="subtle">Protection feed:</span> <span className="font-medium">{feedSummary(fork.protectionFeed)}</span></div> : null}
                <div><span className="subtle">Local drop:</span> <span className="font-medium">{[group?.localRackCode, group?.localOdfCode, group?.localPortLabel].filter(Boolean).join(" / ") || "-"}</span></div>
                {group?.sharingCustomerServiceId ? <div><span className="subtle">Sharing customer service:</span> <span className="font-medium">{group.sharingCustomerServiceId}</span></div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Context B panels — physical trail fork view. Group 1 is the main feeder
 * trunk; every active output port renders as its own Spur dashboard panel.
 */
const SplitterForkPanels = memo(function SplitterForkPanels({ forks }: { forks?: SplitterTraceFork[] }) {
  if (!forks?.length) return null;
  return (
    <div className="space-y-5">
      {forks.map((fork) => {
        const trunk = fork.groups.find((group) => group.role === "MAIN_TRUNK");
        const spurs = fork.groups.filter((group) => group.role === "SPUR");
        return (
          <div key={fork.splitterId} className="card border-amber-500/25 bg-amber-500/5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Split className="h-5 w-5 text-amber-500" />
                <div className="section-title">Splitter Fork — {fork.splitterCode}</div>
                <span className="badge topology-role-main-ring">{fork.splitterType}</span>
                {fork.locationContext ? <span className="subtle text-xs">{fork.locationContext}</span> : null}
              </div>
              <span className="badge topology-role-spur">{spurs.length} active output branch{spurs.length === 1 ? "" : "es"}</span>
            </div>
            {trunk ? (
              <div className="topology-attachment-card mt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge topology-role-main-ring">Group 1</span>
                  <span className="text-sm font-semibold text-slate-950 dark:text-white">Main feeder trunk</span>
                </div>
                <div className="mt-2 font-mono text-xs text-slate-700 dark:text-slate-300">{trunk.pathLabel}</div>
                <div className="mt-2 text-sm"><span className="subtle">Input boundary:</span> <span className="font-medium">{feedSummary(fork.inputFeed)}</span></div>
                {fork.protectionFeed ? <div className="mt-1 text-sm"><span className="subtle">Protection boundary:</span> <span className="font-medium">{feedSummary(fork.protectionFeed)}</span></div> : null}
              </div>
            ) : null}
            {spurs.length ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {spurs.map((spur, index) => (
                  <div key={`${fork.splitterId}-spur-${spur.outputPort ?? index}`} className="topology-attachment-card border border-amber-400/30">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge topology-role-spur">Spur {index + 1}</span>
                      <span className="text-sm font-semibold text-slate-950 dark:text-white">Port {spur.outputPort ?? "?"}</span>
                      {spur.status ? <span className="badge badge-spare text-[10px]">{spur.status}</span> : null}
                    </div>
                    <div className="mt-2 font-mono text-xs text-slate-700 dark:text-slate-300">{spur.pathLabel}</div>
                    <div className="mt-2 space-y-1 text-xs">
                      {spur.serviceCode ? <div><span className="subtle">Service:</span> <span className="font-semibold">{spur.serviceCode}</span></div> : null}
                      {spur.sharingCustomerServiceId ? <div><span className="subtle">Sharing:</span> {spur.sharingCustomerServiceId}</div> : null}
                      <div><span className="subtle">Local drop:</span> {[spur.localRackCode, spur.localOdfCode, spur.localPortLabel].filter(Boolean).join(" / ") || "-"}</div>
                      {spur.destinationSite || spur.destinationLabel ? <div><span className="subtle">Destination:</span> {[spur.destinationSite, spur.destinationLabel].filter(Boolean).join(" — ")}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="subtle mt-3 text-sm">No active output ports configured on this splitter.</div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const TopologyGroupPanel = memo(function TopologyGroupPanel({
  title,
  groups,
  roleKey,
  onToggleJumper,
  busyNode,
  mplsCore = false,
}: {
  title: string;
  groups?: ServiceTraceTopologyGroup[];
  roleKey: keyof typeof ROLE_TONES;
  onToggleJumper?: (node: string, currentlyJumper: boolean) => void;
  busyNode?: string | null;
  /** True when the traced service is MPLS core — chain sites draw PE artwork. */
  mplsCore?: boolean;
}) {
  if (!groups?.length) return null;
  const tones = ROLE_TONES[roleKey] ?? ROLE_TONES.REVIEW;
  return (
    <div className={`card p-5 border ${tones.panel}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitBranch className={`h-4 w-4 ${tones.accent}`} />
          <div className="section-title">{title}</div>
        </div>
        <span className={`badge ${tones.badge}`}>{groups.length} group{groups.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="mt-4 space-y-4">
        {groups.map((group, index) => (
          <div key={`${group.topologyRole}-${group.fullPathLabel}-${index}`} className="topology-attachment-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-950 dark:text-white">
                    {group.topologyLabel} Group {index + 1}
                  </span>
                  <ShapeBadge group={group} />
                  {group.junctions?.length ? (
                    <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-200">
                      {group.junctions.length} junction{group.junctions.length !== 1 ? "s" : ""}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 font-mono text-xs font-semibold text-slate-600 dark:text-slate-300 leading-relaxed">
                  {group.fullPathLabel || "Unsequenced group"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--text-main)]">
                  {Math.round((group.totalDistanceKm ?? 0) * 100) / 100} km
                </span>
                <span className="rounded-full border border-white/10 bg-white/8 px-2.5 py-1 text-xs text-slate-400">
                  {group.nodes.length} site{group.nodes.length !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
            <TopologyChain group={group} onToggleJumper={onToggleJumper} busyNode={busyNode} mplsCore={mplsCore} />
            {group.branches?.length ? (
              <div className="mt-3 rounded-xl border border-dashed border-amber-400/40 bg-amber-500/5 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">
                  Off-main branches
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {group.branches.map((branch, bi) => (
                    <span key={`${branch.fromSite}-${branch.toSite}-${bi}`} className="rounded-lg border border-border bg-white/5 px-2.5 py-1 text-xs">
                      {branch.fromSite} → {branch.toSite}
                      {branch.distanceKm != null ? ` · ${branch.distanceKm} km` : ""}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});

function TraceStatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: string;
}) {
  return (
    <div className="trace-stat-card">
      <div className="flex items-center justify-between">
        <div className="trace-stat-label">{label}</div>
        {Icon ? <Icon className={`h-4 w-4 ${tone ?? "text-slate-400"}`} /> : null}
      </div>
      <div className={`trace-stat-value ${tone ?? ""}`}>{value}</div>
      {sub ? <div className="trace-stat-sub">{sub}</div> : null}
    </div>
  );
}

function kmLabel(value: number | null | undefined): string {
  return `${Math.round(Number(value ?? 0) * 100) / 100} km`;
}

/**
 * Compose the human-readable deployment-instructions text for a Detailed Trace,
 * used as the editable body of the Email Report. Reads only from the already
 * rendered preview data — no trace-core coupling.
 */
function buildTraceReportText(preview: PathPreview, nearSite: string, farSite: string): string {
  const lines: string[] = [];
  lines.push("DEPLOYMENT INSTRUCTIONS — Detailed Trace");
  if (nearSite || farSite) lines.push(`Route: ${nearSite || "?"} → ${farSite || "?"}`);
  if (preview.path) lines.push(`Path: ${preview.path}`);
  lines.push(
    `Matched hops: ${preview.matchedHops}   Missing: ${preview.missingHops}` +
      (preview.totalDistanceKm ? `   Total distance: ${preview.totalDistanceKm} km` : ""),
  );
  lines.push("");
  lines.push("Segment plan:");
  preview.hops.forEach((hop, index) => {
    const segment = hop.segmentCode ?? (hop.matched ? "-" : "NO MATCHING SEGMENT");
    const km = hop.distanceKm != null ? `${hop.distanceKm} km` : "-";
    const cumulative = hop.cumulativeDistanceKm != null ? ` (cum ${hop.cumulativeDistanceKm} km)` : "";
    const status = hop.status ? ` | ${hop.status}` : "";
    lines.push(`${String(index + 1).padStart(2, "0")}. ${hop.from} → ${hop.to} | segment ${segment} | ${km}${cumulative}${status}`);
  });
  return lines.join("\n");
}

function IndirectTraceSummaryPanel({ summaryData }: { summaryData: IndirectRouteSummary }) {
  return (
    <div className="mt-4 rounded-xl border border-cyan-400/25 bg-cyan-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-400/20 pb-3">
        <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
          Total {summaryData.totalJumpersInvolved} jumpers will be involved. Cumulative Distance: {kmLabel(summaryData.cumulativeDistance)}
        </div>
        <span className="badge badge-active">{summaryData.path.length} transit sites</span>
      </div>
      <div className="mt-3 grid gap-2">
        {summaryData.path.map((hop, index) => (
          <div key={`${hop.siteId}-${index}`} className="grid gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs sm:grid-cols-[44px_minmax(0,1fr)_150px_120px]">
            <span className="font-mono font-bold text-cyan-500">{String(index + 1).padStart(2, "0")}</span>
            <span className="min-w-0">
              <span className="font-semibold text-slate-900 dark:text-white">{hop.siteId}</span>
              {hop.siteName && hop.siteName !== hop.siteId ? <span className="ml-2 text-slate-500 dark:text-slate-400">{hop.siteName}</span> : null}
              {hop.isJumper ? <span className="ml-2 rounded-full bg-amber-400/15 px-2 py-0.5 font-bold text-amber-600 dark:text-amber-200">Jumper</span> : null}
            </span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">{hop.availablePortsCount} available ports</span>
            <span className="text-slate-500 dark:text-slate-400">{index === 0 ? "Origin" : kmLabel(hop.segmentDistance)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Build the graphical chain for a DIRECT (segment-matched) trail preview so every
 * trace query renders BOTH the tabular view and the node-link diagram — not just
 * indirect traces.
 */
function directTrailPath(preview: PathPreview): RouteHop[] {
  const hops = preview.hops;
  if (!hops.length) return [];
  const chain: RouteHop[] = [{
    siteId: hops[0].from,
    siteName: hops[0].from,
    availablePortsCount: hops[0].availableFibers ?? 0,
    segmentDistance: 0,
    isJumper: false,
  }];
  for (const hop of hops) {
    chain.push({
      siteId: hop.to,
      siteName: hop.to,
      availablePortsCount: hop.availableFibers ?? 0,
      segmentDistance: hop.distanceKm ?? 0,
      isJumper: false,
    });
  }
  return chain;
}

/**
 * Topology shown when a Detailed Trace / transport-trail search finds NO direct
 * segment AND no indirect route between the endpoints. Instead of drawing a
 * misleading "0 km" connector, the two sites are joined by a red cross (X) and
 * an explicit unavailability note.
 */
function NoConnectivityTopology({ near, far }: { near: string; far: string }) {
  return (
    <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <div className="service-topology-line justify-center">
        <SiteChainNode label={near || "Near"} title={near} />
        <div className="flex flex-col items-center px-4" role="img" aria-label="No connection between the sites">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-red-500 text-red-500">
            <X className="h-7 w-7" strokeWidth={3} />
          </span>
        </div>
        <SiteChainNode label={far || "Far"} title={far} />
      </div>
      <div className="mt-2 text-center text-sm font-semibold text-red-600 dark:text-red-400">
        No available direct or indirect segments
      </div>
      <div className="mt-0.5 text-center text-[11px] font-medium text-red-500/80">
        Searched up to Max 25 indirect hops
      </div>
    </div>
  );
}

function TraceCanvasTrailRenderer({
  path,
  intermediatesAsJumpers = false,
}: {
  path: RouteHop[];
  /** True for INDIRECT traces: transit sites render the jumper stencil. */
  intermediatesAsJumpers?: boolean;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const isDark = useIsDarkMode();
  if (path.length < 2) return null;
  const padding = 100;
  const spacing = 210;
  const vbW = Math.max(560, padding * 2 + (path.length - 1) * spacing);
  const vbH = 270;
  const points = calculateLinearChainCoordinates(path.length, vbW, vbH, padding);
  // Stencils are decoupled from Service IDs / child-row configuration and driven
  // strictly by PATH POSITION and physical connectivity: boundary nodes (the
  // absolute first and last site) always load the standard Site stencil
  // (public/network-stencils/Site.svg); on an INDIRECT trace every pass-through
  // transit site between them overrides to the jumper stencil
  // (public/network-stencils/Jumper.svg). Site names render strictly BENEATH the
  // icon in solid black.
  const roleFor = (index: number): RingRole =>
    intermediatesAsJumpers && index > 0 && index < path.length - 1 ? "jumper" : "site";
  const renderNodes: TopologyRenderNode[] = path.map((hop, index) => ({
    raw: hop.siteId,
    clean: cleanNodeLabel(hop.siteId),
    isCore: false,
    isJumper: roleFor(index) === "jumper",
  }));

  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-2">
      {/*
        The chain renders at NATIVE 1:1 size and scrolls horizontally instead of
        compressing to fit the container — long multi-hop paths (and multiple
        stacked path charts) stay fully readable at any hop count.
      */}
      <svg viewBox={`0 0 ${vbW} ${vbH}`} width={vbW} height={vbH} style={{ maxWidth: "none", display: "block" }} role="img" aria-label="Indirect trace trail">
        {path.slice(0, -1).map((_, index) => {
          const a = points[index] ?? { x: padding, y: vbH / 2 };
          const b = points[index + 1] ?? { x: padding, y: vbH / 2 };
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={`indirect-edge-${index}`}>
              <path d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} fill="none" stroke="#06b6d4" strokeWidth={3} opacity={0.85} strokeLinecap="round" />
              <rect x={mx - 30} y={my - 24} width={60} height={20} rx={5} fill="var(--surface, #ffffff)" opacity={0.92} />
              <text x={mx} y={my - 10} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="var(--muted-text, #64748b)">
                {kmLabel(path[index + 1]?.segmentDistance)}
              </text>
            </g>
          );
        })}
        {renderNodes.map((node, index) => {
          const role = roleFor(index);
          const isTower = role === "site";
          const size = isTower ? TRACE_TOWER_SIZE : TRACE_JUMPER_SIZE;
          return (
            <StencilNode
              key={`indirect-node-${node.clean}-${index}`}
              node={node}
              point={points[index] ?? { x: vbW / 2, y: vbH / 2 }}
              role={role}
              clipId={`${gid}-indirect-${index}`}
              busy={false}
              flagged={false}
              editable={false}
              labelPlacement="below"
              labelColor={isDark ? "#e2e8f0" : "#000000"}
              href={isTower ? siteStencilForTheme(isDark) : undefined}
              width={size.w}
              height={size.h}
              onClick={() => undefined}
              onDoubleClick={() => undefined}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function ServiceTraceExplorer({ initialTrace, initialService = "" }: { initialTrace: ServiceTraceResult | null; initialService?: string }) {
  const [service, setService] = useState(initialTrace?.serviceCode ?? initialService ?? "");
  const [trace, setTrace] = useState(initialTrace);
  const [transportPath, setTransportPath] = useState("");
  const [transportPathSourceService, setTransportPathSourceService] = useState<string | null>(null);
  const [pathPreview, setPathPreview] = useState<PathPreview | null>(null);
  // The exact trail input that produced the current preview, so the export
  // recomputes the SAME indirect route discovery (not the resolved chain).
  const [previewTrailQuery, setPreviewTrailQuery] = useState<string | null>(null);
  const [allocationInput, setAllocationInput] = useState("");
  const [allocationServiceId, setAllocationServiceId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [detailNearSite, setDetailNearSite] = useState("");
  const [detailNearRack, setDetailNearRack] = useState("");
  const [detailNearOdf, setDetailNearOdf] = useState("");
  const [detailFarSite, setDetailFarSite] = useState("");
  const [detailFarRack, setDetailFarRack] = useState("");
  const [detailFarOdf, setDetailFarOdf] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [isAllocating, setIsAllocating] = useState(false);
  const [jumperBusyNode, setJumperBusyNode] = useState<string | null>(null);
  const [flaggedSitesInput, setFlaggedSitesInput] = useState("");
  const [deployTo, setDeployTo] = useState("");
  const [deployCc, setDeployCc] = useState("");
  const [isDeploying, setIsDeploying] = useState(false);
  const searchRequestIdRef = useRef(0);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  // Wraps the Detailed Trace / Transport Trail Preview canvases so the Email
  // Report module can snapshot whichever topology is currently on screen.
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const visibleTrace = trace;
  const flaggedSites = parseSelectedSiteIds(flaggedSitesInput);
  const flaggedSiteString = formatSelectedSiteIds(flaggedSites);
  // MPLS CORE service detection (A-MPLS explicitly excluded): the chain views
  // draw PE artwork on the sites of a core-MPLS service. Keyed on the Service
  // record's type first, link tags as fallback.
  const mplsCoreService =
    isMplsCoreTag(visibleTrace?.serviceType) || linksAreMplsCore(visibleTrace?.serviceLinks);

  function clearRenderedTraceResults() {
    setTrace(null);
    setPathPreview(null);
    setPreviewTrailQuery(null);
    setJumperBusyNode(null);
  }

  // Retroactive jumper marking from the canvas. Toggles the clicked site as a
  // passive jumper for the active service chain, writes it back, and repaints the
  // topology from the trace returned by the mutation — no page refresh.
  // useCallback keeps this handler referentially stable across re-renders (e.g.
  // typing in the form inputs), so the memoized topology sub-components below do
  // not re-render on every keystroke.
  const toggleJumper = useCallback(async (node: string, currentlyJumper: boolean) => {
    const selectedService = trace?.serviceCode;
    if (!selectedService) {
      setMessage("Trace a service first to mark jumper sites on its chain.");
      return;
    }
    const nextIsJumper = !currentlyJumper;
    setTrace((current) => current ? patchTraceJumperState(current, node, nextIsJumper) : current);
    setJumperBusyNode(node);
    setMessage(null);
    try {
      const response = await fetch("/api/service-trace/jumper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceCode: selectedService, siteCode: node, isJumper: nextIsJumper }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to update jumper marking.");
      if (payload.trace) setTrace(patchTraceJumperState(payload.trace, node, nextIsJumper));
      setMessage(payload.message ?? null);
    } catch (error) {
      setTrace((current) => current ? patchTraceJumperState(current, node, currentlyJumper) : current);
      setMessage(error instanceof Error ? error.message : "Failed to update jumper marking.");
    } finally {
      setJumperBusyNode(null);
    }
  }, [trace?.serviceCode]);
  const canMarkJumper = Boolean(visibleTrace?.serviceCode);

  function updateFlaggedSites(site: string, flagged: boolean) {
    setFlaggedSitesInput((current) => {
      const sites = parseSelectedSiteIds(current);
      if (flagged) return normalizeSelectedSiteIds([...sites, site]).join(", ");
      const target = site.trim().toUpperCase();
      return sites.filter((candidate) => candidate.trim().toUpperCase() !== target).join(", ");
    });
  }

  async function searchTrace(nextService = service) {
    const serviceQuery = nextService.trim();
    const serviceKey = serviceSearchKey(serviceQuery);
    const pathQuery = transportPath.trim();
    const shouldUsePath = Boolean(pathQuery && !transportPathSourceService);

    if (pathQuery && transportPathSourceService && serviceKey && transportPathSourceService !== serviceKey) {
      setTransportPath("");
      setTransportPathSourceService(null);
    }

    if (!serviceQuery && !shouldUsePath) {
      setMessage("Enter a service ID, transport trail/path, or both.");
      return;
    }
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setIsSearching(true);
    setMessage(null);
    clearRenderedTraceResults();
    try {
      const params = new URLSearchParams();
      if (serviceQuery) params.set("service", serviceQuery);
      if (shouldUsePath) params.set("path", pathQuery);
      const response = await fetch(`/api/service-trace?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Trace search failed.");
      if (searchRequestIdRef.current !== requestId) return;
      setTrace(payload.trace);
      setPathPreview(payload.pathPreview ?? null);
      setPreviewTrailQuery(payload.pathPreview && shouldUsePath ? pathQuery : null);
      setMessage(payload.trace || payload.pathPreview ? null : "No trace found.");
    } catch (error) {
      if (searchRequestIdRef.current !== requestId) return;
      setMessage(error instanceof Error ? error.message : "Trace search failed.");
    } finally {
      if (searchRequestIdRef.current === requestId) setIsSearching(false);
    }
  }

  // Deep-link support: when the page is opened with ?service=... (e.g. from a
  // clickable Service ID in ODF Mappings), run that trace once on mount so the
  // operator lands directly on the rendered trace instead of an empty form.
  const didAutoTraceRef = useRef(false);
  useEffect(() => {
    if (didAutoTraceRef.current) return;
    if (initialService.trim() && !initialTrace) {
      didAutoTraceRef.current = true;
      void searchTrace(initialService);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function detailedTrace() {
    if (!detailNearSite.trim() || !detailFarSite.trim()) {
      setMessage("Detailed Trace requires Near End Site and Far End Site.");
      return;
    }
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setIsSearching(true);
    setMessage(null);
    clearRenderedTraceResults();
    try {
      const params = new URLSearchParams({ detailed: "1", nearSite: detailNearSite.trim(), farSite: detailFarSite.trim() });
      if (detailNearRack.trim()) params.set("nearRack", detailNearRack.trim());
      if (detailNearOdf.trim()) params.set("nearOdf", detailNearOdf.trim());
      if (detailFarRack.trim()) params.set("farRack", detailFarRack.trim());
      if (detailFarOdf.trim()) params.set("farOdf", detailFarOdf.trim());
      const response = await fetch(`/api/service-trace?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Detailed trace failed.");
      if (searchRequestIdRef.current !== requestId) return;
      setPathPreview(payload.pathPreview ?? null);
      setPreviewTrailQuery(null); // detailed traces fall back to the resolved chain
      setTrace(payload.trace ?? null);
      setMessage(payload.pathPreview ? null : "No detailed trace match found.");
    } catch (error) {
      if (searchRequestIdRef.current !== requestId) return;
      setMessage(error instanceof Error ? error.message : "Detailed trace failed.");
    } finally {
      if (searchRequestIdRef.current === requestId) setIsSearching(false);
    }
  }

  function exportTracePath() {
    const trail = previewTrailQuery ?? pathPreview?.path;
    if (!trail?.trim()) {
      setMessage("Run a transport trail / site-to-site trace before exporting it.");
      return;
    }
    const params = new URLSearchParams({ type: "trace-path", format: "xlsx", transportTrail: trail.trim() });
    if (flaggedSites.length) params.set("redSites", flaggedSites.join(","));
    window.location.href = `/api/export?${params.toString()}`;
  }

  function exportTrace() {
    const selectedService = trace?.serviceCode ?? service;
    if (!selectedService.trim()) {
      setMessage("Search or allocate a service before exporting its trace.");
      return;
    }
    const params = new URLSearchParams({ type: "trace", format: "xlsx", service: selectedService });
    if (flaggedSites.length) params.set("redSites", flaggedSites.join(","));
    window.location.href = `/api/export?${params.toString()}`;
  }

  async function emailTrace() {
    const selectedService = trace?.serviceCode ?? service;
    if (!selectedService.trim()) {
      setMessage("Search or allocate a service before emailing its trace.");
      return;
    }
    const recipients = window.prompt("Email export to (comma separated):");
    if (!recipients) return;
    setMessage(null);
    const response = await fetch("/api/export/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "trace",
        serviceCode: selectedService,
        recipients,
        includeConfiguredRecipients: window.confirm("Also send to configured portal recipients?"),
      }),
    });
    const payload = await response.json();
    setMessage(response.ok ? payload.message : payload.error ?? "Email export failed.");
  }

  // Emails the "Deployment instructions" template for the red-tagged integration
  // site list: rasterizes the canvas, then lets the server attach the trace data sheet,
  // embed the image inline, resolve TO/CC aliases, and dispatch.
  async function sendDeploymentEmail() {
    const selectedService = trace?.serviceCode ?? "";
    const sites = parseSelectedSiteIds(flaggedSitesInput);
    if (!selectedService.trim()) {
      setMessage("Trace a service before sending deployment instructions.");
      return;
    }
    if (!sites.length) {
      setMessage("Tag integration sites red on the canvas (double-click nodes) or type them below.");
      return;
    }
    setIsDeploying(true);
    setMessage(null);
    try {
      let canvasImage: string | null = null;
      // Pick the topology canvas SVG (not the Lucide toolbar icons) and rasterize
      // it, sanitized of the live navigation dots/handles, for inline embedding.
      const topo = pickTopologySvg(canvasWrapRef.current);
      if (topo) canvasImage = await svgToPngDataUrl(topo);
      const response = await fetch("/api/service-trace/deployment-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceCode: selectedService, siteCodes: sites, to: deployTo, cc: deployCc, canvasImage }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to send deployment instructions.");
      setMessage(payload.message ?? "Deployment instructions sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send deployment instructions.");
    } finally {
      setIsDeploying(false);
    }
  }

  async function releaseService() {
    const selectedService = trace?.serviceCode ?? service;
    if (!selectedService.trim()) {
      setMessage("Search a service before releasing it.");
      return;
    }
    if (!window.confirm(
      `Release service ${selectedService}? This purges the service record and frees all of its ports back to Available. This cannot be undone.`,
    )) return;
    setIsReleasing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/service-allocation/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceCode: selectedService }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Service release failed.");
      // The service no longer exists — clear the trace and re-search the (now
      // released) path so freed ports repaint as Available.
      setTrace(null);
      setPathPreview(null);
      setPreviewTrailQuery(null);
      setTransportPathSourceService(null);
      setMessage(payload.message ?? `Released ${selectedService}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Service release failed.");
    } finally {
      setIsReleasing(false);
    }
  }

  async function allocatePath() {
    if (!allocationInput.trim() || !allocationServiceId.trim()) {
      setMessage("Enter both a service ID and an ordered service path before allocation.");
      return;
    }
    setIsAllocating(true);
    setMessage(null);
    try {
      const response = await fetch("/api/service-allocation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pathInput: allocationInput,
          serviceCode: allocationServiceId,
          serviceName: serviceName.trim() || undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Service allocation failed.");
      setService(payload.serviceCode);
      setMessage(`Allocated ${payload.allocatedSegments.length} fiber pair(s) for ${payload.serviceCode}.`);
      await searchTrace(payload.serviceCode);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Service allocation failed.");
    } finally {
      setIsAllocating(false);
    }
  }

  const isSingleHomed = visibleTrace?.routeType === "SINGLE_HOMED";
  const suppressReviewDashboard = Boolean(visibleTrace?.suppressReviewDashboard);
  const reviewCount = suppressReviewDashboard ? 0 : (visibleTrace?.reviewItems?.length ?? 0) + (visibleTrace?.attachedInterconnects?.length ?? 0);
  const totalBranches =
    (visibleTrace?.attachedSingleHomed?.length ?? 0) +
    (visibleTrace?.attachedSubrings?.length ?? 0) +
    (visibleTrace?.attachedSpurs?.length ?? 0) +
    (visibleTrace?.attachedSpurChains?.length ?? 0);
  // The unified canvas (rectangular main ring + branches) is the primary topology
  // view for rings and for any service that has attached branch groups. When it is
  // shown we suppress the separate per-group main-ring chain to avoid rendering a
  // second, cramped copy of the same ring.
  const showUnified = Boolean(
    visibleTrace?.mainRingPath &&
      visibleTrace.mainRingPath.nodes.length >= 2 &&
      (visibleTrace.mainRingPath.renderAsRing || visibleTrace.mainRingPath.isClosedRing || totalBranches > 0),
  );
  const canSendDeployment = Boolean(visibleTrace?.serviceCode && flaggedSites.length);

  return (
    <div className="space-y-5">
      {/* ── Search bar ── */}
      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Network className="h-4 w-4 text-red-400" />
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Service Trace Search</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SuggestionInput
            kind="services"
            className="input-dark flex-1 min-w-[260px]"
            value={service}
            placeholder="Service ID or name…"
            onChange={(nextValue) => {
              const nextServiceKey = serviceSearchKey(nextValue);
              setService(nextValue);
              if (transportPathSourceService && nextServiceKey !== transportPathSourceService) {
                setTransportPath("");
                setTransportPathSourceService(null);
                setPathPreview(null);
                setPreviewTrailQuery(null);
              }
            }}
            onKeyDown={(event) => { if (event.key === "Enter") void searchTrace(); }}
          />
          <SuggestionInput
            kind="transport-trails"
            className="input-dark flex-[2] min-w-[300px]"
            value={transportPath}
            placeholder="Transport trail/path e.g. DH0055-DH0022-DH0033(Jumper)-DH0023"
            onChange={(nextValue) => {
              setTransportPath(nextValue);
              setTransportPathSourceService(null);
            }}
            onKeyDown={(event) => { if (event.key === "Enter") void searchTrace(); }}
          />
          <button
            className="inline-flex items-center gap-2 rounded-xl bg-red-500 hover:bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
            onClick={() => void searchTrace()}
            disabled={isSearching}
          >
            {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Trace Service
          </button>
          <button
            className="btn btn-ghost"
            onClick={exportTrace}
          >
            <Download className="h-4 w-4" /> Export Excel
          </button>
          <button
            className="btn btn-ghost"
            onClick={emailTrace}
          >
            <Mail className="h-4 w-4" /> Email Export
          </button>
          <button
            className="btn btn-danger-soft"
            onClick={releaseService}
            disabled={isReleasing || !(trace?.serviceCode ?? service).trim()}
            title="Purge this service and free its ports back to Available"
          >
            {isReleasing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />} Release Service
          </button>
        </div>
        {message ? (
          <div className="mt-3 rounded-lg border border-amber-400/30 px-4 py-2.5 text-sm font-medium opacity-50" style={{ backgroundColor: "#0af5c6", color: "#910303" }}>
            {message}
          </div>
        ) : null}
      </div>

      {/* ── Detailed trace ── */}
      <div className="card p-5">
        <div className="mb-1 flex items-center gap-2">
          <MapPin className="h-4 w-4 text-cyan-400" />
          <div className="section-title">Detailed Trace</div>
        </div>
        <div className="subtle mt-0.5">Search by exact near/far site with optional rack and ODF filters.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <SuggestionInput kind="sites" className="input-dark" value={detailNearSite} onChange={setDetailNearSite}
            onKeyDown={(e) => { if (e.key === "Enter") void detailedTrace(); }} placeholder="Near End Site *" />
          <input className="input-dark" value={detailNearRack} onChange={(e) => setDetailNearRack(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void detailedTrace(); }} placeholder="Near End Rack ID" />
          <input className="input-dark" value={detailNearOdf} onChange={(e) => setDetailNearOdf(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void detailedTrace(); }} placeholder="Near End ODF ID" />
          <SuggestionInput kind="sites" className="input-dark" value={detailFarSite} onChange={setDetailFarSite}
            onKeyDown={(e) => { if (e.key === "Enter") void detailedTrace(); }} placeholder="Far End Site *" />
          <input className="input-dark" value={detailFarRack} onChange={(e) => setDetailFarRack(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void detailedTrace(); }} placeholder="Far End Rack ID" />
          <input className="input-dark" value={detailFarOdf} onChange={(e) => setDetailFarOdf(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void detailedTrace(); }} placeholder="Far End ODF ID" />
        </div>
        <button
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-cyan-500 hover:bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors disabled:opacity-50"
          onClick={detailedTrace}
          disabled={isSearching}
        >
          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Detailed Trace
        </button>
      </div>

      {/* Operational controls */}
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="card p-5">
          <div className="mb-1 flex items-center gap-2">
            <Activity className="h-4 w-4 text-red-400" />
            <div className="section-title">Automatic Service Allocation</div>
          </div>
          <div className="subtle mt-0.5">
            Enter a mandatory Service ID and ordered path. The portal validates endpoints, checks fiber-level availability,
            preserves jumper notation, and consumes only the assigned fiber pair on each segment.
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[180px_1fr_220px_auto] xl:grid-cols-1 2xl:grid-cols-[180px_1fr_220px_auto]">
            <input
              className="input-dark w-full"
              value={allocationServiceId}
              onChange={(e) => setAllocationServiceId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void allocatePath(); }}
              placeholder="Service ID"
            />
            <input
              className="input-dark w-full"
              value={allocationInput}
              onChange={(e) => setAllocationInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void allocatePath(); }}
              placeholder="DH0055-DH1023-DH0088-DH0022(Jumper)-DH0123"
            />
            <input
              className="input-dark w-full"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void allocatePath(); }}
              placeholder="Optional service name"
            />
            <button
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 hover:bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
              disabled={isAllocating}
              onClick={allocatePath}
            >
              {isAllocating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Allocate
            </button>
          </div>
        </div>

        <div className="card p-5">
          <div className="mb-1 flex items-center gap-2">
            <Mail className="h-4 w-4 text-emerald-400" />
            <div className="section-title">Deployment Instructions (Trace Route)</div>
          </div>
          <div className="subtle mt-0.5">
            Emails the deployment instructions template for the active traced service, with the trace data sheet and topology image attached.
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
            <input className="input-dark" value={flaggedSitesInput} onChange={(e) => setFlaggedSitesInput(e.target.value)} placeholder="Sites flagged for integration (red)" />
            <input className="input-dark" value={deployTo} onChange={(e) => setDeployTo(e.target.value)} placeholder="TO (blank = template default)" />
            <input className="input-dark" value={deployCc} onChange={(e) => setDeployCc(e.target.value)} placeholder="CC (blank = template default)" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors disabled:opacity-50"
              onClick={sendDeploymentEmail}
              disabled={isDeploying || !canSendDeployment}
            >
              {isDeploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              Email Deployment Instructions
            </button>
            {flaggedSites.length ? (
              <span className="text-xs font-medium text-emerald-500">Flagged sites: {flaggedSiteString}</span>
            ) : visibleTrace?.serviceCode ? (
              <span className="text-xs text-slate-500">Double-click nodes on the canvas to flag them red.</span>
            ) : (
              <span className="text-xs text-slate-500">Trace a service to enable deployment instructions.</span>
            )}
          </div>
        </div>
      </div>

      {pathPreview ? (
        <div className="card p-5" ref={previewWrapRef}>
          <div className="mb-1 flex items-center gap-2">
            <Cable className="h-4 w-4 text-sky-400" />
            <div className="section-title">Transport Trail Preview</div>
            <button className="btn btn-ghost ml-auto" onClick={exportTracePath} title="Download this trace (all routes + segment details) as Excel">
              <Download className="h-4 w-4" /> Export Excel
            </button>
          </div>
          <div className="subtle mt-0.5 font-mono text-xs">{pathPreview.path}</div>
          <div className="mt-2 flex gap-3">
            <span className="badge badge-active">{pathPreview.matchedHops} matched</span>
            {pathPreview.missingHops > 0 ? <span className="badge badge-faulty">{pathPreview.missingHops} missing</span> : null}
            {pathPreview.totalDistanceKm ? <span className="badge badge-reserved">{pathPreview.totalDistanceKm} km total</span> : null}
          </div>
          {pathPreview.matchedHops === 0 && !pathPreview.indirectRouteSummary ? (
            // No direct segment AND no indirect route between the endpoints:
            // show a red cross + note instead of a misleading "0 km" connector.
            <NoConnectivityTopology
              near={pathPreview.hops[0]?.from ?? ""}
              far={pathPreview.hops[pathPreview.hops.length - 1]?.to ?? ""}
            />
          ) : pathPreview.indirectRouteSummary ? (
            // key forces a full canvas remount whenever a new trace is computed.
            <div key={`indirect-${pathPreview.path}`}>
              <div className="mt-4 text-xs font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                Primary Route — {Math.max(0, pathPreview.indirectRouteSummary.path.length - 1)} hops (fewest)
              </div>
              <IndirectTraceSummaryPanel summaryData={pathPreview.indirectRouteSummary} />
              <TraceCanvasTrailRenderer path={pathPreview.indirectRouteSummary.path} intermediatesAsJumpers />
              {(pathPreview.alternativeRouteSummaries ?? []).map((alternative, index) => (
                <div key={`alt-route-${index}`} className="mt-5 border-t border-[var(--border)] pt-4">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Alternative Route {index + 2} — {Math.max(0, alternative.path.length - 1)} hops
                  </div>
                  <IndirectTraceSummaryPanel summaryData={alternative} />
                  <TraceCanvasTrailRenderer path={alternative.path} intermediatesAsJumpers />
                </div>
              ))}
            </div>
          ) : (
            // Direct segment-matched trail: the graphical chain renders alongside
            // the table (standard Site stencils; no transit overrides).
            <TraceCanvasTrailRenderer key={`direct-${pathPreview.path}`} path={directTrailPath(pathPreview)} />
          )}
          <div className="table-shell mt-4">
            <table>
              <thead>
                <tr>
                  <th>From</th><th>To</th><th>Segment</th><th>Services</th>
                  <th>Active / Total</th><th>Available</th><th>Status</th>
                  <th>km</th><th>Cumulative km</th>
                </tr>
              </thead>
              <tbody>
                {pathPreview.hops.map((hop) => (
                  <tr key={`${hop.from}-${hop.to}`} className={hop.matched ? "" : "opacity-60"}>
                    <td className="font-semibold">{hop.from}</td>
                    <td className="font-semibold">{hop.to}</td>
                    <td className="font-mono text-xs">{hop.segmentCode ?? (hop.matched ? "–" : "No matching segment")}</td>
                    <td className="break-cell max-w-[200px]">{hop.serviceIds ?? "–"}</td>
                    <td>{hop.totalFibers == null ? "–" : `${hop.usedFibers ?? 0} / ${hop.totalFibers}`}</td>
                    <td>{hop.availableFibers ?? "–"}</td>
                    <td>{hop.status ?? "–"}</td>
                    <td>{hop.distanceKm ?? "–"}</td>
                    <td>{hop.cumulativeDistanceKm ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pathPreview.splitterForks?.length ? (
            <div className="mt-5">
              <SplitterForkPanels forks={pathPreview.splitterForks} />
            </div>
          ) : null}

          {/* ── Email Report: deployment-instructions text + optional canvas snapshot ── */}
          <TraceEmailReport
            reportText={buildTraceReportText(pathPreview, detailNearSite, detailFarSite)}
            subjectDefault={`Detailed Trace${detailNearSite && detailFarSite ? `: ${detailNearSite} → ${detailFarSite}` : ""}`}
            getCanvasSvg={() => pickTopologySvg(previewWrapRef.current)}
            serviceCode={trace?.serviceCode ?? null}
            trail={previewTrailQuery ?? pathPreview.path}
            redSites={flaggedSites}
            disabled={isSearching}
          />
        </div>
      ) : null}

      {/* ── Service allocation ── */}
      {/* ── Trace result ── */}
      {visibleTrace ? (
        <>
          {/* Header + stats */}
          <div className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Wifi className="h-4 w-4 text-red-400 shrink-0" />
                  <div className="section-title truncate">{visibleTrace.serviceName}</div>
                  {isSingleHomed ? (
                    <span className="badge topology-role-single-homed text-[11px]">Single-homed</span>
                  ) : null}
                </div>
                <div className="subtle mt-1 font-mono text-xs">
                  {visibleTrace.serviceCode}
                  <span className="mx-2 opacity-40">·</span>
                  {visibleTrace.routeType}
                  <span className="mx-2 opacity-40">·</span>
                  {visibleTrace.totalDistanceKm} km total
                </div>
              </div>
              {visibleTrace.mainRingPath ? <ShapeBadge group={visibleTrace.mainRingPath} /> : null}
            </div>

            {/* KPI stat cards */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <TraceStatCard
                label="Main Hops"
                value={visibleTrace.hops.length}
                sub="sites on primary path"
                icon={Network}
                tone="text-sky-400"
              />
              <TraceStatCard
                label="Distance"
                value={`${visibleTrace.totalDistanceKm} km`}
                sub="primary chain"
                icon={Cable}
                tone="text-emerald-400"
              />
              <TraceStatCard
                label="Branches"
                value={totalBranches}
                sub={`${visibleTrace.attachedSubrings?.length ?? 0} subrings, ${(visibleTrace.attachedSpurs?.length ?? 0) + (visibleTrace.attachedSpurChains?.length ?? 0)} spurs`}
                icon={GitBranch}
                tone="text-amber-400"
              />
              <TraceStatCard
                label="Review"
                value={reviewCount}
                sub={suppressReviewDashboard ? "suppressed for clean local single-homed path" : "groups need review"}
                icon={CheckCircle2}
                tone={reviewCount > 0 ? "text-red-400" : "text-slate-400"}
              />
            </div>

            {/* ── Main ring / single-homed path topology chain ── */}
            {/* ── Unified multi-topology canvas: main ring + every attached subring/
                spur/spur-chain in ONE viewport, branches wired to their parent
                junctions, with anti-collision spacing. Front-end layout only. ── */}
            {showUnified ? (
              <div className="mt-5">
                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                  <span className="inline-block h-2 w-2 rounded-full bg-violet-400" />
                  Unified network topology
                </div>
                <div ref={canvasWrapRef}>
                  <UnifiedTopologyCanvas
                    trace={visibleTrace}
                    onToggleJumper={canMarkJumper ? toggleJumper : undefined}
                    onFlagSite={updateFlaggedSites}
                    busyNode={jumperBusyNode}
                  />
                </div>
              </div>
            ) : null}

            {/* EDIT HERE: Service Trail topology is intentionally graphical; the operational link table moved to Impact Analysis. */}
            <div className="mt-5">
              {!showUnified ? (
              <>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                {isSingleHomed ? (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                    Single-homed path
                  </>
                ) : (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
                    Main ring path
                  </>
                )}
              </div>
              {visibleTrace.mainRingPath ? (
                <TopologyChain
                  group={visibleTrace.mainRingPath}
                  onToggleJumper={canMarkJumper ? toggleJumper : undefined}
                  busyNode={jumperBusyNode}
                  mplsCore={mplsCoreService}
                />
              ) : (
                <div className={`service-topology-line mt-3 ${isSingleHomed ? "topology-single-homed" : ""}`}>
                  {visibleTrace.hops.map((hop, idx) => {
                    const rawLabel = hop.siteLabel ?? hop.siteCode ?? "UNKNOWN";
                    const cleanNode = rawLabel.replace(/\s*\(\s*jumper\s*\)/i, "").trim();
                    const isJumper = Boolean(hop.isJumper) || /\(\s*jumper\s*\)/i.test(rawLabel);
                    const isBusy = jumperBusyNode === cleanNode;
                    return (
                    <Fragment key={`${hop.siteCode}-${idx}`}>
                      <SiteChainNode
                        label={cleanNode}
                        isJumper={isJumper}
                        icon={mplsCoreService ? "pe" : "site"}
                        editable={canMarkJumper}
                        busy={isBusy}
                        onClick={canMarkJumper ? () => toggleJumper(cleanNode, isJumper) : undefined}
                        onKeyDown={canMarkJumper ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleJumper(cleanNode, isJumper); } } : undefined}
                        title={canMarkJumper ? `${isJumper ? "Clear jumper on" : "Mark as jumper:"} ${cleanNode}` : cleanNode}
                      />
                      {idx < visibleTrace.hops.length - 1 ? (
                        <div className="service-topology-edge">
                          <span>{visibleTrace.hops[idx]?.distanceKm != null ? `${visibleTrace.hops[idx]!.distanceKm} km` : "–"}</span>
                        </div>
                      ) : null}
                    </Fragment>
                    );
                  })}
                </div>
              )}
              </>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                  Total chain distance: <span className="text-slate-900 dark:text-white">{visibleTrace.totalDistanceKm} km</span>
                </div>
                {canMarkJumper ? (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <span className="topology-jumper-icon" aria-hidden>⤧</span>
                    Click any site to mark / clear it as a jumper
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── Splitter linear path (Context A — allocated port only) ── */}
          <SplitterLinearPath forks={visibleTrace.splitterPath} />

          {/* ── Topology warnings ── */}
          {visibleTrace.topologyWarnings?.length ? (
            <div className="card border-amber-400/30 bg-amber-500/8 p-5">
              <div className="section-title flex items-center gap-2 text-amber-700 dark:text-amber-200">
                <span aria-hidden>⚠</span> Topology Notes
              </div>
              <ul className="mt-3 space-y-1.5 text-sm font-medium text-amber-900 dark:text-amber-100">
                {visibleTrace.topologyWarnings.map((w) => (
                  <li key={w} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300">›</span>
                    {w}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-amber-400/30 pt-3 text-[11px] font-bold">
                <span className="text-amber-900 dark:text-amber-200">Legend:</span>
                <span className="badge topology-role-main-ring">Main ring</span>
                <span className="badge topology-role-single-homed">Single-homed</span>
                <span className="badge topology-role-subring">Subring</span>
                <span className="badge topology-role-spur">Spur</span>
                <span className="badge topology-role-spur-chain">Spur chain</span>
                <span className="inline-flex items-center gap-1 text-amber-900 dark:text-amber-200"><span aria-hidden>⤴</span> junction</span>
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><span aria-hidden>↺</span> ring closes</span>
              </div>
            </div>
          ) : null}

          {/* ── Topology group panels ── */}
          <TopologyGroupPanel
            title="Attached Single-homed Rings"
            groups={visibleTrace.attachedSingleHomed}
            roleKey="SINGLE_HOMED"
            onToggleJumper={canMarkJumper ? toggleJumper : undefined}
            busyNode={jumperBusyNode}
            mplsCore={mplsCoreService}
          />
          <TopologyGroupPanel
            title="Attached Subrings"
            groups={visibleTrace.attachedSubrings}
            roleKey="SUBRING"
            onToggleJumper={canMarkJumper ? toggleJumper : undefined}
            busyNode={jumperBusyNode}
            mplsCore={mplsCoreService}
          />
          <TopologyGroupPanel
            title="Attached Spurs"
            groups={visibleTrace.attachedSpurs}
            roleKey="SPUR"
            onToggleJumper={canMarkJumper ? toggleJumper : undefined}
            busyNode={jumperBusyNode}
            mplsCore={mplsCoreService}
          />
          <TopologyGroupPanel
            title="Attached Spur Chains"
            groups={visibleTrace.attachedSpurChains}
            roleKey="SPUR_CHAIN"
            onToggleJumper={canMarkJumper ? toggleJumper : undefined}
            busyNode={jumperBusyNode}
            mplsCore={mplsCoreService}
          />
          <TopologyGroupPanel
            title="Interconnects"
            groups={visibleTrace.attachedInterconnects}
            roleKey="INTERCONNECT"
            onToggleJumper={canMarkJumper ? toggleJumper : undefined}
            busyNode={jumperBusyNode}
            mplsCore={mplsCoreService}
          />
          {!suppressReviewDashboard ? (
            <TopologyGroupPanel
              title="Review / Backbone Traversal"
              groups={[...(visibleTrace.reviewItems ?? []), ...(visibleTrace.attachedInterconnects?.length ? [] : [])]}
              roleKey="REVIEW"
              onToggleJumper={canMarkJumper ? toggleJumper : undefined}
              busyNode={jumperBusyNode}
              mplsCore={mplsCoreService}
            />
          ) : null}

          {/* ── Detail table ── */}
          <TraceDetailsTable trace={visibleTrace} />
        </>
      ) : (
        <div className="card p-12 text-center">
          <Network className="mx-auto h-12 w-12 text-slate-500 dark:text-slate-600" />
          <div className="mt-3 text-sm font-semibold text-slate-600 dark:text-slate-400">No trace found</div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-500">Enter a service ID or transport trail above to trace a service.</div>
        </div>
      )}
    </div>
  );
}
