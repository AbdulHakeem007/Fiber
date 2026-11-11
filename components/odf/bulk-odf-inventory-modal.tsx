"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { SuggestionInput } from "@/components/ui/suggestion-input";

// Client-side field validation mirrored from the ODF & Racks Inventory page so
// this modal behaves identically. The authoritative validation still runs on the
// server (/api/odf-ports/bulk-update) — this is a UX fast-path only.
function optionalPositiveInteger(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : NaN;
}

const PORT_FIELDS: Array<[key: string, label: string]> = [
  ["siteName", "Customer / Site name"],
  ["rackCode", "Rack ID"],
  ["odfCode", "ODF ID"],
  ["totalPorts", "Total ODF ports"],
  ["terminatedStartPort", "Fiber terminated start port"],
  ["terminatedEndPort", "Fiber terminated end port"],
  ["dummyStartPort", "Dummy start port"],
  ["dummyEndPort", "Dummy end port"],
];

type BulkInventoryState = {
  siteCode: string;
  siteName: string;
  rackCode: string;
  odfCode: string;
  totalPorts: string;
  terminatedStartPort: string;
  terminatedEndPort: string;
  dummyStartPort: string;
  dummyEndPort: string;
  remarks: string;
};

function initialState(siteCode = "", siteName = ""): BulkInventoryState {
  return {
    siteCode,
    siteName: siteName || siteCode,
    rackCode: "",
    odfCode: "",
    totalPorts: "48",
    terminatedStartPort: "",
    terminatedEndPort: "",
    dummyStartPort: "",
    dummyEndPort: "",
    remarks: "",
  };
}

/**
 * Bulk ODF inventory add, rendered as a modal so it can be raised in context
 * (e.g. right after a new site is created on the Sites Database page) without
 * navigating away to the ODF & Racks Inventory page. Posts to the same
 * /api/odf-ports/bulk-update endpoint the ODF page uses — no new logic.
 */
export function BulkOdfInventoryModal({
  open,
  onClose,
  initialSiteCode = "",
  initialSiteName = "",
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  initialSiteCode?: string;
  initialSiteName?: string;
  onSuccess?: (message: string) => void;
}) {
  const [bulkInventory, setBulkInventory] = useState<BulkInventoryState>(() => initialState(initialSiteCode, initialSiteName));
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // After a successful add, hold the confirmation so we can ask whether the
  // operator wants to add another ODF for the same site (sites usually have 2+).
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // Reset the form to the target site each time the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setBulkInventory(initialState(initialSiteCode, initialSiteName));
      setMessage(null);
      setSavedNotice(null);
    }
  }, [open, initialSiteCode, initialSiteName]);

  if (!open) return null;

  async function applyBulkInventoryAdd() {
    setMessage(null);
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
      setMessage("Port values must be positive whole numbers.");
      return;
    }
    if (!totalPorts) {
      setMessage("Total ODF ports must be a positive whole number.");
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
      setMessage(rangeError);
      return;
    }

    setIsSaving(true);
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
      const successMessage = payload.message ?? "Bulk ODF inventory configured.";
      onSuccess?.(successMessage);
      // Preserve the site but clear the ODF-specific fields, then ask whether the
      // operator wants to add another ODF for this site. They choose when to stop.
      setBulkInventory((current) => ({
        ...initialState(current.siteCode, current.siteName),
      }));
      setSavedNotice(successMessage);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk ODF inventory add failed.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6" role="dialog" aria-modal="true" aria-label="Bulk ODF inventory add">
      <div className="w-full max-w-3xl rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold">Bulk ODF inventory add</div>
            <div className="subtle mt-1">
              Create or update physical ODF inventory for {bulkInventory.siteCode ? `site ${bulkInventory.siteCode}` : "a site"}. Newly generated
              ports are parked as Available by default; dummy ranges are marked Dummy. Use ODF Mappings to mark traffic-carrying links as Active.
            </div>
          </div>
          <button className="btn btn-ghost btn-compact" onClick={onClose}>Close</button>
        </div>
        {savedNotice ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
            <span>{savedNotice} Add another ODF for {bulkInventory.siteName || bulkInventory.siteCode || "this site"}?</span>
            <div className="flex gap-2">
              <button className="btn btn-primary btn-compact" onClick={() => setSavedNotice(null)}>Add another ODF</button>
              <button className="btn btn-ghost btn-compact" onClick={onClose}>Finish</button>
            </div>
          </div>
        ) : null}
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <SuggestionInput
            kind="sites"
            className="input-dark"
            value={bulkInventory.siteCode}
            onChange={(nextValue) => setBulkInventory({ ...bulkInventory, siteCode: nextValue, siteName: bulkInventory.siteName || nextValue })}
            placeholder="Site ID"
          />
          {PORT_FIELDS.map(([key, label]) => (
            <input
              key={key}
              className="input-dark"
              value={String(bulkInventory[key as keyof BulkInventoryState])}
              onChange={(event) => setBulkInventory({ ...bulkInventory, [key]: event.target.value })}
              placeholder={label}
            />
          ))}
          <input className="input-dark md:col-span-3" value={bulkInventory.remarks} onChange={(event) => setBulkInventory({ ...bulkInventory, remarks: event.target.value })} placeholder="Remarks" />
          <button className="btn btn-primary" onClick={applyBulkInventoryAdd} disabled={isSaving}>
            <Save className="h-4 w-4" />
            {isSaving ? "Saving" : "Add / Update ODF"}
          </button>
        </div>
        {message ? <div className="mt-4 text-sm font-medium text-red-700 dark:text-red-200">{message}</div> : null}
        <div className="mt-5 flex justify-end gap-3">
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
