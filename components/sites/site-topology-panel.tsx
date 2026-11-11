"use client";

import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { Filter, Maximize2, Minimize2 } from "lucide-react";
import type { SiteConnectivityNode } from "@/types/site-connectivity";

// Preferred display order for the link-type filter chips. "default" is the
// general-purpose transport bucket (normal segments usable by any service).
// Any type not listed here (a future tag/role) is appended alphabetically, so
// the filter always exposes every type present — nothing is silently dropped.
const LINK_TYPE_ORDER = ["default", "Backbone", "GPON", "B2B"];

function orderLinkTypes(types: Iterable<string>): string[] {
  return [...new Set(types)].sort((a, b) => {
    const ai = LINK_TYPE_ORDER.indexOf(a);
    const bi = LINK_TYPE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function statusColor(status: SiteConnectivityNode["status"]): string {
  if (status === "Critical") return "#ef4444";
  if (status === "High") return "#f97316";
  if (status === "Moderate") return "#f59e0b";
  if (status === "Low") return "#22c55e";
  return "#64748b";
}

function nodePosition(index: number, total: number) {
  // Horizontal-first projection for wide monitor/browser canvases.
  // Fill the X-axis row first, then add additional rows on the Y-axis.
  // This avoids the old circular layout stretching vertically and clipping nodes.
  const horizontalCapacity = total > 24 ? 8 : total > 14 ? 7 : 6;
  const xSpacing = total > 24 ? 190 : 220;
  const ySpacing = 150;
  const firstRowYOffset = 210;

  const rowIndex = Math.floor(index / horizontalCapacity);
  const columnIndex = index % horizontalCapacity;
  const columnsInRow = Math.min(horizontalCapacity, Math.max(0, total - rowIndex * horizontalCapacity));
  const x = (columnIndex - (columnsInRow - 1) / 2) * xSpacing;

  // Rows alternate below and above the center after the first horizontal row so
  // large payloads use width first but remain balanced inside the SVG workspace.
  if (rowIndex === 0) return { x, y: firstRowYOffset };
  const layer = Math.ceil(rowIndex / 2);
  const direction = rowIndex % 2 === 1 ? -1 : 1;
  return { x, y: direction * (firstRowYOffset + layer * ySpacing) };
}

export function SiteTopologyPanel({ centerSite, nodes: connectedNodes }: { centerSite: string; nodes: SiteConnectivityNode[] }) {
  const [isFull, setIsFull] = useState(false);

  // Every link type present around this site, in display order. The canvas used
  // to blanket-hide GPON / B2B; now the operator picks exactly which types show.
  const availableTypes = useMemo(
    () => orderLinkTypes(connectedNodes.flatMap((node) => node.linkTypes ?? [])),
    [connectedNodes],
  );
  const typesKey = availableTypes.join("|");
  // Default: every type selected (nothing hidden). Reset to "all" whenever the
  // available set changes (i.e. a different site is loaded).
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => new Set(availableTypes));
  useEffect(() => {
    setSelectedTypes(new Set(availableTypes));
  }, [typesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of connectedNodes) {
      for (const type of new Set(node.linkTypes ?? [])) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
  }, [connectedNodes]);

  const visibleNodes = useMemo(
    () => connectedNodes.filter((node) => {
      const types = node.linkTypes ?? [];
      return types.length ? types.some((type) => selectedTypes.has(type)) : true;
    }),
    [connectedNodes, selectedTypes],
  );
  const hiddenCount = connectedNodes.length - visibleNodes.length;
  const allSelected = availableTypes.length > 0 && selectedTypes.size === availableTypes.length;

  const toggleType = (type: string) =>
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  const selectAllTypes = () => setSelectedTypes(new Set(availableTypes));
  const clearTypes = () => setSelectedTypes(new Set());

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

  const remoteNodeId = (node: SiteConnectivityNode, index: number) => `${node.siteCode || "UNKNOWN"}-${index}`;
  const flowNodes: Node[] = [
    {
      id: centerSite,
      position: { x: 0, y: 0 },
      data: { label: centerSite },
      style: {
        width: 128,
        height: 128,
        borderRadius: 64,
        border: "1px solid rgba(14,165,233,.7)",
        background: "radial-gradient(circle at 35% 30%, #38bdf8, #1d4ed8 72%)",
        color: "#eff6ff",
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 0 44px rgba(14,165,233,.4)",
      },
    },
    ...visibleNodes.map((node, index) => {
      const position = nodePosition(index, visibleNodes.length);
      const color = statusColor(node.status);
      const distanceText = node.distanceKm != null ? ` · ${node.distanceKm} km${node.segmentCount > 1 ? "+" : ""}` : "";
      return {
        id: remoteNodeId(node, index),
        position,
        data: { label: `${node.siteCode}\n${node.segmentCount} segment(s)${distanceText}` },
        style: {
          width: 156,
          minHeight: 68,
          borderRadius: 12,
          border: `1px solid ${color}`,
          background: node.isCoreSite ? "rgba(127,29,29,.42)" : "rgba(15,23,42,.92)",
          color: "#e2e8f0",
          whiteSpace: "pre-line",
          fontSize: 12,
          lineHeight: 1.45,
          textAlign: "center" as const,
          padding: 12,
          boxShadow: "0 10px 24px rgba(2,6,23,.25)",
        },
      };
    }),
  ];

  const flowEdges: Edge[] = visibleNodes.map((node, index) => {
    const color = statusColor(node.status);
    return {
      id: `${centerSite}-${remoteNodeId(node, index)}`,
      source: centerSite,
      target: remoteNodeId(node, index),
      animated: node.status === "Critical" || node.status === "High",
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: node.hasParallelLinks ? 3 : 2 },
      interactionWidth: 20,
    };
  });

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-title">Site Topology (Direct Connections)</div>
          <div className="subtle mt-1">
            Graph canvas for live direct physical connectivity around {centerSite}. Use the segment-type filter to
            choose which segment types (default, Backbone, GPON, B2B) appear; each connection shows its distance.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="badge badge-spare">{visibleNodes.length} connected sites</span>
          <span className="badge tag-none">{visibleNodes.reduce((sum, node) => sum + node.segmentCount, 0)} direct segments</span>
          <button
            type="button"
            onClick={() => setIsFull((value) => !value)}
            className="badge tag-none inline-flex items-center gap-1"
            title={isFull ? "Exit fullscreen (Esc)" : "Maximize canvas"}
            aria-pressed={isFull}
          >
            {isFull ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {isFull ? "Exit fullscreen" : "Maximize"}
          </button>
        </div>
      </div>

      {/* Segment-type filter — replaces the old blanket GPON/B2B hide. Each chip
          toggles a segment type on/off; only sites reachable via a selected type
          stay on the canvas. */}
      {availableTypes.length ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-semibold text-slate-500 dark:text-slate-400">
            <Filter className="h-3.5 w-3.5" /> Segment types
          </span>
          {availableTypes.map((type) => {
            const active = selectedTypes.has(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                className={`badge inline-flex items-center gap-1 ${active ? "badge-active" : "tag-none opacity-60"}`}
                aria-pressed={active}
                title={`${active ? "Hide" : "Show"} ${type} segments (${typeCounts.get(type) ?? 0} site(s))`}
              >
                {type} <span className="opacity-70">{typeCounts.get(type) ?? 0}</span>
              </button>
            );
          })}
          <span className="mx-1 h-4 w-px bg-slate-300/60 dark:bg-slate-600/60" aria-hidden />
          <button
            type="button"
            onClick={selectAllTypes}
            disabled={allSelected}
            className="badge tag-none disabled:opacity-40"
            title="Show every segment type"
          >
            All
          </button>
          <button
            type="button"
            onClick={clearTypes}
            disabled={selectedTypes.size === 0}
            className="badge tag-none disabled:opacity-40"
            title="Hide every segment type"
          >
            None
          </button>
          {hiddenCount > 0 ? <span className="text-slate-400">{hiddenCount} site(s) filtered out</span> : null}
        </div>
      ) : null}

      <div
        className={
          isFull
            ? "site-topology-shell fixed inset-0 z-[60] h-screen w-screen overflow-hidden bg-[radial-gradient(circle_at_center,rgba(14,165,233,.14)_0%,#0f172a_55%,#0c1322_100%)]"
            : "site-topology-shell mt-5 h-[680px] overflow-hidden rounded-2xl border border-slate-700/60 bg-[radial-gradient(circle_at_center,rgba(14,165,233,.14)_0%,#0f172a_55%,#0c1322_100%)]"
        }
      >
        {isFull ? (
          <button
            type="button"
            onClick={() => setIsFull(false)}
            className="badge tag-none absolute right-4 top-4 z-[61] inline-flex items-center gap-1"
            title="Exit fullscreen (Esc)"
          >
            <Minimize2 className="h-3.5 w-3.5" /> Exit fullscreen
          </button>
        ) : null}
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          fitView
          fitViewOptions={{ padding: 0.22 }}
          minZoom={0.35}
          maxZoom={1.8}
          onNodeClick={(_, node) => {
            const target = visibleNodes.find((item, index) => remoteNodeId(item, index) === node.id);
            if (target?.siteCode) window.location.href = `/sites/${target.siteCode}`;
          }}
        >
          <Background color="#1e293b" gap={28} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="mt-4 table-shell max-h-[280px] overflow-auto">
        <table>
          <thead>
            <tr>
              <th>Connected site</th>
              <th>Segments</th>
              <th>Segment types</th>
              <th>Distance</th>
              <th>Services</th>
              <th>Rack / ODF / Port</th>
              <th>Cable</th>
              <th>Utilization</th>
            </tr>
          </thead>
          <tbody>
            {visibleNodes.map((node, index) => (
              <tr key={`${node.siteCode}-${index}`}>
                <td>{node.siteCode}</td>
                <td>{node.segmentCount}</td>
                <td>{node.linkTypes?.length ? node.linkTypes.join(", ") : "-"}</td>
                <td>{node.distanceKm === null || node.distanceKm === undefined ? "-" : `${node.distanceKm} km`}</td>
                <td>{node.serviceCount}</td>
                <td>{[node.rackSummary, node.odfSummary, node.portSummary].filter(Boolean).join(" / ") || "-"}</td>
                <td>{node.cableSummary ?? "-"}</td>
                <td>{node.utilizationPct === null || node.utilizationPct === undefined ? "-" : `${node.utilizationPct}%`}</td>
              </tr>
            ))}
            {!visibleNodes.length ? (
              <tr>
                <td colSpan={8}>
                  {connectedNodes.length
                    ? `No sites match the selected segment types. ${connectedNodes.length} connected site(s) filtered out — adjust the segment-type filter above.`
                    : "No direct connected sites found."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
