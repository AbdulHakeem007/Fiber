"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, Loader2, Mail, Pencil, Radar, RotateCcw, Save, Search, Trash2, Undo2, X } from "lucide-react";
import { usePendingDeletions, type PendingDeletionHold } from "@/lib/hooks/use-pending-deletions";
import {
  activeInventoryFilterEntries,
  inventoryFiltersToParams,
  matchesInventoryFilters,
  type InventoryFilters,
} from "@/lib/filters/inventory-filters";
import { REGION_OPTIONS } from "@/lib/config/regions";
import { PAGE_SIZE_OPTIONS } from "@/lib/config/ui";
import { SuggestionInput } from "@/components/ui/suggestion-input";
import { UtilizationFilter, matchesUtilizationTier, type UtilizationTier } from "@/components/ui/utilization-filter";
import { ChildLinkTagDropdown } from "@/components/inventory/child-link-tag-dropdown";
import { ChildTagFilter } from "@/components/inventory/child-tag-filter";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { DraggablePanel } from "@/components/ui/draggable-panel";
import { badgeClassForStatus, displayStatusLabel } from "@/lib/utils/status";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode, normalizeSiteCode } from "@/lib/telecom/connection-identity";
import { displaySiteHrefKey, displaySiteLabel } from "@/lib/telecom/site-display";
import { fiberCountFromUnit } from "@/lib/telecom/fiber-unit";
import { segmentDisplaySubtitle, segmentDisplayTitle } from "@/lib/telecom/segment-naming";
import { SEGMENT_TYPES, CHILD_TOPOLOGY_ROLES, effectiveTopologyRole, segmentTypeLabel, topologyRoleLabel, topologyRoleSourceLabel, normalizeSegmentDefaultTopologyRole, normalizeTopologyRole } from "@/lib/telecom/topology-role";
import { useRowFlash, rowFlashStyle } from "@/lib/hooks/use-row-flash";
import { useToast } from "@/components/ui/toast";
import type { CutoverImpactSummary } from "@/types/impact";
import type { InventoryMappingRow, InventorySegmentRow, SegmentStatus } from "@/types/telecom";

// Adaptive-pagination threshold. At or below this many matching rows the table
// collapses pagination and shows every match inline; above it, standard
// multi-page pagination stays on to keep the heavy grid from lagging.
const CONSOLIDATION_LIMIT = 1000;
const SEARCH_DEBOUNCE_MS = 300;

// Segment-editor fields whose values are checked against ODF & Rack inventory so
// the operator sees a live registered/not-registered mark before saving.
type AssetCheckState = "idle" | "checking" | "ok" | "missing";
const ASSET_CHECK_FIELDS = ["nearSite", "nearRack", "nearOdf", "farSite", "farRack", "farOdf"] as const;
type AssetCheckField = (typeof ASSET_CHECK_FIELDS)[number];

const STATUSES: SegmentStatus[] = ["ACTIVE", "AVAILABLE", "RESERVED", "FAULTY", "DUMMY", "DECOMMISSIONED", "REHOMED"];
const EDITABLE_STATUSES: SegmentStatus[] = ["ACTIVE", "AVAILABLE", "RESERVED", "FAULTY", "DUMMY", "PLANNED", "INACTIVE", "DECOMMISSIONED"];
const CHILD_EDITABLE_STATUSES: SegmentStatus[] = ["ACTIVE", "AVAILABLE", "RESERVED", "FAULTY", "PLANNED", "INACTIVE", "DECOMMISSIONED"];
const BULK_CHILD_STATUSES: SegmentStatus[] = CHILD_EDITABLE_STATUSES;

function siteHref(label?: string | null, code?: string | null): Route {
  return `/sites/${encodeURIComponent(displaySiteHrefKey(code ?? label))}` as Route;
}

function suggestionKindForFilter(key: string): string | null {
  if (["site"].includes(key)) return "sites";
  if (["connectedSite"].includes(key)) return "connected-sites";
  if (["serviceId"].includes(key)) return "services";
  if (["rackId"].includes(key)) return "racks";
  if (["odfId"].includes(key)) return "odfs";
  if (["portPair"].includes(key)) return "ports";
  if (["cableId"].includes(key)) return "segments";
  if (["tubeNumber", "tubeColor", "fiberNumber"].includes(key)) return "ports";
  return null;
}

function suggestionKindForEditor(key: string): string | null {
  if (["segmentCode"].includes(key)) return "segments";
  if (["nearSite", "farSite", "insertedSite"].includes(key)) return "sites";
  if (["nearRack", "farRack", "insertedNearRack", "insertedFarRack"].includes(key)) return "racks";
  if (["nearOdf", "farOdf", "insertedNearOdf", "insertedFarOdf"].includes(key)) return "odfs";
  if (["borrowedPortGroup", "insertedNearPortGroup", "insertedFarPortGroup"].includes(key)) return "ports";
  return null;
}

function splitPortRange(label?: string | null): { start: string; end: string } {
  const normalized = normalizePortLabel(label);
  const match = normalized?.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return { start: "", end: "" };
  return { start: match[1], end: match[2] ?? match[1] };
}

function rangeLabel(start?: string | null, end?: string | null): string {
  const first = String(start ?? "").trim();
  const last = String(end ?? "").trim();
  if (!first && !last) return "";
  if (first && !last) return first;
  if (!first && last) return last;
  return first === last ? first : `${first}-${last}`;
}

function childFiberCount(child: InventoryMappingRow): number {
  const inferredCount = fiberCountFromUnit(child.localPort ?? child.farPort, child.fiberNumbers);
  return child.fiberCount ?? inferredCount ?? 1;
}

