"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, Download, Loader2, RefreshCw, Upload, Database, Trash2, XCircle } from "lucide-react";
import type { ImportReviewBatch, ImportReviewIssue, ImportReviewRow } from "@/types/import";
import { importRowDecision, importDecisionBadgeClass } from "@/lib/import/row-status";
import { useToast } from "@/components/ui/toast";

function parseJson(value?: string | null): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

interface BackgroundCommitJobView {
  state: "RUNNING" | "COMPLETED" | "FAILED";
  committedRows: number;
  skippedRows: number;
  outOfScopeRows: number;
  remainingRows: number | null;
  error: string | null;
}

/** Rows the operator can still act on; committed/rejected rows are read-only history. */
function isSelectableRow(row: ImportReviewRow): boolean {
  return row.status !== "COMMITTED" && row.status !== "REJECTED";
}

/** Rows the commit engine will actually accept — used to pre-filter "approve selected". */
function isCommittableRow(row: ImportReviewRow): boolean {
  if (!isSelectableRow(row) || row.status === "SKIPPED") return false;
  return !row.issues.some((issue) => issue.blocking || issue.severity === "ERROR" || issue.severity === "CRITICAL");
}

function mapApiBatch(payload: any): ImportReviewBatch {
  const issues: ImportReviewIssue[] = (payload.issues ?? []).map((issue: any) => ({
    id: issue.id,
    stagingRowId: issue.stagingRowId ?? null,
    severity: issue.severity,
    issueCode: issue.issueCode,
    message: issue.message,
    blocking: Boolean(issue.blocking),
  }));
  const issuesByRow = new Map<string, ImportReviewIssue[]>();
  for (const issue of issues) {
    if (!issue.stagingRowId) continue;
    issuesByRow.set(issue.stagingRowId, [...(issuesByRow.get(issue.stagingRowId) ?? []), issue]);
  }

  const rows: ImportReviewRow[] = (payload.stagingRows ?? []).map((row: any) => {
    const normalized = parseJson(row.normalizedJson);
    const raw = parseJson(row.rawJson);
    return {
      id: row.id,
      rowNumber: row.rowNumber,
      status: row.status,
      reviewerComment: row.reviewerComment ?? null,
      duplicateOfSegmentId: row.duplicateOfSegmentId ?? null,
      sourceSheet: normalized.sourceSheet ?? null,
      sourceSiteRaw: normalized.sourceSiteRaw ?? null,
      sourceSiteCanonical: normalized.sourceSiteCanonical ?? null,
      farSiteRaw: normalized.farSiteRaw ?? null,
      farSiteCanonical: normalized.farSiteCanonical ?? null,
      rackCode: normalized.rackCode ?? null,
      odfCode: normalized.odfCode ?? null,
      portGroupLabel: normalized.portGroupLabel ?? null,
      farRackCode: normalized.farRackCode ?? null,
      farOdfCode: normalized.farOdfCode ?? null,
      farPortGroupLabel: normalized.farPortGroupLabel ?? null,
      serviceIdResolved: normalized.serviceIdResolved ?? null,
      statusHint: normalized.statusHint ?? null,
      matchStatus: normalized.matchStatus ?? null,
      directionText: normalized.directionText ?? null,
      definitionText: normalized.definitionText ?? null,
      proposedSegmentCode: row.proposedSegmentCode ?? null,
      rawJson: raw,
      normalizedJson: normalized,
      issues: issuesByRow.get(row.id) ?? [],
    };
  });

  return {
    id: payload.id,
    batchCode: payload.batchCode,
    fileName: payload.fileName,
    status: payload.status,
    totalRows: payload.totalRows ?? rows.length,
    validRows: payload.validRows ?? 0,
    warningRows: payload.warningRows ?? 0,
    errorRows: payload.errorRows ?? 0,
    committedRows: payload.committedRows ?? 0,
    rows,
    issues,
  };
}

