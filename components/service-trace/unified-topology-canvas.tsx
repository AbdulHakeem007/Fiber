"use client";

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED MULTI-TOPOLOGY CANVAS  (rectangular / orthogonal geometry)
//
// One SVG viewport renders the whole service: a RECTANGULAR main ring, with every
// dependent spur / spur-chain / orthogonal subring wired back to its parent
// junction node — nothing floats. All layout math is in front-end memory; NO
// schema / DB changes.
//
// GEOMETRY RULES (per design spec):
//   1. MAIN RING  -> a clean horizontal RECTANGLE ("stadium"): two evenly-spaced
//      rows. PE / Core / DC nodes are anchored on the TOP row, in transport-chain
//      sequence, left -> right (never re-ordered). The remaining arc fills the
//      BOTTOM row; the two rows are joined by the left/right return edges. Node
//      intervals scale with count so a wide ring spreads out instead of cramming.
//   2. SUBRING    -> rendered as clean rectangular / side-corridor lanes outside
//      the main ring, connected to BOTH of its main-ring uplink junctions.
//   3. SPUR / SPUR CHAIN -> drop straight out from their junction (up from a
//      top-row junction, down from a bottom-row junction).
//   4. ANTI-COLLISION -> a rigid minimum clearance is enforced; branch nodes are
//      nudged until no two frames (or their labels) overlap.
//
// Stencil geometry + the PE/ATN/Jumper selection rule come from ./topology-stencils.
// ─────────────────────────────────────────────────────────────────────────────

import { Maximize2, Minimize2, Move, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  type Point,
  type TopologyRenderNode,
  MAX_STENCIL_HEIGHT,
  MAX_STENCIL_WIDTH,
  StencilNode,
  normalizedNodeLabel,
  selectStencil,
  toRenderNode,
} from "@/components/service-trace/topology-stencils";
import type { ServiceTraceResult, ServiceTraceTopologyGroup } from "@/types/telecom";

// ── Tunable layout geometry (generous padding for at-a-glance scannability) ──
// Configurable bounding-box padding between adjacent node frames. Per spec §1 the
// canvas keeps a strict minimum grid gap (separate horizontal / vertical values)
// so no two node+label boxes intersect.
const X_GAP = 44; // horizontal padding between sequential / parallel row nodes
const Y_GAP = 44; // vertical padding between vertically stacked (side-edge) nodes
const COL_SLOT = MAX_STENCIL_WIDTH + X_GAP; // horizontal interval between row nodes
const ROW_SLOT = MAX_STENCIL_HEIGHT + Y_GAP; // vertical interval between stacked side-edge nodes
const BAND_GAP = X_GAP; // padding between adjacent downlink slots on the same host
const TOP_ROW_Y = MAX_STENCIL_HEIGHT / 2 + 6; // PE/Core stencil top edge defines the canvas ceiling
const ROW_GAP_BASE = 260; // vertical gap between the PE axis and the first main-ring lane
const MAIN_ARC_LANE_GAP = MAX_STENCIL_HEIGHT + 88; // separation between the two PE-to-PE arcs
const BRANCH_STEP = MAX_STENCIL_HEIGHT + 88; // spacing between successive branch nodes
const BRANCH_CLEARANCE = MAX_STENCIL_HEIGHT + 44; // exit distance before branches leave the main ring
const SUBRING_OUTER_GAP = MAX_STENCIL_HEIGHT + 118; // subring clearance outside the main rectangle
const SUBRING_LANE_GAP = MAX_STENCIL_HEIGHT + 94; // separation between multiple subring lanes
const SINGLE_ANCHOR_SUBRING_GAP = MAX_STENCIL_WIDTH + 8; // compact baseline so same-node subrings do not look attached to neighbours
const SINGLE_ANCHOR_NECK_HALF_GAP = 14; // two close drops from the same host node before widening into the subring box
const SINGLE_ANCHOR_NECK_DROP = MAX_STENCIL_HEIGHT / 2 + 22; // short drop that clears the host stencil and main-ring edge
const MIN_CLEARANCE = MAX_STENCIL_WIDTH + 8; // anti-collision minimum centre distance
const DRAG_CLICK_THRESHOLD = 3;

const ROLE_EDGE_COLOR: Record<string, string> = {
  MAIN_RING: "#22c55e",
  SUBRING: "#a78bfa",
  SPUR: "#fbbf24",
  SPUR_CHAIN: "#fb923c",
  SINGLE_HOMED: "#34d399",
  INTERCONNECT: "#2dd4bf",
  REVIEW: "#f87171",
};

interface PlacedNode {
  key: string;
  render: TopologyRenderNode;
  point: Point;
}
interface PlacedEdge {
  points: Point[];
  color: string;
  km?: number | null;
}

type MainFace = "top" | "bottom" | "left" | "right";
type AxisFirst = "horizontal" | "vertical";
type PerimeterBoundary = {
  total: number;
  vertexDistances: number[];
  vertices: Point[];
  distanceByIndex: Map<number, number>;
};

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function roleColor(role?: string | null): string {
  return ROLE_EDGE_COLOR[String(role ?? "").toUpperCase()] ?? "#94a3b8";
}
function add(p: Point, q: Point): Point {
  return { x: p.x + q.x, y: p.y + q.y };
}
function scale(p: Point, s: number): Point {
  return { x: p.x * s, y: p.y * s };
}
function dist(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function dedupePoints(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
}

function orthogonalPoints(a: Point, b: Point, first: AxisFirst = "vertical"): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const elbow = first === "vertical" ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  return dedupePoints([a, elbow, b]);
}

function mainEdgePoints(a: Point, b: Point): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  if (a.y <= TOP_ROW_Y + 1) return orthogonalPoints(a, b, "vertical");
  if (b.y <= TOP_ROW_Y + 1) return orthogonalPoints(a, b, "horizontal");
  return orthogonalPoints(a, b, "horizontal");
}

function pathFromPoints(points: Point[]): string {
  const clean = dedupePoints(points);
  return clean.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function polylineLabelPoint(points: Point[]): Point {
  const clean = dedupePoints(points);
  if (clean.length === 1) return clean[0];
  const segments = clean.slice(0, -1).map((point, index) => ({
    a: point,
    b: clean[index + 1],
    length: dist(point, clean[index + 1]),
  }));
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.length || segment === segments[segments.length - 1]) {
      const t = segment.length === 0 ? 0 : remaining / segment.length;
      return {
        x: segment.a.x + (segment.b.x - segment.a.x) * t,
        y: segment.a.y + (segment.b.y - segment.a.y) * t,
      };
    }
    remaining -= segment.length;
  }
  return clean[Math.floor(clean.length / 2)];
}

