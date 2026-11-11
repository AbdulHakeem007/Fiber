"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { CheckSquare, ChevronDown, ChevronLeft, ChevronRight, Download, Loader2, Pencil, Plus, Save, Trash2, Upload, X } from "lucide-react";
import type { SplitterInventoryRow, SplitterListFilters, SplitterOutputRow, SplitterSummary } from "@/types/splitters";
import { BULK_OPERATIONAL_STATUSES, PAGE_SIZE_OPTIONS } from "@/lib/config/ui";
import { UtilizationFilter, matchesUtilizationTier, type UtilizationTier } from "@/components/ui/utilization-filter";
import { useRowFlash, rowFlashStyle } from "@/lib/hooks/use-row-flash";
import { useToast } from "@/components/ui/toast";

type SplitterForm = {
  id?: string;
  splitterCode: string;
  splitterName: string;
  splitterType: string;
  scope: string;
  location: string;
  locationContext: string;
  protectionMode: string;
  primaryInputSiteCode: string;
  primaryInputRackCode: string;
  primaryInputOdfCode: string;
  primaryInputPortLabel: string;
  secondaryInputSiteCode: string;
  secondaryInputRackCode: string;
  secondaryInputOdfCode: string;
  secondaryInputPortLabel: string;
  outputPortCapacity: string;
  configuredOutputPorts: string;
  status: string;
  remarks: string;
};

type OutputForm = {
  id?: string;
  splitterId?: string;
  outputLabel: string;
  outputPort: string;
  localSiteCode: string;
  localRackCode: string;
  localOdfCode: string;
  localPortLabel: string;
  destinationSiteCode: string;
  destinationLabel: string;
  destinationRackCode: string;
  destinationOdfCode: string;
  destinationPortLabel: string;
  serviceCode: string;
  sharingCustomerServiceId: string;
  capacityFibers: string;
  status: string;
  remarks: string;
};

const emptySplitterForm: SplitterForm = {
  splitterCode: "",
  splitterName: "",
  splitterType: "OSP_SPL",
  scope: "OSP",
  location: "",
  locationContext: "",
  protectionMode: "UNKNOWN",
  primaryInputSiteCode: "",
  primaryInputRackCode: "",
  primaryInputOdfCode: "",
  primaryInputPortLabel: "",
  secondaryInputSiteCode: "",
  secondaryInputRackCode: "",
  secondaryInputOdfCode: "",
  secondaryInputPortLabel: "",
  outputPortCapacity: "32",
  configuredOutputPorts: "0",
  status: "ACTIVE",
  remarks: "",
};

const emptyOutputForm: OutputForm = {
  outputLabel: "",
  outputPort: "",
  localSiteCode: "",
  localRackCode: "",
  localOdfCode: "",
  localPortLabel: "",
  destinationSiteCode: "",
  destinationLabel: "",
  destinationRackCode: "",
  destinationOdfCode: "",
  destinationPortLabel: "",
  serviceCode: "",
  sharingCustomerServiceId: "",
  capacityFibers: "1",
  status: "AVAILABLE",
  remarks: "",
};

const INITIAL_OUTPUT_ROW_LIMIT = 64;

function protectionDisplay(mode?: string | null): string {
  const normalized = String(mode ?? "UNKNOWN").toUpperCase();
  if (normalized === "PROTECTED") return "Protected";
  if (normalized === "UNPROTECTED" || normalized === "NON_PROTECTED") return "Non Protected";
  return "Unknown";
}

function isProtected(mode?: string | null): boolean {
  return String(mode ?? "").toUpperCase() === "PROTECTED";
}

function isOsp(row: SplitterInventoryRow): boolean {
  return (row.splitterType ?? `${row.scope}_SPL`) !== "ISP_SPL";
}

function formatOutgoingPort(output: SplitterOutputRow): string {
  // The "Output Port" text label lives in the table header; line items show the bare port value.
  const raw = output.outputPort ?? output.outputLabel ?? "-";
  return raw.replace(/^\s*(output\s*)?(port\s*)?/i, "").trim() || raw;
}

function statusBadgeClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "ACTIVE" || normalized === "AVAILABLE") return "badge badge-active";
  if (normalized === "RESERVED" || normalized === "MAINTENANCE") return "badge badge-reserved";
  if (normalized === "FAULTY") return "badge badge-faulty";
  if (normalized === "PLANNED") return "badge badge-planned";
  return "badge badge-spare";
}

function FeedField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-0.5 break-words font-medium text-slate-900 dark:text-slate-100">{value?.trim() || "-"}</div>
    </div>
  );
}