function childFiberNumbers(child: InventoryMappingRow): number[] {
  if (Number.isInteger(child.fiberNumber) && Number(child.fiberNumber) > 0) return [Number(child.fiberNumber)];
  const text = String(child.fiberNumbers ?? child.localPort ?? child.farPort ?? "");
  const values = text.match(/\d+/g)?.map(Number).filter((value) => Number.isInteger(value) && value > 0) ?? [];
  if (values.length >= 2 && text.includes("-")) {
    const start = Math.min(values[0], values[1]);
    const end = Math.max(values[0], values[1]);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function childRowFiberSortKey(child: InventoryMappingRow): number {
  // Benchmark = NEAR-site ODF port (localPort). Each child row is a single record
  // holding BOTH its near and far port, so ordering rows by the near port carries
  // each far-end mapping along with it — the near↔far pairing is never disturbed.
  const near = String(child.localPort ?? "").match(/\d+/)?.[0];
  if (near !== undefined) return Number(near);
  const far = String(child.farPort ?? "").match(/\d+/)?.[0];
  if (far !== undefined) return Number(far);
  const numbers = childFiberNumbers(child);
  return numbers.length ? numbers[0] : Number.MAX_SAFE_INTEGER;
}

function sortChildRowsAscending(children: InventoryMappingRow[]): InventoryMappingRow[] {
  // Strict ascending order by the near-site port, regardless of source order (the
  // /fibers API returns rows in createdAt order). Presentation-only ordering — it
  // never alters any split/child derivation, and rows move as whole near+far units.
  return [...children].sort((a, b) =>
    childRowFiberSortKey(a) - childRowFiberSortKey(b)
    || String(a.localPort ?? a.farPort ?? "").localeCompare(String(b.localPort ?? b.farPort ?? ""), undefined, { numeric: true })
    || String(a.id).localeCompare(String(b.id)),
  );
}

function isLiveSelectableChild(child: InventoryMappingRow): boolean {
  const status = String(child.status ?? "").toUpperCase();
  return !["FAULTY", "DUMMY", "DECOMMISSIONED", "UNKNOWN", "PLANNED", "REHOMED"].includes(status);
}

function isLiveDisplayChild(child: InventoryMappingRow): boolean {
  const status = String(child.status ?? "").toUpperCase();
  // REHOMED rows remain visible as cleanup-only records after an approved partial split.
  // They are not counted as live parent capacity and may be safely deleted.
  return !["DUMMY", "DECOMMISSIONED"].includes(status);
}

function childStats(children: InventoryMappingRow[]) {
  let total = 0;
  let used = 0;
  let reserved = 0;
  let faulty = 0;
  let dummy = 0;
  let rehomed = 0;
  let blocked = 0;
  for (const child of children) {
    const count = childFiberCount(child);
    const status = String(child.status ?? "").toUpperCase();

    // EDIT HERE: Parent partial-split live capacity in UI.
    // REHOMED child links are cleanup-only references after split approval.
    // Exclude them from parent totals and show a separate cleanup count.
    if (status === "REHOMED") {
      rehomed += count;
      continue;
    }
    if (status === "DUMMY" || status === "DECOMMISSIONED") {
      dummy += count;
      continue;
    }

    total += count;
    if (child.serviceId?.trim() || status === "USED" || status === "ACTIVE") used += count;
    else if (status === "RESERVED") reserved += count;
    else if (status === "FAULTY") faulty += count;
    else if (["BLOCKED", "UNKNOWN", "PLANNED"].includes(status)) blocked += count;
  }
  return { total, used, reserved, faulty, dummy, rehomed, blocked, available: Math.max(0, total - used - reserved - faulty - blocked) };
}

function applyChildStats(row: InventorySegmentRow, children: InventoryMappingRow[]): InventorySegmentRow {
  if (!children.length) return row;
  const stats = childStats(children);
  return {
    ...row,
    mappings: children,
    totalFibers: stats.total,
    totalOdfPorts: stats.total,
    usedFibers: stats.used,
    usedOdfPorts: stats.used,
    reservedFibers: stats.reserved,
    reservedOdfPorts: stats.reserved,
    faultyFibers: stats.faulty,
    faultyOdfPorts: stats.faulty,
    blockedFibers: stats.blocked,
    blockedOdfPorts: stats.blocked,
    dummyFibers: stats.dummy,
    dummyOdfPorts: stats.dummy,
    rehomedFibers: stats.rehomed,
    rehomedOdfPorts: stats.rehomed,
    availableFibers: stats.available,
    availableOdfPorts: stats.available,
    utilizationPct: stats.total ? Math.round((stats.used / stats.total) * 1000) / 10 : 0,
  };
}

interface EditorState {
  segmentId: string;
  segmentCode: string;
  segmentCapacity: string;
  segmentDefaultRole: string;
  nearSite: string;
  nearRack: string;
  nearOdf: string;
  nearPortGroup: string;
  nearPortStart: string;
  nearPortEnd: string;
  farSite: string;
  farRack: string;
  farOdf: string;
  farPortGroup: string;
  farPortStart: string;
  farPortEnd: string;
  cableLabel: string;
  tubeNumber: string;
  tubeColor: string;
  fiberPortNumber: string;
  distanceKm: string;
  status: SegmentStatus;
  comments: string;
  overrideReason: string;
}


interface ChildEditorState {
  parentSegmentId: string;
  id: string;
  serviceId: string;
  childTopologyRole: string;
  localSite: string;
  localRack: string;
  localOdf: string;
  localPort: string;
  farSite: string;
  farRack: string;
  farOdf: string;
  farPort: string;
  status: SegmentStatus;
  remarks: string;
}

interface SplitEditorState {
  parentSegmentId: string;
  mode: "FULL_SPLIT" | "PARTIAL_SPLIT";
  insertedSite: string;
  insertedNearRack: string;
  insertedNearOdf: string;
  insertedNearPortGroup: string;
  insertedFarRack: string;
  insertedFarOdf: string;
  insertedFarPortGroup: string;
  selectedFiberNumbers: number[];
  // EDIT HERE: Split child-link selection. Backend uses these mapping IDs to
  // preserve existing far-end rack/ODF/port payload instead of auto-sequencing
  // both sides from the near-end port range.
  selectedMappingIds: string[];
  distanceKmNear: string;
  distanceKmFar: string;
  comments: string;
  overrideReason: string;
}

interface UpgradeOdfContext {
  site: string | null;
  rack: string | null;
  odf: string | null;
  odfId: string | null;
  configuredRange: string | null;
  dummyPorts: number[];
  dummyRanges: string;
}
interface UpgradeContext {
  segmentId: string;
  segmentCode: string;
  totalFiberCapacity: number | null;
  near: UpgradeOdfContext;
  far: UpgradeOdfContext;
}
interface UpgradeEditorState {
  segmentId: string;
  nearPorts: string;
  farPorts: string;
  // Operator-chosen count driving the "add N fibers" stepper. The two range
  // strings above are derived from it (first N dummy ports of each end) but stay
  // hand-editable as an advanced override.
  fibersToAdd: number;
  context: UpgradeContext | null;
  loading: boolean;
}

// Lowest N dummy ports of a pool, ascending. Client mirror of the server's
// selection so the count-matched ranges shown match what the upgrade consumes.
function firstNPorts(ports: number[], count: number): number[] {
  return [...new Set(ports)].sort((a, b) => a - b).slice(0, Math.max(0, count));
}

// Compact an ascending port list into "2-7, 10" form — the exact shape the
// upgrade API already parses.
function compactPortRanges(ports: number[]): string {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const out: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    out.push(index === end ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`);
    index = end + 1;
  }
  return out.join(", ");
}

type AffectedServiceDetail = {
  serviceId: string;
  fibers: number[];
  // EDIT HERE: Split affected-service preview should be driven by selected ODF port-link rows,
  // not by standalone tube/fiber labels. This keeps the telecom view focused on ODF ports.
  portPairs: string[];
  status: SegmentStatus;
  localSite?: string | null;
  localRack?: string | null;
  localOdf?: string | null;
  localPort?: string | null;
  farSite?: string | null;
  farRack?: string | null;
  farOdf?: string | null;
  farPort?: string | null;
};

// EDIT HERE: Split form predictive-text parameters. Port suggestions need the
// inserted site + selected rack + selected ODF, otherwise the datalist shows
// unrelated ports and the form feels like predictive text is broken.
function splitSuggestionParams(key: string, splitEditor: SplitEditorState): Record<string, string> {
  if (key === "insertedNearRack" || key === "insertedFarRack") return { site: splitEditor.insertedSite, rack: "", odf: "" };
  if (key === "insertedNearOdf") return { site: splitEditor.insertedSite, rack: splitEditor.insertedNearRack, odf: "" };
  if (key === "insertedFarOdf") return { site: splitEditor.insertedSite, rack: splitEditor.insertedFarRack, odf: "" };
  if (key === "insertedNearPortGroup") return { site: splitEditor.insertedSite, rack: splitEditor.insertedNearRack, odf: splitEditor.insertedNearOdf };
  if (key === "insertedFarPortGroup") return { site: splitEditor.insertedSite, rack: splitEditor.insertedFarRack, odf: splitEditor.insertedFarOdf };
  return { site: "", rack: "", odf: "" };
}

function toChildEditor(parentSegmentId: string, child: InventoryMappingRow): ChildEditorState {
  return {
    parentSegmentId,
    id: child.fiberId ?? child.id,
    serviceId: child.serviceId ?? "",
    childTopologyRole: child.childTopologyRole ?? "",
    localSite: child.localSite ?? "",
    localRack: child.localRack ?? "",
    localOdf: child.localOdf ?? "",
    localPort: child.localPort ?? "",
    farSite: child.farSite ?? child.farEndpoint ?? "",
    farRack: child.farRack ?? "",
    farOdf: child.farOdf ?? "",
    farPort: child.farPort ?? "",
    status: child.status,
    remarks: child.remarks ?? "",
  };
}

function toEditor(row: InventorySegmentRow): EditorState {
  const nearRange = splitPortRange(row.nearPortGroup);
  const farRange = splitPortRange(row.farPortGroup);
  return {
    segmentId: row.segmentId,
    segmentCode: row.segmentCode,
    segmentCapacity: row.totalFibers === null || row.totalFibers === undefined ? "" : String(row.totalFibers),
    segmentDefaultRole: normalizeSegmentDefaultTopologyRole(row.segmentDefaultRole) ?? "DEFAULT",
    nearSite: row.nearSite ?? "",
    nearRack: row.nearRack ?? "",
    nearOdf: row.nearOdf ?? "",
    nearPortGroup: row.nearPortGroup ?? "",
    nearPortStart: nearRange.start,
    nearPortEnd: nearRange.end,
    farSite: row.farSite ?? "",
    farRack: row.farRack ?? "",
    farOdf: row.farOdf ?? "",
    farPortGroup: row.farPortGroup ?? "",
    farPortStart: farRange.start,
    farPortEnd: farRange.end,
    cableLabel: row.cableLabel ?? "",
    tubeNumber: row.tubeNumber === null || row.tubeNumber === undefined ? "" : String(row.tubeNumber),
    tubeColor: row.tubeColor ?? "",
    fiberPortNumber: row.fiberPortNumber === null || row.fiberPortNumber === undefined ? "" : String(row.fiberPortNumber),
    distanceKm: row.distanceKm === null || row.distanceKm === undefined ? "" : String(row.distanceKm),
    status: row.status,
    comments: "",
    overrideReason: "",
  };
}

// Clone: seed the Add-Segment editor from an existing row for fast parallel
// links (C02 alongside C01…). Endpoint identity, capacity, cable, distance and
// role carry over; the port ranges and segment code are cleared so the operator
// picks the new fibers and a fresh unique code auto-derives (no forced name).
// segmentId "__new__" routes the save down the create path — the source row is
// never touched.
function cloneEditor(row: InventorySegmentRow): EditorState {
  return {
    ...toEditor(row),
    segmentId: "__new__",
    segmentCode: "",
    nearPortGroup: "",
    nearPortStart: "",
    nearPortEnd: "",
    farPortGroup: "",
    farPortStart: "",
    farPortEnd: "",
    comments: "",
    overrideReason: `Cloned from ${row.segmentCode}`,
  };
}

function blankEditor(): EditorState {
  return {
    segmentId: "__new__",
    segmentCode: "",
    segmentCapacity: "48",
    segmentDefaultRole: "DEFAULT",
    nearSite: "",
    nearRack: "",
    nearOdf: "",
    nearPortGroup: "",
    nearPortStart: "1",
    nearPortEnd: "48",
    farSite: "",
    farRack: "",
    farOdf: "",
    farPortGroup: "",
    farPortStart: "1",
    farPortEnd: "48",
    cableLabel: "",
    tubeNumber: "",
    tubeColor: "",
    fiberPortNumber: "",
    distanceKm: "",
    status: "ACTIVE",
    comments: "",
    overrideReason: "Manual near/far mapping",
  };
}

export function InventoryExplorer({
  initialRows,
  initialSearch = "",
  initialFilters = {},
  serverPage,
  canDelete = false,
  canBulkDelete = false,
}: {
  initialRows: InventorySegmentRow[];
  initialSearch?: string;
  initialFilters?: InventoryFilters;
  serverPage?: { page: number; pageSize: number; total: number };
  canDelete?: boolean;
  canBulkDelete?: boolean;
}) {
  const router = useRouter();
  const { flash, isFlashing } = useRowFlash();
  const [rows, setRows] = useState(initialRows);
  const [filters, setFilters] = useState<InventoryFilters>({ ...initialFilters, search: initialFilters.search ?? initialSearch });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [childEditor, setChildEditor] = useState<ChildEditorState | null>(null);
  const [splitEditor, setSplitEditor] = useState<SplitEditorState | null>(null);
  const [upgradeEditor, setUpgradeEditor] = useState<UpgradeEditorState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [impact, setImpact] = useState<CutoverImpactSummary | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedChildIds, setSelectedChildIds] = useState<string[]>([]);
  const [bulkChildRole, setBulkChildRole] = useState<string>("");
  const [bulkSegmentRole, setBulkSegmentRole] = useState<string>("DEFAULT");
  const [bulkChildStatus, setBulkChildStatus] = useState<SegmentStatus>("ACTIVE");
  const [isBulkRoleSaving, setIsBulkRoleSaving] = useState(false);
  const [isBulkStatusSaving, setIsBulkStatusSaving] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  // 24 working-hour soft-delete holds: scheduled rows keep showing with an
  // "Undo Delete (Xh Ym remaining)" countdown until the hold expires.
  const deletionHolds = usePendingDeletions("SEGMENT", canDelete || canBulkDelete);
  // Post-scheduling suggestion box offering the segment-configuration export
  // for future reference / manual reversal.
  const [exportPromptIds, setExportPromptIds] = useState<string[] | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [fiberRowsBySegment, setFiberRowsBySegment] = useState<Record<string, InventoryMappingRow[]>>({});
  const [pageSize, setPageSize] = useState<number>(serverPage?.pageSize ?? PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(serverPage?.page ?? 1);
  const [utilTier, setUtilTier] = useState<UtilizationTier>("ALL");
  // Child-row service-type tags selected in the adjacent multi-select. Applied as
  // a pure client-side refinement over the already-loaded rows.
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // Live registered/not-registered status per segment-editor asset field.
  const [assetCheck, setAssetCheck] = useState<Partial<Record<AssetCheckField, AssetCheckState>>>({});
  // Same, for the split dialog's inserted-node Site/Rack/ODF fields.
  const [splitAssetCheck, setSplitAssetCheck] = useState<Partial<Record<string, AssetCheckState>>>({});
  // Focus target for the "/" keyboard shortcut.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isServerPaged = Boolean(serverPage);
  const activeFilters = activeInventoryFilterEntries(filters);

  const filteredRows = useMemo(() => {
    if (isServerPaged) return rows;
    return rows.filter((row) => matchesInventoryFilters(row, filters));
  }, [rows, filters, isServerPaged]);
  // Child-row service-type refinement. A parent row survives when ANY of its
  // child links carries one of the selected tags. Runs purely over the loaded
  // rows so it updates instantly without a round-trip.
  const tagFilteredRows = useMemo(() => {
    if (!tagFilter.length) return filteredRows;
    const wanted = new Set(tagFilter);
    return filteredRows.filter((row) => allChildRows(row).some((child) => child.tag != null && wanted.has(child.tag)));
  }, [filteredRows, tagFilter, fiberRowsBySegment]);
  // The matching-record total can never be smaller than the rows actually being
  // shown; clamping keeps the "Showing X of Y" line from ever contradicting the
  // table (e.g. "Showing 34 of 1") when a server total lags local row state.
  // When a client tag refinement is active, its own (narrower) count is
  // authoritative because the server total predates that refinement.
  const serverTotal = serverPage?.total ?? tagFilteredRows.length;
  const allServerRowsLoaded = !isServerPaged || rows.length >= serverTotal;
  const matchingTotal = tagFilter.length
    ? tagFilteredRows.length
    : Math.max(serverTotal, tagFilteredRows.length);
  // Consolidation: when a search / filter is active and the FULL matching set is
  // both loaded and <= the limit, collapse pagination and render every match on
  // one page. Otherwise standard paging stays on.
  const hasActiveScope = activeFilters.length > 0 || tagFilter.length > 0;
  const consolidated = hasActiveScope && allServerRowsLoaded && matchingTotal <= CONSOLIDATION_LIMIT;
  const effectivePageSize = serverPage?.pageSize ?? pageSize;
  const pageCount = consolidated ? 1 : Math.max(1, Math.ceil(matchingTotal / effectivePageSize));
  const currentPage = Math.min(serverPage?.page ?? page, pageCount);
  const pagedRows = useMemo(() => {
    if (consolidated) return tagFilteredRows;   // every match inline, no paging
    if (isServerPaged) return tagFilteredRows;  // server already returned this window
    const start = (currentPage - 1) * pageSize; // client-side slice
    return tagFilteredRows.slice(start, start + pageSize);
  }, [tagFilteredRows, consolidated, currentPage, pageSize, isServerPaged]);
  // ODF Mappings utilization tier filter (Critical/High/Moderate/Normal),
  // applied client-side over the loaded page so it composes with server paging.
  const visibleRows = useMemo(
    () => utilTier === "ALL"
      ? pagedRows
      : pagedRows.filter((row) => matchesUtilizationTier(row.utilizationPct ?? 0, utilTier)),
    [pagedRows, utilTier],
  );
  const utilCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: pagedRows.length };
    for (const row of pagedRows) {
      const pct = row.utilizationPct ?? 0;
      const band = matchesUtilizationTier(pct, "Critical") ? "Critical"
        : matchesUtilizationTier(pct, "High") ? "High"
        : matchesUtilizationTier(pct, "Moderate") ? "Moderate" : "Normal";
      counts[band] = (counts[band] ?? 0) + 1;
    }
    return counts as Partial<Record<UtilizationTier, number>>;
  }, [pagedRows]);
  // In server-paged mode edited filters only take effect after Enter / Apply;
  // surface that pending state instead of reporting mismatched counts.
  const filtersDirty = useMemo(() => {
    const applied = inventoryFiltersToParams({ ...initialFilters, search: initialFilters.search ?? initialSearch }).toString();
    const current = inventoryFiltersToParams(filters).toString();
    return applied !== current;
  }, [filters, initialFilters, initialSearch]);
  const filtersPending = isServerPaged && filtersDirty;
  const visibleIds = visibleRows.map((row) => row.segmentId);
  const visibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  useEffect(() => {
    setRows(initialRows);
    setFilters({ ...initialFilters, search: initialFilters.search ?? initialSearch });
    setPage(serverPage?.page ?? 1);
    setPageSize(serverPage?.pageSize ?? PAGE_SIZE_OPTIONS[0]);
    setSelectedIds([]);
    setSelectedChildIds([]);
    setExpandedIds({});
    setFiberRowsBySegment({});
  }, [initialRows, initialSearch, initialFilters, serverPage?.page, serverPage?.pageSize, serverPage?.total]);

  // A hold that vanished server-side either expired (segment purged / reverse
  // split applied) or was undone in another session; drop the affected rows and
  // re-sync — the server re-render restores any row that still exists.
  useEffect(() => {
    if (!deletionHolds.purgedEntityIds.length) return;
    const purged = new Set(deletionHolds.purgedEntityIds);
    setRows((current) => current.filter((row) => !purged.has(row.segmentId)));
    deletionHolds.acknowledgePurged();
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deletionHolds.purgedEntityIds]);

  // Debounced auto-search: as the operator types/selects, apply the filter after
  // a short pause instead of on every keystroke and instead of a manual button.
  // Loop-safe: navigateServerPage pushes a new URL; the server round-trip resets
  // `filters` to the applied value via the effect above, so `filtersDirty` goes
  // false and this effect no-ops on its next run. Deliberately does NOT depend on
  // navigateServerPage (a fresh closure each render) to avoid re-scheduling.
  useEffect(() => {
    if (!isServerPaged || !filtersDirty) return;
    const handle = setTimeout(() => navigateServerPage(1), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, filtersDirty, isServerPaged]);

  // Adaptive-capacity fallback: a filtered query is fetched at the consolidation
  // page size (up to 1000) so small result sets can collapse inline. If the true
  // match count exceeds the limit, step down to standard 100-row pages to keep
  // the grid light. Runs once per oversized result (guarded on pageSize) — after
  // it re-navigates at 100 the guard is false, so there is no loop.
  useEffect(() => {
    if (!serverPage) return;
    if (serverPage.total > CONSOLIDATION_LIMIT && serverPage.pageSize > 100) {
      navigateServerPage(1, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPage?.total, serverPage?.pageSize]);

  // ── Cascading smart defaults (segment editor) ───────────────────────────────
  // Once a side's Site is set, auto-fill its Rack (when the site has exactly one
  // registered rack) and then its ODF (when that rack has exactly one ODF), via
  // the same suggestions API the inputs already use. Fill-in only: a field is
  // written only while it is empty or still holding the previous auto-fill, so
  // operator-typed values are never overwritten; clearing a field marks that
  // cascade done so it is not stubbornly re-filled. Presentation-only — the
  // unchanged save path submits whatever ends up in the fields.
  const editorAutoFillRef = useRef<Record<string, string>>({});
  const editorCascadeDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!editor) {
      editorAutoFillRef.current = {};
      editorCascadeDoneRef.current = new Set();
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      // Returns null when the fetch was aborted (a newer effect run superseded
      // this one) — the caller must NOT mark that cascade step done, so the
      // fresh run can retry it. Only a completed fetch settles the step.
      async function suggest(kind: string, params: Record<string, string>): Promise<Array<{ value: string }> | null> {
        try {
          const query = new URLSearchParams(params);
          const response = await fetch(`/api/suggestions/${kind}?${query.toString()}`, { signal: controller.signal });
          if (!response.ok) return [];
          const payload = await response.json();
          return Array.isArray(payload.suggestions) ? payload.suggestions : [];
        } catch {
          return null;
        }
      }
      async function cascade(siteKey: "nearSite" | "farSite", rackKey: "nearRack" | "farRack", odfKey: "nearOdf" | "farOdf") {
        const site = String(editor?.[siteKey] ?? "").trim();
        if (!site) return;

        let rack = String(editor?.[rackKey] ?? "").trim();
        const rackDoneKey = `${rackKey}|${site}`;
        const rackWritable = (!rack || rack === editorAutoFillRef.current[rackKey]) && !editorCascadeDoneRef.current.has(rackDoneKey);
        if (rackWritable) {
          const racks = await suggest("racks", { site });
          if (racks === null) return; // aborted — retry on the next run
          editorCascadeDoneRef.current.add(rackDoneKey);
          if (racks.length === 1 && racks[0].value && racks[0].value !== rack) {
            rack = racks[0].value;
            editorAutoFillRef.current[rackKey] = rack;
            setEditor((current) => (current ? { ...current, [rackKey]: rack } : current));
          }
        }
        if (!rack) return;

        const odf = String(editor?.[odfKey] ?? "").trim();
        const odfDoneKey = `${odfKey}|${site}|${rack}`;
        const odfWritable = (!odf || odf === editorAutoFillRef.current[odfKey]) && !editorCascadeDoneRef.current.has(odfDoneKey);
        if (odfWritable) {
          const odfs = await suggest("odfs", { site, rack });
          if (odfs === null) return; // aborted — retry on the next run
          editorCascadeDoneRef.current.add(odfDoneKey);
          if (odfs.length === 1 && odfs[0].value && odfs[0].value !== odf) {
            const nextOdf = odfs[0].value;
            editorAutoFillRef.current[odfKey] = nextOdf;
            setEditor((current) => (current ? { ...current, [odfKey]: nextOdf } : current));
          }
        }
      }
      await cascade("nearSite", "nearRack", "nearOdf");
      await cascade("farSite", "farRack", "farOdf");
    }, 350);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
    // Depends on the cascade INPUTS only; its own writes re-run it once (rack in
    // deps) to chain the ODF step, then the done-set guards stop further writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.nearSite, editor?.nearRack, editor?.farSite, editor?.farRack, editor?.segmentId]);

  // ── Live asset registration check-marks (segment editor) ─────────────────────
  // As Site/Rack/ODF are typed (or auto-filled by the cascade above), verify each
  // side against ODF & Rack inventory via the shared read-only resolver and show
  // a ✓ / ✗ beside the field. Read-only and debounced; never blocks or mutates —
  // the operator learns a triple is unregistered BEFORE hitting Save instead of
  // via the submit error. Depends only on the six asset values.
  useEffect(() => {
    if (!editor) {
      setAssetCheck({});
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      async function checkSide(
        siteKey: AssetCheckField,
        rackKey: AssetCheckField,
        odfKey: AssetCheckField,
      ) {
        const site = String(editor?.[siteKey] ?? "").trim();
        const rack = String(editor?.[rackKey] ?? "").trim();
        const odf = String(editor?.[odfKey] ?? "").trim();
        if (!site) {
          setAssetCheck((current) => ({ ...current, [siteKey]: "idle", [rackKey]: "idle", [odfKey]: "idle" }));
          return;
        }
        setAssetCheck((current) => ({
          ...current,
          [siteKey]: "checking",
          [rackKey]: rack ? "checking" : "idle",
          [odfKey]: odf ? "checking" : "idle",
        }));
        try {
          const query = new URLSearchParams({ site, rack, odf });
          const response = await fetch(`/api/inventory/asset-check?${query.toString()}`, { signal: controller.signal });
          if (!response.ok) return;
          const status = await response.json();
          setAssetCheck((current) => ({
            ...current,
            [siteKey]: status.site ? "ok" : "missing",
            [rackKey]: !rack ? "idle" : status.rack ? "ok" : "missing",
            [odfKey]: !odf ? "idle" : status.odf ? "ok" : "missing",
          }));
        } catch {
          // Aborted by a newer edit — the fresh run will repaint the marks.
        }
      }
      await Promise.all([
        checkSide("nearSite", "nearRack", "nearOdf"),
        checkSide("farSite", "farRack", "farOdf"),
      ]);
    }, 400);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.nearSite, editor?.nearRack, editor?.nearOdf, editor?.farSite, editor?.farRack, editor?.farOdf, editor?.segmentId]);

  // ── Live asset registration check-marks (split dialog inserted node) ─────────
  // The inserted split node's Site/Rack/ODF must already be registered in ODF &
  // Rack inventory before the split commits. Same read-only, debounced check as
  // the segment editor, so the operator sees ✓/✗ before pressing Confirm instead
  // of hitting the registration error. Both faces share the inserted site.
  useEffect(() => {
    if (!splitEditor) {
      setSplitAssetCheck({});
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      const site = String(splitEditor?.insertedSite ?? "").trim();
      const nearRack = String(splitEditor?.insertedNearRack ?? "").trim();
      const nearOdf = String(splitEditor?.insertedNearOdf ?? "").trim();
      const farRack = String(splitEditor?.insertedFarRack ?? "").trim();
      const farOdf = String(splitEditor?.insertedFarOdf ?? "").trim();
      if (!site) {
        setSplitAssetCheck({ insertedSite: "idle", insertedNearRack: "idle", insertedNearOdf: "idle", insertedFarRack: "idle", insertedFarOdf: "idle" });
        return;
      }
      setSplitAssetCheck({
        insertedSite: "checking",
        insertedNearRack: nearRack ? "checking" : "idle",
        insertedNearOdf: nearOdf ? "checking" : "idle",
        insertedFarRack: farRack ? "checking" : "idle",
        insertedFarOdf: farOdf ? "checking" : "idle",
      });
      async function check(rack: string, odf: string): Promise<{ site: boolean; rack: boolean; odf: boolean } | null> {
        try {
          const query = new URLSearchParams({ site, rack, odf });
          const response = await fetch(`/api/inventory/asset-check?${query.toString()}`, { signal: controller.signal });
          if (!response.ok) return null;
          return await response.json();
        } catch {
          return null;
        }
      }
      const near = await check(nearRack, nearOdf);
      if (!near) return; // aborted — retry on next run
      const far = farRack || farOdf ? await check(farRack, farOdf) : near;
      if (!far) return;
      setSplitAssetCheck({
        insertedSite: near.site ? "ok" : "missing",
        insertedNearRack: !nearRack ? "idle" : near.rack ? "ok" : "missing",
        insertedNearOdf: !nearOdf ? "idle" : near.odf ? "ok" : "missing",
        insertedFarRack: !farRack ? "idle" : far.rack ? "ok" : "missing",
        insertedFarOdf: !farOdf ? "idle" : far.odf ? "ok" : "missing",
      });
    }, 400);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitEditor?.insertedSite, splitEditor?.insertedNearRack, splitEditor?.insertedNearOdf, splitEditor?.insertedFarRack, splitEditor?.insertedFarOdf, splitEditor?.parentSegmentId]);

  // ── Keyboard shortcut: "/" focuses the inventory search box ──────────────────
  // Only fires when the operator is not already typing in a field and no modifier
  // is held, so it never hijacks a literal "/" inside an input. Pure navigation
  // convenience — no data or logic touched.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Auto-port prefill (split dialog) ─────────────────────────────────────────
  // The inserted node consumes one ODF port per selected fiber and the block is
  // virtually always "1-N", so both inserted port-group fields are prefilled
  // from the live selection count and kept in step while they still hold the
  // previous auto value. Anything the operator typed is left alone. Loop-safe:
  // state is only written when the value actually changes.
  const splitAutoPortsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!splitEditor) {
      splitAutoPortsRef.current = {};
      return;
    }
    const count = splitEditor.selectedFiberNumbers.length;
    if (!count) return;
    const auto = count === 1 ? "1" : `1-${count}`;
    setSplitEditor((current) => {
      if (!current) return current;
      let changed = false;
      const next = { ...current };
      for (const key of ["insertedNearPortGroup", "insertedFarPortGroup"] as const) {
        const value = String(next[key] ?? "").trim();
        const writable = !value || value === splitAutoPortsRef.current[key];
        if (writable && value !== auto) {
          next[key] = auto;
          splitAutoPortsRef.current[key] = auto;
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitEditor?.selectedFiberNumbers.length, splitEditor?.parentSegmentId]);

  // Shared ✓ / ✗ / spinner renderer for a single registration state. Used by both
  // the segment editor and the split inserted-site fields.
  function assetStateMark(state?: AssetCheckState) {
    if (!state || state === "idle") return null;
    if (state === "checking") {
      return (
        <span className="inline-flex" title="Checking ODF & Rack inventory…" aria-label="Checking inventory">
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--muted-text)" }} aria-hidden="true" />
        </span>
      );
    }
    if (state === "ok") {
      return (
        <span className="inline-flex" title="Registered in ODF & Rack inventory" aria-label="Registered in inventory">
          <Check className="h-3.5 w-3.5" style={{ color: "#16a34a" }} aria-hidden="true" />
        </span>
      );
    }
    return (
      <span className="inline-flex" title="Not registered — add it in ODF & Rack inventory first" aria-label="Not registered in inventory">
        <X className="h-3.5 w-3.5" style={{ color: "#dc2626" }} aria-hidden="true" />
      </span>
    );
  }

  function renderAssetMark(key: string) {
    if (!(ASSET_CHECK_FIELDS as readonly string[]).includes(key)) return null;
    return assetStateMark(assetCheck[key as AssetCheckField]);
  }

  function preferredCapacity(row: InventorySegmentRow) {
    // EDIT HERE: ODF Mappings capacity column.
    // Prefer the recalculated live remaining capacity after partial split.
    // segmentCapacityFibers may still contain the original imported capacity on
    // older rows until the backend refresh completes.
    return row.totalOdfPorts ?? row.totalFibers ?? row.segmentCapacityFibers ?? null;
  }

  function childLinkCount(row: InventorySegmentRow) {
    return row.childLinkCount ?? childRows(row).length;
  }

  function structuralRowCount(row: InventorySegmentRow): number {
    // Parent-child row arithmetic: a parent holding N fibers provisioned as
    // fiber pairs yields exactly ceil(N / 2) structural rows (126 fibers -> 63
    // rows). Raw reported counts can include retired/cleanup rows and overshoot.
    const loaded = childRows(row);
    if (loaded.length) return loaded.length;
    const capacity = preferredCapacity(row);
    const reported = row.childLinkCount ?? 0;
    if (capacity && capacity > 0 && reported > 0) {
      const pairRows = Math.ceil(capacity / 2);
      if (reported === capacity) return reported; // single-fiber units: one row per fiber
      if (reported > capacity) return pairRows; // impossible raw count -> trust pair math
      if (reported > pairRows) return pairRows; // mixed/cleanup overshoot (e.g. 72 vs 63)
    }
    return reported;
  }

  function navigateServerPage(nextPage = 1, nextPageSize?: number, nextFilters = filters) {
    const params = inventoryFiltersToParams(nextFilters);
    // When a filter/search is active, pull the whole matching set (up to the
    // consolidation limit) so <=1000 results can collapse onto one page. Callers
    // that pass an explicit size (e.g. the Rows-per-page selector, or the >1000
    // step-down) win. Unfiltered browsing keeps the light default page size.
    const isFiltered = activeInventoryFilterEntries(nextFilters).length > 0;
    // Don't carry the filtered consolidation size into an unfiltered browse view
    // (that would momentarily load 1000 rows before the >1000 step-down); fall
    // back to the light default instead. The Rows-per-page selector still wins.
    const carried = serverPage?.pageSize ?? pageSize;
    const browseSize = carried >= CONSOLIDATION_LIMIT ? PAGE_SIZE_OPTIONS[1] : carried;
    const resolvedPageSize = nextPageSize ?? (isFiltered ? CONSOLIDATION_LIMIT : browseSize);
    params.set("page", String(Math.max(1, nextPage)));
    params.set("pageSize", String(resolvedPageSize));
    const query = params.toString();
    router.push((query ? `/inventory?${query}` : "/inventory") as Route);
  }

  function updateFilter(key: keyof InventoryFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function updateLocalRow(row: InventorySegmentRow) {
    setRows((current) => current.map((item) => (item.segmentId === row.segmentId ? row : item)));
  }

  async function patchSegment(payload: EditorState | { segmentId: string; status: SegmentStatus }) {
    const current = rows.find((row) => row.segmentId === payload.segmentId);
    const isNew = payload.segmentId === "__new__";
    if (!current && !isNew) return;

    const editorPayload = "segmentCode" in payload ? payload : { ...toEditor(current as InventorySegmentRow), status: payload.status };
    const normalizedEditor: EditorState = {
      ...editorPayload,
      nearSite: normalizeSiteCode(editorPayload.nearSite) ?? "",
      nearRack: normalizeRackCode(editorPayload.nearRack) ?? "",
      nearOdf: normalizeOdfCode(editorPayload.nearOdf) ?? "",
      nearPortGroup: normalizePortLabel(rangeLabel(editorPayload.nearPortStart, editorPayload.nearPortEnd) || editorPayload.nearPortGroup) ?? "",
      farSite: normalizeSiteCode(editorPayload.farSite) ?? "",
      farRack: normalizeRackCode(editorPayload.farRack) ?? "",
      farOdf: normalizeOdfCode(editorPayload.farOdf) ?? "",
      farPortGroup: normalizePortLabel(rangeLabel(editorPayload.farPortStart, editorPayload.farPortEnd) || editorPayload.farPortGroup) ?? "",
    };
    const missing = [
      ["Near site", normalizedEditor.nearSite],
      ["Near rack", normalizedEditor.nearRack],
      ["Near ODF", normalizedEditor.nearOdf],
      ["Near ODF port range", normalizedEditor.nearPortGroup],
      ["Far site", normalizedEditor.farSite],
      ...(isNew ? [["Segment capacity", normalizedEditor.segmentCapacity]] : []),
    ].filter(([, value]) => !String(value ?? "").trim()).map(([label]) => label);
    if (missing.length) {
      setMessage(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for manual mapping.`);
      return;
    }
    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch(isNew ? "/api/segments" : `/api/segments/${editorPayload.segmentId}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segmentCode: normalizedEditor.segmentCode,
          segmentCapacity: normalizedEditor.segmentCapacity ? Number(normalizedEditor.segmentCapacity) : null,
          segmentDefaultRole: normalizeSegmentDefaultTopologyRole(normalizedEditor.segmentDefaultRole),
          cableLabel: normalizedEditor.cableLabel,
          tubeNumber: normalizedEditor.tubeNumber ? Number(normalizedEditor.tubeNumber) : null,
          tubeColor: normalizedEditor.tubeColor,
          fiberPortNumber: normalizedEditor.fiberPortNumber ? Number(normalizedEditor.fiberPortNumber) : null,
          distanceKm: normalizedEditor.distanceKm ? Number(normalizedEditor.distanceKm) : null,
          status: normalizedEditor.status,
          comments: normalizedEditor.comments,
          manualOverride: true,
          overrideReason: normalizedEditor.overrideReason || "Manual portal update",
          endpointA: {
            rawSiteCode: normalizedEditor.nearSite,
            rawRackCode: normalizedEditor.nearRack,
            rawOdfCode: normalizedEditor.nearOdf,
            rawPortText: normalizedEditor.nearPortGroup,
          },
          endpointB: {
            rawSiteCode: normalizedEditor.farSite,
            rawRackCode: normalizedEditor.farRack,
            rawOdfCode: normalizedEditor.farOdf,
            rawPortText: normalizedEditor.farPortGroup,
          },
        }),
      });
      const payloadJson = await response.json();
      if (!response.ok || !payloadJson.row) {
        throw new Error(payloadJson.error ?? "Segment update failed.");
      }
      if (isNew) {
        setRows((currentRows) => [payloadJson.row, ...currentRows]);
        setFilters({});
        setPage(1);
        setExpandedIds((current) => ({ ...current, [payloadJson.row.segmentId]: true }));
        if (payloadJson.row.mappings?.length) {
          setFiberRowsBySegment((current) => ({ ...current, [payloadJson.row.segmentId]: payloadJson.row.mappings }));
        }
      } else updateLocalRow(payloadJson.row);
      setEditor(null);
      // Amber-flash the affected parent segment row. Updates keep the operator on
      // their current page (updateLocalRow mutates in place; no page reset).
      flash(payloadJson.row.segmentId);
      setMessage(isNew ? "Segment container created and added to the top of ODF Mappings." : "Segment updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Segment update failed.");
    } finally {
      setIsSaving(false);
    }
  }

  function toggleRow(segmentId: string) {
    setSelectedIds((current) => current.includes(segmentId) ? current.filter((id) => id !== segmentId) : [...current, segmentId]);
  }

  async function toggleExpanded(segmentId: string) {
    const willExpand = !expandedIds[segmentId];
    setExpandedIds((current) => ({ ...current, [segmentId]: willExpand }));
    if (!willExpand || fiberRowsBySegment[segmentId]) return;

    const existingRow = rows.find((row) => row.segmentId === segmentId);
    if (existingRow?.mappings?.length) {
      setFiberRowsBySegment((current) => ({ ...current, [segmentId]: existingRow.mappings ?? [] }));
      return;
    }

    try {
      const response = await fetch(`/api/segments/${segmentId}/fibers`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Fiber link load failed.");
      // Only populate the child table. The parent capacity/used/available/util keep
      // coming from the segment's individual-fiber counters: a parent may have more
      // physical fibers (SegmentFiber rows) than there are ODF mappings, so
      // recomputing the parent from the mapping subset would understate the cable.
      setFiberRowsBySegment((current) => ({ ...current, [segmentId]: payload.rows ?? [] }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Fiber link load failed.");
    }
  }

  function allChildRows(row: InventorySegmentRow): InventoryMappingRow[] {
    if (fiberRowsBySegment[row.segmentId]) return fiberRowsBySegment[row.segmentId];
    if (row.mappings?.length) return row.mappings;
    return [];
  }

  function childRows(row: InventorySegmentRow): InventoryMappingRow[] {
    // Live table rows only, in strict ascending fiber order. Borrowed DUMMY rows
    // remain in database and in the dummy counter, but no longer appear as active
    // parent port definitions.
    return sortChildRowsAscending(allChildRows(row).filter(isLiveDisplayChild));
  }

  function selectableFiberNumbers(row: InventorySegmentRow): number[] {
    const values = childRows(row).filter(isLiveSelectableChild).flatMap(childFiberNumbers);
    return [...new Set<number>(values)].sort((a, b) => a - b);
  }

  function readableServiceText(value?: string | null): string {
    // EDIT HERE: CSV / preview service text cleanup.
    // Imported rows can contain JSON payloads such as {"type":"trace","serviceCode":"..."}.
    // The UI/export must show the human service code only, never raw JSON.
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as { serviceCode?: string; serviceName?: string; id?: string; type?: string };
      const candidate = parsed.serviceCode ?? parsed.serviceName ?? parsed.id;
      if (candidate?.trim()) return candidate.trim();
    } catch {
      // Not JSON; use the plain text value.
    }
    return raw.replace(/â†’/g, "->").replace(/→/g, "->");
  }

  function odfPortLinkLabel(child: InventoryMappingRow): string {
    // EDIT HERE: Human-readable ODF port-link label. Keep ASCII "->" for CSV safety.
    const localOdf = child.localOdf ?? "ODF";
    const localPort = child.localPort ?? "?";
    const farOdf = child.farOdf ?? "ODF";
    const farPort = child.farPort ?? "?";
    return `${localOdf}:${localPort} -> ${farOdf}:${farPort}`;
  }

  function csvEscape(value: unknown): string {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function csvPortText(value?: string | null): string {
    // EDIT HERE: Excel-safe ODF port export.
    // CSV alone cannot stop Excel converting 1-2 to a date. Exporting as ="1-2"
    // keeps the displayed value as text while preserving the visible port label.
    const text = readableServiceText(value);
    if (!text) return csvEscape("");
    return csvEscape(`="${text.replace(/"/g, '""')}"`);
  }

  function affectedServiceDetailsForSplit(row: InventorySegmentRow): AffectedServiceDetail[] {
    const activeSplit = splitEditor?.parentSegmentId === row.segmentId ? splitEditor : null;
    const selectedIds = new Set(activeSplit?.selectedMappingIds ?? []);
    const selectedFibers = new Set(activeSplit?.selectedFiberNumbers ?? []);
    const byService = new Map<string, AffectedServiceDetail>();

    for (const child of childRows(row)) {
      const serviceId = readableServiceText(child.serviceId);
      if (!serviceId) continue;

      // EDIT HERE: Affected services are filtered from selected ODF port-to-port mapping rows first.
      // Fiber numbers are only kept internally for backend compatibility/export metadata.
      const childFibers = childFiberNumbers(child);
      const selectedByPortMapping = selectedIds.size ? selectedIds.has(child.id) : false;
      const fibers = selectedByPortMapping
        ? childFibers
        : childFibers.filter((fiberNumber) => selectedFibers.has(fiberNumber));
      if (!fibers.length) continue;

      const portPair = odfPortLinkLabel(child);
      const existing = byService.get(serviceId);
      const mergedFibers = [...new Set([...(existing?.fibers ?? []), ...fibers])].sort((a, b) => a - b);
      const mergedPortPairs = [...new Set([...(existing?.portPairs ?? []), portPair])];
      byService.set(serviceId, {
        serviceId,
        fibers: mergedFibers,
        portPairs: mergedPortPairs,
        status: child.status,
        localSite: child.localSite,
        localRack: child.localRack,
        localOdf: child.localOdf,
        localPort: child.localPort,
        farSite: child.farSite ?? child.farEndpoint,
        farRack: child.farRack,
        farOdf: child.farOdf,
        farPort: child.farPort,
      });
    }
    return [...byService.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  }

  function affectedServicesForSplit(row: InventorySegmentRow) {
    return affectedServiceDetailsForSplit(row).map((service) => service.serviceId);
  }

  function exportAffectedServices(row: InventorySegmentRow) {
    const details = affectedServiceDetailsForSplit(row);
    const header = ["Service ID", "Selected ODF Port Links", "Status", "Local Site", "Local Rack", "Local ODF", "Local Port", "Far Site", "Far Rack", "Far ODF", "Far Port"];

    // EDIT HERE: CSV formatting lock.
    // Port values are exported as Excel-safe text, and the file includes UTF-8 BOM.
    // This prevents 1-2 / 3-4 from becoming dates and avoids garbled arrow symbols.
    const csvLines = [
      header.map(csvEscape).join(","),
      ...details.map((item) => [
        csvEscape(readableServiceText(item.serviceId)),
        csvEscape(item.portPairs.map(readableServiceText).join(" | ")),
        csvEscape(item.status),
        csvEscape(item.localSite ?? ""),
        csvEscape(item.localRack ?? ""),
        csvEscape(item.localOdf ?? ""),
        csvPortText(item.localPort),
        csvEscape(item.farSite ?? ""),
        csvEscape(item.farRack ?? ""),
        csvEscape(item.farOdf ?? ""),
        csvPortText(item.farPort),
      ].join(",")),
    ];
    const csv = csvLines.join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${row.segmentCode}-affected-services.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function startSplit(row: InventorySegmentRow, mode: "FULL_SPLIT" | "PARTIAL_SPLIT") {
    const selected = mode === "FULL_SPLIT" ? selectableFiberNumbers(row) : [];
    setExpandedIds((current) => ({ ...current, [row.segmentId]: true }));
    setSplitEditor({
      parentSegmentId: row.segmentId,
      mode,
      insertedSite: "",
      insertedNearRack: "",
      insertedNearOdf: "",
      insertedNearPortGroup: "",
      insertedFarRack: "",
      insertedFarOdf: "",
      insertedFarPortGroup: "",
      selectedFiberNumbers: selected,
      selectedMappingIds: mode === "FULL_SPLIT" ? childRows(row).filter(isLiveSelectableChild).map((child) => child.id) : [],
      distanceKmNear: "",
      distanceKmFar: "",
      comments: "",
      overrideReason: "",
    });
  }

  function toggleSplitFiber(fiberNumber: number) {
    if (!splitEditor) return;
    setSplitEditor((current) => {
      if (!current) return current;
      const selected = new Set<number>(current.selectedFiberNumbers);
      if (selected.has(fiberNumber)) selected.delete(fiberNumber);
      else selected.add(fiberNumber);
      return { ...current, selectedFiberNumbers: [...selected].sort((a, b) => a - b), selectedMappingIds: [] };
    });
  }

  function toggleSplitChildLink(child: InventoryMappingRow) {
    if (!splitEditor) return;
    const childFibers = childFiberNumbers(child);
    if (!childFibers.length) return;
    setSplitEditor((current) => {
      if (!current) return current;
      const mappingIds = new Set<string>(current.selectedMappingIds);
      const selected = new Set<number>(current.selectedFiberNumbers);
      const isSelected = mappingIds.has(child.id) || childFibers.every((fiberNumber) => selected.has(fiberNumber));
      if (isSelected) {
        mappingIds.delete(child.id);
        childFibers.forEach((fiberNumber) => selected.delete(fiberNumber));
      } else {
        mappingIds.add(child.id);
        childFibers.forEach((fiberNumber) => selected.add(fiberNumber));
      }
      return {
        ...current,
        selectedMappingIds: [...mappingIds],
        selectedFiberNumbers: [...selected].sort((a, b) => a - b),
      };
    });
  }

  async function submitSplit(row: InventorySegmentRow) {
    if (!splitEditor || splitEditor.parentSegmentId !== row.segmentId) return;
    const selectedCount = splitEditor.selectedFiberNumbers.length;
    const liveCount = selectableFiberNumbers(row).length;
    if (!selectedCount) {
      setMessage("Select at least one live fiber before confirming the split.");
      return;
    }
    if (splitEditor.mode === "PARTIAL_SPLIT" && selectedCount === liveCount) {
      setMessage("Partial split selected all fibers. Use Split Fully for complete termination.");
      return;
    }
    if (splitEditor.mode === "FULL_SPLIT" && selectedCount !== liveCount) {
      setMessage("Full split must include all live fibers. Use Split Partially for a selected fiber move.");
      return;
    }
    setIsSaving(true);
    setMessage(null);
    try {
      let response = await fetch(`/api/segments/${row.segmentId}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(splitEditor),
      });
      let payload = await response.json();
      // Pre-split infrastructure mapping warning: the inserted site's
      // ODF/ports are already mapped to another route — operator must confirm.
      if (response.status === 409 && payload.requiresAcknowledgement) {
        const proceed = window.confirm(payload.warning ?? "Warning: These fibers are mapped with another site. Do you still want to proceed?");
        if (!proceed) {
          setMessage("Split cancelled: inserted site fibers are mapped to another route.");
          return;
        }
        response = await fetch(`/api/segments/${row.segmentId}/split`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...splitEditor, acknowledgeMappedConflict: true }),
        });
        payload = await response.json();
      }
      if (!response.ok) throw new Error(payload.error ?? "Segment split failed.");
      const createdRows = (payload.createdRows ?? []).filter(Boolean) as InventorySegmentRow[];
      const parentRow = payload.parentRow as InventorySegmentRow | null;
      const parentIsRetired = parentRow?.status === "DECOMMISSIONED" || splitEditor.mode === "FULL_SPLIT";
      setRows((current) => {
        const withoutCreated = current.filter((item) => !createdRows.some((created) => created.segmentId === item.segmentId));
        const updated = withoutCreated
          .filter((item) => !(item.segmentId === row.segmentId && parentIsRetired))
          .map((item) => item.segmentId === row.segmentId && parentRow ? parentRow : item);
        return [...createdRows, ...updated];
      });
      setFiberRowsBySegment((current) => {
        const next = { ...current };
        if (parentIsRetired) delete next[row.segmentId];
        else if (parentRow?.mappings) next[row.segmentId] = parentRow.mappings;
        for (const created of createdRows) next[created.segmentId] = created.mappings ?? [];
        return next;
      });
      setExpandedIds((current) => {
        const next = { ...current };
        if (parentIsRetired) delete next[row.segmentId];
        for (const created of createdRows) next[created.segmentId] = true;
        return next;
      });
      setFiberRowsBySegment((current) => {
        const next = { ...current };
        if (parentIsRetired) delete next[row.segmentId];
        else if (parentRow?.mappings) next[row.segmentId] = parentRow.mappings ?? [];
        for (const created of createdRows) {
          if (created.mappings) next[created.segmentId] = created.mappings ?? [];
        }
        return next;
      });
      setSelectedIds((current) => current.filter((id) => id !== row.segmentId));
      setSplitEditor(null);
      router.refresh();
      setMessage(`${splitEditor.mode === "FULL_SPLIT" ? "Full split" : "Partial split"} committed on exact parent segment ${row.segmentCode}. Dashboard and inventory data were refreshed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Segment split failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function startUpgrade(row: InventorySegmentRow) {
    // Dedicated capacity-upgrade flow (distinct from the generic Edit modal).
    setSplitEditor(null);
    setEditor(null);
    setMessage(null);
    setUpgradeEditor({ segmentId: row.segmentId, nearPorts: "", farPorts: "", fibersToAdd: 0, context: null, loading: true });
    setExpandedIds((current) => ({ ...current, [row.segmentId]: true }));
    try {
      const response = await fetch(`/api/segments/${row.segmentId}/upgrade-capacity`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed to load dummy-port availability.");
      setUpgradeEditor((current) => {
        if (!current || current.segmentId !== row.segmentId) return current;
        const ctx = data as UpgradeContext;
        // Default the stepper to the largest count both ends can satisfy, and
        // derive count-matched ranges. (Prefilling each end's full pool could
        // mismatch when the pools differ in size, tripping the count guard.)
        const nearDummy = ctx.near?.dummyPorts ?? [];
        const farDummy = ctx.far?.dummyPorts ?? [];
        const count = Math.min(nearDummy.length, farDummy.length);
        return {
          ...current,
          context: ctx,
          loading: false,
          fibersToAdd: count,
          nearPorts: compactPortRanges(firstNPorts(nearDummy, count)),
          farPorts: compactPortRanges(firstNPorts(farDummy, count)),
        };
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load dummy-port availability.");
      setUpgradeEditor((current) => (current && current.segmentId === row.segmentId ? { ...current, loading: false } : current));
    }
  }

  // Stepper: set the number of fibers to add. Clamps to the count both ends can
  // satisfy and rewrites BOTH range strings from the lowest N dummy ports of each
  // end, so near/far counts always match. Presentation only — Confirm still POSTs
  // the same range strings to the unchanged upgrade endpoint.
  function setUpgradeFiberCount(nextCount: number) {
    setUpgradeEditor((current) => {
      if (!current?.context) return current;
      const nearDummy = current.context.near.dummyPorts ?? [];
      const farDummy = current.context.far.dummyPorts ?? [];
      const maxCount = Math.min(nearDummy.length, farDummy.length);
      const count = Math.max(0, Math.min(Number.isFinite(nextCount) ? Math.trunc(nextCount) : 0, maxCount));
      return {
        ...current,
        fibersToAdd: count,
        nearPorts: compactPortRanges(firstNPorts(nearDummy, count)),
        farPorts: compactPortRanges(firstNPorts(farDummy, count)),
      };
    });
  }

  async function submitUpgrade(row: InventorySegmentRow) {
    if (!upgradeEditor || upgradeEditor.segmentId !== row.segmentId) return;
    if (!upgradeEditor.nearPorts.trim() || !upgradeEditor.farPorts.trim()) {
      setMessage("Enter the near-end and far-end dummy port ranges to add.");
      return;
    }
    setIsSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/segments/${row.segmentId}/upgrade-capacity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nearPorts: upgradeEditor.nearPorts, farPorts: upgradeEditor.farPorts }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Capacity upgrade failed.");
      const updated = data.row as InventorySegmentRow | null;
      if (updated) {
        setRows((current) => current.map((item) => (item.segmentId === row.segmentId ? updated : item)));
        if (updated.mappings) setFiberRowsBySegment((current) => ({ ...current, [row.segmentId]: updated.mappings ?? [] }));
      }
      setUpgradeEditor(null);
      router.refresh();
      setMessage(`Capacity upgraded on ${row.segmentCode}: added ${data.addedFibers} fiber(s) from dummy ports. New capacity ${data.newTotalCapacity}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Capacity upgrade failed.");
    } finally {
      setIsSaving(false);
    }
  }

  function toggleVisibleRows() {
    setSelectedIds((current) => {
      if (visibleSelected) return current.filter((id) => !visibleIds.includes(id));
      return [...new Set([...current, ...visibleIds])];
    });
  }

  function selectAllFiltered() {
    setSelectedIds((isServerPaged ? visibleRows : filteredRows).map((row) => row.segmentId));
  }

  async function deleteSegments(ids: string[]) {
    // Parent ODF-Mapping (segment) deletion is a bulk/top-level destructive op:
    // ADMIN only. READ_WRITE deletes individual child rows via deleteFiberLink.
    if (!canBulkDelete || !ids.length) return;
    setPendingDeleteIds(ids);
  }

  async function confirmDeleteSegments() {
    const ids = pendingDeleteIds ?? [];
    if (!canBulkDelete || !ids.length) return;
    setMessage(null);
    try {
      const response = await fetch("/api/segments/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Segment retire/delete failed.");
      if (payload.pending === true && Array.isArray(payload.holds)) {
        // Soft-delete hold: rows stay visible with an Undo countdown for the
        // 24 working-hour window, then purge (or Reverse Split for a marked
        // adjacent pair). Offer the configuration export right away.
        const holds = payload.holds as PendingDeletionHold[];
        deletionHolds.applyHolds(holds);
        setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
        setPendingDeleteIds(null);
        setExportPromptIds(ids);
        setMessage(payload.message ?? `${ids.length} ODF Mapping row(s) scheduled for deletion. Undo is available for 24 working hours.`);
        toast.deleted(`${ids.length} ODF Mapping segment${ids.length === 1 ? "" : "s"}`, {
          markedForDeletion: true,
          title: payload.mergeTopology ? "Scheduled — Reverse Split on expiry" : "Scheduled for deletion (24 working-hour undo window)",
          action: holds.length === 1 ? {
            label: "Undo",
            onClick: async () => {
              const result = await deletionHolds.undo(holds[0].entityId);
              setMessage(result.message);
            },
          } : undefined,
        });
        return;
      }
      const hardDeletedIds = Array.isArray(payload.deletedIds) ? payload.deletedIds : [];
      const mergedRow = payload.mergedRow as InventorySegmentRow | null;
      setRows((current) => {
        const remaining = current.filter((row) => !hardDeletedIds.includes(row.segmentId));
        return mergedRow ? [mergedRow, ...remaining.filter((row) => row.segmentId !== mergedRow.segmentId)] : remaining;
      });
      setExpandedIds((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        if (mergedRow) next[mergedRow.segmentId] = true;
        return next;
      });
      setFiberRowsBySegment((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        if (mergedRow?.mappings) next[mergedRow.segmentId] = mergedRow.mappings;
        return next;
      });
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      setPendingDeleteIds(null);
      router.refresh();
      setMessage(payload.message ?? `Deleted ${ids.length} selected ODF Mapping row(s).`);
      const removedCount = hardDeletedIds.length || ids.length;
      toast.deleted(`${removedCount} ODF Mapping segment${removedCount === 1 ? "" : "s"}`, mergedRow ? { title: `Merged into ${mergedRow.segmentCode} (Reverse Split)` } : undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Segment retire/delete failed.");
    }
  }

  async function deleteSelected() {
    await deleteSegments(selectedIds);
  }

  function toggleChildSelection(childId: string) {
    setSelectedChildIds((current) =>
      current.includes(childId) ? current.filter((id) => id !== childId) : [...current, childId],
    );
  }

  async function bulkSetTopologyRole(target: "child" | "segment") {
    const ids = target === "child" ? selectedChildIds : selectedIds;
    const role = target === "child" ? bulkChildRole : bulkSegmentRole;
    if (!ids.length) {
      setMessage(`Select at least one ${target} row first.`);
      return;
    }
    setIsBulkRoleSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/topology-role/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, ids, topologyRole: role }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Bulk topology role update failed.");
      setMessage(payload.message ?? "Topology roles updated.");
      // Reflect changes locally so the UI updates without a full reload.
      const normalizedRole = target === "segment" ? (normalizeSegmentDefaultTopologyRole(role) ?? "DEFAULT") : role || "";
      if (target === "child") {
        setFiberRowsBySegment((current) => {
          const next: Record<string, InventoryMappingRow[]> = {};
          for (const [segmentId, list] of Object.entries(current)) {
            next[segmentId] = list.map((child) =>
              ids.includes(child.id)
                ? { ...child, childTopologyRole: normalizedRole || null, effectiveTopologyRole: undefined, topologyRoleSource: undefined }
                : child,
            );
          }
          return next;
        });
        setSelectedChildIds([]);
      } else {
        setRows((current) =>
          current.map((row) =>
            ids.includes(row.segmentId) ? { ...row, segmentDefaultRole: normalizedRole } : row,
          ),
        );
        setSelectedIds([]);
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk topology role update failed.");
    } finally {
      setIsBulkRoleSaving(false);
    }
  }

  async function bulkSetChildStatus(segmentId: string, children: InventoryMappingRow[]) {
    const ids = children.filter((child) => selectedChildIds.includes(child.id)).map((child) => child.id);
    if (!ids.length) {
      setMessage("Select at least one child row first.");
      return;
    }
    if (!BULK_CHILD_STATUSES.includes(bulkChildStatus)) {
      setMessage("Invalid child port status selected.");
      return;
    }
    setIsBulkStatusSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/odf-mappings/child-links/bulk-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status: bulkChildStatus }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Bulk child status update failed.");
      const rowsBySegment = payload.rowsBySegment ?? {};
      const returnedRows = Array.isArray(rowsBySegment[segmentId]) ? rowsBySegment[segmentId] as InventoryMappingRow[] : null;
      if (returnedRows) {
        setFiberRowsBySegment((current) => ({ ...current, [segmentId]: returnedRows }));
        setRows((current) => current.map((row) => row.segmentId === segmentId ? applyChildStats(row, returnedRows) : row));
      }
      setSelectedChildIds((current) => current.filter((id) => !ids.includes(id)));
      setMessage(payload.message ?? `Updated ${ids.length} child row(s).`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk child status update failed.");
    } finally {
      setIsBulkStatusSaving(false);
    }
  }

  async function saveChildLink() {
    if (!childEditor) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/fiber-links/${childEditor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceCode: childEditor.serviceId,
          serviceId: childEditor.serviceId,
          childTopologyRole: normalizeTopologyRole(childEditor.childTopologyRole),
          localSite: childEditor.localSite,
          localRack: childEditor.localRack,
          localOdf: childEditor.localOdf,
          localPort: childEditor.localPort,
          farSite: childEditor.farSite,
          farRack: childEditor.farRack,
          farOdf: childEditor.farOdf,
          farPort: childEditor.farPort,
          status: childEditor.status,
          remarks: childEditor.remarks,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Child fiber-link update failed.");
      const updated = {
        serviceId: childEditor.serviceId || null,
        childTopologyRole: childEditor.childTopologyRole || null,
        localSite: childEditor.localSite || null,
        localRack: childEditor.localRack || null,
        localOdf: childEditor.localOdf || null,
        localPort: childEditor.localPort || null,
        farSite: childEditor.farSite || null,
        farRack: childEditor.farRack || null,
        farOdf: childEditor.farOdf || null,
        farPort: childEditor.farPort || null,
        fiberNumbers: childEditor.localPort ? JSON.stringify((childEditor.localPort.match(/\d+/g) ?? []).map(Number)) : null,
        fiberCount: fiberCountFromUnit(childEditor.localPort || childEditor.farPort, null),
        status: childEditor.status,
        remarks: childEditor.remarks || null,
      };
      const returnedRows = Array.isArray(payload.rows) ? payload.rows as InventoryMappingRow[] : null;
      const nextChildren = returnedRows ?? (fiberRowsBySegment[childEditor.parentSegmentId] ?? rows.find((row) => row.segmentId === childEditor.parentSegmentId)?.mappings ?? [])
        .map((item) => (item.id === childEditor.id || item.fiberId === childEditor.id) ? { ...item, ...updated } : item);
      setFiberRowsBySegment((current) => ({
        ...current,
        [childEditor.parentSegmentId]: nextChildren,
      }));
      setRows((current) => current.map((row) => row.segmentId === childEditor.parentSegmentId ? applyChildStats(row, nextChildren) : row));
      // Highlight both the modified child fiber-link and its parent segment row.
      flash([childEditor.id, childEditor.parentSegmentId]);
      setChildEditor(null);
      setMessage(payload.message ?? "Child fiber-link updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Child fiber-link update failed.");
    }
  }

  async function releaseFiberLink(row: InventorySegmentRow, child: InventoryMappingRow) {
    const linkId = child.fiberId ?? child.id;
    if (!linkId) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/fiber-links/${linkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseService: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Fiber release failed.");
      const returnedRows = Array.isArray(payload.rows) ? payload.rows as InventoryMappingRow[] : null;
      const nextChildren = returnedRows ?? (fiberRowsBySegment[row.segmentId] ?? row.mappings ?? []).map((item) => item.id === child.id ? { ...item, serviceId: null, status: "AVAILABLE" as SegmentStatus } : item);
      setFiberRowsBySegment((current) => ({
        ...current,
        [row.segmentId]: nextChildren,
      }));
      setRows((current) => current.map((item) => item.segmentId === row.segmentId ? applyChildStats(item, nextChildren) : item));
      setMessage(payload.message ?? "Fiber link released successfully.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Fiber release failed.");
    }
  }

  async function deleteFiberLink(row: InventorySegmentRow, child: InventoryMappingRow) {
    const linkId = child.fiberId ?? child.id;
    if (!linkId) return;
    const isRehomedCleanup = String(child.status ?? "").toUpperCase() === "REHOMED";
    const confirmMessage = isRehomedCleanup
      ? "Delete this rehomed cleanup row? This will not affect the newly created split segment, the parent segment configuration, service trace, or ODF utilization."
      : `Delete/retire fiber ${child.fiberNumber ?? child.fiberNumbers ?? child.id}?`;
    if (!window.confirm(confirmMessage)) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/fiber-links/${linkId}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Fiber link delete failed.");
      const currentChildren = fiberRowsBySegment[row.segmentId] ?? row.mappings ?? [];
      const nextChildren = payload.removed
        ? currentChildren.filter((item) => item.id !== child.id)
        : currentChildren.map((item) => item.id === child.id ? { ...item, status: "DECOMMISSIONED" as SegmentStatus } : item);
      setFiberRowsBySegment((current) => ({
        ...current,
        [row.segmentId]: nextChildren,
      }));
      setRows((current) => current.map((item) => item.segmentId === row.segmentId ? applyChildStats(item, nextChildren) : item));
      setMessage(payload.message ?? "Fiber link deleted successfully.");
      const fiberLabel = `Fiber link ${child.fiberNumber ?? child.fiberNumbers ?? child.id} on ${row.segmentCode}`;
      if (payload.removed) toast.deleted(fiberLabel);
      else toast.notify({ tone: "delete", persistent: true, title: "Retired", message: `${fiberLabel} has been retired (decommissioned).` });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Fiber link delete failed.");
    }
  }

  function exportExcel(scope: "filtered" | "all") {
    const params = new URLSearchParams({ type: "inventory", format: "xlsx" });
    if (scope === "filtered") {
      const filterParams = inventoryFiltersToParams(filters);
      filterParams.forEach((value, key) => params.set(key, value));
    }
    window.location.href = `/api/export?${params.toString()}`;
  }

  async function emailInventory() {
    const recipients = window.prompt("Email filtered inventory export to (comma separated):");
    if (!recipients) return;
    setMessage(null);
    try {
      const response = await fetch("/api/export/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "inventory",
          ...filters,
          recipients,
          includeConfiguredRecipients: window.confirm("Also send to configured portal recipients?"),
        }),
      });
      const payload = await response.json();
      setMessage(response.ok ? payload.message : payload.error ?? "Email export failed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Email export failed.");
    }
  }

  async function analyzeImpact(row: InventorySegmentRow) {
    setMessage(null);
    try {
      const response = await fetch("/api/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: {
            site: row.nearSite,
            connectedSite: row.farSite ?? "",
            odfId: row.nearOdf ?? "",
            portPair: row.nearPortGroup ?? "",
            cableId: row.cableLabel ?? "",
            tubeNumber: row.tubeNumber ? String(row.tubeNumber) : "",
            tubeColor: row.tubeColor ?? "",
            fiberPortNumber: row.fiberPortNumber ? String(row.fiberPortNumber) : "",
            fiberNumber: row.fiberNumber ? String(row.fiberNumber) : "",
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Impact analysis failed.");
      setImpact(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Impact analysis failed.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[280px] flex-1">
            <input
              ref={searchInputRef}
              className="input-dark w-full"
              placeholder="Search site, service, cable, ODF, rack, port pair    ( / )"
              value={filters.search ?? ""}
              onChange={(event) => updateFilter("search", event.target.value)}
              onKeyDown={(event) => {
                // Enter applies immediately; otherwise the debounced effect
                // auto-applies ~300ms after the operator pauses typing.
                if (event.key === "Enter") navigateServerPage(1);
              }}
            />
          </div>
          <ChildTagFilter
            value={tagFilter}
            onChange={(next) => {
              setTagFilter(next);
              setPage(1);
            }}
          />
          <select className="input-dark" value={filters.status ?? "ALL"} onChange={(event) => updateFilter("status", event.target.value)}>
            <option value="ALL">Status: All</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>{displayStatusLabel(status)}</option>
            ))}
          </select>
          <select className="input-dark" value={filters.regionPrefix ?? ""} onChange={(event) => updateFilter("regionPrefix", event.target.value)}>
            <option value="">Region: All</option>
            {REGION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => exportExcel("filtered")}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export Filtered
          </button>
          <button className="btn btn-ghost" onClick={() => exportExcel("all")}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export All
          </button>
          <button className="btn btn-ghost" onClick={emailInventory}>
            <Mail className="h-4 w-4" aria-hidden="true" />
            Email Export
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[
            ["site", "Site"],
            ["connectedSite", "Connected site"],
            ["serviceId", "Service ID"],
            ["cableId", "Segment name"],
          ].map(([key, label]) => (
            <SuggestionInput
              key={key}
              kind={suggestionKindForFilter(key) ?? "sites"}
              type={key === "dateFrom" || key === "dateTo" ? "date" : "text"}
              className="input-dark"
              value={String(filters[key as keyof InventoryFilters] ?? "")}
              params={{
                site: key === "connectedSite" ? String(filters.site ?? "") : "",
                rack: "",
                odf: "",
              }}
              onChange={(nextValue) => updateFilter(key as keyof InventoryFilters, nextValue)}
              onKeyDown={(event) => {
                if (event.key === "Enter") navigateServerPage(1);
              }}
              placeholder={label}
            />
          ))}
        </div>
        <div className="selected-filter-row mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span style={{ color: "var(--muted-text)" }}>Active filters:</span>
          {activeFilters.length || tagFilter.length ? (
            <>
              {activeFilters.map(([key, value]) => (
                <button key={key} className="selected-filter-chip !min-h-0" title={`Clear ${key} filter`} onClick={() => updateFilter(key as keyof InventoryFilters, "")}>
                  {key}: {value} ✕
                </button>
              ))}
              {tagFilter.map((tag) => (
                <button key={`tag-${tag}`} className="selected-filter-chip !min-h-0" title={`Clear ${tag} service-type filter`} onClick={() => setTagFilter((current) => current.filter((item) => item !== tag))}>
                  type: {tag} ✕
                </button>
              ))}
            </>
          ) : <span style={{ color: "var(--faint-text)" }}>none</span>}
        </div>
        {message ? (
          <div className="mt-3 rounded-lg border px-3 py-2 text-sm font-semibold" role="status" style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)", color: "var(--text-main)" }}>
            {message}
          </div>
        ) : null}
      </div>

      <div className="card p-5">
        <div className="section-title">ODF Mappings</div>
        <div className="subtle mt-1">
          Showing {visibleRows.length} of {matchingTotal} matching record{matchingTotal === 1 ? "" : "s"}.
          {filtersPending ? (
            <span className="ml-2 inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold" style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)", color: "var(--accent-text)" }}>
              Updating results…
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => setEditor(blankEditor())}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Add Segment
            </button>
            {canBulkDelete ? (
              <button className="btn btn-danger-soft" disabled={!selectedIds.length} onClick={deleteSelected}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete selected ({selectedIds.length})
              </button>
            ) : null}
            <button className="btn btn-ghost" onClick={selectAllFiltered}>
              {isServerPaged ? `Select visible page (${visibleRows.length})` : `Select all filtered (${filteredRows.length})`}
            </button>
            {selectedIds.length ? <button className="btn btn-ghost" onClick={() => setSelectedIds([])}>Clear selection</button> : null}
            {selectedIds.length ? (
              <div className="bulk-bar !py-1.5" role="toolbar" aria-label="Bulk actions for selected segments">
                <span className="bulk-bar-count">{selectedIds.length} segment{selectedIds.length === 1 ? "" : "s"}</span>
                <span className="bulk-bar-label">Type</span>
                <select className="input-dark" value={bulkSegmentRole} aria-label="Bulk segment type" onChange={(event) => setBulkSegmentRole(event.target.value)}>
                  {SEGMENT_TYPES.map((type) => <option key={type} value={type}>{segmentTypeLabel(type)}</option>)}
                </select>
                <button className="btn btn-primary btn-compact" disabled={isBulkRoleSaving} onClick={() => bulkSetTopologyRole("segment")}>Apply</button>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted-text)" }}>
            <span>Rows per page</span>
            <select className="input-dark" value={serverPage?.pageSize ?? pageSize} onChange={(event) => {
              const nextPageSize = Number(event.target.value);
              setPageSize(nextPageSize);
              setPage(1);
              if (isServerPaged) navigateServerPage(1, nextPageSize);
            }}>
              {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-3">
          <UtilizationFilter value={utilTier} onChange={setUtilTier} counts={utilCounts} />
        </div>
        <div className="table-shell inventory-table-shell mt-5">
          <table className="inventory-segment-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={visibleSelected} onChange={toggleVisibleRows} aria-label="Select visible rows" />
                </th>
                <th></th>
                <th>Segment Name</th>
                <th>Segment Group</th>
                <th>Near Site</th>
                <th>Far Site</th>
                <th>Capacity</th>
                <th>Distance</th>
                <th>Child ports</th>
                <th>Utilization (Active / Capacity)</th>
                <th>Available</th>
                <th>Status</th>
                <th className="sticky-action">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <Fragment key={row.segmentId}>
                  <tr style={rowFlashStyle(isFlashing(row.segmentId))}>
                    <td><input type="checkbox" checked={selectedIds.includes(row.segmentId)} onChange={() => toggleRow(row.segmentId)} aria-label={`Select ${row.segmentCode}`} /></td>
                    <td>
                      <button
                        className="btn btn-ghost !min-h-0 h-9 w-9 !p-0"
                        onClick={() => toggleExpanded(row.segmentId)}
                        aria-expanded={Boolean(expandedIds[row.segmentId])}
                        aria-label={`${expandedIds[row.segmentId] ? "Collapse" : "Expand"} ${row.segmentCode}`}
                      >
                        {expandedIds[row.segmentId] ? <ChevronDown className="h-5 w-5" aria-hidden="true" /> : <ChevronRight className="h-5 w-5" aria-hidden="true" />}
                      </button>
                    </td>
                    <td>
                      <div className="font-semibold">{segmentDisplayTitle(row.segmentCode)}</div>
                      <div className="subtle text-xs">{segmentDisplaySubtitle(row.segmentCode, row.segmentSequence, preferredCapacity(row))}</div>
                    </td>
                    <td>{row.segmentGroupName ?? row.segmentCode.split("-C")[0] ?? "-"}</td>
                    <td><Link className="text-red-700 hover:text-red-900 dark:text-red-200" href={siteHref(row.nearSite, row.nearSiteCode)}>{displaySiteLabel(row.nearSite, row.segmentGroupName ?? row.segmentCode)}</Link></td>
                    <td>{row.farSite ? <Link className="text-red-700 hover:text-red-900 dark:text-red-200" href={siteHref(row.farSite, row.farSiteCode)}>{displaySiteLabel(row.farSite, row.segmentGroupName ?? row.segmentCode)}</Link> : "-"}</td>
                    <td>{preferredCapacity(row) ? `${preferredCapacity(row)} fibers` : "-"}</td>
                    <td>{row.distanceKm === 0 || row.distanceKm ? `${row.distanceKm} km` : "-"}</td>
                    <td>
                      {preferredCapacity(row) ?? (childStats(childRows(row)).total || childLinkCount(row))}
                      <div className="text-xs" style={{ color: "var(--muted-text)" }}>{structuralRowCount(row)} rows</div>
                    </td>
                    <td>
                      {(() => {
                        const capacity = preferredCapacity(row);
                        const used = row.usedFibers ?? 0;
                        const utilization = row.utilizationPct ?? (capacity && capacity > 0
                          ? Math.round((used / capacity) * 1000) / 10
                          : 0);
                        return (
                          <>
                            <div className="font-semibold">{used} / {capacity ?? "-"}</div>
                            <div className="mt-1 h-2 w-28 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                              <div
                                className={`h-full rounded-full ${utilization >= 90 ? "bg-red-600" : utilization >= 70 ? "bg-amber-500" : "bg-emerald-600"}`}
                                style={{ width: `${Math.min(100, utilization)}%` }}
                              />
                            </div>
                            <div className="subtle text-xs">{utilization}% used</div>
                          </>
                        );
                      })()}
                    </td>
                    <td>
                      {row.availableFibers === 0 || row.availableFibers ? row.availableFibers : "-"}
                      {row.rehomedFibers ? <div className="text-xs font-semibold text-cyan-700 dark:text-cyan-200">{row.rehomedFibers} rehomed</div> : null}
                      {row.dummyFibers ? <div className="text-xs text-amber-700 dark:text-amber-200">{row.dummyFibers} dummy</div> : null}
                    </td>
                    <td><span className={`badge ${badgeClassForStatus(row.status)}`}>{displayStatusLabel(row.status)}</span></td>
                    <td className="sticky-action">
                      <div className="flex gap-2">
                        <button className="btn btn-ghost btn-compact" onClick={() => setEditor(toEditor(row))}>
                          Edit
                        </button>
                        <button className="btn btn-ghost btn-compact" title="Create a parallel segment from this one (same endpoints, fresh ports)" onClick={() => setEditor(cloneEditor(row))}>
                          Clone
                        </button>
                        <button className="btn btn-ghost btn-compact" onClick={() => patchSegment({ segmentId: row.segmentId, status: "RESERVED" })}>
                          Reserve
                        </button>
                        <button className="btn btn-ghost btn-compact" onClick={() => patchSegment({ segmentId: row.segmentId, status: "AVAILABLE" })}>
                          Release
                        </button>
                        <button className="btn btn-danger-soft btn-compact" onClick={() => analyzeImpact(row)}>
                          <Radar className="h-3 w-3" aria-hidden="true" />
                          Impact
                        </button>
                        {canBulkDelete ? (() => {
                          // Scheduled-for-deletion rows swap the Delete action
                          // for a live Undo countdown (24 working hours on the
                          // GCC calendar; weekends/holidays pause the timer).
                          const remaining = deletionHolds.remainingFor(row.segmentId);
                          if (remaining) {
                            return (
                              <button
                                className="btn btn-compact border border-amber-400/40 bg-amber-500/10 font-semibold text-amber-800 dark:text-amber-200"
                                onClick={async () => {
                                  const result = await deletionHolds.undo(row.segmentId);
                                  setMessage(result.message);
                                }}
                                title="This segment is scheduled for deletion. Click to undo while the reversal window is open. The countdown pauses over GCC weekends and holidays."
                              >
                                <Undo2 className="h-3 w-3" aria-hidden="true" />
                                Undo Delete ({remaining.label} remaining)
                              </button>
                            );
                          }
                          return (
                            <button className="btn btn-danger-soft btn-compact" onClick={() => deleteSegments([row.segmentId])}>
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                              Delete
                            </button>
                          );
                        })() : null}
                      </div>
                    </td>
                  </tr>
                  {expandedIds[row.segmentId] ? (() => {
                    const children = childRows(row);
                    return (
                      <tr className="child-detail-row">
                        <td></td>
                        <td colSpan={12}>
                          <div className="segment-operation-panel mb-4 rounded-lg border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-950/70">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Parent segment operations</div>
                                <div className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                                  Split and capacity actions are bound to this exact parent segment under the hood, not only to the site pair.
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button type="button" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 dark:border-red-700 dark:bg-red-950/50 dark:text-red-100" onClick={() => startSplit(row, "FULL_SPLIT")}>
                                  Split Fully
                                </button>
                                <button type="button" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100" onClick={() => startSplit(row, "PARTIAL_SPLIT")}>
                                  Split Partially
                                </button>
                                <button type="button" className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-900 dark:border-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-100" onClick={() => startUpgrade(row)}>
                                  Upgrade Capacity
                                </button>
                              </div>
                            </div>

                            {upgradeEditor?.segmentId === row.segmentId ? (
                              <div className="upgrade-editor-panel mt-4 rounded-lg border border-cyan-300 bg-cyan-50 p-4 dark:border-cyan-700 dark:bg-cyan-950/40">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">Upgrade capacity from dummy ports</div>
                                    <div className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                                      Add live fibers by consuming DUMMY ports already provisioned on both ODFs. Only dummy ports may be used — active/available/reserved ports are rejected.
                                    </div>
                                  </div>
                                  <button type="button" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" onClick={() => setUpgradeEditor(null)}>
                                    Close
                                  </button>
                                </div>
                                {upgradeEditor.loading ? (
                                  <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">Loading dummy-port availability…</div>
                                ) : upgradeEditor.context ? (
                                  <>
                                  {(() => {
                                    const nearAvail = upgradeEditor.context.near.dummyPorts.length;
                                    const farAvail = upgradeEditor.context.far.dummyPorts.length;
                                    const maxCount = Math.min(nearAvail, farAvail);
                                    return (
                                      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-300 bg-white p-3 dark:border-cyan-700 dark:bg-slate-950">
                                        <label className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Fibers to add</label>
                                        <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700">
                                          <button
                                            type="button"
                                            aria-label="Remove one fiber"
                                            className="px-3 py-1.5 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-800"
                                            disabled={upgradeEditor.fibersToAdd <= 0}
                                            onClick={() => setUpgradeFiberCount(upgradeEditor.fibersToAdd - 1)}
                                          >
                                            −
                                          </button>
                                          <input
                                            type="number"
                                            min={0}
                                            max={maxCount}
                                            aria-label="Number of fibers to add"
                                            className="w-16 border-x border-slate-300 bg-transparent text-center text-sm font-semibold tabular-nums outline-none dark:border-slate-700"
                                            value={upgradeEditor.fibersToAdd}
                                            onChange={(event) => setUpgradeFiberCount(Number(event.target.value))}
                                          />
                                          <button
                                            type="button"
                                            aria-label="Add one fiber"
                                            className="px-3 py-1.5 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-800"
                                            disabled={upgradeEditor.fibersToAdd >= maxCount}
                                            onClick={() => setUpgradeFiberCount(upgradeEditor.fibersToAdd + 1)}
                                          >
                                            +
                                          </button>
                                        </div>
                                        <button
                                          type="button"
                                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                          disabled={maxCount === 0 || upgradeEditor.fibersToAdd >= maxCount}
                                          onClick={() => setUpgradeFiberCount(maxCount)}
                                        >
                                          Max ({maxCount})
                                        </button>
                                        <span className="text-xs text-slate-600 dark:text-slate-300">
                                          {maxCount === 0
                                            ? "No matched dummy ports available on both ends."
                                            : `Up to ${maxCount} (near ${nearAvail} / far ${farAvail} dummy ports). Near & far ranges auto-match.`}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                                    {(["near", "far"] as const).map((side) => {
                                      const ctx = upgradeEditor.context![side];
                                      return (
                                        <div key={side} className="rounded-lg border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
                                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{side === "near" ? "Near end (A)" : "Far end (B)"}</div>
                                          <div className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{ctx.site ?? "?"} / {ctx.rack ?? "?"} / ODF {ctx.odf ?? "?"}</div>
                                          <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">Configured ports: {ctx.configuredRange ?? "—"}</div>
                                          <div className="mt-1 text-xs font-semibold text-cyan-800 dark:text-cyan-200">Available dummy ports: {ctx.dummyRanges || "none"}</div>
                                          <label className="mt-2 block text-xs font-semibold text-slate-600 dark:text-slate-300">Port range to add <span className="font-normal text-slate-500">(auto from stepper — editable)</span></label>
                                          <input
                                            className="input-dark mt-1 w-full normal-case tracking-normal"
                                            value={side === "near" ? upgradeEditor.nearPorts : upgradeEditor.farPorts}
                                            placeholder={ctx.dummyRanges || "e.g. 13-24"}
                                            onChange={(event) => setUpgradeEditor((current) => (current ? { ...current, [side === "near" ? "nearPorts" : "farPorts"]: event.target.value } : current))}
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                  </>
                                ) : (
                                  <div className="mt-3 text-sm font-semibold text-red-700 dark:text-red-300">Could not load ODF dummy-port availability for this segment.</div>
                                )}
                                <div className="mt-4 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    disabled={isSaving || upgradeEditor.loading || !upgradeEditor.context || !upgradeEditor.nearPorts.trim() || !upgradeEditor.farPorts.trim()}
                                    className="inline-flex items-center gap-2 rounded-lg border border-cyan-300 bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
                                    onClick={() => submitUpgrade(row)}
                                  >
                                    {isSaving ? "Upgrading…" : "Confirm upgrade"}
                                  </button>
                                  <button type="button" disabled={isSaving} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" onClick={() => setUpgradeEditor(null)}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            {splitEditor?.parentSegmentId === row.segmentId ? (() => {
                              const liveFiberNumbers = selectableFiberNumbers(row);
                              const selectedSet = new Set<number>(splitEditor.selectedFiberNumbers);
                              const selectedMappingSet = new Set<string>(splitEditor.selectedMappingIds);
                              const affectedServiceDetails = affectedServiceDetailsForSplit(row);
                              return (
                                <div className="split-editor-panel mt-4 rounded-lg border border-slate-300 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                                        {splitEditor.mode === "FULL_SPLIT" ? "Full split preview" : "Partial split preview"}
                                      </div>
                                      <div className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                                        {splitEditor.mode === "FULL_SPLIT"
                                          ? `${row.nearSite} - ${row.farSite} will retire and become ${row.nearSite} - X and X - ${row.farSite}.`
                                          : `${row.nearSite} - ${row.farSite} remains active for unselected fibers; selected fibers move via X.`}
                                      </div>
                                    </div>
                                    <button className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" onClick={() => setSplitEditor(null)}>
                                      Close split panel
                                    </button>
                                  </div>
                                  <div className="split-form-grid mt-4 grid gap-3">
                                    {[
                                      ["Inserted Site", "insertedSite"],
                                      ["B rack facing A", "insertedNearRack"],
                                      ["B ODF facing A", "insertedNearOdf"],
                                      ["B ports facing A", "insertedNearPortGroup"],
                                      ["B rack facing far end", "insertedFarRack"],
                                      ["B ODF facing far end", "insertedFarOdf"],
                                      ["B ports facing far end", "insertedFarPortGroup"],
                                      ["Distance A-X km", "distanceKmNear"],
                                      ["Distance X-B km", "distanceKmFar"],
                                      ["Comments", "comments"],
                                    ].map(([label, key]) => (
                                      <label key={key} className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-700 dark:text-slate-200">
                                        <span className="inline-flex items-center gap-1.5">
                                          <span>{label}</span>
                                          {assetStateMark(splitAssetCheck[key])}
                                        </span>
                                        {suggestionKindForEditor(key) || key === "insertedSite" ? (
                                          <SuggestionInput
                                            kind={key === "insertedSite" ? "sites" : suggestionKindForEditor(key) ?? "sites"}
                                            className="input-dark mt-2 w-full normal-case tracking-normal"
                                            value={String(splitEditor[key as keyof SplitEditorState] ?? "")}
                                            params={splitSuggestionParams(key, splitEditor)}
                                            onChange={(nextValue, suggestion) => {
                                              const nextEditor = { ...splitEditor, [key]: nextValue };
                                              if (key === "insertedSite" && suggestion) {
                                                const defaultRack = String(suggestion.defaultRack ?? "");
                                                const defaultOdf = String(suggestion.defaultOdf ?? "");
                                                const defaultPortGroup = String(suggestion.defaultPortGroup ?? "");
                                                nextEditor.insertedNearRack = nextEditor.insertedNearRack || defaultRack;
                                                nextEditor.insertedFarRack = nextEditor.insertedFarRack || defaultRack;
                                                nextEditor.insertedNearOdf = nextEditor.insertedNearOdf || defaultOdf;
                                                nextEditor.insertedFarOdf = nextEditor.insertedFarOdf || defaultOdf;
                                                nextEditor.insertedNearPortGroup = nextEditor.insertedNearPortGroup || defaultPortGroup;
                                                nextEditor.insertedFarPortGroup = nextEditor.insertedFarPortGroup || defaultPortGroup;
                                              }
                                              if (suggestion && (key === "insertedNearRack" || key === "insertedFarRack")) {
                                                const suggestionSite = String(suggestion.site ?? splitEditor.insertedSite ?? "");
                                                if (suggestionSite) nextEditor.insertedSite = nextEditor.insertedSite || suggestionSite;
                                              }
                                              if (suggestion && key === "insertedNearOdf") {
                                                nextEditor.insertedNearRack = nextEditor.insertedNearRack || String(suggestion.rack ?? "");
                                              }
                                              if (suggestion && key === "insertedFarOdf") {
                                                nextEditor.insertedFarRack = nextEditor.insertedFarRack || String(suggestion.rack ?? "");
                                              }
                                              if (suggestion && key === "insertedNearPortGroup") {
                                                nextEditor.insertedNearRack = nextEditor.insertedNearRack || String(suggestion.rack ?? "");
                                                nextEditor.insertedNearOdf = nextEditor.insertedNearOdf || String(suggestion.odf ?? "");
                                              }
                                              if (suggestion && key === "insertedFarPortGroup") {
                                                nextEditor.insertedFarRack = nextEditor.insertedFarRack || String(suggestion.rack ?? "");
                                                nextEditor.insertedFarOdf = nextEditor.insertedFarOdf || String(suggestion.odf ?? "");
                                              }
                                              setSplitEditor(nextEditor);
                                            }}
                                            placeholder={label}
                                          />
                                        ) : (
                                          <input
                                            className="input-dark mt-2 w-full normal-case tracking-normal"
                                            value={String(splitEditor[key as keyof SplitEditorState] ?? "")}
                                            onChange={(event) => setSplitEditor({ ...splitEditor, [key]: event.target.value })}
                                          />
                                        )}
                                      </label>
                                    ))}
                                  </div>
                                  <div className="mt-4">
                                    {(() => {
                                      const selectedChildren = children.filter((child) => {
                                        const childFibers = childFiberNumbers(child);
                                        return selectedMappingSet.has(child.id) || childFibers.every((fiberNumber) => selectedSet.has(fiberNumber));
                                      });
                                      const selectedPortLabels = selectedChildren.map(odfPortLinkLabel);
                                      return (
                                        <>
                                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                                              Selected ODF port links: {selectedPortLabels.length ? selectedPortLabels.join(" | ") : "none"}
                                            </div>
                                            {splitEditor.mode === "PARTIAL_SPLIT" ? (
                                              <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" onClick={() => setSplitEditor({ ...splitEditor, selectedFiberNumbers: liveFiberNumbers, selectedMappingIds: children.filter(isLiveSelectableChild).map((child) => child.id) })}>
                                                Select all live port links
                                              </button>
                                            ) : null}
                                          </div>
                                          <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
                                            <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-700 dark:text-slate-200">Select ODF port-to-port links</div>
                                            <div className="flex flex-wrap gap-2">
                                              {children.filter(isLiveSelectableChild).map((child) => {
                                                const childFibers = childFiberNumbers(child);
                                                const childSelected = selectedMappingSet.has(child.id) || childFibers.every((fiberNumber) => selectedSet.has(fiberNumber));
                                                return (
                                                  <button
                                                    key={child.id}
                                                    type="button"
                                                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${childSelected ? "border-cyan-500 bg-cyan-100 text-cyan-950 ring-2 ring-cyan-300 dark:bg-cyan-500 dark:text-slate-950" : "border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"}`}
                                                    onClick={() => toggleSplitChildLink(child)}
                                                    title="Uses this child link's existing far-end rack, ODF and port mapping during split"
                                                  >
                                                    {odfPortLinkLabel(child)}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </div>
                                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                                    <div className="split-preview-card rounded-lg border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
                                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Topology preview</div>
                                      <div className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                                        {splitEditor.mode === "FULL_SPLIT"
                                          ? `${row.nearSite} - ${row.farSite} -> ${row.nearSite} - ${splitEditor.insertedSite || "X"} - ${row.farSite}`
                                          : `${row.nearSite} - ${row.farSite} stays active; selected ODF port links route ${row.nearSite} - ${splitEditor.insertedSite || "X"} - ${row.farSite}`}
                                      </div>
                                    </div>
                                    <div className="split-preview-card rounded-lg border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Affected services</div>
                                        {affectedServiceDetails.length ? (
                                          <button
                                            type="button"
                                            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                            onClick={() => exportAffectedServices(row)}
                                          >
                                            Export affected
                                          </button>
                                        ) : null}
                                      </div>
                                      <div className="mt-2 max-h-28 space-y-1 overflow-y-auto pr-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                                        {affectedServiceDetails.length ? affectedServiceDetails.map((service) => (
                                          <div key={service.serviceId} className="break-words rounded-md bg-slate-50 px-2 py-1 text-slate-800 dark:bg-slate-900 dark:text-slate-100">
                                            {service.serviceId}
                                            <span className="ml-2 text-xs font-semibold text-slate-600 dark:text-slate-300">{service.portPairs.join(" | ")}</span>
                                          </div>
                                        )) : "No active services on selected ODF port links."}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="mt-4 flex justify-end gap-2">
                                    <button className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" onClick={() => setSplitEditor(null)}>
                                      Cancel
                                    </button>
                                    <button type="button" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70" disabled={isSaving} onClick={() => submitSplit(row)}>
                                      {isSaving ? "Applying split..." : "Confirm Split"}
                                    </button>
                                  </div>
                                </div>
                              );
                            })() : null}
                          </div>
                          {children.length ? (() => {
                            const selectedChildCount = children.filter((child) => selectedChildIds.includes(child.id)).length;
                            const allChildrenSelected = selectedChildCount > 0 && selectedChildCount === children.length;
                            return (
                            <>
                              {selectedChildCount > 0 ? (
                                <div className="bulk-bar mb-3" role="toolbar" aria-label="Bulk actions for selected ports">
                                  <span className="bulk-bar-count">{selectedChildCount} port{selectedChildCount === 1 ? "" : "s"} selected</span>
                                  <span className="bulk-bar-label">Set status</span>
                                  <select className="input-dark" value={bulkChildStatus} aria-label="Bulk port status" onChange={(event) => setBulkChildStatus(event.target.value as SegmentStatus)}>
                                    {BULK_CHILD_STATUSES.map((status) => <option key={status} value={status}>{displayStatusLabel(status)}</option>)}
                                  </select>
                                  <button className="btn btn-primary btn-compact" disabled={isBulkStatusSaving} onClick={() => bulkSetChildStatus(row.segmentId, children)}>
                                    {isBulkStatusSaving ? "Applying…" : "Apply status"}
                                  </button>
                                  <span className="bulk-bar-label">Topology</span>
                                  <select className="input-dark" value={bulkChildRole} aria-label="Bulk topology role" onChange={(event) => setBulkChildRole(event.target.value)}>
                                    <option value="">Default / inherit (MAIN_RING)</option>
                                    {CHILD_TOPOLOGY_ROLES.map((role) => <option key={role} value={role}>{topologyRoleLabel(role)}</option>)}
                                  </select>
                                  <button className="btn btn-ghost btn-compact" disabled={isBulkRoleSaving} onClick={() => bulkSetTopologyRole("child")}>
                                    {isBulkRoleSaving ? "Applying…" : "Apply role"}
                                  </button>
                                  <button className="btn btn-ghost btn-compact" onClick={() => setSelectedChildIds((current) => current.filter((id) => !children.some((child) => child.id === id)))}>
                                    Clear selection
                                  </button>
                                </div>
                              ) : null}
                              <div className="child-table-shell">
                              <table className="child-link-table">
                                <thead>
                                  <tr>
                                    <th className="w-8">
                                      <input
                                        type="checkbox"
                                        className="child-link-checkbox"
                                        checked={allChildrenSelected}
                                        aria-label="Select all ports in this segment"
                                        onChange={() => setSelectedChildIds((current) => allChildrenSelected
                                          ? current.filter((id) => !children.some((child) => child.id === id))
                                          : [...new Set([...current, ...children.map((child) => child.id)])])}
                                      />
                                    </th>
                                    <th>Service ID</th>
                                    <th>Local Site</th>
                                    <th>Local Rack</th>
                                    <th>Local ODF</th>
                                    <th>Local ODF Port</th>
                                    <th>Port Count</th>
                                    <th>Far Site</th>
                                    <th>Far Rack</th>
                                    <th>Far ODF</th>
                                    <th>Far ODF Port</th>
                                    <th>Cable ID</th>
                                    <th>Tag</th>
                                    <th>Topology Role</th>
                                    <th>Status</th>
                                    <th className="sticky-action">Actions</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {children.map((child) => {
                                    const childFibers = childFiberNumbers(child);
                                    const childSelectedForSplit = splitEditor?.parentSegmentId === row.segmentId
                                      && (splitEditor.selectedMappingIds.includes(child.id) || childFibers.every((fiberNumber) => splitEditor.selectedFiberNumbers.includes(fiberNumber)));
                                    return (
                                    <tr key={child.id} className={childSelectedForSplit ? "split-selected-child-row" : undefined} style={rowFlashStyle(isFlashing(child.id))}>
                                      <td><input type="checkbox" className="child-link-checkbox" checked={selectedChildIds.includes(child.id)} onChange={() => toggleChildSelection(child.id)} aria-label={`Select child link ${child.serviceId ?? child.id}`} /></td>
                                      <td className="break-cell min-w-[220px]">{(() => {
                                        const serviceText = readableServiceText(child.serviceId);
                                        if (!serviceText) return "-";
                                        return (
                                          <Link
                                            className="font-medium text-red-700 hover:text-red-900 hover:underline dark:text-red-200 dark:hover:text-white"
                                            href={`/service-trace?service=${encodeURIComponent(serviceText)}` as Route}
                                            title={`Trace ${serviceText} in Trace and Provision`}
                                          >
                                            {serviceText}
                                          </Link>
                                        );
                                      })()}</td>
                                      <td>{displaySiteLabel(child.localSite)}</td>
                                      <td>{child.localRack ?? "-"}</td>
                                      <td>{child.localOdf ?? "-"}</td>
                                      <td>{child.localPort ?? "-"}</td>
                                      <td>{childFiberCount(child)}</td>
                                      <td className="break-cell min-w-[160px]">{displaySiteLabel(child.farSite ?? child.farEndpoint)}</td>
                                      <td>{child.farRack ?? "-"}</td>
                                      <td>{child.farOdf ?? "-"}</td>
                                      <td>{child.farPort ?? "-"}</td>
                                      <td className="break-cell min-w-[160px]">{child.cableId ?? row.cableLabel ?? "-"}</td>
                                      <td>
                                        <ChildLinkTagDropdown
                                          childId={child.id}
                                          value={child.tag}
                                          onChange={(tag, payload) => {
                                            const updatedIds = new Set(payload?.updatedIds?.length ? payload.updatedIds : [child.id]);
                                            const updatedService = payload?.serviceCode ?? child.serviceId ?? null;
                                            const shouldInheritTag = (mapping: InventoryMappingRow) =>
                                              updatedIds.has(mapping.id) || (updatedService !== null && mapping.serviceId === updatedService);
                                            setRows((current) => current.map((item) => ({
                                              ...item,
                                              mappings: (item.mappings ?? []).map((mapping) => shouldInheritTag(mapping) ? { ...mapping, tag } : mapping),
                                            })));
                                            setFiberRowsBySegment((current) => Object.fromEntries(
                                              Object.entries(current).map(([segmentId, mappings]) => [
                                                segmentId,
                                                mappings.map((mapping) => shouldInheritTag(mapping) ? { ...mapping, tag } : mapping),
                                              ]),
                                            ));
                                          }}
                                        />
                                      </td>
                                      <td><span className={`badge topology-role-${String(child.effectiveTopologyRole ?? effectiveTopologyRole({ childTopologyRole: child.childTopologyRole, segmentDefaultRole: row.segmentDefaultRole }).role).toLowerCase().replace("_", "-")}`} title={topologyRoleSourceLabel(child.topologyRoleSource ?? effectiveTopologyRole({ childTopologyRole: child.childTopologyRole, segmentDefaultRole: row.segmentDefaultRole }).source)}>{topologyRoleLabel(child.effectiveTopologyRole ?? effectiveTopologyRole({ childTopologyRole: child.childTopologyRole, segmentDefaultRole: row.segmentDefaultRole }).role)}</span></td>
                                      <td><span className={`badge ${badgeClassForStatus(child.status)}`}>{displayStatusLabel(child.status)}</span></td>
                                      <td className="sticky-action">
                                        <div className="flex flex-wrap gap-2">
                                          <button className="btn btn-ghost btn-compact" onClick={() => setChildEditor(toChildEditor(row.segmentId, child))}>
                                            Edit
                                          </button>
                                          {child.serviceId ? (
                                            <button className="btn btn-ghost btn-compact" onClick={() => releaseFiberLink(row, child)}>
                                              Release
                                            </button>
                                          ) : null}
                                          {canDelete ? (
                                            <button className="btn btn-danger-soft btn-compact" onClick={() => deleteFiberLink(row, child)}>
                                              Delete
                                            </button>
                                          ) : null}
                                        </div>
                                      </td>
                                    </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              </div>
                            </>
                            );
                          })() : (
                            <div className="child-empty-panel">
                              <div className="font-semibold">No child fiber links found for this segment.</div>
                              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                                This segment has no individual endpoint mapping rows yet. Add child fiber links/service allocation later, or edit the segment container if this was created as a simple high-level segment.
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })() : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {consolidated ? (
          <div className="mt-4 flex items-center justify-end text-xs" style={{ color: "var(--faint-text)" }}>
            All {matchingTotal} matching record{matchingTotal === 1 ? "" : "s"} shown on one page.
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-end gap-2 text-sm" style={{ color: "var(--muted-text)" }}>
            <button className="btn btn-ghost btn-compact" disabled={currentPage <= 1} onClick={() => {
              const nextPage = Math.max(1, currentPage - 1);
              // Preserve the active page size so a stepped-down (100-row) view
              // is not re-inflated back to the consolidation size on paging.
              if (isServerPaged) navigateServerPage(nextPage, effectivePageSize);
              else setPage(nextPage);
            }}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Prev
            </button>
            <span>Page {currentPage} of {pageCount}</span>
            <button className="btn btn-ghost btn-compact" disabled={currentPage >= pageCount} onClick={() => {
              const nextPage = Math.min(pageCount, currentPage + 1);
              if (isServerPaged) navigateServerPage(nextPage, effectivePageSize);
              else setPage(nextPage);
            }}>
              Next
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {editor ? (
        <DraggablePanel
          className="modal-wide"
          title={editor.segmentId === "__new__" ? "Add segment container" : "Edit segment container"}
          subtitle="Segment-level ODF/rack/port-range details. Services are allocated later on child fiber links."
          onClose={() => setEditor(null)}
        >
            <div className="mt-1 grid gap-4 md:grid-cols-4">
              {[
                ["Segment Code", "segmentCode"],
                ["Segment Capacity (fibers)", "segmentCapacity"],
                ["Near Site", "nearSite"],
                ["Near Rack", "nearRack"],
                ["Near ODF", "nearOdf"],
                ["Near ODF Port Start", "nearPortStart"],
                ["Near ODF Port End", "nearPortEnd"],
                ["Far Site", "farSite"],
                ["Far Rack", "farRack"],
                ["Far ODF", "farOdf"],
                ["Far ODF Port Start", "farPortStart"],
                ["Far ODF Port End", "farPortEnd"],
                ["Cable", "cableLabel"],
                ["Distance Km", "distanceKm"],
                ["Reason", "overrideReason"],
              ].map(([label, key]) => (
                <label key={key} className="text-xs uppercase tracking-[0.14em] text-slate-400">
                  <span className="inline-flex items-center gap-1.5">
                    <span>{label}{["nearSite", "nearRack", "nearOdf", "nearPortStart", "nearPortEnd", "farSite"].includes(key) ? " *" : ""}</span>
                    {renderAssetMark(String(key))}
                  </span>
                  {suggestionKindForEditor(key) ? (
                    <SuggestionInput
                      kind={suggestionKindForEditor(key) ?? "sites"}
                      className="input-dark mt-2 w-full normal-case tracking-normal"
                      value={String(editor[key as keyof EditorState] ?? "")}
                      params={{
                        site: ["nearRack", "nearOdf"].includes(key) ? editor.nearSite : ["farRack", "farOdf"].includes(key) ? editor.farSite : "",
                        rack: key === "nearOdf" ? editor.nearRack : key === "farOdf" ? editor.farRack : "",
                        odf: "",
                      }}
                      onChange={(nextValue, suggestion) => {
                        const nextEditor = { ...editor, [key]: nextValue };
                        if (["nearSite", "farSite"].includes(key) && suggestion) {
                          const defaultRack = String(suggestion.defaultRack ?? "");
                          const defaultOdf = String(suggestion.defaultOdf ?? "");
                          if (key === "nearSite") {
                            nextEditor.nearRack = nextEditor.nearRack || defaultRack;
                            nextEditor.nearOdf = nextEditor.nearOdf || defaultOdf;
                          }
                          if (key === "farSite") {
                            nextEditor.farRack = nextEditor.farRack || defaultRack;
                            nextEditor.farOdf = nextEditor.farOdf || defaultOdf;
                          }
                        }
                        if (key === "segmentCode" && suggestion) {
                          nextEditor.nearSite = String(suggestion.nearSite ?? nextEditor.nearSite);
                          nextEditor.farSite = String(suggestion.farSite ?? nextEditor.farSite);
                          nextEditor.nearRack = String(suggestion.nearRack ?? nextEditor.nearRack);
                          nextEditor.farRack = String(suggestion.farRack ?? nextEditor.farRack);
                          nextEditor.nearOdf = String(suggestion.nearOdf ?? nextEditor.nearOdf);
                          nextEditor.farOdf = String(suggestion.farOdf ?? nextEditor.farOdf);
                          const nearRange = splitPortRange(String(suggestion.nearPort ?? ""));
                          const farRange = splitPortRange(String(suggestion.farPort ?? ""));
                          nextEditor.nearPortStart = nearRange.start || nextEditor.nearPortStart;
                          nextEditor.nearPortEnd = nearRange.end || nextEditor.nearPortEnd;
                          nextEditor.farPortStart = farRange.start || nextEditor.farPortStart;
                          nextEditor.farPortEnd = farRange.end || nextEditor.farPortEnd;
                        }
                        setEditor(nextEditor);
                      }}
                      placeholder={label}
                    />
                  ) : (
                    <input
                      className="input-dark mt-2 w-full normal-case tracking-normal"
                      value={String(editor[key as keyof EditorState] ?? "")}
                      onChange={(event) => setEditor({ ...editor, [key]: event.target.value })}
                      placeholder={label}
                    />
                  )}
                </label>
              ))}
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Status
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value as SegmentStatus })}>
                  {/* "Dummy" and "Decommissioned" are intentionally omitted here:
                      those states are kept local to the ODF & Racks Inventory.
                      The current value is still rendered if a legacy segment
                      already holds one, so editing never silently changes it. */}
                  {EDITABLE_STATUSES
                    .filter((status) => status === editor.status || (status !== "DUMMY" && status !== "DECOMMISSIONED"))
                    .map((status) => <option key={status} value={status}>{displayStatusLabel(status)}</option>)}
                </select>
                {editor.status === "INACTIVE" ? (
                  <div className="mt-1 text-[11px] normal-case tracking-normal text-amber-700 dark:text-amber-200">
                    Inactive segments are not usable until outside-plant (OSP) work is completed and the status is explicitly changed back.
                  </div>
                ) : null}
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Segment Type
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={editor.segmentDefaultRole} onChange={(event) => setEditor({ ...editor, segmentDefaultRole: event.target.value })}>
                  {SEGMENT_TYPES.map((type) => <option key={type} value={type}>{segmentTypeLabel(type)}</option>)}
                </select>
              </label>
              <label className="md:col-span-3 text-xs uppercase tracking-[0.14em] text-slate-400">
                Comments
                <input className="input-dark mt-2 w-full normal-case tracking-normal" value={editor.comments} onChange={(event) => setEditor({ ...editor, comments: event.target.value })} />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button className="inline-flex items-center gap-2 rounded-2xl border border-border bg-white/5 px-4 py-2 text-sm" onClick={() => setEditor(null)}>
                <RotateCcw className="h-4 w-4" />
                Cancel
              </button>
              <button className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={isSaving} onClick={() => patchSegment(editor)}>
                {isSaving ? <Pencil className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                Save segment
              </button>
            </div>
        </DraggablePanel>
      ) : null}

      {childEditor ? (
        <div className="modal-backdrop">
          <div className="modal-panel max-w-4xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-950 dark:text-white">Edit child fiber link / service allocation</div>
                <div className="subtle mt-1">Assign service ID/status to this child fiber unit. To use one fiber from a pair, change 1-2 to 1 or 2; the surviving fiber remains as an available child row.</div>
              </div>
              <button className="rounded-2xl border border-border bg-white/5 px-3 py-2 text-sm" onClick={() => setChildEditor(null)}>Close</button>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {[
                ["serviceId", "Service ID"],
                ["localSite", "Local site"],
                ["localRack", "Local rack"],
                ["localOdf", "Local ODF"],
                ["localPort", "Local port / fiber unit"],
                ["farSite", "Far site"],
                ["farRack", "Far rack"],
                ["farOdf", "Far ODF"],
                ["farPort", "Far port / fiber unit"],
                ["remarks", "Remarks"],
              ].map(([key, label]) => (
                <label key={key} className="text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                  {label}
                  <input className="input-dark mt-2 w-full normal-case tracking-normal" value={String(childEditor[key as keyof ChildEditorState] ?? "")} onChange={(event) => setChildEditor({ ...childEditor, [key]: event.target.value })} />
                </label>
              ))}
              <label className="text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Status
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={childEditor.status} onChange={(event) => setChildEditor({ ...childEditor, status: event.target.value as SegmentStatus })}>
                  {CHILD_EDITABLE_STATUSES.map((status) => <option key={status} value={status}>{displayStatusLabel(status)}</option>)}
                </select>
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Child Topology Role
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={childEditor.childTopologyRole} onChange={(event) => setChildEditor({ ...childEditor, childTopologyRole: event.target.value })}>
                  <option value="">Default / inherit segment</option>
                  {CHILD_TOPOLOGY_ROLES.map((role) => <option key={role} value={role}>{topologyRoleLabel(role)}</option>)}
                </select>
                <div className="mt-1 text-[11px] normal-case tracking-normal text-slate-500 dark:text-slate-400">Priority: child override &gt; segment default &gt; MAIN_RING.</div>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="rounded-2xl border border-border bg-white/5 px-4 py-2 text-sm" onClick={() => setChildEditor(null)}>Cancel</button>
              <button className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white" onClick={saveChildLink}>
                <Save className="h-4 w-4" />
                Save child link
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {impact ? (
        <div className="modal-backdrop">
          <div className="modal-panel modal-wide">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>Cutover impact summary</div>
                <div className="subtle">Direct, downstream, service, and core-site impact for the selected resource.</div>
              </div>
              <button className="btn btn-ghost btn-compact" onClick={() => setImpact(null)}>Close</button>
            </div>
            <div className="split-form-grid mt-4 grid gap-3">
              {[
                ["Services", impact.counts.impactedServices],
                ["Links", impact.counts.impactedLinks],
                ["Sites", impact.counts.impactedSites],
                ["Core Sites", impact.counts.coreSites],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-white/5 p-3">
                  <div className="text-xs uppercase tracking-[0.14em] text-slate-400">{label}</div>
                  <div className="mt-1 text-2xl font-semibold">{value}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="badge impact-badge-red">{impact.facing}</span>
              <span className="badge impact-badge-amber">{impact.impactScope}</span>
              {impact.criticalCoreSites.map((site) => <span key={site.siteCode} className="badge impact-badge-red">{site.siteCode} {site.coreSiteType}</span>)}
            </div>
            <div className="table-shell mt-4 max-h-[360px] overflow-auto">
              <table>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Segment</th>
                    <th>Near</th>
                    <th>Far</th>
                    <th>Resource</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.exportRows.map((row, index) => (
                    <tr key={index}>
                      <td>{String(row.serviceCode ?? "-")}</td>
                      <td>{String(row.segmentCode ?? "-")}</td>
                      <td>{[row.nearSite, row.nearRack, row.nearOdf, row.nearPortGroup].filter(Boolean).join(" / ")}</td>
                      <td>{[row.farSite, row.farRack, row.farOdf, row.farPortGroup].filter(Boolean).join(" / ")}</td>
                      <td>{[row.cableLabel, row.tubeNumber ? `T${row.tubeNumber}` : null, row.tubeColor, row.fiberPortNumber ? `FP${row.fiberPortNumber}` : null, row.fiberNumber ? `F${row.fiberNumber}` : null].filter(Boolean).join(" / ") || "-"}</td>
                      <td>{String(row.status ?? "-")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmDeleteModal
        open={Boolean(pendingDeleteIds?.length)}
        title={`Schedule ${pendingDeleteIds?.length ?? 0} ODF Mapping Row(s) for Deletion`}
        message="The selected row(s) are scheduled for deletion with a 24 working-hour undo window (the countdown pauses over GCC weekends and holidays). The deletion covers the parent segment AND every child link under it. Two adjacent segments sharing one transit site will be merged by removing that site (Reverse Split) — the portal executes this automatically when the timer completes. Historical utilization data and search logs retain a cached reference. Are you sure you want to proceed?"
        onCancel={() => setPendingDeleteIds(null)}
        onConfirm={confirmDeleteSegments}
      />
      {exportPromptIds?.length ? (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-6" style={{ background: "var(--backdrop)" }} role="dialog" aria-modal="true" aria-label="Export segment configuration">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>Export segment configuration?</div>
            <p className="mt-3 text-sm leading-6">
              Would you like to export the segment configuration for future reference or manual reversal?
              The Excel report lists every dependent service with its sequential end-to-end transport chain
              (A-Z), plus the configuration and port mappings of the {exportPromptIds.length} scheduled row(s).
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setExportPromptIds(null)}>
                No, skip export
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  // Immediate configuration download for the scheduled rows.
                  window.location.href = `/api/segments/export-config?ids=${encodeURIComponent(exportPromptIds.join(","))}`;
                  setExportPromptIds(null);
                }}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Export configuration
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
