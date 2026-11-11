"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Database, Download, Eye, FileText, Loader2, Network, Plus, Save, Search, Trash2, Upload } from "lucide-react";
import { REGION_OPTIONS, matchesRegionPrefix, normalizeRegionPrefix, regionForSiteCode } from "@/lib/config/regions";
import { PAGE_SIZE_OPTIONS, SITE_STATUS_OPTIONS, SITE_TYPE_OPTIONS, SITE_CRITICALITY_OPTIONS, TOWER_STRUCTURE_OPTIONS, COLOCATION_TYPE_OPTIONS } from "@/lib/config/ui";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { BulkOdfInventoryModal } from "@/components/odf/bulk-odf-inventory-modal";
import { StatusBanner, useStatusMessage } from "@/components/ui/status-message";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { SiteConnectivitySummary } from "@/types/site-connectivity";

type SiteDocumentType = "FDD" | "ODF_PHOTO" | "OTDR_REPORT";

interface SiteDocumentAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  uploadedAt: string;
  remarks?: string | null;
}

interface SiteDirectoryRow {
  id: string;
  code: string;
  name?: string | null;
  region?: string | null;
  city?: string | null;
  siteType?: string | null;
  label?: string | null;
  siteStructure?: string | null;
  colocationType?: string | null;
  colocationOwner?: string | null;
  coordinateX?: number | null;
  coordinateY?: number | null;
  status: string;
  docStatus?: Record<SiteDocumentType, boolean>;
  documents?: Record<SiteDocumentType, SiteDocumentAttachment | null>;
  _count: {
    racks: number;
    odfs: number;
    portGroups: number;
    segmentEndpoints: number;
  };
  criticalityTags?: Array<{ tag: { label: string } }>;
}

const SITE_DOCUMENT_TYPES: Array<{ type: SiteDocumentType; label: string }> = [
  { type: "OTDR_REPORT", label: "OTDR" },
  { type: "FDD", label: "FDD" },
  { type: "ODF_PHOTO", label: "ODF Photos" },
];

function isGeneratedNameCode(code: string, name?: string | null): boolean {
  if (!name?.trim()) return false;
  const normalizedName = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalizedName === code.toUpperCase() && !/\d/.test(code);
}

function compactKey(value?: string | null): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function primarySiteLabel(site: SiteDirectoryRow): string {
  // displaySiteLabel strips a leading "To" and renders Site-ID-first, so legacy
  // names like "To MU0170" / "To MU5905(RCA)" show cleanly as "MU0170" /
  // "MU5905 (RCA)" — the Site ID is always the authoritative primary label.
  const cleaned = site.name?.trim() ? displaySiteLabel(site.name, site.code) : null;
  return cleaned && cleaned !== "-" ? cleaned : displaySiteLabel(site.code);
}

function secondarySiteLabel(site: SiteDirectoryRow): string | null {
  // Only surface the raw Site ID as a secondary chip when the primary label adds
  // a descriptive legacy name on top of the code (avoids "MU0170 / MU0170").
  if (compactKey(primarySiteLabel(site)) === compactKey(site.code)) return null;
  if (site.name?.trim()) return site.code;
  if (isGeneratedNameCode(site.code, site.name)) return site.code;
  return null;
}

