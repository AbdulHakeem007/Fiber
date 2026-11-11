"use client";

import { useEffect, useMemo, useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink, Loader2, Radar, Save, Trash2, Undo2, Wand2, X } from "lucide-react";
import { usePendingDeletions, type PendingDeletionHold } from "@/lib/hooks/use-pending-deletions";
import { useToast } from "@/components/ui/toast";
import { PAGE_SIZE_OPTIONS } from "@/lib/config/ui";
import { normalizeOdfCode, odfCodeWarning } from "@/lib/validation/odf";
import { normalizeRackCode, normalizeSiteCode } from "@/lib/telecom/connection-identity";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { displayStatusLabel } from "@/lib/utils/status";
import { SuggestionInput } from "@/components/ui/suggestion-input";
import { DraggablePanel } from "@/components/ui/draggable-panel";
import { StatusBanner, useStatusMessage } from "@/components/ui/status-message";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useRowFlash, rowFlashStyle } from "@/lib/hooks/use-row-flash";
import { UtilizationFilter, matchesUtilizationTier, type UtilizationTier } from "@/components/ui/utilization-filter";

/** Decommissioned ports are retired capacity and must not inflate the total. */
function odfDecommissionedCount(row: OdfRackRow): number {
  return Math.max(0, row.decommissionedCount ?? 0);
}

/** Live (still-usable) ports = total ports minus the decommissioned ones. */
function odfLivePortCount(row: OdfRackRow): number {
  const total = row.totalOdfPorts ?? row.maxPorts ?? 0;
  return Math.max(0, total - odfDecommissionedCount(row));
}

/**
 * Saturation = used ODF ports / live (non-decommissioned) ODF ports.
 * Decommissioned ports are excluded from the denominator so a fully retired
 * range never counts as spare capacity.
 */
function odfUtilizationPct(row: OdfRackRow): number {
  const total = odfLivePortCount(row);
  if (!total || total <= 0) return 0;
  const used = row.usedOdfPorts ?? row.usedCount ?? 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function countCsvItems(value?: string | null): number {
  return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean).length : 0;
}

function coerceNonNegativeCount(payload: { odfPortCount?: unknown; updatedPorts?: unknown }): number {
  const rawCount = payload.odfPortCount ?? payload.updatedPorts ?? 0;
  const count = Number(rawCount);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error("Server returned an invalid port count.");
  }
  return count;
}

function optionalPositiveInteger(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : NaN;
}

type DeleteDependency = {
  id: string;
  kind: string;
  label: string;
  detail?: string | null;
  href?: string | null;
};

type DeletePayload = {
  error?: unknown;
  dependencies?: unknown;
  /** 24 working-hour soft-delete hold created instead of an immediate purge. */
  pending?: unknown;
  hold?: unknown;
  message?: unknown;
};

function deleteHold(payload: DeletePayload): PendingDeletionHold | null {
  if (payload.pending !== true || !isRecord(payload.hold)) return null;
  return payload.hold as unknown as PendingDeletionHold;
}