export function ImportCenterWorkbench({
  initialBatch,
}: {
  initialBatch: ImportReviewBatch | null;
}) {
  const [batch, setBatch] = useState(initialBatch);
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState("");
  const [sheetFilter, setSheetFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Record<string, boolean>>({});
  const [distanceFile, setDistanceFile] = useState<File | null>(null);
  const [distanceImporting, setDistanceImporting] = useState(false);
  const [distanceColumns, setDistanceColumns] = useState({ nearColumn: "", farColumn: "", distanceColumn: "", remarksColumn: "", overwrite: false });
  const [distanceResult, setDistanceResult] = useState<Record<string, any> | null>(null);
  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const toast = useToast();
  const [stageOverlayOpen, setStageOverlayOpen] = useState(false);
  const [removeWarning, setRemoveWarning] = useState<{ approvedCount: number; message: string } | null>(null);
  const [isRemovingBatch, setIsRemovingBatch] = useState(false);
  const [backgroundJob, setBackgroundJob] = useState<BackgroundCommitJobView | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Incremental rendering window: validation/commit always run over the FULL
  // batch server-side, but the DOM must never hold 200k <tr> nodes at once.
  const ROW_RENDER_STEP = 400;
  const [rowRenderLimit, setRowRenderLimit] = useState(ROW_RENDER_STEP);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const rows = (batch?.rows ?? []).filter((row) => !sheetFilter || row.sourceSheet === sheetFilter);
    if (!needle) return rows;
    return rows.filter((row) =>
      [
        row.sourceSheet,
        row.sourceSiteRaw,
        row.sourceSiteCanonical,
        row.farSiteRaw,
        row.farSiteCanonical,
        row.rackCode,
        row.odfCode,
        row.portGroupLabel,
        row.farRackCode,
        row.farOdfCode,
        row.farPortGroupLabel,
        row.serviceIdResolved,
        row.statusHint,
        row.matchStatus,
        row.directionText,
        row.definitionText,
        row.status,
      ].filter(Boolean).join(" ").toUpperCase().includes(needle),
    );
  }, [batch, query, sheetFilter]);

  const sheetSummaries = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of batch?.rows ?? []) {
      const sheet = row.sourceSheet ?? "Unknown sheet";
      map.set(sheet, (map.get(sheet) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([sheetName, count]) => ({ sheetName, count }));
  }, [batch]);

  // Each staged row resolves to ONE explicit lifecycle decision — never the old
  // ambiguous "Rejected / Skipped" blend — with the precise reason beside it.
  function decisionFor(row: ImportReviewRow) {
    return importRowDecision({
      status: row.status,
      statusHint: String(row.normalizedJson?.statusHint ?? row.statusHint ?? "") || null,
      reviewerComment: row.reviewerComment,
      duplicateOfSegmentId: row.duplicateOfSegmentId,
      issues: row.issues,
    });
  }

  function DecisionCell({ row, showReason = true }: { row: ImportReviewRow; showReason?: boolean }) {
    const decision = decisionFor(row);
    return (
      <div className="flex min-w-0 flex-col items-start gap-1 whitespace-normal break-words">
        <span className={`${importDecisionBadgeClass(decision.tone)} max-w-full break-words`} style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{decision.label}</span>
        {showReason && decision.reason ? (
          <span className="max-w-full whitespace-normal break-words text-[11px] leading-snug text-slate-600 dark:text-slate-300" style={{ overflowWrap: "anywhere" }}>{decision.reason}</span>
        ) : null}
      </div>
    );
  }

  function shortJson(value?: Record<string, unknown>): string {
    const text = JSON.stringify(value ?? {});
    return text.length > 220 ? `${text.slice(0, 220)}...` : text;
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setError(null);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose the normalized migration_template_inventory.csv file first.");
      return;
    }

    setIsUploading(true);
    setError(null);
    setNotice(null);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/import/upload", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Upload failed.");
      setBatch(mapApiBatch(payload));
      setSheetFilter("");
      setSelectedRows({});
      setStageOverlayOpen(true);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function validate() {
    if (!batch) return;
    setIsValidating(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: batch.id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Validation failed.");
      setBatch(mapApiBatch(payload));
      setStageOverlayOpen(true);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "Validation failed.");
    } finally {
      setIsValidating(false);
    }
  }

  function selectedRowIds(): string[] {
    return Object.entries(selectedRows).filter(([, selected]) => selected).map(([id]) => id);
  }

  function toggleVisibleRows(checked: boolean) {
    // Select-all only touches actionable rows; committed/rejected rows are
    // read-only history and stay out of every bulk action.
    const ids = new Set(filteredRows.filter(isSelectableRow).map((row) => row.id));
    setSelectedRows((current) => {
      const next = { ...current };
      for (const id of ids) next[id] = checked;
      return next;
    });
  }

  async function stagingAction(action: "approve" | "reject" | "flush", actionPayload: Record<string, unknown> = {}) {
    if (!batch) return;
    setIsCommitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/import/${batch.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(actionPayload),
      });
      const responsePayload = await response.json();
      if (!response.ok) throw new Error(responsePayload.error ?? `${action} failed.`);
      setBatch(mapApiBatch(responsePayload));
      setSelectedRows({});
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : `${action} failed.`);
    } finally {
      setIsCommitting(false);
    }
  }

  /**
   * Resumable commit loop: the server processes a bounded window per request
   * and returns a continuation cursor. Looping here keeps every HTTP request
   * short (no frozen UI, no dropped connections) while still committing the
   * ENTIRE batch — with live progress feedback for the operator.
   */
  async function runApprove(payloadBase: Record<string, unknown>) {
    if (!batch) return;
    setIsCommitting(true);
    setError(null);
    setNotice("Committing staged rows…");
    let totalCommitted = 0;
    let totalSkipped = 0;
    try {
      // SINGLE-CLICK GUARANTEE: the outer loop re-sweeps the selection while
      // the server reports deferred rows (transient DB failures left
      // committable), so one click commits everything instead of forcing the
      // operator to press Commit repeatedly.
      const MAX_DEFERRED_SWEEPS = 3;
      for (let sweep = 0; sweep < MAX_DEFERRED_SWEEPS; sweep += 1) {
        let cursor: number | null = null;
        let sweepDeferred = 0;
        for (;;) {
          const response = await fetch(`/api/import/${batch.id}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cursor === null ? payloadBase : { ...payloadBase, afterRowNumber: cursor }),
          });
          const responsePayload = await response.json();
          if (!response.ok) throw new Error(responsePayload.error ?? "Commit failed.");
          const progress = responsePayload.commitProgress as
            | { committedRows: number; skippedRows: number; deferredRows?: number; remainingRows: number; nextCursor: number | null }
            | undefined;
          totalCommitted += progress?.committedRows ?? 0;
          if (sweep === 0) totalSkipped += progress?.skippedRows ?? 0;
          sweepDeferred += progress?.deferredRows ?? 0;
          setBatch(mapApiBatch(responsePayload));
          if (!progress || progress.nextCursor === null) break;
          cursor = progress.nextCursor;
          setNotice(`Committing… ${totalCommitted} committed, ${totalSkipped} skipped, ~${progress.remainingRows} remaining.`);
        }
        if (!sweepDeferred) break;
        setNotice(`Retrying ${sweepDeferred} row(s) that hit transient database contention…`);
      }
      setSelectedRows({});
      setNotice(`Commit complete: ${totalCommitted} row(s) committed, ${totalSkipped} skipped.`);
    } catch (commitError) {
      setError(
        `${commitError instanceof Error ? commitError.message : "Commit failed."}` +
        (totalCommitted ? ` ${totalCommitted} row(s) were already committed before the error; re-run commit to continue the remainder.` : ""),
      );
    } finally {
      setIsCommitting(false);
    }
  }

  async function refreshBatchWindow() {
    if (!batch) return;
    try {
      const response = await fetch(`/api/import/batches/${batch.id}`);
      const payload = await response.json();
      if (response.ok) setBatch(mapApiBatch(payload));
    } catch {
      // The next poll or manual refresh recovers; do not surface transient noise.
    }
  }

  function stopJobPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  // Polling only updates progress copy — the commit itself lives entirely on
  // the server, so closing this page or navigating away never interrupts it.
  function startJobPolling(batchId: string) {
    stopJobPolling();
    pollTimerRef.current = setInterval(async () => {
      try {
        const response = await fetch(`/api/import/${batchId}/approve`);
        const payload = await response.json();
        const job = payload.backgroundJob as BackgroundCommitJobView | null;
        if (!job) return;
        setBackgroundJob(job);
        if (job.state === "RUNNING") {
          setNotice(
            `Background commit in progress — ${job.committedRows} committed, ${job.skippedRows} skipped` +
            (job.remainingRows !== null ? `, ~${job.remainingRows} remaining.` : ".") +
            " You can keep working anywhere in the portal; the commit continues on the server.",
          );
          return;
        }
        stopJobPolling();
        if (job.state === "COMPLETED") {
          setNotice(`Background commit complete: ${job.committedRows} row(s) committed, ${job.skippedRows} skipped.`);
        } else {
          setError(`Background commit failed: ${job.error ?? "unknown error"}. Committed rows are kept; start the commit again to continue the remainder.`);
        }
        setIsCommitting(false);
        setSelectedRows({});
        void refreshBatchWindow();
      } catch {
        // Transient polling error — keep the interval alive and retry.
      }
    }, 2500);
  }

  useEffect(() => {
    // Re-attach to a still-running server-side commit after a navigation away
    // and back, so progress reporting survives page changes.
    if (!batch) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/import/${batch.id}/approve`);
        const payload = await response.json();
        const job = payload.backgroundJob as BackgroundCommitJobView | null;
        if (!cancelled && job?.state === "RUNNING") {
          setBackgroundJob(job);
          setIsCommitting(true);
          startJobPolling(batch.id);
        }
      } catch {
        // No job to re-attach to.
      }
    })();
    return () => {
      cancelled = true;
      stopJobPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id]);

  /**
   * Whole-upload approval runs as a server-side background job: one click
   * approves everything, the server batches the work, and the operator is
   * immediately free to navigate the portal while it completes.
   */
  async function runBackgroundApprove(payloadBase: Record<string, unknown>) {
    if (!batch) return;
    setIsCommitting(true);
    setError(null);
    setNotice("Starting background commit…");
    try {
      const response = await fetch(`/api/import/${batch.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payloadBase, background: true }),
        // keepalive lets this start request complete even if the operator
        // navigates away the instant after clicking — otherwise the browser
        // aborts the in-flight POST before the 202 returns and the server-side
        // job is never registered, so the commit "disconnects" before it runs.
        keepalive: true,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Background commit failed to start.");
      setBackgroundJob(payload.backgroundJob ?? null);
      setNotice("Background commit started. You can navigate away — progress is saved on the server.");
      startJobPolling(batch.id);
    } catch (commitError) {
      setIsCommitting(false);
      setError(commitError instanceof Error ? commitError.message : "Background commit failed to start.");
    }
  }

  function approveClean() {
    void runBackgroundApprove({ sheetName: sheetFilter || null, approveCleanOnly: true });
  }

  function approveSelected() {
    const rowIds = selectedRowIds();
    if (!rowIds.length) {
      setError("Select staged rows before approving selected rows.");
      return;
    }
    // The commit engine only accepts valid, uncommitted rows — pre-filter the
    // selection so committed/blocked rows never silently eat the request.
    const committableIds = new Set(filteredRows.filter(isCommittableRow).map((row) => row.id));
    const eligible = rowIds.filter((id) => committableIds.has(id));
    if (!eligible.length) {
      setError("None of the selected rows are committable. Already-committed, rejected, and blocked rows cannot be approved.");
      return;
    }
    if (eligible.length < rowIds.length) {
      setNotice(`${rowIds.length - eligible.length} selected row(s) are not committable (already committed, rejected, or blocked) and were excluded.`);
    }
    void runApprove({ rowIds: eligible, approveCleanOnly: false, reviewerComment: "Approved selected staging rows after review." });
  }

  function rejectSelected() {
    const rowIds = selectedRowIds();
    if (!rowIds.length) {
      setError("Select staged rows before rejecting rows.");
      return;
    }
    stagingAction("reject", { rowIds, reviewerComment: "Rejected from Import Center review." });
  }

  function flushSelected() {
    const rowIds = selectedRowIds();
    if (!rowIds.length) {
      setError("Select staged rows before flushing rows.");
      return;
    }
    stagingAction("flush", { rowIds, reviewerComment: "Flushed from Import Center review." });
  }

  function flushOne(rowId: string) {
    stagingAction("flush", { rowIds: [rowId], reviewerComment: "Individual staged row flushed from Import Center review." });
  }

  function flushBatch() {
    if (!batch) return;
    if (!window.confirm(`Flush all uncommitted rows in ${batch.batchCode}? Committed live inventory will not be deleted.`)) return;
    stagingAction("flush", { flushAll: true, reviewerComment: "Full uncommitted staging flush from Import Center." });
  }

  function siteCellClass(row: ImportReviewRow, side: "local" | "far") {
    const codes = row.issues.map((issue) => issue.issueCode);
    const missingCode = side === "local" ? "MISSING_LOCAL_SITE_MASTER" : "MISSING_FAR_SITE_MASTER";
    const blockingCode = side === "local" ? "MISSING_LOCAL_SITE" : "MISSING_FAR_ENDPOINT";
    if (codes.includes(blockingCode) || codes.includes(missingCode)) {
      return "rounded-md bg-yellow-100 px-2 py-1 font-semibold text-yellow-950";
    }
    return "rounded-md bg-green-100 px-2 py-1 font-semibold text-green-950";
  }

  function exportReview() {
    if (!batch) return;
    window.location.href = `/api/export?type=import&format=xlsx&batchId=${batch.id}`;
  }

  async function removeUploadBatch(mode: "default" | "stagingOnly" = "default") {
    if (!batch) return;
    setIsRemovingBatch(true);
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (mode === "stagingOnly") params.set("stagingOnly", "true");
      const response = await fetch(`/api/import/batches/${encodeURIComponent(batch.id)}${params.toString() ? `?${params.toString()}` : ""}`, { method: "DELETE" });
      const payload = await response.json();
      if (response.status === 409) {
        setRemoveWarning({
          approvedCount: Number(payload.approvedCount ?? 0),
          message: payload.message ?? "This upload has approved live inventory.",
        });
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "Upload batch removal failed.");
      setRemoveModalOpen(false);
      setRemoveWarning(null);
      setSelectedRows({});
      setQuery("");
      setSheetFilter("");
      setBatch(null);
      setNotice("Upload batch removed");
      toast.deleted(mode === "stagingOnly" ? "Import staging review data" : "Upload batch", { title: "Removed" });
      if (payload.deletedBatch) window.setTimeout(() => window.location.reload(), 900);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Upload batch removal failed.");
    } finally {
      setIsRemovingBatch(false);
    }
  }

  async function importDistance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!distanceFile) {
      setError("Choose a distance CSV/XLSX file first.");
      return;
    }
    setDistanceImporting(true);
    setError(null);
    setDistanceResult(null);
    const formData = new FormData();
    formData.append("file", distanceFile);
    Object.entries(distanceColumns).forEach(([key, value]) => formData.append(key, String(value)));
    try {
      const response = await fetch("/api/import/distance", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Distance import failed.");
      setDistanceResult(payload);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Distance import failed.");
    } finally {
      setDistanceImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">Fiber inventory upload, transformation, and approval</div>
        <div className="subtle mt-1">
          Upload the normalized migration CSV generated by the Python migration script. Rows are staged first, reviewed for warnings, duplicates, missing sites, dummy ports, and splitter records, and only then approved into live inventory.
        </div>
        <div className="mt-3 text-sm text-slate-700 dark:text-slate-200">
          Site master uploads stay separate on the <Link className="font-semibold text-red-700 dark:text-red-200" href="/sites">Site Database</Link> page.
        </div>

        <form className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center" onSubmit={upload}>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Select normalized inventory CSV</span>
            <input
              className="input-dark w-full"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
            />
          </label>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-50" type="submit" disabled={!file || isUploading}>
            {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload
          </button>
          <button className="btn btn-ghost" type="button" disabled={!batch || isValidating} onClick={validate}>
            {isValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Validate
          </button>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!batch || isCommitting} onClick={approveClean}>
            {isCommitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            {sheetFilter ? "Approve Clean In Sheet" : "Approve All Clean"}
          </button>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl border border-cyan-300/50 bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!batch || isCommitting || !selectedRowIds().length} onClick={approveSelected}>
            <CheckCircle2 className="h-4 w-4" />
            Approve Selected
          </button>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl border border-amber-300/50 bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!batch || isCommitting || !selectedRowIds().length} onClick={rejectSelected}>
            <XCircle className="h-4 w-4" />
            Reject Selected
          </button>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl border border-red-300/50 bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!batch || isCommitting || !selectedRowIds().length} onClick={flushSelected}>
            <Trash2 className="h-4 w-4" />
            Flush Selected
          </button>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl border border-border bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 disabled:opacity-50 dark:bg-slate-900 dark:text-white" type="button" disabled={!batch || isCommitting} onClick={flushBatch}>
            Flush Batch
          </button>
          <button className="btn btn-ghost" type="button" disabled={!batch} onClick={exportReview}>
            <Download className="h-4 w-4" />
            Export Review
          </button>
        </form>

        {error ? <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm font-medium text-rose-800 dark:text-rose-100">{error}</div> : null}
        {notice ? <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-950 dark:text-emerald-100">{notice}</div> : null}
        {backgroundJob?.state === "RUNNING" ? (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3 text-sm text-cyan-900 dark:text-cyan-100">
            <Loader2 className="h-4 w-4 flex-none animate-spin" />
            <div>
              <div className="font-semibold">Background commit running on the server</div>
              <div className="mt-0.5">
                {backgroundJob.committedRows} committed · {backgroundJob.skippedRows} skipped
                {backgroundJob.remainingRows !== null ? ` · ~${backgroundJob.remainingRows} remaining` : ""}
                . Feel free to navigate to other portal pages — committed rows keep flowing into ODF Mappings.
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="card p-5">
        <div className="section-title">Distance import</div>
        <div className="subtle mt-1">Import segment-level distances from CSV/XLSX. Site A - Site B and Site B - Site A are matched as the same active segment pair.</div>
        <form className="mt-4 grid gap-3 lg:grid-cols-6" onSubmit={importDistance}>
          <input className="input-dark lg:col-span-2" type="file" accept=".csv,.xlsx,.xls" onChange={(event) => setDistanceFile(event.target.files?.[0] ?? null)} />
          {[
            ["nearColumn", "Near site column"],
            ["farColumn", "Far site column"],
            ["distanceColumn", "Distance km column"],
            ["remarksColumn", "Route/remarks column"],
          ].map(([key, label]) => (
            <input
              key={key}
              className="input-dark"
              value={String(distanceColumns[key as keyof typeof distanceColumns] ?? "")}
              onChange={(event) => setDistanceColumns((current) => ({ ...current, [key]: event.target.value }))}
              placeholder={label}
            />
          ))}
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={distanceColumns.overwrite} onChange={(event) => setDistanceColumns((current) => ({ ...current, overwrite: event.target.checked }))} />
            Overwrite existing distance
          </label>
          <button className="inline-flex items-center justify-center gap-2 rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50" disabled={!distanceFile || distanceImporting}>
            {distanceImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Import Distance
          </button>
        </form>
        {distanceResult ? (
          <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-950 dark:text-emerald-100">
            Updated {distanceResult.updatedSegments} segment(s) from {distanceResult.matchedRows} matched row(s). Unmatched rows: {distanceResult.unmatchedRows?.length ?? 0}.
          </div>
        ) : null}
      </div>

      {batch ? (
        <>
          <div className="grid gap-4 md:grid-cols-5">
            {[
              ["Status", batch.status],
              ["Rows", batch.totalRows],
              ["Valid", batch.validRows],
              ["Warnings", batch.warningRows],
              ["Committed", batch.committedRows],
            ].map(([label, value]) => (
              <div key={label} className="card p-4">
                <div className="text-xs uppercase tracking-[0.14em] text-slate-400">{label}</div>
                <div className="mt-2 text-2xl font-semibold text-[var(--text-strong)]">{value}</div>
              </div>
            ))}
          </div>

          <div className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">{batch.fileName}</div>
                <div className="subtle mt-1">{batch.batchCode} - all workbook sheets are staged; choose a sheet or review all rows before commit.</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-900 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-100"
                  type="button"
                  onClick={() => setStageOverlayOpen(true)}
                >
                  <Database className="h-4 w-4" />
                  Full Review Overlay
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-xl border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-950 dark:text-red-200"
                  type="button"
                  onClick={() => {
                    setRemoveModalOpen(true);
                    setRemoveWarning(null);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Remove Upload
                </button>
                <select className="input-dark" value={sheetFilter} onChange={(event) => setSheetFilter(event.target.value)}>
                  <option value="">All sheets</option>
                  {sheetSummaries.map((sheet) => (
                    <option key={sheet.sheetName} value={sheet.sheetName}>{sheet.sheetName} ({sheet.count})</option>
                  ))}
                </select>
                <input className="input-dark min-w-[280px]" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter imported rows" />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {sheetSummaries.map((sheet) => (
                <button
                  key={sheet.sheetName}
                  className={`rounded-full border px-3 py-1 ${sheetFilter === sheet.sheetName ? "border-red-300 bg-red-600 text-white" : "border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"}`}
                  onClick={() => setSheetFilter(sheet.sheetName)}
                >
                  {sheet.sheetName}: {sheet.count}
                </button>
              ))}
              {sheetFilter ? <button className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200" onClick={() => setSheetFilter("")}>Show all sheets</button> : null}
            </div>

            <div className="table-shell mt-5 max-h-[620px] overflow-auto">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={filteredRows.some(isSelectableRow) && filteredRows.filter(isSelectableRow).every((row) => selectedRows[row.id])}
                        onChange={(event) => toggleVisibleRows(event.target.checked)}
                        aria-label="Select visible rows"
                      />
                    </th>
                    <th>Row</th>
                    <th>Sheet</th>
                    <th>Class</th>
                    <th>Source Site</th>
                    <th>Rack</th>
                    <th>ODF</th>
                    <th>Port Pair</th>
                    <th>Far Site</th>
                    <th>Far Rack</th>
                    <th>Far ODF</th>
                    <th>Far Port</th>
                    <th>Service</th>
                    <th>Direction</th>
                    <th>Match</th>
                    <th>Status</th>
                    <th>Commit Decision</th>
                    <th>Raw Source Row</th>
                    <th>Normalized Row</th>
                    <th>Issues</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.slice(0, rowRenderLimit).map((row) => (
                    <tr key={row.id} className={row.status === "COMMITTED" ? "import-row-committed" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(selectedRows[row.id]) && isSelectableRow(row)}
                          disabled={!isSelectableRow(row)}
                          onChange={(event) => setSelectedRows((current) => ({ ...current, [row.id]: event.target.checked }))}
                          aria-label={`Select row ${row.rowNumber}`}
                        />
                      </td>
                      <td>{row.rowNumber}</td>
                      <td>{row.sourceSheet ?? "-"}</td>
                      <td>{row.statusHint ?? "-"}</td>
                      <td><span className={siteCellClass(row, "local")}>{row.sourceSiteCanonical ?? row.sourceSiteRaw ?? "-"}</span></td>
                      <td>{row.rackCode ?? "-"}</td>
                      <td>{row.odfCode ?? "-"}</td>
                      <td>{row.portGroupLabel ?? "-"}</td>
                      <td><span className={siteCellClass(row, "far")}>{row.farSiteCanonical ?? row.farSiteRaw ?? "-"}</span></td>
                      <td>{row.farRackCode ?? "-"}</td>
                      <td>{row.farOdfCode ?? "-"}</td>
                      <td>{row.farPortGroupLabel ?? "-"}</td>
                      <td>{row.serviceIdResolved ?? "-"}</td>
                      <td>{row.directionText ?? "-"}</td>
                      <td>{row.matchStatus ?? "-"}</td>
                      <td>{row.status}</td>
                      <td><DecisionCell row={row} /></td>
                      <td className="max-w-[360px] font-mono text-xs text-slate-300">{shortJson(row.rawJson)}</td>
                      <td className="max-w-[360px] font-mono text-xs text-slate-300">{shortJson(row.normalizedJson)}</td>
                      <td>
                        {row.issues.length ? (
                          <span className="text-amber-700 dark:text-amber-200">{row.issues.map((issue) => issue.issueCode).join(", ")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3 w-3" /> Clean</span>
                        )}
                      </td>
                      <td>
                        <button className="rounded-lg border border-red-300/50 bg-red-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={row.status === "COMMITTED"} onClick={() => flushOne(row.id)}>
                          Delete staged row
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredRows.length > rowRenderLimit ? (
              <button
                className="mt-3 rounded-lg border border-[var(--border-strong)] px-4 py-2.5 text-sm font-semibold"
                onClick={() => setRowRenderLimit((current) => current + ROW_RENDER_STEP)}
              >
                Show {ROW_RENDER_STEP} more rows ({filteredRows.length - rowRenderLimit} of {batch.totalRows} not rendered)
              </button>
            ) : null}
            {batch.totalRows > (batch.rows?.length ?? 0) ? (
              <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                Review table hydrated with the first {batch.rows.length} of {batch.totalRows} staged rows. Validation and commit always process the entire batch.
              </div>
            ) : null}

            {batch.committedRows > 0 ? (
              <Link className="mt-4 inline-flex rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950" href="/inventory">
                View committed rows in Inventory
              </Link>
            ) : null}
          </div>
        </>
      ) : (
        <div className="card p-8 text-sm text-slate-300">Upload the workbook to stage ODF mappings for review.</div>
      )}
      {stageOverlayOpen && batch ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
          <div className="flex h-[92vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4" style={{ backgroundColor: "#b9f9e9" }}>
              <div>
                <div className="text-lg font-bold text-[var(--text-strong)]">Inventory Upload Staging Review</div>
                <div className="text-xs text-slate-400">{batch.fileName} · {batch.batchCode} · explicit commit required before live DB mutation</div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-[var(--border-strong)] px-3 py-1 text-[var(--muted-text)]">Rows: {filteredRows.length}</span>
                <span className="rounded-full border border-emerald-600/40 px-3 py-1 text-emerald-700 dark:text-emerald-200">Valid: {batch.validRows}</span>
                <span className="rounded-full border border-amber-600/40 px-3 py-1 text-amber-700 dark:text-amber-200">Warnings: {batch.warningRows}</span>
                <span className="rounded-full border border-red-600/40 px-3 py-1 text-red-700 dark:text-red-200">Errors: {batch.errorRows}</span>
                <button className="btn btn-ghost btn-compact" onClick={() => setStageOverlayOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4" style={{ backgroundColor: "#e1d6d6" }}>
              <table className="w-full min-w-[1700px] table-fixed border-collapse text-left text-xs">
                <colgroup>
                  <col className="w-12" />
                  <col className="w-16" />
                  <col className="w-36" />
                  <col className="w-44" />
                  <col className="w-56" />
                  <col className="w-44" />
                  <col className="w-56" />
                  <col className="w-56" />
                  <col className="w-28" />
                  <col className="w-44" />
                  <col className="w-[340px]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-slate-900 text-slate-300">
                  <tr>
                    <th className="p-3"><input type="checkbox" checked={filteredRows.some(isSelectableRow) && filteredRows.filter(isSelectableRow).every((row) => selectedRows[row.id])} onChange={(event) => toggleVisibleRows(event.target.checked)} /></th>
                    <th className="p-3">Row</th>
                    <th className="p-3">Sheet</th>
                    <th className="p-3">Source Site</th>
                    <th className="p-3">Rack / ODF / Port</th>
                    <th className="p-3">Far Site</th>
                    <th className="p-3">Far Rack / ODF / Port</th>
                    <th className="p-3">Service</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 whitespace-normal break-words">Commit Decision</th>
                    <th className="p-3 whitespace-normal break-words">Issues / Validation Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--table-border)] text-[var(--text-main)]">
                  {filteredRows.slice(0, rowRenderLimit).map((row) => (
                    <tr key={`overlay-${row.id}`} className={row.status === "COMMITTED" ? "import-row-committed" : "hover:bg-slate-900/60"}>
                      <td className="p-3"><input type="checkbox" checked={Boolean(selectedRows[row.id]) && isSelectableRow(row)} disabled={!isSelectableRow(row)} onChange={(event) => setSelectedRows((current) => ({ ...current, [row.id]: event.target.checked }))} /></td>
                      <td className="p-3 font-mono">{row.rowNumber}</td>
                      <td className="p-3">{row.sourceSheet ?? "-"}</td>
                      <td className="p-3">{row.sourceSiteCanonical ?? row.sourceSiteRaw ?? "-"}</td>
                      <td className="p-3">{[row.rackCode, row.odfCode, row.portGroupLabel].filter(Boolean).join(" / ") || "-"}</td>
                      <td className="p-3">{row.farSiteCanonical ?? row.farSiteRaw ?? "-"}</td>
                      <td className="p-3">{[row.farRackCode, row.farOdfCode, row.farPortGroupLabel].filter(Boolean).join(" / ") || "-"}</td>
                      <td className="p-3">{row.serviceIdResolved ?? "-"}</td>
                      <td className="p-3">{row.status}</td>
                      <td className="p-3 align-top font-semibold whitespace-normal break-words"><DecisionCell row={row} /></td>
                      <td className="p-3 align-top whitespace-normal break-words leading-relaxed text-amber-800 dark:text-amber-100" style={{ overflowWrap: "anywhere" }}>{row.issues.length ? row.issues.map((issue) => `${issue.issueCode}: ${issue.message}`).join(" | ") : "Clean"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredRows.length > rowRenderLimit ? (
                <button
                  className="mt-3 rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200"
                  onClick={() => setRowRenderLimit((current) => current + ROW_RENDER_STEP)}
                >
                  Show {ROW_RENDER_STEP} more rows ({filteredRows.length - rowRenderLimit} remaining)
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-5 py-4">
              <div className="text-xs text-slate-400">Commit only after reviewing validation flags. Selected rows can be committed independently. Commit always processes the entire batch of {batch.totalRows} staged rows.</div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ghost" onClick={() => setStageOverlayOpen(false)}>Continue Reviewing</button>
                <button className="btn bg-emerald-600 text-white" disabled={isCommitting} onClick={approveClean}>Commit All Clean Rows</button>
                <button className="btn bg-cyan-600 text-white" disabled={isCommitting || !selectedRowIds().length} onClick={approveSelected}>Commit Selected Rows</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {removeModalOpen && batch ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="text-lg font-semibold">Remove Upload Batch</div>
            <div className="mt-2 text-sm text-slate-700 dark:text-slate-200">
              Remove this uploaded file and all staged review data? Approved live inventory will remain in place.
            </div>
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="font-semibold">{batch.fileName}</div>
              <div className="text-xs text-slate-600 dark:text-slate-300">{batch.batchCode}</div>
            </div>
            {removeWarning ? (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
                <div className="font-semibold">{removeWarning.message}</div>
                <div className="mt-1">This upload has approved live inventory. Only staging review data can be removed from this dialog.</div>
                <div className="mt-1 text-xs">{removeWarning.approvedCount} approved row(s) remain linked to this upload.</div>
              </div>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setRemoveModalOpen(false)} disabled={isRemovingBatch}>
                Cancel
              </button>
              <button
                className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50 dark:border-red-800 dark:bg-slate-950 dark:text-red-200"
                onClick={() => removeUploadBatch(removeWarning ? "stagingOnly" : "default")}
                disabled={isRemovingBatch}
              >
                {isRemovingBatch ? "Removing..." : "Remove Staging Only"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