function boundsOf(points: Point[]): Bounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function arcBetween(start: number, end: number, total: number): number[] {
  const arc: number[] = [];
  for (let step = 0, limit = (end - start + total) % total; step <= limit; step += 1) {
    arc.push((start + step) % total);
  }
  return arc;
}

function resolveTrack(candidates: Point[], dir: Point, occupied: Point[]): Point[] {
  let shift = { x: 0, y: 0 };
  for (let guard = 0; guard < 40; guard += 1) {
    const shifted = candidates.map((point) => add(point, shift));
    if (shifted.every((point) => !occupied.some((other) => dist(point, other) < MIN_CLEARANCE))) return shifted;
    shift = add(shift, scale(dir, MIN_CLEARANCE * 0.6));
  }
  return candidates.map((point) => add(point, shift));
}

/** Lateral span between the first and last node of a single-anchor subring box. */
function subringLoopSpan(n: number): number {
  return Math.max((n - 1) * SINGLE_ANCHOR_SUBRING_GAP, SINGLE_ANCHOR_SUBRING_GAP);
}

/** Pack N footprint widths edge-to-edge (with a gap) centred on 0; returns each slot centre. */
function allocateLateralSlots(widths: number[], gap: number): { center: number }[] {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  let cursor = -total / 2;
  return widths.map((width) => {
    const center = cursor + width / 2;
    cursor += width + gap;
    return { center };
  });
}

interface FaceGeom {
  out: Point;
  toPoint: (lateral: number, depth: number) => Point;
  lateralOf: (point: Point) => number;
  shift: (point: Point, delta: number) => Point;
}

/**
 * Face-local coordinate frame: `lateral` runs ALONG the host's edge, `depth` runs
 * OUTWARD away from the ring. Top and bottom faces both fan downward below the
 * rectangle (matching the branch geometry); left/right fan sideways. `shift` nudges
 * a point along the lateral axis (used to open the neck right at the host, staying
 * orthogonal wherever the host sits). One implementation serves all four faces.
 */
function faceGeom(face: MainFace, bounds: Bounds): FaceGeom {
  if (face === "left") return { out: { x: -1, y: 0 }, toPoint: (lateral, depth) => ({ x: bounds.minX - depth, y: lateral }), lateralOf: (point) => point.y, shift: (point, delta) => ({ x: point.x, y: point.y + delta }) };
  if (face === "right") return { out: { x: 1, y: 0 }, toPoint: (lateral, depth) => ({ x: bounds.maxX + depth, y: lateral }), lateralOf: (point) => point.y, shift: (point, delta) => ({ x: point.x, y: point.y + delta }) };
  return { out: { x: 0, y: 1 }, toPoint: (lateral, depth) => ({ x: lateral, y: bounds.maxY + depth }), lateralOf: (point) => point.x, shift: (point, delta) => ({ x: point.x + delta, y: point.y }) };
}

/**
 * Split the closed main-ring sequence into a TOP row (anchoring the PE/Core/DC
 * nodes) and a BOTTOM row. With two boundary nodes the shorter arc between them
 * becomes the top (both PEs land on the top corners); otherwise the sequence is
 * rotated so a PE leads and split in half. Sequence order is always preserved.
 */
function splitRows(seq: string[], isPE: boolean[]): { top: number[]; bottom: number[] } {
  const N = seq.length;
  const peIdx = seq.map((_, i) => i).filter((i) => isPE[i]);

  if (peIdx.length >= 2) {
    const p = peIdx[0];
    const q = peIdx[peIdx.length - 1];
    // Two arcs run between the two boundary PEs; BOTH arcs include the PEs at their
    // ends, so whichever becomes the top row carries both PEs on its two corners.
    const arcA: number[] = []; // forward p -> q (inclusive)
    for (let s = 0, d = (q - p + N) % N; s <= d; s += 1) arcA.push((p + s) % N);
    const arcB: number[] = []; // wrap q -> p (inclusive) — must include the wrap to p
    for (let s = 0, d = (p - q + N) % N; s <= d; s += 1) arcB.push((q + s) % N);
    // Top = shorter arc (its two endpoints are PEs -> the top corners).
    const top = arcA.length <= arcB.length ? arcA : arcB;
    const topSet = new Set(top);
    // Bottom = the remaining interior nodes, in ring order continuing past `top`.
    const bottom: number[] = [];
    const last = top[top.length - 1];
    for (let step = 1; step < N; step += 1) {
      const i = (last + step) % N;
      if (!topSet.has(i)) bottom.push(i);
    }
    return { top, bottom };
  }

  // 0 or 1 PE: rotate so a PE (if any) leads, then split roughly in half.
  const start = peIdx[0] ?? 0;
  const rotated = Array.from({ length: N }, (_, k) => (start + k) % N);
  const half = Math.ceil(N / 2);
  return { top: rotated.slice(0, half), bottom: rotated.slice(half) };
}