type RowDeleteError = {
  odfId: string;
  message: string;
  dependencies: DeleteDependency[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function readDeletePayload(response: Response): Promise<DeletePayload> {
  try {
    const payload = await response.json();
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

function deleteErrorMessage(payload: DeletePayload, fallback: string): string {
  return typeof payload.error === "string" && payload.error.trim() ? payload.error : fallback;
}

function deleteDependencies(payload: DeletePayload): DeleteDependency[] {
  if (!Array.isArray(payload.dependencies)) return [];
  return payload.dependencies.flatMap((item) => {
    if (!isRecord(item)) return [];
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const id = typeof item.id === "string" && item.id.trim() ? item.id : label;
    if (!label || !id) return [];
    return [{
      id,
      kind: typeof item.kind === "string" ? item.kind : "dependency",
      label,
      detail: typeof item.detail === "string" ? item.detail : null,
      href: typeof item.href === "string" && item.href.trim() ? item.href : null,
    }];
  });
}

/**
 * Deletion guard for the strict decommission-then-delete workflow: an ODF (and
 * its segment + ports) may only be removed once every port has been explicitly
 * set to "Decommissioned". Any remaining live port blocks deletion. The server
 * enforces the same rule, so this is a UX fast-path, not the security boundary.
 */
function isOdfDeletable(row: OdfRackRow): boolean {
  return odfLivePortCount(row) === 0;
}

export interface OdfRackRow {
  odfId: string;
  siteCode: string;
  siteName?: string | null;
  rackCode: string;
  odfCode: string;
  status: string;
  maxPorts?: number | null;
  portGroupCount: number;
  usedCount: number;
  freeCount?: number;
  spareCount: number;
  dummyCount?: number;
  reservedCount: number;
  faultyCount: number;
  decommissionedCount?: number;
  splitterOutputCount?: number;
  atpLabels?: string | null;
  /** Number of distinct ATPs (access termination points) hanging off this ODF. */
  atpCount?: number;
  /** Total ATP-side ports terminated across those ATPs. */
  atpPortCount?: number;
  /** Per-ATP "label: N ports" breakdown for the hover tooltip. */
  atpBreakdown?: string | null;
  customerLabels?: string | null;
  totalOdfPorts?: number;
  usedOdfPorts?: number;
  freeOdfPorts?: number;
  mappedFarEnds?: string | null;
  remarks?: string | null;
  availableRanges?: string;
  dummyRanges?: string;
  ports?: OdfPortDetailRow[];
}

export interface OdfPortDetailRow {
  id: string;
  siteCode: string;
  siteName?: string | null;
  rackCode: string;
  odfCode: string;
  portPair: string;
  farSite?: string | null;
  farRack?: string | null;
  farOdf?: string | null;
  farPort?: string | null;
  serviceId?: string | null;
  status: string;
  remarks?: string | null;
  atpLabel?: string | null;
  /** ATP-side ports terminated by this port group's ATP outputs. */
  atpPortCount?: number;
  customerName?: string | null;
}

export function OdfRackExplorer({
  initialRows,
  canDelete = false,
  canBulkDelete = false,
  initialQuery = "",
  serverPage,
}: {
  initialRows: OdfRackRow[];
  canDelete?: boolean;
  canBulkDelete?: boolean;
  initialQuery?: string;
  serverPage?: { page: number; pageSize: number; total: number };
}) {
  const router = useRouter();
  const { flash, isFlashing } = useRowFlash();
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState(initialQuery);
  const [editing, setEditing] = useState<OdfRackRow | null>(null);
  // Edit-form port-status control: pick a port type, enter a range, apply to just
  // those ODF ports via the shared bulk-update endpoint (isolated + synced).
  const [editPort, setEditPort] = useState<{ type: string; range: string }>({ type: "AVAILABLE", range: "" });
  const [viewMode, setViewMode] = useState<"SUMMARY" | "DETAIL">("SUMMARY");
  const [utilTier, setUtilTier] = useState<UtilizationTier>("ALL");
  const [farEndModal, setFarEndModal] = useState<OdfRackRow | null>(null);
  const { status, showSuccess, showError, clear: clearStatus } = useStatusMessage();
  const toast = useToast();
  // In-flight guards for spinner + double-submit protection.
  const [isSavingOdf, setIsSavingOdf] = useState(false);
  const [isApplyingPortStatus, setIsApplyingPortStatus] = useState(false);
  const [isAddingInventory, setIsAddingInventory] = useState(false);
  const [isApplyingBulkEdit, setIsApplyingBulkEdit] = useState(false);
  // Styled confirm for single-ODF delete (replaces native window.confirm).
  const [pendingOdfDelete, setPendingOdfDelete] = useState<OdfRackRow | null>(null);
  const [isDeletingOdf, setIsDeletingOdf] = useState(false);
  const [deleteError, setDeleteError] = useState<RowDeleteError | null>(null);
  // 24 working-hour soft-delete holds: rows scheduled for deletion keep showing
  // with an "Undo Delete (Xh Ym remaining)" countdown until the hold expires.
  const deletionHolds = usePendingDeletions("ODF", canDelete || canBulkDelete);
  const [pageSize, setPageSize] = useState<number>(serverPage?.pageSize ?? PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(serverPage?.page ?? 1);
  const [selectedOdfIds, setSelectedOdfIds] = useState<Record<string, boolean>>({});
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkEdit, setBulkEdit] = useState({
    siteCode: "",
    rackCode: "",
    odfCode: "",
    ranges: "1-12",
    status: "AVAILABLE",
    tubeNumber: "",
    tubeColor: "",
    fiberPortStart: "",
    remarks: "",
  });
  const [bulkInventory, setBulkInventory] = useState({
    siteCode: "",
    siteName: "",
    rackCode: "",
    odfCode: "",
    totalPorts: "48",
    terminatedStartPort: "",
    terminatedEndPort: "",
    dummyStartPort: "",
    dummyEndPort: "",
    remarks: "",
  });

  const isServerPaged = Boolean(serverPage);

  const filteredRows = useMemo(() => {
    // Utilization tier is a client-side filter applied to the loaded rows so it
    // works in both server-paged and in-memory modes without an extra request.
    const byTier = (input: OdfRackRow[]) => utilTier === "ALL"
      ? input
      : input.filter((row) => matchesUtilizationTier(odfUtilizationPct(row), utilTier));
    if (isServerPaged) return byTier(rows);
    const needle = query.trim().toUpperCase();
    const searched = !needle ? rows : rows.filter((row) => [
      row.siteCode,
      row.siteName,
      row.rackCode,
      row.odfCode,
      row.status,
      row.remarks,
      row.atpLabels,
      row.customerLabels,
      ...(row.ports ?? []).map((port) => [port.serviceId, port.farSite, port.remarks, port.atpLabel, port.customerName].filter(Boolean).join(" ")),
    ].filter(Boolean).join(" ").toUpperCase().includes(needle));
    return byTier(searched);
  }, [query, rows, isServerPaged, utilTier]);

  // Tier counts over the loaded rows so each chip shows how many ODFs land there.
  const utilCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: rows.length };
    for (const row of rows) {
      const band = matchesUtilizationTier(odfUtilizationPct(row), "Critical") ? "Critical"
        : matchesUtilizationTier(odfUtilizationPct(row), "High") ? "High"
        : matchesUtilizationTier(odfUtilizationPct(row), "Moderate") ? "Moderate" : "Normal";
      counts[band] = (counts[band] ?? 0) + 1;
    }
    return counts as Partial<Record<UtilizationTier, number>>;
  }, [rows]);
  const pageCount = Math.max(1, Math.ceil((serverPage?.total ?? filteredRows.length) / (serverPage?.pageSize ?? pageSize)));
  const currentPage = Math.min(serverPage?.page ?? page, pageCount);
  const visibleRows = useMemo(() => {
    if (isServerPaged) return filteredRows;
    const start = (currentPage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, currentPage, pageSize, isServerPaged]);
  const selectedVisibleRows = visibleRows.filter((row) => selectedOdfIds[row.odfId]);
  const selectedOdfCount = selectedVisibleRows.length;
  const bulkOdfWarning = odfCodeWarning(bulkEdit.odfCode);

  // Re-sync local view state when the server re-renders with fresh data after a
  // search/pagination navigation (navigateServerPage -> router.push). Without
  // this, useState keeps the first render's rows and the table shows stale or
  // empty results until a full browser reload.
  useEffect(() => {
    setRows(initialRows);
    setDeleteError((current) => current && initialRows.some((row) => row.odfId === current.odfId) ? current : null);
  }, [initialRows]);
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // A hold that vanished server-side either expired (row purged) or was undone
  // in another session; drop it locally and re-sync — the server re-render
  // restores any row that still exists.
  useEffect(() => {
    if (!deletionHolds.purgedEntityIds.length) return;
    const purged = new Set(deletionHolds.purgedEntityIds);
    setRows((current) => current.filter((row) => !purged.has(row.odfId)));
    deletionHolds.acknowledgePurged();
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deletionHolds.purgedEntityIds]);

  useEffect(() => {
    setSelectedOdfIds({});
  }, [currentPage, pageSize, query, viewMode, utilTier]);

  useEffect(() => {
    setSelectedOdfIds({});
    setUtilTier("ALL");
  }, [viewMode]);

  function navigateServerPage(nextPage = 1, nextPageSize = serverPage?.pageSize ?? pageSize, nextQuery = query) {
    const params = new URLSearchParams();
    const cleanQuery = nextQuery.trim();
    if (cleanQuery) params.set("search", cleanQuery);
    params.set("page", String(Math.max(1, nextPage)));
    params.set("pageSize", String(nextPageSize));
    router.push(`/odf-racks?${params.toString()}` as Route);
  }

  async function save() {
    if (!editing || isSavingOdf) return;
    clearStatus();
    setIsSavingOdf(true);
    try {
      const response = await fetch(`/api/odfs/${editing.odfId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const payload = await response.json();
      if (!response.ok || !payload.row) throw new Error(payload.error ?? "ODF update failed.");
      const savedOdfId = editing.odfId;
      setRows((current) => current.map((row) => (row.odfId === savedOdfId ? { ...row, ...payload.row } : row)));
      setEditing(null);
      flash(savedOdfId);
      showSuccess("ODF details updated.");
      router.refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "ODF update failed.");
    } finally {
      setIsSavingOdf(false);
    }
  }

  // Apply a single, explicit port-type to the listed ODF ports only. Reuses the
  // canonical /api/odf-ports/bulk-update endpoint so the change is isolated to
  // these ports and reflects everywhere (ODF Mappings, dashboards) after reload.
  async function applyEditPortStatus() {
    if (!editing || isApplyingPortStatus) return;
    if (!editPort.range.trim()) {
      showError("Enter a port range (e.g. 1-12,15-18) to apply.");
      return;
    }
    clearStatus();
    setIsApplyingPortStatus(true);
    try {
      const response = await fetch("/api/odf-ports/bulk-update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteCode: normalizeSiteCode(editing.siteCode),
          rackCode: normalizeRackCode(editing.rackCode),
          odfCode: normalizeOdfCode(editing.odfCode),
          ranges: editPort.range,
          status: editPort.type,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Port status update failed.");
      const updatedCount = coerceNonNegativeCount(payload);
      // Highlight the affected ODF row and refresh in place — router.refresh keeps
      // the operator on their current page and scroll position (no reload jump).
      const affectedOdfId = editing.odfId;
      setEditing(null);
      flash(affectedOdfId);
      showSuccess(`Set ${updatedCount} port(s) to ${displayStatusLabel(editPort.type)}. View refreshed.`);
      router.refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Port status update failed.");
    } finally {
      setIsApplyingPortStatus(false);
    }
  }

  /** Best-effort: highlight the on-page ODF row(s) matching a site/rack/odf code
   *  triplet after a bulk port update (a fresh add may not be on this page yet). */
  function flashMatchingOdf(siteCode: string, rackCode: string, odfCode: string) {
    const site = normalizeSiteCode(siteCode);
    const rack = normalizeRackCode(rackCode);
    const odf = normalizeOdfCode(odfCode);
    const matches = rows.filter(
      (row) =>
        normalizeSiteCode(row.siteCode) === site &&
        normalizeRackCode(row.rackCode) === rack &&
        normalizeOdfCode(row.odfCode) === odf,
    );
    flash(matches.map((row) => row.odfId));
  }

  async function applyBulkInventoryAdd() {
    if (isAddingInventory) return;
    clearStatus();
    const totalPorts = optionalPositiveInteger(bulkInventory.totalPorts);
    const terminatedStartPort = optionalPositiveInteger(bulkInventory.terminatedStartPort);
    const terminatedEndPort = optionalPositiveInteger(bulkInventory.terminatedEndPort);
    const dummyStartPort = optionalPositiveInteger(bulkInventory.dummyStartPort);
    const dummyEndPort = optionalPositiveInteger(bulkInventory.dummyEndPort);

    if (
      Number.isNaN(totalPorts) ||
      Number.isNaN(terminatedStartPort) ||
      Number.isNaN(terminatedEndPort) ||
      Number.isNaN(dummyStartPort) ||
      Number.isNaN(dummyEndPort)
    ) {
      showError("Port values must be positive whole numbers.");
      return;
    }
    if (!totalPorts) {
      showError("Total ODF ports must be a positive whole number.");
      return;
    }
    const validateRange = (label: string, start: number | null, end: number | null): string | null => {
      if (start === null && end === null) return null;
      const first = start ?? end;
      const last = end ?? start;
      if (!first || !last) return `${label} start and end ports are required together.`;
      if (first > last) return `${label} start port must be <= end port.`;
      if (last > totalPorts) return `${label} end port (${last}) exceeds total ports (${totalPorts}).`;
      return null;
    };
    const rangeError =
      validateRange("Terminated", terminatedStartPort, terminatedEndPort) ??
      validateRange("Dummy", dummyStartPort, dummyEndPort);
    if (rangeError) {
      showError(rangeError);
      return;
    }

    setIsAddingInventory(true);
    try {
      const response = await fetch("/api/odf-ports/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteCode: bulkInventory.siteCode,
          siteName: bulkInventory.siteName,
          rackCode: bulkInventory.rackCode,
          odfCode: bulkInventory.odfCode,
          totalPorts: bulkInventory.totalPorts,
          terminatedStartPort: bulkInventory.terminatedStartPort,
          terminatedEndPort: bulkInventory.terminatedEndPort,
          dummyStartPort: bulkInventory.dummyStartPort,
          dummyEndPort: bulkInventory.dummyEndPort,
          remarks: bulkInventory.remarks,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Bulk ODF inventory add failed.");
      flashMatchingOdf(bulkInventory.siteCode, bulkInventory.rackCode, bulkInventory.odfCode);
      showSuccess(payload.message ?? "Bulk ODF inventory configured. View refreshed.");
      router.refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Bulk ODF inventory add failed.");
    } finally {
      setIsAddingInventory(false);
    }
  }

  async function applyBulkEdit() {
    if (isApplyingBulkEdit) return;
    clearStatus();
    setIsApplyingBulkEdit(true);
    try {
      const response = await fetch("/api/odf-ports/bulk-update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteCode: normalizeSiteCode(bulkEdit.siteCode),
          rackCode: normalizeRackCode(bulkEdit.rackCode),
          odfCode: normalizeOdfCode(bulkEdit.odfCode),
          ranges: bulkEdit.ranges,
          status: bulkEdit.status,
          remarks: bulkEdit.remarks,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "ODF port range update failed.");
      const updatedCount = coerceNonNegativeCount(payload);
      flashMatchingOdf(bulkEdit.siteCode, bulkEdit.rackCode, bulkEdit.odfCode);
      showSuccess(`Updated ${updatedCount} physical ODF port(s). View refreshed.`);
      router.refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "ODF port range update failed.");
    } finally {
      setIsApplyingBulkEdit(false);
    }
  }

  function requestDeleteOdf(row: OdfRackRow) {
    if (!canDelete) return;
    // The server owns the final decommission-then-delete check. Do not block
    // here from the local row snapshot because it can be briefly stale after a
    // port status update while router.refresh() is still settling.
    setDeleteError(null);
    setPendingOdfDelete(row);
  }

  async function confirmDeleteOdf() {
    const row = pendingOdfDelete;
    if (!canDelete || !row) return;
    clearStatus();
    setIsDeletingOdf(true);
    try {
      const response = await fetch(`/api/odfs/${row.odfId}`, { method: "DELETE" });
      const payload = await readDeletePayload(response);
      if (!response.ok) {
        setPendingOdfDelete(null);
        setDeleteError({
          odfId: row.odfId,
          message: deleteErrorMessage(payload, "ODF delete failed."),
          dependencies: deleteDependencies(payload),
        });
        return;
      }
      const odfLabel = `ODF ${displaySiteLabel(row.siteName ?? row.siteCode)}/${row.rackCode}/${row.odfCode}`;
      const hold = deleteHold(payload);
      if (hold) {
        // Soft-delete hold: the row stays visible with an Undo countdown until
        // the 24 working-hour window (GCC calendar) elapses.
        deletionHolds.applyHolds(hold);
        setDeleteError(null);
        showSuccess(typeof payload.message === "string" && payload.message
          ? payload.message
          : `${odfLabel} scheduled for deletion. Undo is available for 24 working hours.`);
        toast.deleted(odfLabel, {
          markedForDeletion: true,
          title: "Scheduled for deletion (24 working-hour undo window)",
          action: {
            label: "Undo",
            onClick: async () => {
              const result = await deletionHolds.undo(row.odfId);
              if (result.ok) showSuccess(result.message);
              else showError(result.message);
            },
          },
        });
        setPendingOdfDelete(null);
        return;
      }
      setRows((current) => current.filter((item) => item.odfId !== row.odfId));
      setDeleteError(null);
      showSuccess(`Deleted ${odfLabel}.`);
      toast.deleted(odfLabel);
      setPendingOdfDelete(null);
      router.refresh();
    } catch (error) {
      setPendingOdfDelete(null);
      setDeleteError({
        odfId: row.odfId,
        message: error instanceof Error ? error.message : "ODF delete failed.",
        dependencies: [],
      });
    } finally {
      setIsDeletingOdf(false);
    }
  }

  async function deleteSelectedOdfs() {
    if (!canBulkDelete || !selectedOdfCount) return;
    // Let the DELETE API validate each row against current database state; the
    // selected row snapshot may lag behind a successful decommission refresh.
    const rowsToDelete = [...selectedVisibleRows];
    const errors: Array<{ odfId: string; odfCode: string; error: string; dependencies: DeleteDependency[] }> = [];
    const deletedIds = new Set<string>();
    const scheduledHolds: PendingDeletionHold[] = [];
    setDeleteError(null);
    clearStatus();

    for (const row of rowsToDelete) {
      try {
        const response = await fetch(`/api/odfs/${row.odfId}`, { method: "DELETE" });
        const payload = await readDeletePayload(response);
        if (!response.ok) {
          errors.push({
            odfId: row.odfId,
            odfCode: row.odfCode,
            error: deleteErrorMessage(payload, `ODF delete failed for ${row.odfCode}.`),
            dependencies: deleteDependencies(payload),
          });
          continue;
        }
        const hold = deleteHold(payload);
        if (hold) scheduledHolds.push(hold);
        else deletedIds.add(row.odfId);
      } catch (error) {
        errors.push({ odfId: row.odfId, odfCode: row.odfCode, error: error instanceof Error ? error.message : String(error), dependencies: [] });
      }
    }

    if (scheduledHolds.length) deletionHolds.applyHolds(scheduledHolds);
    setRows((current) => current.filter((row) => !deletedIds.has(row.odfId)));
    setSelectedOdfIds((current) => {
      const next = { ...current };
      for (const id of deletedIds) delete next[id];
      for (const hold of scheduledHolds) delete next[hold.entityId];
      return next;
    });
    setConfirmBulkDelete(false);

    if (errors.length) {
      const first = errors[0];
      setDeleteError({
        odfId: first.odfId,
        message: errors.length === 1
          ? first.error
          : `${errors.length} deletion(s) failed. First blocked row: ${first.odfCode}. ${first.error}`,
        dependencies: first.dependencies,
      });
      if (scheduledHolds.length) {
        showSuccess(`${scheduledHolds.length} row(s) scheduled for deletion (24 working-hour undo window). Review the highlighted row for ${errors.length} blocked deletion(s).`);
        toast.deleted(`${scheduledHolds.length} ODF row${scheduledHolds.length === 1 ? "" : "s"}`, { markedForDeletion: true, title: "Scheduled for deletion (24 working-hour undo window)" });
      }
      return;
    }
    showSuccess(`${scheduledHolds.length} row(s) scheduled for deletion. Undo is available for 24 working hours on each row.`);
    if (scheduledHolds.length) toast.deleted(`${scheduledHolds.length} ODF row${scheduledHolds.length === 1 ? "" : "s"}`, { markedForDeletion: true, title: "Scheduled for deletion (24 working-hour undo window)" });
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="section-title">ODF and Racks Inventory</div>
            <div className="subtle mt-1">Inspect rack/ODF port inventory, mapped far-end directions, dummy ports, reserved ports, faulty ports, and splitter output markers.</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[280px]">
              <SuggestionInput
                kind="sites"
                className="input-dark"
                value={query}
                onChange={(nextValue, suggestion) => {
                  setQuery(nextValue);
                  setPage(1);
                  // Picking a site from the predictive list runs the search right
                  // away (server-paged view only re-queries on navigate/Enter).
                  if (suggestion && isServerPaged) navigateServerPage(1, undefined, nextValue);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isServerPaged) navigateServerPage(1);
                }}
                placeholder="Search site, rack, ODF"
              />
            </div>
            {isServerPaged ? (
              <button className="btn btn-ghost" onClick={() => navigateServerPage(1)}>
                Search
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-3">
          <UtilizationFilter value={utilTier} onChange={setUtilTier} counts={utilCounts} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="subtle">Showing {visibleRows.length} of {serverPage?.total ?? filteredRows.length} matching ODFs{utilTier !== "ALL" ? ` · ${utilTier} utilization` : ""}.</div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <button className={`rounded-lg border px-3 py-2 ${viewMode === "SUMMARY" ? "border-red-500 bg-red-50 text-red-800 dark:bg-red-500/20 dark:text-red-100" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`} onClick={() => setViewMode("SUMMARY")}>Summary</button>
            <button className={`rounded-lg border px-3 py-2 ${viewMode === "DETAIL" ? "border-red-500 bg-red-50 text-red-800 dark:bg-red-500/20 dark:text-red-100" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`} onClick={() => setViewMode("DETAIL")}>Detailed ports</button>
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
        <StatusBanner status={status} onDismiss={clearStatus} className="mt-3" />
        {canBulkDelete && viewMode === "SUMMARY" && selectedOdfCount > 0 ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
            <span>{selectedOdfCount} row(s) selected</span>
            <button className="btn btn-danger-soft" onClick={() => setConfirmBulkDelete(true)}>
              <Trash2 className="h-4 w-4" />
              Delete Selected
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-6">
        <div className="card p-5">
          <div className="section-title">Range-based ODF port edit</div>
          <div className="subtle mt-1">Apply status and remarks to physical ODF port ranges such as 1-12 or 1-2,3-4,5-6. This updates ODF ports, not cable fiber capacity.</div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <SuggestionInput kind="sites" className="input-dark" value={bulkEdit.siteCode} onChange={(nextValue) => setBulkEdit({ ...bulkEdit, siteCode: nextValue })} placeholder="Site ID" />
            {[
              ["rackCode", "Rack"],
              ["odfCode", "ODF"],
              ["ranges", "ODF port range"],
              ["remarks", "Remarks"],
            ].map(([key, label]) => (
              <input key={key} className="input-dark" value={String(bulkEdit[key as keyof typeof bulkEdit])} onChange={(event) => setBulkEdit({ ...bulkEdit, [key]: event.target.value })} placeholder={label} />
            ))}
            <select className="input-dark" value={bulkEdit.status} onChange={(event) => setBulkEdit({ ...bulkEdit, status: event.target.value })}>
              {/* ODF port states operators can assign to a range. */}
              <option value="AVAILABLE">Available</option>
              <option value="ACTIVE">Active</option>
              <option value="FAULTY">Faulty</option>
              <option value="RESERVED">Reserved</option>
              <option value="DUMMY">Dummy</option>
              <option value="DECOMMISSIONED">Decommissioned</option>
            </select>
            <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" onClick={applyBulkEdit} disabled={isApplyingBulkEdit}>
              {isApplyingBulkEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {isApplyingBulkEdit ? "Applying…" : "Apply"}
            </button>
          </div>
          {bulkOdfWarning ? <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{bulkOdfWarning}</div> : null}
        </div>

        <div className="card p-5">
          <div className="section-title">Bulk ODF inventory add</div>
          <div className="subtle mt-1">Create or update physical ODF inventory for a new or existing site. Newly generated ports are parked as Available by default; dummy ranges are marked Dummy. Use ODF Mappings to mark traffic-carrying links as Active.</div>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            {/* EDIT HERE: Site Code has been removed from the ODF form. Use Site ID autocomplete instead. */}
            <SuggestionInput
              kind="sites"
              className="input-dark"
              value={bulkInventory.siteCode}
              onChange={(nextValue) => setBulkInventory({ ...bulkInventory, siteCode: nextValue, siteName: bulkInventory.siteName || nextValue })}
              placeholder="Site ID"
            />
            {[
              ["siteName", "Customer / Site name"],
              ["rackCode", "Rack ID"],
              ["odfCode", "ODF ID"],
              ["totalPorts", "Total ODF ports"],
              ["terminatedStartPort", "Fiber terminated start port"],
              ["terminatedEndPort", "Fiber terminated end port"],
              ["dummyStartPort", "Dummy start port"],
              ["dummyEndPort", "Dummy end port"],
            ].map(([key, label]) => (
              <input
                key={key}
                className="input-dark"
                value={String(bulkInventory[key as keyof typeof bulkInventory])}
                onChange={(event) => setBulkInventory({ ...bulkInventory, [key]: event.target.value })}
                placeholder={label}
              />
            ))}
            <input className="input-dark md:col-span-3" value={bulkInventory.remarks} onChange={(event) => setBulkInventory({ ...bulkInventory, remarks: event.target.value })} placeholder="Remarks" />
            <button className="btn btn-primary" onClick={applyBulkInventoryAdd} disabled={isAddingInventory}>
              {isAddingInventory ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isAddingInventory ? "Saving…" : "Add / Update ODF"}
            </button>
          </div>
        </div>
      </div>

      {viewMode === "SUMMARY" ? (
      <div className="table-shell odf-rack-table-shell">
        <table className="min-w-[1320px]">
          <thead>
            <tr>
              {canBulkDelete ? (
                <th>
                  <input
                    type="checkbox"
                    checked={visibleRows.length > 0 && visibleRows.every((row) => selectedOdfIds[row.odfId])}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelectedOdfIds((current) => {
                        const next = { ...current };
                        for (const row of visibleRows) next[row.odfId] = checked;
                        return next;
                      });
                    }}
                    aria-label="Select all ODF/rack rows on current page"
                  />
                </th>
              ) : null}
              <th>Site</th>
              <th>Rack</th>
              <th>ODF</th>
              <th>Status</th>
              <th>Saturation</th>
              <th>Total Ports</th>
              <th>Port Status</th>
              <th>Splitter Out</th>
              <th className="w-32 text-center">ATPs / ATP Ports</th>
              <th className="sticky-action">Actions</th>
            </tr>
          </thead>
          <tbody>
              {visibleRows.map((row) => (
              <tr key={row.odfId} style={rowFlashStyle(isFlashing(row.odfId))}>
                {canBulkDelete ? (
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedOdfIds[row.odfId])}
                      onChange={(event) => setSelectedOdfIds((current) => ({ ...current, [row.odfId]: event.target.checked }))}
                      aria-label={`Select ODF ${row.odfCode}`}
                    />
                  </td>
                ) : null}
                <td>{displaySiteLabel(row.siteName ?? row.siteCode)}</td>
                <td>{row.rackCode}</td>
                <td>{row.odfCode}</td>
                <td>{displayStatusLabel(row.status)}</td>
                <td>
                  {(() => {
                    const pct = odfUtilizationPct(row);
                    const band = matchesUtilizationTier(pct, "Critical") ? "critical"
                      : matchesUtilizationTier(pct, "High") ? "high"
                      : matchesUtilizationTier(pct, "Moderate") ? "moderate" : "normal";
                    return (
                      <div className="util-cell">
                        <span className={`util-cell-bar util-cell-${band}`}><span style={{ width: `${pct}%` }} /></span>
                        <span className="util-cell-pct">{pct}%</span>
                      </div>
                    );
                  })()}
                </td>
                <td>{row.totalOdfPorts ?? row.maxPorts ?? "-"}</td>
                <td>
                  {(() => {
                    // Port Status-wise Port Count: one labelled badge per status
                    // that actually has ports. Replaces the old per-status
                    // columns and the removed "Port Groups / Pairs" metric.
                    const entries: Array<[string, number, string]> = ([
                      ["Active", row.usedOdfPorts ?? row.usedCount ?? 0, "badge-active"],
                      ["Available", row.freeOdfPorts ?? row.freeCount ?? 0, "badge-available"],
                      ["Reserved", row.reservedCount ?? 0, "badge-reserved"],
                      ["Faulty", row.faultyCount ?? 0, "badge-faulty"],
                      ["Dummy", row.dummyCount ?? 0, "badge-spare"],
                      ["Decommissioned", row.decommissionedCount ?? 0, "badge-decommissioned"],
                    ] as Array<[string, number, string]>).filter(([, count]) => count > 0);
                    if (!entries.length) return <span className="subtle">No ports</span>;
                    return (
                      <div className="flex flex-wrap gap-1">
                        {entries.map(([label, count, cls]) => (
                          <span key={label} className={`badge ${cls}`} title={`${label} ports`}>{label} {count}</span>
                        ))}
                      </div>
                    );
                  })()}
                </td>
                <td>{row.splitterOutputCount ?? 0}</td>
                <td className="text-center">
                  {(() => {
                    // ATP visibility upgrade: show BOTH the number of ATPs and
                    // the number of ports terminated on them (was: ATP count
                    // only). Falls back to the legacy label-count when the
                    // server has not supplied the new aggregate fields.
                    const atpCount = row.atpCount
                      ?? countCsvItems(row.atpLabels || row.customerLabels);
                    const atpPortCount = row.atpPortCount ?? countCsvItems(row.atpLabels);
                    if (!atpCount) return <span className="badge bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-200">0</span>;
                    return (
                      <span
                        className="badge bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-200"
                        title={row.atpBreakdown ?? undefined}
                      >
                        {atpCount} ATP{atpCount === 1 ? "" : "s"} · {atpPortCount} port{atpPortCount === 1 ? "" : "s"}
                      </span>
                    );
                  })()}
                </td>
                <td className={`sticky-action ${deleteError?.odfId === row.odfId ? "odf-delete-error-anchor" : ""}`}>
                  <div className="odf-row-actions">
                    <button className="btn btn-ghost btn-compact" onClick={() => { setEditing(row); setEditPort({ type: "AVAILABLE", range: "" }); }}>Edit</button>
                    <button
                      className="btn btn-danger-soft btn-compact"
                      onClick={() => {
                        const params = new URLSearchParams({ context: "odf", site: row.siteCode, rackId: row.rackCode, odfId: row.odfCode });
                        window.location.href = `/impact?${params.toString()}`;
                      }}
                    >
                      <Radar className="h-3 w-3" />
                      Impact
                    </button>
                    {canDelete ? (() => {
                      // Scheduled-for-deletion rows swap the Delete action for a
                      // live Undo countdown (24 working hours on the GCC
                      // calendar; weekends/holidays pause the timer).
                      const remaining = deletionHolds.remainingFor(row.odfId);
                      if (remaining) {
                        return (
                          <button
                            className="btn btn-compact border border-amber-400/40 bg-amber-500/10 font-semibold text-amber-800 dark:text-amber-200"
                            onClick={async () => {
                              const result = await deletionHolds.undo(row.odfId);
                              if (result.ok) showSuccess(result.message);
                              else showError(result.message);
                            }}
                            title="This ODF is scheduled for deletion. Click to undo while the reversal window is open. The countdown pauses over GCC weekends and holidays."
                          >
                            <Undo2 className="h-3 w-3" />
                            Undo Delete ({remaining.label} remaining)
                          </button>
                        );
                      }
                      return (
                        <button
                          className="btn btn-danger-soft btn-compact"
                          onClick={() => requestDeleteOdf(row)}
                          title={isOdfDeletable(row)
                            ? "Delete this ODF and its (decommissioned) ports"
                            : `Server will verify before deleting. Last loaded state shows ${odfLivePortCount(row)} live port(s).`}
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
                      );
                    })() : null}
                    {deleteError?.odfId === row.odfId ? (
                      <div className="odf-delete-popover" role="alert" aria-live="polite">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-red-600 dark:text-red-300" aria-hidden />
                            <div className="min-w-0">
                              <div className="font-semibold text-red-900 dark:text-red-100">Deletion blocked</div>
                              <p className="mt-1 text-xs leading-5 text-red-800 dark:text-red-100">{deleteError.message}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="odf-delete-popover-close"
                            onClick={() => setDeleteError(null)}
                            aria-label="Dismiss delete warning"
                          >
                            <X className="h-4 w-4" aria-hidden />
                          </button>
                        </div>
                        {deleteError.dependencies.length ? (
                          <div className="mt-3">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-red-700 dark:text-red-200">Blocking dependencies</div>
                            <ul className="mt-2 space-y-2">
                              {deleteError.dependencies.map((dependency) => (
                                <li key={`${dependency.kind}-${dependency.id}`} className="rounded-md border border-red-200 bg-white/70 p-2 text-xs dark:border-red-400/30 dark:bg-slate-950/40">
                                  {dependency.href ? (
                                    <a className="inline-flex max-w-full items-center gap-1 font-semibold text-red-800 underline-offset-2 hover:underline dark:text-red-100" href={dependency.href}>
                                      <span className="truncate">{dependency.label}</span>
                                      <ExternalLink className="h-3 w-3 flex-none" aria-hidden />
                                    </a>
                                  ) : (
                                    <span className="font-semibold text-red-800 dark:text-red-100">{dependency.label}</span>
                                  )}
                                  {dependency.detail ? <div className="mt-1 break-words text-red-700 dark:text-red-200">{dependency.detail}</div> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p className="mt-3 text-xs leading-5 text-red-800 dark:text-red-100">
                            No linked blocker details were returned. Refresh the row and retry after retiring this ODF's mappings.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : (
      <div className="table-shell odf-rack-table-shell">
        <table className="min-w-[1320px]">
          <thead>
            <tr>
              <th>Site</th>
              <th>Rack</th>
              <th>ODF</th>
              <th>ODF Port / Pair</th>
              <th>Far-end Site</th>
              <th>Far Rack</th>
              <th>Far ODF</th>
              <th>Far ODF Port / Pair</th>
              <th>Service ID</th>
              <th>Status</th>
              <th className="w-32 text-center">ATPs / ATP Ports</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.flatMap((row) => row.ports ?? []).map((port) => (
              <tr key={port.id}>
                <td>{displaySiteLabel(port.siteName ?? port.siteCode)}</td>
                <td>{port.rackCode}</td>
                <td>{port.odfCode}</td>
                <td>{port.portPair}</td>
                <td>{displaySiteLabel(port.farSite)}</td>
                <td>{port.farRack ?? "-"}</td>
                <td>{port.farOdf ?? "-"}</td>
                <td>{port.farPort ?? "-"}</td>
                <td>{port.serviceId ?? "-"}</td>
                <td>{displayStatusLabel(port.status)}</td>
                <td className="text-center">
                  {(() => {
                    // Per-port view: name the ATP(s) this port group feeds and
                    // how many ATP-side ports they terminate (was: bare 1/0).
                    const label = port.atpLabel || port.customerName;
                    if (!label) return <span className="badge bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-200">0</span>;
                    const atpCount = countCsvItems(label);
                    const atpPortCount = port.atpPortCount ?? countCsvItems(label);
                    return (
                      <span className="badge bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-200" title={String(label)}>
                        {atpCount} ATP{atpCount === 1 ? "" : "s"} · {atpPortCount} port{atpPortCount === 1 ? "" : "s"}
                      </span>
                    );
                  })()}
                </td>
                <td>{port.remarks ?? "-"}</td>
              </tr>
            ))}
            {!visibleRows.flatMap((row) => row.ports ?? []).length ? <tr><td colSpan={12}>No port detail rows found.</td></tr> : null}
          </tbody>
        </table>
      </div>
      )}
      <div className="flex items-center justify-end gap-2 text-sm text-slate-600 dark:text-slate-300">
        <button className="btn btn-ghost" disabled={currentPage <= 1} onClick={() => {
          const nextPage = Math.max(1, currentPage - 1);
          if (isServerPaged) navigateServerPage(nextPage);
          else setPage(nextPage);
        }}>Prev</button>
        <span>Page {currentPage} of {pageCount}</span>
        <button className="btn btn-ghost" disabled={currentPage >= pageCount} onClick={() => {
          const nextPage = Math.min(pageCount, currentPage + 1);
          if (isServerPaged) navigateServerPage(nextPage);
          else setPage(nextPage);
        }}>Next</button>
      </div>

      {editing ? (
        <DraggablePanel
          className="modal-small"
          title={`Edit ${displaySiteLabel(editing.siteName ?? editing.siteCode)} / ${editing.rackCode} / ${editing.odfCode}`}
          onClose={() => setEditing(null)}
        >
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Site ID
                <SuggestionInput kind="sites" className="input-dark mt-2 w-full normal-case tracking-normal" value={editing.siteCode} onChange={(nextValue) => setEditing({ ...editing, siteCode: nextValue })} />
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Rack
                <input className="input-dark mt-2 w-full normal-case tracking-normal" value={editing.rackCode} onChange={(event) => setEditing({ ...editing, rackCode: event.target.value })} />
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                ODF
                <input className="input-dark mt-2 w-full normal-case tracking-normal" value={editing.odfCode} onChange={(event) => setEditing({ ...editing, odfCode: event.target.value })} />
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Status
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value })}>
                  <option value="ACTIVE">Active</option>
                  <option value="PLANNED">Planned</option>
                  <option value="INACTIVE">Inactive</option>
                  <option value="DECOMMISSIONED">Decommissioned</option>
                </select>
                {editing.status === "INACTIVE" ? (
                  <div className="mt-1 text-[11px] normal-case tracking-normal text-amber-700 dark:text-amber-200">
                    Inactive ports/ODFs are not usable until outside-plant (OSP) work is completed and the status is explicitly changed back.
                  </div>
                ) : null}
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Max Ports
                <input className="input-dark mt-2 w-full normal-case tracking-normal" value={editing.maxPorts ?? ""} onChange={(event) => setEditing({ ...editing, maxPorts: event.target.value ? Number(event.target.value) : null })} />
              </label>
              <div className="md:col-span-2">
                <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Set port status</div>
                <div className="mt-2 grid gap-3 md:grid-cols-[1fr_1.6fr_auto]">
                  <select
                    className="input-dark normal-case tracking-normal"
                    aria-label="Port type"
                    value={editPort.type}
                    onChange={(event) => setEditPort({ ...editPort, type: event.target.value })}
                  >
                    <option value="AVAILABLE">Available</option>
                    <option value="FAULTY">Faulty</option>
                    <option value="DUMMY">Dummy</option>
                    <option value="RESERVED">Reserved</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="DECOMMISSIONED">Decommissioned</option>
                  </select>
                  <input
                    className="input-dark normal-case tracking-normal"
                    value={editPort.range}
                    onChange={(event) => setEditPort({ ...editPort, range: event.target.value })}
                    placeholder="Port range e.g. 1-12,15-18"
                  />
                  <button type="button" className="btn btn-ghost" onClick={applyEditPortStatus} disabled={isApplyingPortStatus}>
                    {isApplyingPortStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    {isApplyingPortStatus ? "Applying…" : "Apply"}
                  </button>
                </div>
                <div className="subtle mt-1 normal-case tracking-normal">Sets only the listed ODF ports to the selected type. The change syncs to ODF Mappings and dashboards.</div>
              </div>
              <label className="md:col-span-2 text-xs uppercase tracking-[0.14em] text-slate-400">
                Remarks
                <input className="input-dark mt-2 w-full normal-case tracking-normal" value={editing.remarks ?? ""} onChange={(event) => setEditing({ ...editing, remarks: event.target.value })} />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={isSavingOdf}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={isSavingOdf}>
                {isSavingOdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSavingOdf ? "Saving…" : "Save ODF"}
              </button>
            </div>
        </DraggablePanel>
      ) : null}

      {farEndModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6">
          <div className="w-full max-w-5xl rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-950 dark:text-white">Far ends for {displaySiteLabel(farEndModal.siteName ?? farEndModal.siteCode)} / {farEndModal.rackCode} / {farEndModal.odfCode}</div>
                <div className="subtle mt-1">All mapped far-end directions linked with this ODF.</div>
              </div>
              <button className="btn btn-ghost" onClick={() => setFarEndModal(null)}>Close</button>
            </div>
            <div className="table-shell mt-4 max-h-[520px] overflow-auto">
              <table className="min-w-[1100px]">
                <thead>
                  <tr>
                    <th>Local Port</th>
                    <th>Far Site</th>
                    <th>Far Rack</th>
                    <th>Far ODF</th>
                    <th>Far Port</th>
                    <th>Service</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(farEndModal.ports ?? []).filter((port) => port.farSite || port.farRack || port.farOdf || port.farPort).map((port) => (
                    <tr key={port.id}>
                      <td>{port.portPair}</td>
                      <td>{displaySiteLabel(port.farSite)}</td>
                      <td>{port.farRack ?? "-"}</td>
                      <td>{port.farOdf ?? "-"}</td>
                      <td>{port.farPort ?? "-"}</td>
                      <td>{port.serviceId ?? "-"}</td>
                      <td>{displayStatusLabel(port.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
      {confirmBulkDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6">
          <div className="w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="text-lg font-semibold">Schedule {selectedOdfCount} selected row(s) for deletion?</div>
            <p className="subtle mt-2">Each row gets a 24 working-hour undo window (GCC calendar) before it is permanently removed.</p>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
              <button className="btn btn-danger-soft" onClick={deleteSelectedOdfs}>Delete</button>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={Boolean(pendingOdfDelete)}
        title={pendingOdfDelete ? `Delete ODF ${displaySiteLabel(pendingOdfDelete.siteName ?? pendingOdfDelete.siteCode)}/${pendingOdfDelete.rackCode}/${pendingOdfDelete.odfCode}?` : "Delete ODF?"}
        message="The ODF is scheduled for deletion with a 24 working-hour undo window (the countdown pauses over GCC weekends and holidays). After the window expires, its ports, mappings, and related route hop references are permanently removed."
        confirmLabel="Schedule Delete"
        busy={isDeletingOdf}
        onConfirm={confirmDeleteOdf}
        onCancel={() => setPendingOdfDelete(null)}
      />
    </div>
  );
}