export function SiteDirectory({
  initialSites,
  initialSearch = "",
  initialRegionPrefix = "",
  selectedConnectivity = null,
  canDelete = false,
  canBulkDelete = false,
  canUpload = false,
}: {
  initialSites: SiteDirectoryRow[];
  initialSearch?: string;
  initialRegionPrefix?: string;
  selectedConnectivity?: SiteConnectivitySummary | null;
  canDelete?: boolean;
  canBulkDelete?: boolean;
  canUpload?: boolean;
}) {
  const router = useRouter();
  const [sites, setSites] = useState(initialSites);
  const [query, setQuery] = useState(initialSearch);
  const [regionPrefix, setRegionPrefix] = useState(normalizeRegionPrefix(initialRegionPrefix));
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [siteImportFile, setSiteImportFile] = useState<File | null>(null);
  const [selectedSiteIds, setSelectedSiteIds] = useState<Record<string, boolean>>({});
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [uploadSite, setUploadSite] = useState<SiteDirectoryRow | null>(null);
  const [uploadDocumentType, setUploadDocumentType] = useState<SiteDocumentType>("OTDR_REPORT");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadRemarks, setUploadRemarks] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [pendingDocumentDelete, setPendingDocumentDelete] = useState<{
    document: SiteDocumentAttachment;
    label: string;
    siteLabel: string;
  } | null>(null);
  const [isDeletingDocument, setIsDeletingDocument] = useState(false);
  const [editor, setEditor] = useState({
    code: "",
    name: "",
    region: "",
    city: "",
    siteType: "",
    label: "",
    siteCriticality: "",
    siteStructure: "",
    colocationType: "",
    colocationOwner: "",
    coordinateX: "",
    coordinateY: "",
    status: "ACTIVE",
    remarks: "",
  });
  const { status, showSuccess, showError, clear: clearStatus } = useStatusMessage();
  const toast = useToast();
  // In-flight guards prevent double-submits and drive button spinners.
  const [isSavingSite, setIsSavingSite] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  // After a NEW site is created, ask whether the operator wants to add ODF/rack
  // inventory right away; "Yes" raises the Bulk ODF modal on this same page.
  const [postAddPrompt, setPostAddPrompt] = useState<{ code: string; name: string } | null>(null);
  const [bulkOdfSite, setBulkOdfSite] = useState<{ code: string; name: string } | null>(null);
  // Styled confirm for single-site delete (replaces native window.confirm).
  const [pendingSiteDelete, setPendingSiteDelete] = useState<SiteDirectoryRow | null>(null);
  const [isDeletingSite, setIsDeletingSite] = useState(false);

  const filteredSites = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return sites.filter((site) => {
      if (!matchesRegionPrefix(site.code, regionPrefix)) return false;
      if (!needle) return true;
      const haystack = [
        site.code,
        site.name,
        site.region,
        site.city,
        site.siteType,
      site.label,
      site.criticalityTags?.map((assignment) => assignment.tag.label).join(" "),
      site.siteStructure,
      site.colocationType,
      site.colocationOwner,
      site.status,
      ].filter(Boolean).join(" ").toUpperCase();
      return haystack.includes(needle);
    });
  }, [sites, query, regionPrefix]);

  const pageCount = Math.max(1, Math.ceil(filteredSites.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleSites = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredSites.slice(start, start + pageSize);
  }, [filteredSites, currentPage, pageSize]);
  const selectedVisibleSites = visibleSites.filter((site) => selectedSiteIds[site.id]);
  const selectedSiteCount = selectedVisibleSites.length;

  useEffect(() => {
    setSelectedSiteIds({});
  }, [currentPage, pageSize, query, regionPrefix]);

  async function refreshSites() {
    const refreshed = await fetch("/api/sites");
    const refreshedPayload = await refreshed.json();
    setSites(refreshedPayload.sites ?? sites);
  }

  function SiteDocLight({ document, label, siteLabel }: { document?: SiteDocumentAttachment | null; label: string; siteLabel: string }) {
    const present = Boolean(document);
    const previewHref = document ? `/api/attachments/${document.id}/download?preview=1` : undefined;
    const downloadHref = document ? `/api/attachments/${document.id}/download` : undefined;
    return (
      <div className="inline-flex items-center gap-2 text-xs" title={document ? `${label}: ${document.originalFilename}` : `${label}: missing`}>
        <span className="inline-flex min-w-[6rem] items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: present ? "#22c55e" : "#ef4444" }}
          />
          {label}
        </span>
        <span className="inline-flex items-center gap-1">
          {document ? (
            <>
              <a
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:border-cyan-300 hover:text-cyan-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-200"
                href={previewHref}
                target="_blank"
                rel="noreferrer"
                aria-label={`View ${label} for ${document.originalFilename}`}
                title={`View ${document.originalFilename}`}
              >
                <Eye className="h-3.5 w-3.5" />
              </a>
              <a
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:border-emerald-300 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-emerald-600 dark:hover:text-emerald-200"
                href={downloadHref}
                download
                aria-label={`Download ${label} file ${document.originalFilename}`}
                title={`Download ${document.originalFilename}`}
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              {canUpload ? (
                <button
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-red-200 bg-white text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 dark:border-red-900/70 dark:bg-slate-950 dark:text-red-200 dark:hover:border-red-700 dark:hover:bg-red-950/30"
                  type="button"
                  onClick={() => setPendingDocumentDelete({ document, label, siteLabel })}
                  aria-label={`Delete ${label} file ${document.originalFilename}`}
                  title={`Delete ${document.originalFilename}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </>
          ) : (
            <span className="inline-flex items-center gap-1 text-slate-400 dark:text-slate-600" aria-label={`${label} actions unavailable`}>
              <Eye className="h-3.5 w-3.5" />
              <Download className="h-3.5 w-3.5" />
            </span>
          )}
        </span>
      </div>
    );
  }

  async function deleteSiteDocument() {
    if (!pendingDocumentDelete) return;
    setIsDeletingDocument(true);
    clearStatus();
    try {
      const response = await fetch(`/api/attachments/${pendingDocumentDelete.document.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Document delete failed.");
      await refreshSites();
      showSuccess(`${pendingDocumentDelete.label} document "${pendingDocumentDelete.document.originalFilename}" deleted from ${pendingDocumentDelete.siteLabel}.`);
      toast.deleted(`${pendingDocumentDelete.label} document "${pendingDocumentDelete.document.originalFilename}"`, { title: `Removed from ${pendingDocumentDelete.siteLabel}` });
      setPendingDocumentDelete(null);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Document delete failed.");
    } finally {
      setIsDeletingDocument(false);
    }
  }

  async function uploadSiteDocument() {
    if (!uploadSite || !uploadFile) {
      showError("Choose a site and file before uploading.");
      return;
    }
    setIsUploading(true);
    clearStatus();
    try {
      const formData = new FormData();
      formData.set("siteId", uploadSite.id);
      formData.set("documentType", uploadDocumentType);
      formData.set("remarks", uploadRemarks);
      formData.set("file", uploadFile);
      const response = await fetch("/api/attachments/upload", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Document upload failed.");
      await refreshSites();
      showSuccess(`${SITE_DOCUMENT_TYPES.find((item) => item.type === uploadDocumentType)?.label ?? "Document"} uploaded for ${primarySiteLabel(uploadSite)}.`);
      setUploadSite(null);
      setUploadFile(null);
      setUploadRemarks("");
      setUploadDocumentType("OTDR_REPORT");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Document upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  function resetEditor() {
    setEditingCode(null);
    setEditor({
      code: "",
      name: "",
      region: "",
      city: "",
      siteType: "",
      label: "",
      siteCriticality: "",
      siteStructure: "",
      colocationType: "",
      colocationOwner: "",
      coordinateX: "",
      coordinateY: "",
      status: "ACTIVE",
      remarks: "",
    });
  }

  async function saveSite() {
    if (isSavingSite) return;
    clearStatus();
    const wasCreate = !editingCode;
    setIsSavingSite(true);
    try {
      const endpoint = editingCode ? `/api/sites/${encodeURIComponent(editingCode)}` : "/api/sites";
      const response = await fetch(endpoint, {
        method: editingCode ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editor),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Site save failed.");
      await refreshSites();
      resetEditor();
      const change = payload.codeChange;
      if (change?.action === "MERGED") {
        showSuccess(`Merged site ${change.mergedFromCode} into existing site ${change.code} (data unified).`);
      } else if (change?.action === "RENAMED") {
        showSuccess(`Renamed legacy code to ${change.code}. The old code still resolves via an alias.`);
      } else {
        showSuccess(`${editingCode ? "Updated" : "Created"} site ${payload.site.code}.`);
        // Fresh site created — offer to add ODF & rack inventory without leaving.
        if (wasCreate && payload.site?.code) {
          setPostAddPrompt({ code: payload.site.code, name: payload.site.name ?? payload.site.code });
        }
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Site save failed.");
    } finally {
      setIsSavingSite(false);
    }
  }

  function editSite(site: SiteDirectoryRow) {
    setEditingCode(site.code);
    setEditor({
      code: site.code,
      name: site.name ?? "",
      region: site.region ?? "",
      city: site.city ?? "",
      siteType: site.siteType ?? "",
      label: site.label ?? "",
      siteCriticality: site.criticalityTags?.map((assignment) => assignment.tag.label).join(", ") || "",
      siteStructure: site.siteStructure ?? "",
      colocationType: site.colocationType ?? "",
      colocationOwner: site.colocationOwner ?? "",
      coordinateX: site.coordinateX === null || site.coordinateX === undefined ? "" : String(site.coordinateX),
      coordinateY: site.coordinateY === null || site.coordinateY === undefined ? "" : String(site.coordinateY),
      status: site.status,
      remarks: "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function requestDeleteSite(site: SiteDirectoryRow) {
    if (!canDelete) return;
    setPendingSiteDelete(site);
  }

  async function confirmDeleteSite() {
    const site = pendingSiteDelete;
    if (!canDelete || !site) return;
    clearStatus();
    setIsDeletingSite(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(site.code)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Site delete failed.");
      setSites((current) => current.filter((item) => item.code !== site.code));
      const deletedCode = payload.deletedCode ?? site.code;
      const mergedCount = Number(payload.segmentsMerged ?? 0);
      const mergedCodes = Array.isArray(payload.mergedSegments)
        ? payload.mergedSegments.map((m: { mergedSegmentCode?: string }) => m.mergedSegmentCode).filter(Boolean)
        : [];
      const mergeNote = mergedCount
        ? ` Pass-through chain reconnected via reverse split${mergedCodes.length ? ` (${mergedCodes.join(", ")})` : ""}.`
        : "";
      showSuccess(`Deleted site ${deletedCode}.${mergeNote}`);
      toast.deleted(`Site ${deletedCode}`, mergedCount ? { title: "Chain reconnected (reverse split)" } : undefined);
      setPendingSiteDelete(null);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Site delete failed.");
    } finally {
      setIsDeletingSite(false);
    }
  }

  async function deleteSelectedSites() {
    if (!canBulkDelete || !selectedSiteCount) return;
    clearStatus();
    try {
      for (const site of selectedVisibleSites) {
        const response = await fetch(`/api/sites/${encodeURIComponent(site.code)}`, { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `Site delete failed for ${site.code}.`);
      }
      const deletedCount = selectedSiteCount;
      setSites((current) => current.filter((site) => !selectedSiteIds[site.id]));
      setSelectedSiteIds({});
      setConfirmBulkDelete(false);
      showSuccess(`${deletedCount} rows deleted`);
      toast.deleted(`${deletedCount} site${deletedCount === 1 ? "" : "s"}`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Selected site delete failed.");
    }
  }

  async function importMasterSites() {
    if (isImporting) return;
    if (!siteImportFile) {
      showError("Choose a master site Excel or CSV file first.");
      return;
    }
    clearStatus();
    setIsImporting(true);
    try {
      const formData = new FormData();
      formData.set("file", siteImportFile);
      const response = await fetch("/api/sites/import", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Master site import failed.");
      await refreshSites();
      setSiteImportFile(null);
      showSuccess(`Master site import complete: ${payload.created} created, ${payload.updated} updated, ${payload.skipped} skipped across ${payload.sheets?.length ?? 0} sheet(s).`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Master site import failed.");
    } finally {
      setIsImporting(false);
    }
  }

  function runSiteSearch() {
    const value = query.trim();
    const params = new URLSearchParams();
    if (value) params.set("search", value);
    if (regionPrefix) params.set("regionPrefix", regionPrefix);
    router.push(params.toString() ? (`/sites?${params.toString()}` as any) : "/sites");
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[280px] flex-1">
            <input
              className="input-dark w-full"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSiteSearch();
              }}
              placeholder="Search master site list — press Enter"
            />
          </div>
          <button className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2.5 text-sm font-semibold text-white" onClick={runSiteSearch}>
            <Search className="h-4 w-4" />
            Search Master
          </button>
          <select className="input-dark" value={regionPrefix} onChange={(event) => { setRegionPrefix(normalizeRegionPrefix(event.target.value)); setPage(1); }}>
            <option value="">Region: All</option>
            {REGION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <StatusBanner status={status} onDismiss={clearStatus} className="mt-3" />
      </div>

      <div className="card p-5">
        <div className="section-title">{editingCode ? `Update site ${sites.find((site) => site.code === editingCode)?.name || editingCode}` : "Create or update site master record"}</div>
        <div className="subtle mt-1">Use the master site list for planning, ownership, location, region, and future operational configuration.</div>
        <div className="mt-4 grid gap-3 md:grid-cols-4 xl:grid-cols-10">
          <label className="flex flex-col gap-1">
            <span className="field-label">Legacy code <span className="font-normal normal-case tracking-normal text-slate-400">(optional)</span></span>
            <input className="input-dark" value={editor.code} onChange={(event) => setEditor({ ...editor, code: event.target.value })} placeholder="Legacy site code" title={editingCode ? "Editing renames the site's code and keeps the old code resolvable. If the new code already belongs to another site, the two are merged." : undefined} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Site ID</span>
            <input className="input-dark" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="Site ID" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Region</span>
            <select className="input-dark" value={editor.region} onChange={(event) => setEditor({ ...editor, region: event.target.value })}>
              <option value="">Region by site code</option>
              {REGION_OPTIONS.map((option) => (
                <option key={option.value} value={option.regionName}>{option.label}</option>
              ))}
            </select>
            {!editor.region.trim() ? (() => {
              // Mirror the server's derivation: when Region is left blank the portal
              // auto-assigns from the site-code prefix (MU→Muscat, BA→Batinah, …).
              // This is a read-only preview of that behaviour — no logic runs here.
              const derivedCode = (editor.code.trim() || editor.name.trim()).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
              const autoRegion = regionForSiteCode(derivedCode);
              return (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {autoRegion ? `Auto: ${autoRegion}` : "Auto: none — set manually"}
                </span>
              );
            })() : null}
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">City</span>
            <input className="input-dark" value={editor.city} onChange={(event) => setEditor({ ...editor, city: event.target.value })} placeholder="City" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Site type</span>
            <select className="input-dark" value={editor.siteType} onChange={(event) => setEditor({ ...editor, siteType: event.target.value })}>
              <option value="">Site type</option>
              {editor.siteType && !(SITE_TYPE_OPTIONS as readonly string[]).includes(editor.siteType) ? <option value={editor.siteType}>{editor.siteType} (existing)</option> : null}
              {SITE_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Criticality</span>
            <select className="input-dark" value={editor.siteCriticality} onChange={(event) => setEditor({ ...editor, siteCriticality: event.target.value })}>
              <option value="">Site criticality</option>
              {editor.siteCriticality && !(SITE_CRITICALITY_OPTIONS as readonly string[]).includes(editor.siteCriticality) ? <option value={editor.siteCriticality}>{editor.siteCriticality} (existing)</option> : null}
              {SITE_CRITICALITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Tower structure</span>
            <select className="input-dark" value={editor.siteStructure} onChange={(event) => setEditor({ ...editor, siteStructure: event.target.value })}>
              <option value="">Tower structure</option>
              {editor.siteStructure && !(TOWER_STRUCTURE_OPTIONS as readonly string[]).includes(editor.siteStructure) ? <option value={editor.siteStructure}>{editor.siteStructure} (existing)</option> : null}
              {TOWER_STRUCTURE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Colocation type</span>
            <select className="input-dark" value={editor.colocationType} onChange={(event) => setEditor({ ...editor, colocationType: event.target.value })}>
              <option value="">Colocation type</option>
              {editor.colocationType && !(COLOCATION_TYPE_OPTIONS as readonly string[]).includes(editor.colocationType) ? <option value={editor.colocationType}>{editor.colocationType} (existing)</option> : null}
              {COLOCATION_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Colocation owner</span>
            <input className="input-dark" value={editor.colocationOwner} onChange={(event) => setEditor({ ...editor, colocationOwner: event.target.value })} placeholder="Colocation owner" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Coordinate X</span>
            <input className="input-dark" value={editor.coordinateX} onChange={(event) => setEditor({ ...editor, coordinateX: event.target.value })} placeholder="Coordinates X" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Coordinate Y</span>
            <input className="input-dark" value={editor.coordinateY} onChange={(event) => setEditor({ ...editor, coordinateY: event.target.value })} placeholder="Coordinates Y" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Status</span>
            <select className="input-dark" value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value })}>
              {SITE_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
          <button
            className="inline-flex items-center justify-center gap-2 self-end rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            onClick={saveSite}
            disabled={isSavingSite}
          >
            {isSavingSite ? <Loader2 className="h-4 w-4 animate-spin" /> : editingCode ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {isSavingSite ? "Saving…" : editingCode ? "Save Site" : "Add Site"}
          </button>
          {editingCode ? <button className="btn btn-ghost self-end" onClick={resetEditor} disabled={isSavingSite}>Cancel</button> : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-100 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
          <input className="text-sm" type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setSiteImportFile(event.target.files?.[0] ?? null)} />
          <button className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-slate-950 dark:text-red-200" onClick={importMasterSites} disabled={isImporting}>
            {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {isImporting ? "Importing…" : "Import Master Site List"}
          </button>
          <span className="text-xs text-slate-700 dark:text-slate-200">Template columns: Site ID, optional legacy Site Code, Region, Site Type, Site Hierarchy, Site Criticality, Site Structure, Colocation Type, Colocation Owner, Coordinates X, Coordinates Y. If legacy code is blank, the portal derives an internal code from Site ID.</span>
        </div>
      </div>

      <div className="card p-5">
        <div className="section-title">Master site list</div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="subtle">Showing {visibleSites.length} of {filteredSites.length} filtered sites, from {sites.length} total.</div>
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <span>Rows per page</span>
            <select className="input-dark" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
              {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
        </div>
        {canBulkDelete && selectedSiteCount > 0 ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
            <span>{selectedSiteCount} row(s) selected</span>
            <button className="btn btn-danger-soft" onClick={() => setConfirmBulkDelete(true)}>
              <Trash2 className="h-4 w-4" />
              Delete Selected
            </button>
          </div>
        ) : null}
        <div className="table-shell mt-5">
          <table>
            <thead>
              <tr>
                {canBulkDelete ? (
                  <th>
                    <input
                      type="checkbox"
                      checked={visibleSites.length > 0 && visibleSites.every((site) => selectedSiteIds[site.id])}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelectedSiteIds((current) => {
                          const next = { ...current };
                          for (const site of visibleSites) next[site.id] = checked;
                          return next;
                        });
                      }}
                      aria-label="Select all sites on current page"
                    />
                  </th>
                ) : null}
                <th>Site</th>
                <th>Type</th>
                <th>Criticality</th>
                <th>Region</th>
                <th>Hierarchy</th>
                <th>Structure / Colocation</th>
                <th>Coordinates</th>
                <th>Documents</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleSites.map((site) => (
                <tr key={site.id}>
                  {canBulkDelete ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedSiteIds[site.id])}
                        onChange={(event) => setSelectedSiteIds((current) => ({ ...current, [site.id]: event.target.checked }))}
                        aria-label={`Select site ${site.code}`}
                      />
                    </td>
                  ) : null}
                  <td>
                    <Link className="font-semibold text-red-700 hover:text-red-900 dark:text-red-200 dark:hover:text-white" href={`/sites/${site.code}`}>
                      {primarySiteLabel(site)}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{secondarySiteLabel(site) ?? "-"}</div>
                  </td>
                  <td>{site.siteType ?? "-"}</td>
                  <td>{site.criticalityTags?.length ? site.criticalityTags.map((assignment) => assignment.tag.label).join(", ") : "-"}</td>
                  <td>{site.region ?? "-"}</td>
                  <td>{site.label ?? "-"}</td>
                  <td>
                    <div>{site.siteStructure ?? "-"}</div>
                    <div className="text-xs text-slate-500">
                      {[site.colocationType, site.colocationOwner].filter(Boolean).join(" / ") || "-"}
                    </div>
                  </td>
                  <td>
                    {site.coordinateX !== null && site.coordinateX !== undefined && site.coordinateY !== null && site.coordinateY !== undefined
                      ? `${site.coordinateX}, ${site.coordinateY}`
                      : "-"}
                  </td>
                  <td>
                    <div className="flex flex-col gap-1">
                      {SITE_DOCUMENT_TYPES.map((documentType) => (
                        <SiteDocLight
                          key={documentType.type}
                          label={documentType.label}
                          siteLabel={primarySiteLabel(site)}
                          document={site.documents?.[documentType.type] ?? null}
                        />
                      ))}
                    </div>
                  </td>
                  <td>{site.status}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      {canUpload ? (
                        <button className="btn btn-ghost btn-compact" onClick={() => setUploadSite(site)}>
                          <FileText className="h-3 w-3" />
                          Upload Docs
                        </button>
                      ) : null}
                      <Link className="btn btn-ghost btn-compact" href={`/sites/${site.code}#inventory-drilldown`}>
                        <Database className="h-3 w-3" />
                        Inventory Drill-down
                      </Link>
                      <Link className="btn btn-ghost btn-compact" href={`/inventory?search=${site.code}`}>
                        <Database className="h-3 w-3" />
                        Configure Inventory
                      </Link>
                      <Link className="btn btn-ghost btn-compact" href={`/odf-racks?search=${site.code}` as any}>
                        <Network className="h-3 w-3" />
                        Configure ODF
                      </Link>
                      <button className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" onClick={() => editSite(site)}>
                        <Save className="h-3 w-3" />
                        Edit
                      </button>
                      {canDelete ? (
                        <button className="btn btn-danger-soft btn-compact" onClick={() => requestDeleteSite(site)}>
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2 text-sm text-slate-600 dark:text-slate-300">
          <button className="btn btn-ghost" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Prev</button>
          <span>Page {currentPage} of {pageCount}</span>
          <button className="btn btn-ghost" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</button>
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(pendingSiteDelete)}
        title={pendingSiteDelete ? `Delete site ${pendingSiteDelete.code}?` : "Delete site?"}
        message={
          <div className="space-y-2">
            <p>
              This will <strong>permanently delete site {pendingSiteDelete?.code}</strong> together with{" "}
              <strong>all inventory and records that belong to it</strong>, including:
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>every <strong>Rack and ODF</strong> registered at this site</li>
              <li>all <strong>ODF port mappings</strong> and fiber allocations on those ODFs</li>
              <li>the <strong>link segments</strong> that terminate at this site</li>
            </ul>
            <p>
              Any chain that only <strong>passes through</strong> this site (A–{pendingSiteDelete?.code}–C) is
              automatically <strong>reverse-split (merged back into a single A–C segment)</strong> so its route and
              service IDs are preserved — no chain is left open.
            </p>
            <p className="font-semibold text-[var(--danger-text,#b91c1c)]">
              This action cannot be undone. Make sure this site is no longer in service before continuing.
            </p>
          </div>
        }
        confirmLabel="Delete site & inventory"
        busy={isDeletingSite}
        onConfirm={confirmDeleteSite}
        onCancel={() => setPendingSiteDelete(null)}
      />
      {confirmBulkDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6">
          <div className="w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="text-lg font-semibold">Delete {selectedSiteCount} selected rows? This cannot be undone.</div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
              <button className="btn btn-danger-soft" onClick={deleteSelectedSites}>Delete</button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingDocumentDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6" role="dialog" aria-modal="true" aria-label="Delete uploaded document">
          <div className="w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="text-lg font-semibold">Delete uploaded document?</div>
            <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              This will permanently delete {pendingDocumentDelete.label} file "{pendingDocumentDelete.document.originalFilename}" from {pendingDocumentDelete.siteLabel}. This cannot be undone.
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" disabled={isDeletingDocument} onClick={() => setPendingDocumentDelete(null)}>Cancel</button>
              <button className="btn btn-danger-soft" disabled={isDeletingDocument} onClick={deleteSiteDocument}>
                <Trash2 className="h-4 w-4" />
                {isDeletingDocument ? "Deleting" : "Delete document"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {uploadSite ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6" role="dialog" aria-modal="true" aria-label="Upload site document">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">Upload Site Document</div>
                <div className="subtle mt-1">{primarySiteLabel(uploadSite)}</div>
              </div>
              <button className="btn btn-ghost btn-compact" onClick={() => setUploadSite(null)}>Close</button>
            </div>
            <div className="mt-5 grid gap-4">
              <label className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted-text)" }}>
                Document Type
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={uploadDocumentType} onChange={(event) => setUploadDocumentType(event.target.value as SiteDocumentType)}>
                  {SITE_DOCUMENT_TYPES.map((documentType) => (
                    <option key={documentType.type} value={documentType.type}>{documentType.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted-text)" }}>
                File
                <input className="input-dark mt-2 w-full normal-case tracking-normal" type="file" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted-text)" }}>
                Remarks
                <textarea className="input-dark mt-2 min-h-24 w-full resize-y normal-case tracking-normal" value={uploadRemarks} onChange={(event) => setUploadRemarks(event.target.value)} />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setUploadSite(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={uploadSiteDocument} disabled={isUploading || !uploadFile}>
                <Upload className="h-4 w-4" />
                {isUploading ? "Uploading" : "Upload"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {postAddPrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6" role="dialog" aria-modal="true" aria-label="Add ODF and rack inventory">
          <div className="w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
            <div className="text-lg font-semibold">Add ODF &amp; rack inventory?</div>
            <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              Site <span className="font-semibold">{postAddPrompt.name}</span> was created. Would you like to add its ODF and rack inventory now?
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setPostAddPrompt(null)}>Not now</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setBulkOdfSite(postAddPrompt);
                  setPostAddPrompt(null);
                }}
              >
                Yes, add inventory
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <BulkOdfInventoryModal
        open={Boolean(bulkOdfSite)}
        initialSiteCode={bulkOdfSite?.code ?? ""}
        initialSiteName={bulkOdfSite?.name ?? ""}
        onClose={() => setBulkOdfSite(null)}
        onSuccess={(successMessage) => {
          void refreshSites();
          showSuccess(successMessage);
        }}
      />
    </div>
  );
}