export function UnifiedTopologyCanvas({
  trace,
  onToggleJumper,
  onFlagSite,
  busyNode,
  manualAdjustable = true,
}: {
  trace: ServiceTraceResult;
  onToggleJumper?: (node: string, currentlyJumper: boolean) => void;
  /** Notifies the parent when a node is flagged (red) / cleared for integration. */
  onFlagSite?: (site: string, flagged: boolean) => void;
  busyNode?: string | null;
  /** Enables click-drag post-layout node adjustment for engineering fine-tuning. */
  manualAdjustable?: boolean;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [contextNode, setContextNode] = useState<{ node: string; isJumper: boolean; point: Point } | null>(null);
  const clickTimer = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    key: string;
    pointerStart: Point;
    offsetStart: Point;
    basePoint: Point;
    moved: boolean;
  } | null>(null);
  const lineDragRef = useRef<{
    key: string;
    axis: "horizontal" | "vertical";
    pointerStart: Point;
    offsetStart: number;
    segmentIndex: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [containerW, setContainerW] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit-to-width
  const [isFull, setIsFull] = useState(false);
  const [manualOffsets, setManualOffsets] = useState<Record<string, Point>>({});
  const [manualLineOffsets, setManualLineOffsets] = useState<Record<string, number>>({});
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!isFull) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFull(false);
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isFull]);

  const pointFromPointerEvent = (event: React.PointerEvent<SVGElement>): Point | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const svgPoint = point.matrixTransform(ctm.inverse());
    return { x: svgPoint.x, y: svgPoint.y };
  };

  const beginNodeDrag = (event: React.PointerEvent<SVGGElement>, key: string, point: Point) => {
    if (!manualAdjustable || event.button !== 0) return;
    const pointerStart = pointFromPointerEvent(event);
    if (!pointerStart) return;
    const offsetStart = manualOffsets[key] ?? { x: 0, y: 0 };
    dragRef.current = {
      key,
      pointerStart,
      offsetStart,
      basePoint: { x: point.x - offsetStart.x, y: point.y - offsetStart.y },
      moved: false,
    };
    setDraggingKey(key);
    setContextNode(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const beginLineDrag = (event: React.PointerEvent<SVGElement>, key: string, segmentIndex: number, points: Point[]) => {
    if (!manualAdjustable || event.button !== 0) return;
    const from = points[segmentIndex];
    const to = points[segmentIndex + 1];
    if (!from || !to) return;
    if (from.x !== to.x && from.y !== to.y) return;
    const pointerStart = pointFromPointerEvent(event);
    if (!pointerStart) return;
    const offsetKey = `${key}:${segmentIndex}`;
    lineDragRef.current = {
      key: offsetKey,
      axis: from.y === to.y ? "horizontal" : "vertical",
      pointerStart,
      offsetStart: manualLineOffsets[offsetKey] ?? 0,
      segmentIndex,
      moved: false,
    };
    setDraggingKey(`line-${segmentIndex + 1}`);
    setContextNode(null);
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const updateCanvasDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const lineDrag = lineDragRef.current;
    if (lineDrag) {
      const pointer = pointFromPointerEvent(event);
      if (!pointer) return;
      event.preventDefault();
      const delta = lineDrag.axis === "horizontal" ? pointer.y - lineDrag.pointerStart.y : pointer.x - lineDrag.pointerStart.x;
      if (Math.abs(delta) >= DRAG_CLICK_THRESHOLD) lineDrag.moved = true;
      const nextOffset = lineDrag.offsetStart + delta;
      const [edgeKey, segmentIndexText] = lineDrag.key.split(":");
      const edgeIndex = Number(edgeKey.replace("edge-", ""));
      const segmentIndex = Number(segmentIndexText);
      const edge = edges[edgeIndex];
      const from = edge?.points[segmentIndex];
      const to = edge?.points[segmentIndex + 1];
      if (edge && from && to) {
        const shiftedFrom = lineDrag.axis === "horizontal" ? { x: from.x, y: from.y + nextOffset } : { x: from.x + nextOffset, y: from.y };
        const shiftedTo = lineDrag.axis === "horizontal" ? { x: to.x, y: to.y + nextOffset } : { x: to.x + nextOffset, y: to.y };
        const tooClose = placed.some((node) => {
          if ((node.point.x === from.x && node.point.y === from.y) || (node.point.x === to.x && node.point.y === to.y)) return false;
          const x1 = Math.min(shiftedFrom.x, shiftedTo.x);
          const x2 = Math.max(shiftedFrom.x, shiftedTo.x);
          const y1 = Math.min(shiftedFrom.y, shiftedTo.y);
          const y2 = Math.max(shiftedFrom.y, shiftedTo.y);
          const dx = node.point.x < x1 ? x1 - node.point.x : node.point.x > x2 ? node.point.x - x2 : 0;
          const dy = node.point.y < y1 ? y1 - node.point.y : node.point.y > y2 ? node.point.y - y2 : 0;
          return Math.hypot(dx, dy) < MIN_CLEARANCE * 0.42;
        });
        if (tooClose) return;
      }
      setManualLineOffsets((prev) => ({ ...prev, [lineDrag.key]: nextOffset }));
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    const pointer = pointFromPointerEvent(event);
    if (!pointer) return;
    event.preventDefault();
    const dx = pointer.x - drag.pointerStart.x;
    const dy = pointer.y - drag.pointerStart.y;
    if (Math.hypot(dx, dy) >= DRAG_CLICK_THRESHOLD) drag.moved = true;
    const minOffsetY = TOP_ROW_Y - drag.basePoint.y;
    const nextOffset = {
      x: drag.offsetStart.x + dx,
      y: Math.max(minOffsetY, drag.offsetStart.y + dy),
    };
    setManualOffsets((prev) => ({ ...prev, [drag.key]: nextOffset }));
  };

  const endNodeDrag = () => {
    const moved = Boolean(dragRef.current?.moved || lineDragRef.current?.moved);
    dragRef.current = null;
    lineDragRef.current = null;
    setDraggingKey(null);
    if (moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 220);
    }
  };

  const main = trace.mainRingPath;
  if (!main || main.nodes.length < 2) return null;

  // Global core / jumper sets across every group.
  const allGroups: ServiceTraceTopologyGroup[] = [
    main,
    ...(trace.attachedSubrings ?? []),
    ...(trace.attachedSpurs ?? []),
    ...(trace.attachedSpurChains ?? []),
    ...(trace.attachedSingleHomed ?? []),
    ...(trace.attachedInterconnects ?? []),
  ];
  const coreSet = new Set<string>();
  const jumperSet = new Set<string>();
  for (const group of allGroups) {
    for (const node of [...(group.coreNodes ?? []), ...(group.peNodes ?? [])]) coreSet.add(normalizedNodeLabel(node));
    for (const node of group.jumpers ?? []) jumperSet.add(normalizedNodeLabel(node));
  }

  const isClosed = Boolean(main.isClosedRing);
  const mainIsRing = Boolean(main.renderAsRing || main.isClosedRing);
  const rawMain = main.nodes;
  const mainNodes = isClosed && rawMain.length > 1 && normalizedNodeLabel(rawMain[0]) === normalizedNodeLabel(rawMain[rawMain.length - 1])
    ? rawMain.slice(0, -1)
    : rawMain;
  const N = mainNodes.length;

  const placed: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];
  const posByKey = new Map<string, Point>();
  const faceByKey = new Map<string, MainFace>();
  const occupied: Point[] = [];
  let mainRingCaption = mainIsRing ? "Rectangular main ring (PEs top)" : "Open main chain";
  let mainPerimeterBoundary: PerimeterBoundary | null = null;
  const applyManualOffset = (key: string, point: Point): Point => {
    const offset = manualOffsets[key];
    if (!offset) return point;
    return { x: point.x + offset.x, y: Math.max(TOP_ROW_Y, point.y + offset.y) };
  };

  const hasSubring = (trace.attachedSubrings?.length ?? 0) > 0;
  const rowGap = ROW_GAP_BASE + (hasSubring ? 40 : 0);

  const placeMainNode = (seqIndex: number, point: Point, face: MainFace) => {
    const raw = mainNodes[seqIndex];
    const key = normalizedNodeLabel(raw);
    const nextPoint = applyManualOffset(key, point);
    const nextFace = face === "top" && !coreSet.has(key) ? "bottom" : face;
    posByKey.set(key, nextPoint);
    faceByKey.set(key, nextFace);
    placed.push({ key, render: toRenderNode(raw, coreSet, jumperSet), point: nextPoint });
    occupied.push(nextPoint);
  };

  // ── 1. Main ring -> rectangular two-row layout (PEs on the TOP row) ──
  if (mainIsRing) {
    const isPE = mainNodes.map((n) => coreSet.has(normalizedNodeLabel(n)));
    const peIdx = mainNodes.map((_, i) => i).filter((i) => isPE[i]);

    if (peIdx.length >= 2) {
      mainRingCaption = "Balanced dual-PE perimeter ring";
      const leftPe = peIdx[0];
      const rightPe = peIdx[peIdx.length - 1];
      const forwardArc = arcBetween(leftPe, rightPe, N);
      const returnArc = arcBetween(rightPe, leftPe, N);
      const forwardInterior = forwardArc.slice(1, -1);
      const returnInterior = returnArc.slice(1, -1);
      const perimeterInterior = forwardInterior.length >= returnInterior.length ? forwardInterior : returnInterior;
      const topInterior = forwardInterior.length >= returnInterior.length ? returnInterior : forwardInterior;
      const perimeterStart = forwardInterior.length >= returnInterior.length ? leftPe : rightPe;
      const perimeterEnd = forwardInterior.length >= returnInterior.length ? rightPe : leftPe;
      const sideCount = perimeterInterior.length >= 3
        ? Math.max(1, Math.floor((perimeterInterior.length + 2) / 4))
        : perimeterInterior.length === 2 ? 1 : 0;
      const leftSideNodes = perimeterInterior.slice(0, sideCount);
      const rightSideNodes = sideCount > 0 ? perimeterInterior.slice(-sideCount) : [];
      const bottomNodes = perimeterInterior.slice(leftSideNodes.length, perimeterInterior.length - rightSideNodes.length);
      const bottomSlots = Math.max(3, bottomNodes.length + 1);
      const width = bottomSlots * COL_SLOT;
      // The left/right edges carry the side nodes stacked vertically (the PE-adjacent
      // columns). Grow the rectangle's height so every side node keeps a full ROW_SLOT
      // of clearance — otherwise a short fixed height crams 4+ stacked stencils into
      // ~60px each and they overlap (spec §1, "zero spatial overlap").
      const maxSideNodes = Math.max(leftSideNodes.length, rightSideNodes.length);
      const height = Math.max(rowGap, (maxSideNodes + 1) * ROW_SLOT);
      const bottomY = TOP_ROW_Y + height;
      const leftX = 0;
      const rightX = width;
      const d1 = height;
      const d2 = d1 + width;
      const d3 = d2 + height;
      const total = d3 + width;
      const distanceByIndex = new Map<number, number>();
      const pointAtDistance = (distance: number): Point => {
        if (distance <= d1) return { x: leftX, y: TOP_ROW_Y + distance };
        if (distance <= d2) return { x: leftX + (distance - d1), y: bottomY };
        if (distance <= d3) return { x: rightX, y: bottomY - (distance - d2) };
        return { x: rightX - (distance - d3), y: TOP_ROW_Y };
      };
      const mirroredPointAtDistance = (distance: number): Point => {
        if (distance <= d1) return { x: rightX, y: TOP_ROW_Y + distance };
        if (distance <= d2) return { x: rightX - (distance - d1), y: bottomY };
        if (distance <= d3) return { x: leftX, y: bottomY - (distance - d2) };
        return { x: leftX + (distance - d3), y: TOP_ROW_Y };
      };
      const faceAtDistance = (distance: number): MainFace => {
        if (distance <= d1) return "left";
        if (distance <= d2) return "bottom";
        if (distance <= d3) return "right";
        return "top";
      };
      const mirroredFaceAtDistance = (distance: number): MainFace => {
        if (distance <= d1) return "right";
        if (distance <= d2) return "bottom";
        if (distance <= d3) return "left";
        return "top";
      };

      placeMainNode(leftPe, { x: leftX, y: TOP_ROW_Y }, "top");
      placeMainNode(rightPe, { x: rightX, y: TOP_ROW_Y }, "top");

      const perimeterStartsOnLeft = perimeterStart === leftPe;
      distanceByIndex.set(perimeterStart, 0);
      distanceByIndex.set(perimeterEnd, d3);
      mainPerimeterBoundary = {
        total,
        vertexDistances: [d1, d2, d3],
        vertices: perimeterStartsOnLeft
          ? [
              { x: leftX, y: bottomY },
              { x: rightX, y: bottomY },
              { x: rightX, y: TOP_ROW_Y },
            ]
          : [
              { x: rightX, y: bottomY },
              { x: leftX, y: bottomY },
              { x: leftX, y: TOP_ROW_Y },
            ],
        distanceByIndex,
      };

      const placePerimeterNode = (seqIndex: number, distance: number) => {
        distanceByIndex.set(seqIndex, distance);
        const point = perimeterStartsOnLeft ? pointAtDistance(distance) : mirroredPointAtDistance(distance);
        const face = perimeterStartsOnLeft ? faceAtDistance(distance) : mirroredFaceAtDistance(distance);
        placeMainNode(seqIndex, point, face);
      };

      leftSideNodes.forEach((seqIndex, k) => {
        placePerimeterNode(seqIndex, (d1 * (k + 1)) / (leftSideNodes.length + 1));
      });
      bottomNodes.forEach((seqIndex, k) => {
        placePerimeterNode(seqIndex, d1 + (width * (k + 1)) / (bottomNodes.length + 1));
      });
      rightSideNodes.forEach((seqIndex, k) => {
        placePerimeterNode(seqIndex, d2 + (height * (k + 1)) / (rightSideNodes.length + 1));
      });
      topInterior.forEach((seqIndex, k) => {
        const t = (k + 1) / (topInterior.length + 1);
        const x = perimeterStartsOnLeft ? rightX - t * width : t * width;
        placeMainNode(seqIndex, { x, y: TOP_ROW_Y }, "top");
      });
    } else if (isClosed && peIdx.length === 1) {
      mainRingCaption = "Centered single-PE ring";
      const peIndex = peIdx[0];
      const childCount = Math.max(0, N - 1);
      const halfWidth = Math.max(COL_SLOT * 2, Math.ceil(childCount / 4) * COL_SLOT);
      const width = halfWidth * 2;
      const topY = TOP_ROW_Y;
      const bottomY = TOP_ROW_Y + rowGap;
      const height = bottomY - topY;
      const centerX = halfWidth;
      const leftX = 0;
      const rightX = width;
      const d1 = halfWidth;
      const d2 = d1 + height;
      const d3 = d2 + width;
      const d4 = d3 + height;
      const total = d4 + halfWidth;
      const childSpan = d4 - d1;
      const distanceByIndex = new Map<number, number>();

      const pointAtDistance = (distance: number): Point => {
        if (distance <= d1) return { x: centerX + distance, y: topY };
        if (distance <= d2) return { x: rightX, y: topY + (distance - d1) };
        if (distance <= d3) return { x: rightX - (distance - d2), y: bottomY };
        if (distance <= d4) return { x: leftX, y: bottomY - (distance - d3) };
        return { x: leftX + (distance - d4), y: topY };
      };

      const faceAtDistance = (distance: number): MainFace => {
        if (distance <= d1 || distance > d4) return "top";
        if (distance <= d2) return "right";
        if (distance <= d3) return "bottom";
        return "left";
      };

      mainPerimeterBoundary = {
        total,
        vertexDistances: [d1, d2, d3, d4],
        vertices: [
          { x: rightX, y: topY },
          { x: rightX, y: bottomY },
          { x: leftX, y: bottomY },
          { x: leftX, y: topY },
        ],
        distanceByIndex,
      };

      placeMainNode(peIndex, { x: centerX, y: topY }, "top");
      distanceByIndex.set(peIndex, 0);
      for (let k = 1; k < N; k += 1) {
        const seqIndex = (peIndex + k) % N;
        const distance = d1 + (childSpan * k) / Math.max(2, N);
        distanceByIndex.set(seqIndex, distance);
        placeMainNode(seqIndex, pointAtDistance(distance), faceAtDistance(distance));
      }
    } else {
      const { top, bottom } = splitRows(mainNodes, isPE);
      const cols = Math.max(top.length, bottom.length, 2);
      const width = (cols - 1) * COL_SLOT;
      const topY = TOP_ROW_Y;
      const bottomY = TOP_ROW_Y + rowGap;

      const placeRow = (idxList: number[], y: number, leftToRight: boolean, face: MainFace) => {
        const m = idxList.length;
        idxList.forEach((seqIndex, k) => {
          const t = m <= 1 ? 0.5 : k / (m - 1);
          const x = (leftToRight ? t : 1 - t) * width;
          placeMainNode(seqIndex, { x, y }, face);
        });
      };
      placeRow(top, topY, true, "top");
      placeRow(bottom, bottomY, false, "bottom");
    }
  } else {
    // Degraded / open main path -> a single horizontal row (never bent).
    mainNodes.forEach((_, i) => {
      placeMainNode(i, { x: i * COL_SLOT, y: TOP_ROW_Y }, "bottom");
    });
  }

  const mainBounds = boundsOf([...posByKey.values()]);

  // Main ring / path edges follow the true sequence (so distances stay correct).
  const ringEdgeCount = mainIsRing && isClosed ? N : Math.max(0, N - 1);
  for (let i = 0; i < ringEdgeCount; i += 1) {
    const a = posByKey.get(normalizedNodeLabel(mainNodes[i]));
    const b = posByKey.get(normalizedNodeLabel(mainNodes[(i + 1) % N]));
    if (a && b) {
      let points = mainEdgePoints(a, b);
      if (mainPerimeterBoundary?.distanceByIndex.has(i) && mainPerimeterBoundary.distanceByIndex.has((i + 1) % N)) {
        const startDistance = mainPerimeterBoundary.distanceByIndex.get(i) ?? 0;
        let endDistance = mainPerimeterBoundary.distanceByIndex.get((i + 1) % N) ?? 0;
        if (endDistance <= startDistance) endDistance += mainPerimeterBoundary.total;
        const crossedVertices = mainPerimeterBoundary.vertexDistances
          .map((distance, index) => ({ distance, point: mainPerimeterBoundary!.vertices[index] }))
          .filter((vertex) => vertex.distance > startDistance && vertex.distance < endDistance)
          .map((vertex) => vertex.point);
        points = dedupePoints([a, ...crossedVertices, b]);
      }
      edges.push({ points, color: roleColor("MAIN_RING"), km: main.segments[i]?.distanceKm ?? null });
    }
  }

  const faceAt = (key: string): MainFace => faceByKey.get(key) ?? "bottom";

  // ── 2. Classify attached groups by how many uplinks land on the main ring ──
  type Spur = { group: ServiceTraceTopologyGroup; junction: string; childRaws: string[] };
  type Sub = { group: ServiceTraceTopologyGroup; j1: string; j2?: string; middleRaws: string[] };
  const spurs: Spur[] = [];
  const subs: Sub[] = [];
  const classify = (groups: ServiceTraceTopologyGroup[] | undefined, forceSubring: boolean) => {
    for (const group of groups ?? []) {
      const attach = group.nodes.filter((n, index, nodes) => {
        const key = normalizedNodeLabel(n);
        return posByKey.has(key) && nodes.findIndex((candidate) => normalizedNodeLabel(candidate) === key) === index;
      });
      const children = group.nodes.filter((n) => !posByKey.has(normalizedNodeLabel(n)));
      if (forceSubring || attach.length >= 2) {
        subs.push({ group, j1: attach[0] ?? mainNodes[0], j2: attach[1], middleRaws: children.length ? children : group.nodes });
      } else if (attach.length === 1) {
        spurs.push({ group, junction: attach[0], childRaws: children });
      } else if (group.nodes.length) {
        spurs.push({ group, junction: mainNodes[0], childRaws: group.nodes });
      }
    }
  };
  classify(trace.attachedSubrings, true); // subrings always keep both main-ring uplinks
  classify(trace.attachedSpurs, false);
  classify(trace.attachedSpurChains, false);
  classify(trace.attachedSingleHomed, false);
  classify(trace.attachedInterconnects, false);

  // ── 3. Host downlinks (spurs, spur chains, single-anchor subrings) ──
  //   Every downlink of a given host is packed into its OWN non-overlapping lateral
  //   slot, sized to that downlink's real footprint, and fanned out of a shared neck
  //   next to the host. A host carrying e.g. a spur + a spur chain + a subring
  //   therefore spreads them side-by-side with padding instead of stacking them on
  //   top of each other. Two-anchor subrings span two hosts -> handled in step 4.
  const singleSubs = subs.filter((sub) => !sub.j2);
  const pairSubs = subs.filter((sub) => sub.j2);

  type DownItem = { kind: "spur"; spur: Spur } | { kind: "sub"; sub: Sub };
  const hostItems = new Map<string, DownItem[]>();
  const pushDownItem = (hostRaw: string, item: DownItem) => {
    const key = normalizedNodeLabel(hostRaw);
    const list = hostItems.get(key) ?? [];
    list.push(item);
    hostItems.set(key, list);
  };
  for (const spur of spurs) pushDownItem(spur.junction, { kind: "spur", spur });
  for (const sub of singleSubs) pushDownItem(sub.j1, { kind: "sub", sub });

  const stencilLateral = (face: MainFace) => (face === "left" || face === "right" ? MAX_STENCIL_HEIGHT : MAX_STENCIL_WIDTH);
  const isClosedSub = (sub: Sub) => Boolean(sub.group.isClosedRing) && sub.middleRaws.length > 0;
  const itemFootprint = (item: DownItem, face: MainFace): number => {
    const latDim = stencilLateral(face) + BAND_GAP;
    if (item.kind === "sub" && isClosedSub(item.sub)) return subringLoopSpan(item.sub.middleRaws.length) + latDim;
    return latDim;
  };

  const placeChild = (raw: string, candidate: Point): Point => {
    const key = normalizedNodeLabel(raw);
    const point = applyManualOffset(key, candidate);
    placed.push({ key, render: toRenderNode(raw, coreSet, jumperSet), point });
    occupied.push(point);
    return point;
  };

  // A straight column of nodes (spur / spur chain / open subring) dropping out of
  // the host, bundled through the shared neck then fanned across to its slot centre.
  const renderColumn = (
    raws: string[],
    group: ServiceTraceTopologyGroup,
    host: Point,
    geom: FaceGeom,
    hostLat: number,
    latCenter: number,
  ) => {
    const track = resolveTrack(raws.map((_, k) => geom.toPoint(latCenter, BRANCH_CLEARANCE + k * BRANCH_STEP)), geom.out, occupied);
    let prev = host;
    raws.forEach((raw, k) => {
      const point = placeChild(raw, track[k]);
      const points = k === 0
        ? dedupePoints([host, geom.toPoint(hostLat, SINGLE_ANCHOR_NECK_DROP), geom.toPoint(latCenter, SINGLE_ANCHOR_NECK_DROP), point])
        : orthogonalPoints(prev, point);
      edges.push({ points, color: roleColor(group.topologyRole), km: group.segments[k]?.distanceKm ?? null });
      prev = point;
    });
  };

  // A closed single-anchor subring: squeeze both ring-ends into a narrow neck at the
  // host, run the parallel channel clear of the ring, then expand into a wide box.
  const renderClosedSubring = (
    sub: Sub,
    host: Point,
    geom: FaceGeom,
    hostLat: number,
    latCenter: number,
    boxDepth: number,
  ) => {
    const raws = sub.middleRaws;
    const n = raws.length;
    const span = subringLoopSpan(n);
    const latAt = (k: number) => latCenter - span / 2 + span * (n === 1 ? 0.5 : k / (n - 1));
    const track = resolveTrack(raws.map((_, k) => geom.toPoint(latAt(k), boxDepth)), geom.out, occupied);
    const pts = raws.map((raw, k) => placeChild(raw, track[k]));
    const color = roleColor("SUBRING");
    const half = SINGLE_ANCHOR_NECK_HALF_GAP;
    // Two parallel neck lines diverge at the host (±half), run out to neck depth as
    // a narrow channel, then expand laterally to the node box.
    const hostA = geom.shift(host, -half);
    const hostB = geom.shift(host, half);
    const neckA = geom.toPoint(hostLat - half, SINGLE_ANCHOR_NECK_DROP);
    const neckB = geom.toPoint(hostLat + half, SINGLE_ANCHOR_NECK_DROP);
    const shoulderA = geom.toPoint(latAt(0), SINGLE_ANCHOR_NECK_DROP);
    const shoulderB = geom.toPoint(latAt(n - 1), SINGLE_ANCHOR_NECK_DROP);
    const first = pts[0];
    const last = pts[n - 1];
    edges.push({ points: dedupePoints([host, hostA, neckA, shoulderA, first]), color, km: sub.group.segments[0]?.distanceKm ?? null });
    for (let k = 1; k < n; k += 1) {
      edges.push({ points: orthogonalPoints(pts[k - 1], pts[k]), color, km: sub.group.segments[k]?.distanceKm ?? null });
    }
    edges.push({ points: dedupePoints([last, shoulderB, neckB, hostB, host]), color, km: sub.group.segments[n]?.distanceKm ?? null });
  };

  for (const [hostKey, items] of hostItems) {
    const host = posByKey.get(hostKey);
    if (!host) continue;
    const face = faceAt(hostKey);
    const geom = faceGeom(face, mainBounds);
    const hostLat = geom.lateralOf(host);
    const slots = allocateLateralSlots(items.map((item) => itemFootprint(item, face)), BAND_GAP);
    items.forEach((item, i) => {
      const latCenter = hostLat + slots[i].center;
      if (item.kind === "spur") {
        renderColumn(item.spur.childRaws, item.spur.group, host, geom, hostLat, latCenter);
      } else if (isClosedSub(item.sub)) {
        renderClosedSubring(item.sub, host, geom, hostLat, latCenter, SUBRING_OUTER_GAP);
      } else {
        renderColumn(item.sub.middleRaws, item.sub.group, host, geom, hostLat, latCenter);
      }
    });
  }

  // ── 4. Two-anchor subrings -> squeeze at both anchors, expand into a box ──
  const subLaneByFace = new Map<MainFace, number>();
  let crossFaceSubLane = 0;
  for (const sub of pairSubs) {
    const p1 = posByKey.get(normalizedNodeLabel(sub.j1));
    const p2 = sub.j2 ? posByKey.get(normalizedNodeLabel(sub.j2)) : undefined;
    if (!p1 || !p2 || !sub.j2) continue;
    const m = sub.middleRaws.length;
    const face1 = faceAt(normalizedNodeLabel(sub.j1));
    const face2 = faceAt(normalizedNodeLabel(sub.j2));
    const color = roleColor("SUBRING");

    if (face1 === face2) {
      // Neighbour anchors on the same face. Transmission flow is a LINEAR chain
      //   anchor1 -> node0 -> ... -> nodeLast -> anchor2
      // so each anchor connects ONLY to its own end node (never the interior). The
      // node lane is oriented so node0 sits on anchor1's side and nodeLast on
      // anchor2's side; each anchor routes over a shallow collector lane straight to
      // its end node, so no line ever points at an interior (non-connected) node.
      const geom = faceGeom(face1, mainBounds);
      const lat1 = geom.lateralOf(p1);
      const lat2 = geom.lateralOf(p2);
      const midLat = (lat1 + lat2) / 2;
      const lane = subLaneByFace.get(face1) ?? 0;
      subLaneByFace.set(face1, lane + 1);
      const boxDepth = SUBRING_OUTER_GAP + lane * SUBRING_LANE_GAP;
      const collectorDepth = SINGLE_ANCHOR_NECK_DROP + lane * SUBRING_LANE_GAP; // always shallower than boxDepth
      const span = Math.max(subringLoopSpan(Math.max(m, 1)), Math.abs(lat2 - lat1) + stencilLateral(face1));
      const dir = lat2 >= lat1 ? 1 : -1; // node0 -> anchor1 side, nodeLast -> anchor2 side
      const latAt = (k: number) => midLat - dir * (span / 2) + dir * span * (m <= 1 ? 0.5 : k / (m - 1));
      const track = resolveTrack(sub.middleRaws.map((_, k) => geom.toPoint(latAt(k), boxDepth)), geom.out, occupied);
      const pts = sub.middleRaws.map((raw, k) => placeChild(raw, track[k]));
      if (pts.length === 0) {
        edges.push({ points: dedupePoints([p1, geom.toPoint(lat1, collectorDepth), geom.toPoint(lat2, collectorDepth), p2]), color, km: sub.group.segments[0]?.distanceKm ?? null });
      } else {
        const first = pts[0];
        const last = pts[pts.length - 1];
        // anchor1 -> its own end node (node0), running over the shallow collector.
        edges.push({ points: dedupePoints([p1, geom.toPoint(lat1, collectorDepth), geom.toPoint(latAt(0), collectorDepth), first]), color, km: sub.group.segments[0]?.distanceKm ?? null });
        for (let k = 1; k < pts.length; k += 1) {
          edges.push({ points: orthogonalPoints(pts[k - 1], pts[k]), color, km: sub.group.segments[k]?.distanceKm ?? null });
        }
        // nodeLast -> anchor2 (its own end), again over the shallow collector.
        edges.push({ points: dedupePoints([last, geom.toPoint(latAt(m - 1), collectorDepth), geom.toPoint(lat2, collectorDepth), p2]), color, km: sub.group.segments[m]?.distanceKm ?? null });
      }
    } else {
      // Cross-face anchors: route around the nearest side corridor.
      const lane = crossFaceSubLane;
      crossFaceSubLane += 1;
      const centerX = (mainBounds.minX + mainBounds.maxX) / 2;
      const sideSign = (p1.x + p2.x) / 2 < centerX ? -1 : 1;
      const sideX = sideSign < 0
        ? mainBounds.minX - SUBRING_OUTER_GAP - lane * SUBRING_LANE_GAP
        : mainBounds.maxX + SUBRING_OUTER_GAP + lane * SUBRING_LANE_GAP;
      const exitFor = (point: Point, face: MainFace): Point => {
        if (face === "bottom" || face === "top") return { x: point.x, y: mainBounds.maxY + SUBRING_OUTER_GAP + lane * SUBRING_LANE_GAP };
        if (face === "left") return { x: mainBounds.minX - SUBRING_OUTER_GAP - lane * SUBRING_LANE_GAP, y: point.y };
        return { x: mainBounds.maxX + SUBRING_OUTER_GAP + lane * SUBRING_LANE_GAP, y: point.y };
      };
      const startExit = exitFor(p1, face1);
      const endExit = exitFor(p2, face2);
      const pushDir = { x: sideSign, y: 0 };
      const track = resolveTrack(sub.middleRaws.map((_, k) => {
        const t = (k + 1) / (m + 1);
        return { x: sideX, y: startExit.y + (endExit.y - startExit.y) * t };
      }), pushDir, occupied);
      const pts = sub.middleRaws.map((raw, k) => placeChild(raw, track[k]));
      if (pts.length === 0) {
        edges.push({ points: dedupePoints([p1, startExit, { x: sideX, y: startExit.y }, { x: sideX, y: endExit.y }, endExit, p2]), color, km: sub.group.segments[0]?.distanceKm ?? null });
      } else {
        let prev = p1;
        pts.forEach((pt, k) => {
          edges.push({ points: k === 0 ? dedupePoints([prev, startExit, { x: pt.x, y: startExit.y }, pt]) : orthogonalPoints(prev, pt, "vertical"), color, km: sub.group.segments[k]?.distanceKm ?? null });
          prev = pt;
        });
        edges.push({ points: dedupePoints([prev, { x: prev.x, y: endExit.y }, endExit, p2]), color, km: sub.group.segments[m]?.distanceKm ?? null });
      }
    }
  }

  const applyManualLineOffsets = (points: Point[], edgeKey: string): Point[] => {
    if (points.length < 2) return points;
    let adjusted = points.map((point) => ({ ...point }));
    for (let index = 0; index < adjusted.length - 1; index += 1) {
      const offset = manualLineOffsets[`${edgeKey}:${index}`];
      if (!offset) continue;
      const from = adjusted[index];
      const to = adjusted[index + 1];
      const isHorizontal = from.y === to.y;
      const isVertical = from.x === to.x;
      if (!isHorizontal && !isVertical) continue;
      const isInterior = index > 0 && index < adjusted.length - 2;
      if (!isInterior) {
        const shiftedFrom = isHorizontal ? { x: from.x, y: from.y + offset } : { x: from.x + offset, y: from.y };
        const shiftedTo = isHorizontal ? { x: to.x, y: to.y + offset } : { x: to.x + offset, y: to.y };
        adjusted = [
          ...adjusted.slice(0, index + 1),
          shiftedFrom,
          shiftedTo,
          ...adjusted.slice(index + 1),
        ];
        index += 2;
      } else if (isHorizontal) {
        from.y += offset;
        to.y += offset;
      } else if (isVertical) {
        from.x += offset;
        to.x += offset;
      }
    }
    return dedupePoints(adjusted);
  };
  const adjustedEdges = edges.map((edge, index) => ({
    ...edge,
    points: applyManualLineOffsets(edge.points, `edge-${index}`),
  }));

  // ── 5. Content-driven viewBox (fits everything + label padding) ──
  const padX = MAX_STENCIL_WIDTH / 2 + 36;
  const padY = MAX_STENCIL_HEIGHT / 2 + 42;
  const allPoints = [...placed.map((p) => p.point), ...adjustedEdges.flatMap((edge) => edge.points)];
  const xs = allPoints.map((point) => point.x);
  const ys = allPoints.map((point) => point.y);
  const minX = Math.min(...xs) - padX;
  const maxX = Math.max(...xs) + padX;
  const minY = mainIsRing ? Math.max(0, Math.min(...ys) - padY) : Math.min(...ys) - padY;
  const maxY = Math.max(...ys) + padY;
  const vbW = Math.max(1, maxX - minX);
  const vbH = Math.max(1, maxY - minY);

  const fitScale = containerW > 0 ? containerW / vbW : 1;
  const effScale = zoom ?? fitScale;
  const renderW = vbW * effScale;
  const renderH = vbH * effScale;
  const bumpZoom = (factor: number) => setZoom(Math.min(3, Math.max(0.15, effScale * factor)));

  // Interactions (parity with the per-group canvases).
  const editable = Boolean(onToggleJumper);
  const openContext = (node: string, isJumper: boolean, point: Point) => {
    if (suppressClickRef.current || dragRef.current?.moved) return;
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
    const willFlag = !flagged.has(node);
    setFlagged((prev) => {
      const next = new Set(prev);
      if (willFlag) next.add(node);
      else next.delete(node);
      return next;
    });
    onFlagSite?.(node, willFlag);
  };
  const menuW = 172;
  const menuH = 66;
  const menuX = contextNode ? clamp(contextNode.point.x + 16, minX + 8, maxX - menuW - 8) : 0;
  const menuY = contextNode ? clamp(contextNode.point.y - menuH / 2, minY + 8, maxY - menuH - 8) : 0;

  const branchCount = spurs.length + subs.length;
  const ringLabelPoint = {
    x: (mainBounds.minX + mainBounds.maxX) / 2,
    y: (mainBounds.minY + mainBounds.maxY) / 2,
  };
  const hasManualTweaks = Object.keys(manualOffsets).length > 0 || Object.keys(manualLineOffsets).length > 0;

  return (
    <div className={isFull ? "fixed inset-0 z-[100] flex h-screen w-screen flex-col bg-white p-4 text-[var(--text-main)] dark:bg-slate-950" : undefined}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setZoom(null)} className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--surface)]">
          Fit
        </button>
        <button type="button" onClick={() => bumpZoom(0.8)} aria-label="Zoom out" className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--surface)]">
          −
        </button>
        <button type="button" onClick={() => bumpZoom(1.25)} aria-label="Zoom in" className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--surface)]">
          +
        </button>
        <button type="button" onClick={() => setZoom(1)} className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--surface)]">
          100%
        </button>
        <span className="ml-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">{Math.round(effScale * 100)}%</span>
        <button
          type="button"
          onClick={() => {
            setManualOffsets({});
            setManualLineOffsets({});
          }}
          disabled={!hasManualTweaks}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-45"
          title="Reset manual node and line adjustments"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset tweaks
        </button>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
          <Move className="h-3 w-3" />
          {draggingKey ? "Dragging" : "Drag nodes / line handles"}
        </span>
        <button
          type="button"
          onClick={() => setIsFull((value) => !value)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-main)] transition hover:bg-[var(--surface)]"
          title={isFull ? "Exit fullscreen (Esc)" : "View fullscreen"}
          aria-pressed={isFull}
        >
          {isFull ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {isFull ? "Exit fullscreen" : "View fullscreen"}
        </button>
      </div>
      <div
        ref={containerRef}
        className={`service-topology-ring overflow-auto rounded-xl border border-[var(--border)] ${isFull ? "min-h-0 flex-1 bg-white dark:bg-slate-950" : "bg-[var(--surface-2)]/40"}`}
        style={isFull ? undefined : { maxHeight: "78vh" }}
      >
        <svg
          ref={svgRef}
          viewBox={`${minX} ${minY} ${vbW} ${vbH}`}
          width={renderW}
          height={renderH}
          style={{ maxWidth: "none", display: "block" }}
          role="img"
          aria-label={`Unified topology for ${trace.serviceCode}: rectangular main ring + ${branchCount} attached branch group(s)`}
          onClick={() => setContextNode(null)}
          onPointerMove={updateCanvasDrag}
          onPointerUp={endNodeDrag}
          onPointerCancel={endNodeDrag}
        >
          {mainIsRing ? (
            <text
              x={ringLabelPoint.x}
              y={ringLabelPoint.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="25pt"
              fontWeight={900}
              fill="var(--text-main, #0f172a)"
              opacity={1}
              style={{ pointerEvents: "none" }}
            >
              {trace.serviceCode}
            </text>
          ) : null}
          {adjustedEdges.map((edge, i) => {
            const label = polylineLabelPoint(edge.points);
            const mx = label.x;
            const my = label.y;
            return (
              <g key={`edge-${i}`}>
                <path d={pathFromPoints(edge.points)} fill="none" stroke={edge.color} strokeWidth={2.5} opacity={0.85} strokeLinecap="round" strokeLinejoin="round" />
                {edge.km != null ? (
                  <>
                    <rect x={mx - 22} y={my - 9} width={44} height={15} rx={4} fill="var(--surface, #0f172a)" opacity={0.9} />
                    <text x={mx} y={my + 2} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--muted-text, #94a3b8)">
                      {edge.km} km
                    </text>
                  </>
                ) : null}
              </g>
            );
          })}
          {placed.map((node, i) => (
            <StencilNode
              key={`node-${node.key}-${i}`}
              node={node.render}
              point={node.point}
              role={selectStencil(node.render)}
              clipId={`${gid}-u-${i}`}
              busy={busyNode === node.render.clean}
              flagged={flagged.has(node.render.clean)}
              editable={editable}
              draggable={manualAdjustable}
              onPointerDown={(event) => beginNodeDrag(event, node.key, node.point)}
              onClick={(event) => {
                event.stopPropagation();
                openContext(node.render.clean, node.render.isJumper, node.point);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                toggleProvisionTarget(node.render.clean);
              }}
            />
          ))}
          {manualAdjustable
            ? adjustedEdges.map((edge, i) => (
                <g key={`edge-${i}-handles`}>
                  {edge.points.slice(0, -1).map((from, segmentIndex) => {
                    const to = edge.points[segmentIndex + 1];
                    const isOrthogonal = from.x === to.x || from.y === to.y;
                    const length = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
                    if (!isOrthogonal || length < 34) return null;
                    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
                    const cursor = from.y === to.y ? "ns-resize" : "ew-resize";
                    return (
                      <g key={`edge-${i}-handle-${segmentIndex}`}>
                        <path
                          d={pathFromPoints([from, to])}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={18}
                          strokeLinecap="round"
                          style={{ cursor }}
                          onPointerDown={(event) => beginLineDrag(event, `edge-${i}`, segmentIndex, edge.points)}
                        />
                        <rect
                          x={mid.x - 5}
                          y={mid.y - 5}
                          width={10}
                          height={10}
                          rx={2}
                          fill="#06b6d4"
                          stroke="var(--surface, #ffffff)"
                          strokeWidth={1.5}
                          opacity={0.88}
                          style={{ cursor }}
                          onPointerDown={(event) => beginLineDrag(event, `edge-${i}`, segmentIndex, edge.points)}
                        >
                          <title>Drag to shift this orthogonal line segment</title>
                        </rect>
                      </g>
                    );
                  })}
                </g>
              ))
            : null}
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
                <rect x={126} y={29} width={36} height={24} rx={6} fill="#33553b" />
                <text x={144} y={45} textAnchor="middle" fontSize={11} fontWeight={800} fill="#ffffff">
                  Close
                </text>
              </g>
            </g>
          ) : null}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
        <span>{mainRingCaption} · {N} sites · {branchCount} attached branch group(s)</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: ROLE_EDGE_COLOR.MAIN_RING }} /> main ring</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: ROLE_EDGE_COLOR.SUBRING }} /> subring</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: ROLE_EDGE_COLOR.SPUR }} /> spur</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: ROLE_EDGE_COLOR.SPUR_CHAIN }} /> spur chain</span>
        <span>PE/Core/DC = blue · ATN = access · jumper = yellow stencil</span>
        <span className="text-red-600 dark:text-red-400">single-click = configure · double-click = Ready for Integration</span>
      </div>
    </div>
  );
}