export function SplitterInventory({
  rows,
  summary,
  serverPage,
  initialFilters = {},
  canWrite = false,
  canDelete = false,
  canBulkDelete = false,
}: {
  rows: SplitterInventoryRow[];
  summary?: SplitterSummary;
  serverPage?: { page: number; pageSize: number; total: number };
  initialFilters?: SplitterListFilters;
  canWrite?: boolean;
  canDelete?: boolean;
  canBulkDelete?: boolean;
}) {
  const router = useRouter();
  const { flash, isFlashing } = useRowFlash();
  const [localRows, setLocalRows] = useState(rows);
  const [query, setQuery] = useState(initialFilters.search ?? "");
  const [typeFilter, setTypeFilter] = useState(initialFilters.splitterType ?? "ALL");
  const [statusFilter, setStatusFilter] = useState(initialFilters.status ?? "ALL");
  const [utilTier, setUtilTier] = useState<UtilizationTier>("ALL");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [outputsBySplitter, setOutputsBySplitter] = useState<Record<string, SplitterOutputRow[]>>({});
  const [outputsLoading, setOutputsLoading] = useState<Record<string, boolean>>({});
  const [outputLimits, setOutputLimits] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkStatus, setBulkStatus] = useState<string>("ACTIVE");
  const [isBulkWorking, setIsBulkWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  const [importFile, setImportFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [splitterForm, setSplitterForm] = useState<SplitterForm | null>(null);
  const [outputForm, setOutputForm] = useState<OutputForm | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocalRows(rows);
    setQuery(initialFilters.search ?? "");
    setTypeFilter(initialFilters.splitterType ?? "ALL");
    setStatusFilter(initialFilters.status ?? "ALL");
    setSelected({});
    setExpanded({});
    setOutputsBySplitter({});
    setOutputLimits({});
  }, [rows, initialFilters.search, initialFilters.splitterType, initialFilters.status]);

  const total = serverPage?.total ?? localRows.length;
  const page = serverPage?.page ?? 1;
  const pageSize = serverPage?.pageSize ?? PAGE_SIZE_OPTIONS[0];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const selectedIds = useMemo(() => Object.entries(selected).filter(([, checked]) => checked).map(([id]) => id), [selected]);

  // Utilization tier filter — configured ports / hardware capacity per splitter.
  // Applied client-side to the loaded page so it pairs with the server filters.
  const displayRows = useMemo(
    () => utilTier === "ALL"
      ? localRows
      : localRows.filter((row) => matchesUtilizationTier(row.utilizationPct ?? 0, utilTier)),
    [localRows, utilTier],
  );
  const utilCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: localRows.length };
    for (const row of localRows) {
      const pct = row.utilizationPct ?? 0;
      const band = matchesUtilizationTier(pct, "Critical") ? "Critical"
        : matchesUtilizationTier(pct, "High") ? "High"
        : matchesUtilizationTier(pct, "Moderate") ? "Moderate" : "Normal";
      counts[band] = (counts[band] ?? 0) + 1;
    }
    return counts as Partial<Record<UtilizationTier, number>>;
  }, [localRows]);

  function navigate(next: { search?: string; splitterType?: string; status?: string; page?: number; pageSize?: number }) {
    const params = new URLSearchParams();
    const search = (next.search ?? query).trim();
    const type = next.splitterType ?? typeFilter;
    const status = next.status ?? statusFilter;
    if (search) params.set("search", search);
    if (type && type !== "ALL") params.set("splitterType", type);
    if (status && status !== "ALL") params.set("status", status);
    params.set("page", String(Math.max(1, next.page ?? 1)));
    params.set("pageSize", String(next.pageSize ?? pageSize));
    router.push(`/splitters?${params.toString()}` as Route);
  }

  async function loadOutputs(splitterId: string, force = false) {
    if (!force && outputsBySplitter[splitterId]) return;
    setOutputsLoading((current) => ({ ...current, [splitterId]: true }));
    try {
      const response = await fetch(`/api/splitters/${splitterId}/outputs`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Splitter output load failed.");
      setOutputsBySplitter((current) => ({ ...current, [splitterId]: payload.rows ?? [] }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitter output load failed.");
    } finally {
      setOutputsLoading((current) => ({ ...current, [splitterId]: false }));
    }
  }

  function toggleExpanded(splitterId: string) {
    const willExpand = !expanded[splitterId];
    setExpanded((current) => ({ ...current, [splitterId]: willExpand }));
    // Child and grand-child rows are only queried when the operator expands the parent.
    if (willExpand) void loadOutputs(splitterId);
  }

  function outputsFor(row: SplitterInventoryRow): SplitterOutputRow[] {
    return outputsBySplitter[row.id] ?? row.outputs ?? [];
  }

  async function bulkDeleteSelected() {
    if (!canBulkDelete || !selectedIds.length) return;
    if (!window.confirm(`Delete ${selectedIds.length} splitter(s) and ALL their child output rows? This cascading delete cannot be undone.`)) return;
    setIsBulkWorking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/splitters/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ splitterIds: selectedIds }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Bulk splitter delete failed.");
      const splitterCount = payload.splittersDeleted ?? selectedIds.length;
      setLocalRows((current) => current.filter((row) => !selectedIds.includes(row.id)));
      setSelected({});
      setMessage(`Deleted ${splitterCount} splitter(s) and ${payload.outputsDeleted ?? 0} child output row(s). No orphaned records remain.`);
      toast.deleted(`${splitterCount} splitter${splitterCount === 1 ? "" : "s"}`, { title: `Removed with ${payload.outputsDeleted ?? 0} child output row(s)` });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk splitter delete failed.");
    } finally {
      setIsBulkWorking(false);
    }
  }

  async function bulkChangeStatus() {
    if (!canWrite || !selectedIds.length) return;
    setIsBulkWorking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/splitters/bulk-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ splitterIds: selectedIds, status: bulkStatus }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Bulk status change failed.");
      setLocalRows((current) => current.map((row) => (selectedIds.includes(row.id) ? { ...row, status: bulkStatus } : row)));
      setSelected({});
      setMessage(`Updated ${payload.splittersUpdated ?? selectedIds.length} splitter(s) and ${payload.outputsUpdated ?? 0} output row(s) to ${bulkStatus}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk status change failed.");
    } finally {
      setIsBulkWorking(false);
    }
  }

  async function deleteSplitter(row: SplitterInventoryRow) {
    if (!canDelete) return;
    if (!window.confirm(`Delete splitter ${row.splitterCode}? Active outputs must be released first.`)) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/splitters/${row.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Splitter delete failed.");
      if (payload.deactivated) {
        setLocalRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "DECOMMISSIONED" } : item));
        toast.notify({ tone: "delete", persistent: true, title: "Decommissioned", message: `Splitter ${row.splitterCode} has been decommissioned.` });
      } else {
        setLocalRows((current) => current.filter((item) => item.id !== row.id));
        toast.deleted(`Splitter ${row.splitterCode}`);
      }
      setMessage(payload.message ?? `Deleted ${row.splitterCode}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitter delete failed.");
    }
  }

  function editSplitter(row: SplitterInventoryRow) {
    setSplitterForm({
      id: row.id,
      splitterCode: row.splitterCode,
      splitterName: row.splitterName ?? "",
      splitterType: row.splitterType ?? `${row.scope}_SPL`,
      scope: row.scope,
      location: row.location ?? "",
      locationContext: row.locationContext ?? row.location ?? "",
      protectionMode: row.protectionMode,
      primaryInputSiteCode: row.primaryInputSiteCode ?? "",
      primaryInputRackCode: row.primaryInputRackCode ?? "",
      primaryInputOdfCode: row.primaryInputOdfCode ?? "",
      primaryInputPortLabel: row.primaryInputPortLabel ?? "",
      secondaryInputSiteCode: row.secondaryInputSiteCode ?? "",
      secondaryInputRackCode: row.secondaryInputRackCode ?? "",
      secondaryInputOdfCode: row.secondaryInputOdfCode ?? "",
      secondaryInputPortLabel: row.secondaryInputPortLabel ?? "",
      outputPortCapacity: row.outputPortCapacity ? String(row.outputPortCapacity) : "32",
      configuredOutputPorts: row.configuredOutputPorts ? String(row.configuredOutputPorts) : "0",
      status: row.status,
      remarks: row.remarks ?? "",
    });
  }

  async function saveSplitter() {
    if (!splitterForm) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(splitterForm.id ? `/api/splitters/${splitterForm.id}` : "/api/splitters", {
        method: splitterForm.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(splitterForm),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Splitter save failed.");
      setMessage(splitterForm.id ? "Splitter updated successfully." : "Splitter added successfully.");
      // Flash the affected splitter row and refresh in place (router.refresh keeps
      // the current page + scroll position, unlike a full window.location.reload).
      const savedId = splitterForm.id ?? payload?.id ?? payload?.splitter?.id ?? null;
      flash(savedId);
      setSplitterForm(null);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitter save failed.");
    } finally {
      setSaving(false);
    }
  }

  function editOutput(splitterId: string, output: SplitterOutputRow) {
    setExpanded((current) => ({ ...current, [splitterId]: true }));
    setOutputForm({
      id: output.id,
      splitterId,
      outputLabel: output.outputLabel ?? "",
      outputPort: output.outputPort ?? "",
      localSiteCode: output.localSiteCode ?? "",
      localRackCode: output.localRackCode ?? "",
      localOdfCode: output.localOdfCode ?? "",
      localPortLabel: output.localPortLabel ?? "",
      destinationSiteCode: output.destinationSiteCode ?? "",
      destinationLabel: output.destinationLabel ?? "",
      destinationRackCode: output.destinationRackCode ?? "",
      destinationOdfCode: output.destinationOdfCode ?? "",
      destinationPortLabel: output.destinationPortLabel ?? "",
      serviceCode: output.serviceCode ?? "",
      sharingCustomerServiceId: output.sharingCustomerServiceId ?? output.sharingCustomerServiceCode ?? "",
      capacityFibers: String(output.capacityFibers ?? 1),
      status: output.status,
      remarks: output.remarks ?? "",
    });
  }

  async function saveOutput() {
    if (!outputForm?.splitterId) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(outputForm.id ? `/api/splitter-outputs/${outputForm.id}` : `/api/splitters/${outputForm.splitterId}/outputs`, {
        method: outputForm.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outputForm),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Splitter output save failed.");
      setMessage(outputForm.id ? "Splitter output updated successfully." : "Splitter output added successfully.");
      const splitterId = outputForm.splitterId;
      // Highlight both the modified output (child) row and its parent splitter row.
      flash([outputForm.id ?? payload?.id ?? payload?.output?.id ?? null, splitterId]);
      setOutputForm(null);
      await loadOutputs(splitterId, true);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitter output save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteOutput(splitterId: string, output: SplitterOutputRow) {
    if (!window.confirm("Delete this splitter output? Active service outputs must be released first.")) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/splitter-outputs/${output.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Splitter output delete failed.");
      setOutputsBySplitter((current) => ({
        ...current,
        [splitterId]: (current[splitterId] ?? []).filter((item) => item.id !== output.id),
      }));
      setLocalRows((current) => current.map((row) => row.id === splitterId ? { ...row, outputCount: Math.max(0, row.outputCount - 1) } : row));
      setMessage(payload.message ?? "Splitter output deleted successfully.");
      toast.deleted(`Splitter output ${output.outputLabel ?? output.outputPort ?? output.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitter output delete failed.");
    }
  }

  async function importSplitters() {
    if (!importFile) {
      setMessage("Choose a normalized splitter CSV first.");
      return;
    }
    setIsImporting(true);
    setMessage(null);
    const formData = new FormData();
    formData.append("file", importFile);
    try {
      const response = await fetch("/api/splitters/import", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Splitter import failed.");
      setMessage(`Imported ${payload.outputsCreated} splitter output row(s). Refreshing view...`);
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitter import failed.");
    } finally {
      setIsImporting(false);
    }
  }

  // Shared body for the output edit/add form. Rendered inline beneath the row being
  // edited (so the operator never has to scroll past every port), and at the bottom of
  // the table for the "Add Output" flow.
  function renderOutputFormBody() {
    if (!outputForm) return null;
    return (
      <>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="font-semibold text-slate-950 dark:text-white">{outputForm.id ? "Edit splitter output" : "Add splitter output"}</div>
          <button aria-label="Close output form" className="rounded-md border border-border p-2" onClick={() => setOutputForm(null)}><X className="h-5 w-5" /></button>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <input className="input-dark" value={outputForm.outputLabel} onChange={(event) => setOutputForm({ ...outputForm, outputLabel: event.target.value })} placeholder="Output label" />
          <input className="input-dark" value={outputForm.outputPort} onChange={(event) => setOutputForm({ ...outputForm, outputPort: event.target.value })} placeholder="Outgoing port #" />
          <input className="input-dark" value={outputForm.localSiteCode} onChange={(event) => setOutputForm({ ...outputForm, localSiteCode: event.target.value })} placeholder="Local site" />
          <input className="input-dark" value={outputForm.localRackCode} onChange={(event) => setOutputForm({ ...outputForm, localRackCode: event.target.value })} placeholder="Local rack (room tag)" />
          <input className="input-dark" value={outputForm.localOdfCode} onChange={(event) => setOutputForm({ ...outputForm, localOdfCode: event.target.value })} placeholder="Local ODF" />
          <input className="input-dark" value={outputForm.localPortLabel} onChange={(event) => setOutputForm({ ...outputForm, localPortLabel: event.target.value })} placeholder="Local ODF port" />
          <input className="input-dark" value={outputForm.destinationSiteCode} onChange={(event) => setOutputForm({ ...outputForm, destinationSiteCode: event.target.value })} placeholder="Destination site" />
          <input className="input-dark" value={outputForm.destinationLabel} onChange={(event) => setOutputForm({ ...outputForm, destinationLabel: event.target.value })} placeholder="Destination/customer" />
          <input className="input-dark" value={outputForm.destinationRackCode} onChange={(event) => setOutputForm({ ...outputForm, destinationRackCode: event.target.value })} placeholder="Destination rack" />
          <input className="input-dark" value={outputForm.destinationOdfCode} onChange={(event) => setOutputForm({ ...outputForm, destinationOdfCode: event.target.value })} placeholder="Destination ODF" />
          <input className="input-dark" value={outputForm.destinationPortLabel} onChange={(event) => setOutputForm({ ...outputForm, destinationPortLabel: event.target.value })} placeholder="Destination port" />
          <input className="input-dark" value={outputForm.serviceCode} onChange={(event) => setOutputForm({ ...outputForm, serviceCode: event.target.value })} placeholder="Service ID" />
          <input className="input-dark" value={outputForm.sharingCustomerServiceId} onChange={(event) => setOutputForm({ ...outputForm, sharingCustomerServiceId: event.target.value })} placeholder="Sharing customer service ID" />
          <input className="input-dark" value={outputForm.capacityFibers} onChange={(event) => setOutputForm({ ...outputForm, capacityFibers: event.target.value })} placeholder="Capacity" />
          <select aria-label="Output status" className="input-dark" value={outputForm.status} onChange={(event) => setOutputForm({ ...outputForm, status: event.target.value })}>
            {["AVAILABLE", "ACTIVE", "RESERVED", "MAINTENANCE", "INACTIVE", "FAULTY", "DECOMMISSIONED"].map((status) => <option key={status}>{status}</option>)}
          </select>
          <input className="input-dark" value={outputForm.remarks} onChange={(event) => setOutputForm({ ...outputForm, remarks: event.target.value })} placeholder="Remarks" />
        </div>
        <button className="mt-3 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={saving} onClick={saveOutput}>
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
          Save Output
        </button>
      </>
    );
  }

  const summaryCards: Array<[string, string | number]> = summary
    ? [
        ["Splitters", summary.totalSplitters],
        ["OSP / ISP", `${summary.ospSplitters} / ${summary.ispSplitters}`],
        ["Output rows", summary.totalOutputs],
        ["Configured / Available ports", `${summary.configuredPorts} / ${summary.availablePorts}`],
      ]
    : [
        ["Splitters", localRows.length],
        ["OSP", localRows.filter((row) => isOsp(row)).length],
        ["Outputs", localRows.reduce((sum, row) => sum + row.outputCount, 0)],
        ["Configured / Available", `${localRows.reduce((sum, row) => sum + (row.configuredOutputPorts ?? 0), 0)} / ${localRows.reduce((sum, row) => sum + row.availableFibers, 0)}`],
      ];

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="section-title">Splitters Inventory</div>
            <div className="subtle mt-1">OSP/ISP splitter patch panels. Parent rows load as summaries; output port mappings load when a row is expanded.</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite ? (
              <>
                <button
                  className="btn bg-emerald-600 text-white"
                  onClick={() => setSplitterForm({ ...emptySplitterForm })}
                >
                  <Plus className="h-5 w-5" />
                  Add Splitter
                </button>
                <input aria-label="Splitter CSV file" className="input-dark" type="file" accept=".csv,text/csv" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} />
                <button
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={!importFile || isImporting}
                  onClick={importSplitters}
                >
                  {isImporting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                  Import Splitter CSV
                </button>
              </>
            ) : null}
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white"
              onClick={() => { window.location.href = "/api/export?type=splitters&format=xlsx"; }}
            >
              <Download className="h-5 w-5" />
              Export
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            aria-label="Search splitters"
            className="input-dark min-w-[300px] flex-1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") navigate({ search: query, page: 1 }); }}
            placeholder="Search splitter, customer, service, site, ODF — press Enter"
          />
          <select aria-label="Splitter type filter" className="input-dark" value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); navigate({ splitterType: event.target.value, page: 1 }); }}>
            <option value="ALL">All types</option>
            <option value="OSP_SPL">OSP_SPL</option>
            <option value="ISP_SPL">ISP_SPL</option>
          </select>
          <select aria-label="Splitter status filter" className="input-dark" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); navigate({ status: event.target.value, page: 1 }); }}>
            <option value="ALL">All statuses</option>
            {["ACTIVE", "AVAILABLE", "RESERVED", "MAINTENANCE", "INACTIVE", "FAULTY", "PLANNED", "DECOMMISSIONED"].map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </div>

        <div className="mt-3">
          <UtilizationFilter value={utilTier} onChange={setUtilTier} counts={utilCounts} />
        </div>

        {message ? <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">{message}</div> : null}

        {selectedIds.length > 0 && (canWrite || canBulkDelete) ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-300 bg-cyan-50 p-3 dark:border-cyan-700/60 dark:bg-cyan-950/40">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-900 dark:text-cyan-100">
              <CheckSquare className="h-5 w-5" />
              {selectedIds.length} selected
            </span>
            {canWrite ? (
              <>
                <select aria-label="Bulk status" className="input-dark" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)}>
                  {BULK_OPERATIONAL_STATUSES.map((status) => <option key={status} value={status}>{status.charAt(0) + status.slice(1).toLowerCase()}</option>)}
                </select>
                <button
                  className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={isBulkWorking}
                  onClick={bulkChangeStatus}
                >
                  {isBulkWorking ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                  Apply Status
                </button>
              </>
            ) : null}
            {canBulkDelete ? (
              <button
                className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                disabled={isBulkWorking}
                onClick={bulkDeleteSelected}
              >
                <Trash2 className="h-5 w-5" />
                Cascade Delete
              </button>
            ) : null}
            <button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold" onClick={() => setSelected({})}>Clear selection</button>
          </div>
        ) : null}

        {splitterForm ? (
          <div className="mt-5 rounded-lg border border-border bg-white/5 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="font-semibold text-slate-950 dark:text-white">{splitterForm.id ? "Edit splitter" : "Add splitter"}</div>
              <button aria-label="Close splitter form" className="rounded-md border border-border p-2" onClick={() => setSplitterForm(null)}><X className="h-5 w-5" /></button>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <input className="input-dark" value={splitterForm.splitterCode} onChange={(event) => setSplitterForm({ ...splitterForm, splitterCode: event.target.value })} placeholder="Splitter ID" />
              <input className="input-dark" value={splitterForm.splitterName} onChange={(event) => setSplitterForm({ ...splitterForm, splitterName: event.target.value })} placeholder="Source site / splitter name" />
              <select aria-label="Splitter Type" className="input-dark" value={splitterForm.splitterType} onChange={(event) => setSplitterForm({ ...splitterForm, splitterType: event.target.value, scope: event.target.value === "ISP_SPL" ? "ISP" : "OSP" })}>
                <option>OSP_SPL</option>
                <option>ISP_SPL</option>
              </select>
              <select aria-label="Protection mode" className="input-dark" value={splitterForm.protectionMode} onChange={(event) => setSplitterForm({ ...splitterForm, protectionMode: event.target.value })}>
                <option value="UNKNOWN">Unknown</option>
                <option value="UNPROTECTED">Non Protected</option>
                <option value="PROTECTED">Protected</option>
              </select>
              <input className="input-dark" value={splitterForm.location} onChange={(event) => setSplitterForm({ ...splitterForm, location: event.target.value })} placeholder="Location / customer / site" />
              <input className="input-dark" value={splitterForm.locationContext} onChange={(event) => setSplitterForm({ ...splitterForm, locationContext: event.target.value })} placeholder={splitterForm.splitterType === "ISP_SPL" ? "Property environment (e.g. Muscat Grand Mall)" : "Field housing (e.g. HH.34 JT.07A /SPL:15)"} />
              <input className="input-dark" value={splitterForm.primaryInputSiteCode} onChange={(event) => setSplitterForm({ ...splitterForm, primaryInputSiteCode: event.target.value })} placeholder="Primary input site" />
              <input className="input-dark" value={splitterForm.primaryInputRackCode} onChange={(event) => setSplitterForm({ ...splitterForm, primaryInputRackCode: event.target.value })} placeholder="Primary rack" />
              <input className="input-dark" value={splitterForm.primaryInputOdfCode} onChange={(event) => setSplitterForm({ ...splitterForm, primaryInputOdfCode: event.target.value })} placeholder="Primary ODF" />
              <input className="input-dark" value={splitterForm.primaryInputPortLabel} onChange={(event) => setSplitterForm({ ...splitterForm, primaryInputPortLabel: event.target.value })} placeholder="Primary port" />
              <input className="input-dark" value={splitterForm.secondaryInputSiteCode} onChange={(event) => setSplitterForm({ ...splitterForm, secondaryInputSiteCode: event.target.value })} placeholder="Protection input site" />
              <input className="input-dark" value={splitterForm.secondaryInputRackCode} onChange={(event) => setSplitterForm({ ...splitterForm, secondaryInputRackCode: event.target.value })} placeholder="Protection rack" />
              <input className="input-dark" value={splitterForm.secondaryInputOdfCode} onChange={(event) => setSplitterForm({ ...splitterForm, secondaryInputOdfCode: event.target.value })} placeholder="Protection ODF" />
              <input className="input-dark" value={splitterForm.secondaryInputPortLabel} onChange={(event) => setSplitterForm({ ...splitterForm, secondaryInputPortLabel: event.target.value })} placeholder="Protection port" />
              <input className="input-dark" value={splitterForm.outputPortCapacity} onChange={(event) => setSplitterForm({ ...splitterForm, outputPortCapacity: event.target.value })} placeholder="Total physical capacity e.g. 32" />
              <input className="input-dark" value={splitterForm.configuredOutputPorts} onChange={(event) => setSplitterForm({ ...splitterForm, configuredOutputPorts: event.target.value })} placeholder="Configured outputs" />
              <select aria-label="Splitter status" className="input-dark" value={splitterForm.status} onChange={(event) => setSplitterForm({ ...splitterForm, status: event.target.value })}>
                {["ACTIVE", "AVAILABLE", "RESERVED", "MAINTENANCE", "INACTIVE", "PLANNED", "DECOMMISSIONED"].map((status) => <option key={status}>{status}</option>)}
              </select>
              <input className="input-dark" value={splitterForm.remarks} onChange={(event) => setSplitterForm({ ...splitterForm, remarks: event.target.value })} placeholder="Remarks" />
            </div>
            <button className="mt-4 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={saving} onClick={saveSplitter}>
              {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
              Save Splitter
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {summaryCards.map(([label, value]) => (
          <div className="card p-4" key={label}>
            <div className="text-xs uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">{label}</div>
            <div className="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">{value}</div>
          </div>
        ))}
      </div>

      <div className="table-shell splitter-table-shell">
        <table>
          <thead>
            <tr>
              {canWrite || canDelete ? (
                <th>
                  <input
                    aria-label="Select all splitters on this page"
                    type="checkbox"
                    className="h-5 w-5 cursor-pointer accent-red-600"
                    checked={displayRows.length > 0 && displayRows.every((row) => selected[row.id])}
                    onChange={(event) => setSelected(Object.fromEntries(displayRows.map((row) => [row.id, event.target.checked])))}
                  />
                </th>
              ) : null}
              <th></th>
              <th>Splitter Type</th>
              <th>Source site</th>
              <th>Location Context</th>
              <th>Protection</th>
              <th>Utilization (Configured / Capacity)</th>
              <th>Status</th>
              {canWrite || canDelete ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              const outputs = outputsFor(row);
              const limit = outputLimits[row.id] ?? INITIAL_OUTPUT_ROW_LIMIT;
              const osp = isOsp(row);
              const utilization = row.utilizationPct ?? 0;
              return (
                <Fragment key={row.id}>
                  <tr style={rowFlashStyle(isFlashing(row.id))}>
                    {canWrite || canDelete ? (
                      <td>
                        <input
                          aria-label={`Select ${row.splitterCode}`}
                          type="checkbox"
                          className="h-5 w-5 cursor-pointer accent-red-600"
                          checked={Boolean(selected[row.id])}
                          onChange={(event) => setSelected((current) => ({ ...current, [row.id]: event.target.checked }))}
                        />
                      </td>
                    ) : null}
                    <td>
                      <button
                        aria-label={expanded[row.id] ? `Collapse ${row.splitterCode}` : `Expand ${row.splitterCode}`}
                        className="rounded-md border border-border p-2"
                        onClick={() => toggleExpanded(row.id)}
                      >
                        {expanded[row.id] ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                      </button>
                    </td>
                    <td>
                      <span className={`badge ${osp ? "border-sky-600/40 bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200" : "border-violet-600/40 bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200"}`}>
                        {row.splitterType ?? `${row.scope}_SPL`}
                      </span>
                    </td>
                    <td>
                      <div className="font-semibold">{row.sourceSite ?? row.primaryInputSiteCode ?? row.splitterCode}</div>
                      <div className="subtle text-xs">{row.splitterName ?? row.splitterCode}</div>
                    </td>
                    <td className="break-cell">{row.locationContext ?? row.location ?? "-"}</td>
                    <td>
                      <span className={`badge ${isProtected(row.protectionMode) ? "border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200" : protectionDisplay(row.protectionMode) === "Unknown" ? "border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-200" : "border-amber-600/40 bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"}`}>
                        {protectionDisplay(row.protectionMode)}
                      </span>
                    </td>
                    <td>
                      <div className="font-semibold">{row.configuredOutputPorts ?? 0} / {row.totalHardwareCapacity ?? row.outputPortCapacity ?? "-"}</div>
                      <div className="mt-1 h-2 w-32 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                        <div
                          className={`h-full rounded-full ${utilization >= 90 ? "bg-red-600" : utilization >= 70 ? "bg-amber-500" : "bg-emerald-600"}`}
                          style={{ width: `${Math.min(100, utilization)}%` }}
                        />
                      </div>
                      <div className="subtle text-xs">{utilization}% used &middot; {row.outputCount} output row(s)</div>
                    </td>
                    <td><span className={statusBadgeClass(row.status)}>{row.status}</span></td>
                    {canWrite || canDelete ? (
                      <td className="space-x-2 whitespace-nowrap">
                        {canWrite ? (
                          <button className="inline-flex items-center gap-1 rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-900 dark:border-cyan-800/70 dark:bg-cyan-950/50 dark:text-cyan-100" onClick={() => editSplitter(row)}>
                            <Pencil className="h-4 w-4" />
                            Edit
                          </button>
                        ) : null}
                        {canDelete ? (
                          <button className="btn btn-danger-soft btn-compact" onClick={() => deleteSplitter(row)}>
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                  {expanded[row.id] ? (
                    <tr key={`${row.id}-outputs`}>
                      {canWrite || canDelete ? <td></td> : null}
                      <td></td>
                      <td colSpan={canWrite || canDelete ? 7 : 6}>
                        <div className="mb-3 rounded-lg border border-border bg-white/5 p-4 text-sm">
                          <div className="mb-3 font-semibold">Inbound physical feed</div>
                          {isProtected(row.protectionMode) ? (
                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="rounded-lg border border-emerald-400/40 bg-emerald-500/5 p-3">
                                <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">Primary Leg</div>
                                <div className="grid grid-cols-2 gap-3">
                                  <FeedField label="Site ID (Primary)" value={row.primaryInputSiteCode} />
                                  <FeedField label="Source Rack ID (Primary)" value={row.primaryInputRackCode} />
                                  <FeedField label="Source ODF ID (Primary)" value={row.primaryInputOdfCode} />
                                  <FeedField label="Source ODF Port (Primary)" value={row.primaryInputPortLabel} />
                                </div>
                              </div>
                              <div className="rounded-lg border border-sky-400/40 bg-sky-500/5 p-3">
                                <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">Protection Leg</div>
                                <div className="grid grid-cols-2 gap-3">
                                  <FeedField label="Site ID (Protection)" value={row.secondaryInputSiteCode} />
                                  <FeedField label="Source Rack ID (Protection)" value={row.secondaryInputRackCode} />
                                  <FeedField label="Source ODF ID (Protection)" value={row.secondaryInputOdfCode} />
                                  <FeedField label="Source ODF Port (Protection)" value={row.secondaryInputPortLabel} />
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                              <FeedField label="Source Site ID" value={row.primaryInputSiteCode} />
                              <FeedField label="Source Rack ID" value={row.primaryInputRackCode} />
                              <FeedField label="Source ODF ID" value={row.primaryInputOdfCode} />
                              <FeedField label="Source ODF Port" value={row.primaryInputPortLabel} />
                            </div>
                          )}
                        </div>
                        {!osp ? (
                          <div className="mb-2 rounded-lg border border-border bg-white/5 px-3 py-2 text-xs">
                            Local Rack inherited at parent context: <span className="font-semibold">{outputs[0]?.localRackCode ?? row.primaryInputRackCode ?? "-"}</span>
                          </div>
                        ) : null}
                        {outputsLoading[row.id] ? (
                          <div className="flex items-center gap-2 rounded-lg border border-border bg-white/5 p-4 text-sm">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Loading output port mappings...
                          </div>
                        ) : (
                          <div className="splitter-output-shell rounded-lg border border-border">
                            <table className="splitter-output-table">
                              <thead>
                                <tr>
                                  <th>Splitter Outgoing Port #</th>
                                  {osp ? <th>Local Rack (Room Tags)</th> : null}
                                  <th>Local ODF ID</th>
                                  <th>Local ODF Port</th>
                                  <th>Service ID</th>
                                  {osp ? <th>Sharing Customer Service ID</th> : null}
                                  <th>Status</th>
                                  {canWrite ? <th>Actions</th> : null}
                                </tr>
                              </thead>
                              <tbody>
                                {outputs.slice(0, limit).map((output) => (
                                  <Fragment key={output.id}>
                                    <tr style={rowFlashStyle(isFlashing(output.id))}>
                                      <td>{formatOutgoingPort(output)}</td>
                                      {osp ? <td className="break-cell">{output.localRackCode ?? "-"}</td> : null}
                                      <td className="break-cell">{output.localOdfCode ?? "-"}</td>
                                      <td className="break-cell">{output.localPortLabel ?? "-"}</td>
                                      <td className="break-cell min-w-[260px]">{output.serviceCode ?? "-"}</td>
                                      {osp ? <td className="break-cell">{output.sharingCustomerServiceId ?? output.sharingCustomerServiceCode ?? "-"}</td> : null}
                                      <td><span className={statusBadgeClass(output.status)}>{output.status}</span></td>
                                      {canWrite ? (
                                        <td className="space-x-2 whitespace-nowrap">
                                          <button className="inline-flex items-center gap-1 rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-900 dark:border-cyan-800/70 dark:bg-cyan-950/50 dark:text-cyan-100" onClick={() => editOutput(row.id, output)}>
                                            <Pencil className="h-4 w-4" />
                                            Edit
                                          </button>
                                          <button className="btn btn-danger-soft btn-compact" onClick={() => deleteOutput(row.id, output)}>
                                            <Trash2 className="h-4 w-4" />
                                            Delete
                                          </button>
                                        </td>
                                      ) : null}
                                    </tr>
                                    {canWrite && outputForm?.id === output.id && outputForm.splitterId === row.id ? (
                                      <tr>
                                        <td colSpan={osp ? 8 : 6} className="p-0">
                                          <div className="m-2 rounded-lg border border-cyan-300 bg-white/5 p-3 dark:border-cyan-800/70">
                                            {renderOutputFormBody()}
                                          </div>
                                        </td>
                                      </tr>
                                    ) : null}
                                  </Fragment>
                                ))}
                                {!outputs.length ? (
                                  <tr><td colSpan={osp ? 8 : 6} className="subtle">No output port records configured yet.</td></tr>
                                ) : null}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {outputs.length > limit ? (
                          <button
                            className="mt-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200"
                            onClick={() => setOutputLimits((current) => ({ ...current, [row.id]: limit + INITIAL_OUTPUT_ROW_LIMIT }))}
                          >
                            Show {INITIAL_OUTPUT_ROW_LIMIT} more outputs ({outputs.length - limit} remaining)
                          </button>
                        ) : null}
                        {canWrite ? (
                          <div className="mt-3 rounded-lg border border-border bg-white/5 p-3">
                            {/* Edit forms render inline beneath their row; only the Add flow lives here. */}
                            {outputForm?.splitterId === row.id && !outputForm.id ? (
                              renderOutputFormBody()
                            ) : (
                              <button className="btn bg-emerald-600 text-white" onClick={() => setOutputForm({ ...emptyOutputForm, splitterId: row.id, localSiteCode: row.primaryInputSiteCode ?? "", localRackCode: row.primaryInputRackCode ?? "", localOdfCode: row.primaryInputOdfCode ?? "", localPortLabel: row.primaryInputPortLabel ?? "" })}>
                                <Plus className="h-5 w-5" />
                                Add Output
                              </button>
                            )}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!displayRows.length ? (
              <tr><td colSpan={9} className="subtle p-6 text-center">{localRows.length && utilTier !== "ALL" ? `No splitters in the ${utilTier} utilization tier on this page.` : "No splitters match the current filters."}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="subtle">
          Page {page} of {pageCount} &middot; {total} splitter(s)
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Rows per page"
            className="input-dark"
            value={pageSize}
            onChange={(event) => navigate({ page: 1, pageSize: Number(event.target.value) })}
          >
            {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} / page</option>)}
          </select>
          <button
            className="btn btn-ghost"
            disabled={page <= 1}
            onClick={() => navigate({ page: page - 1 })}
          >
            <ChevronLeft className="h-5 w-5" />
            Previous
          </button>
          <button
            className="btn btn-ghost"
            disabled={page >= pageCount}
            onClick={() => navigate({ page: page + 1 })}
          >
            Next
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
