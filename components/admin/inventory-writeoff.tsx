"use client";

import { useState } from "react";

const CONFIRM_PHRASE = "RESET LIVE INVENTORY";

/**
 * High-privilege administrative "Inventory Data Write-Off" control.
 *
 * Wired to POST /api/admin/inventory-reset (adminManage-gated), which runs the
 * FK-safe cascading purge in inventoryResetService.resetLiveInventory: it clears
 * segments, child mappings, fibers, services/allocations, splitters, ODFs, racks,
 * ports, port groups, cables, alerts, metrics and import staging back to a clean
 * slate — without tripping foreign-key constraints or stalling the runtime.
 */
export function InventoryWriteOff() {
  const [armed, setArmed] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/inventory-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: confirmText.trim(), reason: "Inventory Data Write-Off from Admin → Notifications" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Inventory write-off failed.");
      const b = data.before ?? {};
      setResult(
        `Inventory write-off complete. Purged ${b.linkSegments ?? 0} segments, ${b.segmentFibers ?? 0} fibers, ` +
          `${b.serviceAllocations ?? 0} allocations, ${b.splitters ?? 0} splitters, ${b.odfs ?? 0} ODFs, ` +
          `${b.racks ?? 0} racks, ${b.portGroups ?? 0} port groups.`,
      );
      setArmed(false);
      setConfirmText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inventory write-off failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 border border-red-300 dark:border-red-800">
      <div className="section-title text-red-700 dark:text-red-300">Inventory Data Write-Off</div>
      <div className="subtle mt-1">
        Completely purges all portal network inventory — ODF mappings, segments, ODFs, racks, ports, splitters,
        services and allocations — back to a clean slate. Users, roles, SMTP and auth settings are preserved.
        This action is irreversible; take a database backup first.
      </div>

      {!armed ? (
        <button
          type="button"
          className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          onClick={() => { setArmed(true); setResult(null); setError(null); }}
        >
          Execute Inventory Write-Off…
        </button>
      ) : (
        <div className="mt-4 space-y-3 rounded-2xl border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/40">
          <div className="text-sm font-semibold text-red-800 dark:text-red-200">
            Type <code className="rounded bg-red-100 px-1 dark:bg-red-900">{CONFIRM_PHRASE}</code> to confirm the purge.
          </div>
          <input
            className="input-dark w-full normal-case tracking-normal"
            value={confirmText}
            placeholder={CONFIRM_PHRASE}
            onChange={(event) => setConfirmText(event.target.value)}
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || confirmText.trim() !== CONFIRM_PHRASE}
              className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              onClick={run}
            >
              {busy ? "Purging…" : "Confirm write-off"}
            </button>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-2xl border border-border bg-white/5 px-4 py-2 text-sm"
              onClick={() => { setArmed(false); setConfirmText(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result ? <div className="mt-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{result}</div> : null}
      {error ? <div className="mt-3 text-sm font-semibold text-red-700 dark:text-red-300">{error}</div> : null}
    </div>
  );
}
