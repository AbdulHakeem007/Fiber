"use client";

import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { CheckCircle2, FileSpreadsheet, Loader2, RefreshCw, Upload } from "lucide-react";

interface UploadResponse {
  id?: string;
  fileName?: string;
  status?: string;
  totalRows?: number;
  validRows?: number;
  warningRows?: number;
  errorRows?: number;
  error?: string;
}

function getErrorMessage(payload: UploadResponse | null, fallback: string): string {
  return payload?.error || fallback;
}

export function LegacyUploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  const canValidate = Boolean(batchId && !isUploading && !isValidating);
  const rowSummary = useMemo(() => {
    if (!result || result.totalRows === undefined) return null;
    return `${result.totalRows} rows, ${result.validRows ?? 0} valid, ${result.warningRows ?? 0} warnings, ${result.errorRows ?? 0} errors`;
  }, [result]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setError(null);
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose the Current ODF Template workbook first.");
      return;
    }

    setIsUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/import/upload", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => null)) as UploadResponse | null;

      if (!response.ok || !payload?.id) {
        throw new Error(getErrorMessage(payload, "Upload failed."));
      }

      setBatchId(payload.id);
      setResult(payload);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleValidate() {
    if (!batchId) return;

    setIsValidating(true);
    setError(null);

    try {
      const response = await fetch("/api/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId }),
      });
      const payload = (await response.json().catch(() => null)) as UploadResponse | null;

      if (!response.ok || !payload?.id) {
        throw new Error(getErrorMessage(payload, "Validation failed."));
      }

      setResult(payload);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "Validation failed.");
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]">
        <FileSpreadsheet className="h-4 w-4 text-cyan-300" />
        Import legacy workbook
      </div>

      <form className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center" onSubmit={handleUpload}>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Select workbook</span>
          <input
            className="input-dark w-full"
            type="file"
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileChange}
          />
        </label>
        <button
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={!file || isUploading}
        >
          {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={!canValidate}
          onClick={handleValidate}
        >
          {isValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Validate
        </button>
      </form>

      {result ? (
        <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            {result.fileName ?? "Workbook"} is staged as {result.status ?? "UPLOADED"}
          </div>
          {rowSummary ? <div className="mt-1 text-emerald-200/80">{rowSummary}</div> : null}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm font-medium text-rose-800 dark:text-rose-100">{error}</div>
      ) : null}
    </div>
  );
}
