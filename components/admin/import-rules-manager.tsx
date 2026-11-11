"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";

interface AliasRow {
  id: string;
  siteCode: string;
  alias: string;
  aliasNormalized: string;
}

export function ImportRulesManager({ initialAliases, siteCodes }: { initialAliases: AliasRow[]; siteCodes: string[] }) {
  const [aliases, setAliases] = useState(initialAliases);
  const [siteCode, setSiteCode] = useState(siteCodes[0] ?? "");
  const [alias, setAlias] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const toast = useToast();

  const filteredAliases = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return aliases;
    return aliases.filter((row) => [row.siteCode, row.alias, row.aliasNormalized].join(" ").toUpperCase().includes(needle));
  }, [aliases, query]);

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, isOn]) => isOn).map(([id]) => id),
    [selected],
  );

  async function addAlias(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    try {
      const response = await fetch("/api/admin/site-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteCode, alias }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.alias) throw new Error(payload.error ?? "Alias update failed.");
      setAliases((current) => [payload.alias, ...current.filter((row) => row.id !== payload.alias.id)]);
      setAlias("");
      setMessage("Alias saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Alias update failed.");
    }
  }

  async function bulkDelete(body: { aliasIds?: string[]; flushAll?: boolean }) {
    setIsDeleting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/site-aliases", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Bulk delete failed.");
      if (body.flushAll) {
        setAliases([]);
      } else {
        const removed = new Set(body.aliasIds ?? []);
        setAliases((current) => current.filter((row) => !removed.has(row.id)));
      }
      setSelected({});
      const deletedCount = payload.deletedCount ?? 0;
      setMessage(`${deletedCount} alias rule(s) deleted.`);
      toast.deleted(body.flushAll ? `All ${deletedCount} alias rule(s)` : `${deletedCount} alias rule${deletedCount === 1 ? "" : "s"}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk delete failed.");
    } finally {
      setIsDeleting(false);
    }
  }

  function deleteSelected() {
    if (!selectedIds.length) {
      setMessage("Tick at least one alias rule before deleting.");
      return;
    }
    if (!window.confirm(`Delete ${selectedIds.length} selected alias rule(s)? Imports will stop resolving these aliases.`)) return;
    void bulkDelete({ aliasIds: selectedIds });
  }

  function flushList() {
    if (!aliases.length) {
      setMessage("The alias rule list is already empty.");
      return;
    }
    if (!window.confirm(`Flush the ENTIRE alias rule list (${aliases.length} rule(s))? This cannot be undone.`)) return;
    void bulkDelete({ flushAll: true });
  }

  async function deleteOne(row: AliasRow) {
    if (!window.confirm(`Delete alias "${row.alias}" for site ${row.siteCode}?`)) return;
    setIsDeleting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/site-aliases/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Alias delete failed.");
      setAliases((current) => current.filter((item) => item.id !== row.id));
      setSelected((current) => ({ ...current, [row.id]: false }));
      setMessage("Alias rule deleted.");
      toast.deleted(`Alias "${row.alias}" (site ${row.siteCode})`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Alias delete failed.");
    } finally {
      setIsDeleting(false);
    }
  }

  function toggleVisible(checked: boolean) {
    setSelected((current) => {
      const next = { ...current };
      for (const row of filteredAliases) next[row.id] = checked;
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">Import rules</div>
        <div className="subtle mt-1">Validate incoming files, reconcile site aliases to real Site IDs, and keep schema mapping predictable before inventory rows are committed.</div>
        <form className="mt-5 flex flex-wrap gap-3" onSubmit={addAlias}>
          <select className="input-dark" value={siteCode} onChange={(event) => setSiteCode(event.target.value)}>
            {siteCodes.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
          <input className="input-dark min-w-[260px] flex-1" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="Alias from Excel, e.g. Site-K" />
          <button className="btn bg-cyan-600 text-white" type="submit">
            <Plus className="h-4 w-4" />
            Add Alias
          </button>
        </form>
        {message ? <div className="mt-3 text-sm text-cyan-700 dark:text-cyan-200">{message}</div> : null}
      </div>

      <div className="card p-5">
        <div className="text-lg font-semibold">Telecom import rule workflow</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="text-sm font-bold text-slate-950 dark:text-white">1. Format validation</div>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">Check mandatory columns, port-range syntax, ODF/rack fields, status values, and duplicate service/segment rows before staging.</p>
          </div>
          <div className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="text-sm font-bold text-slate-950 dark:text-white">2. Foreign-key mapping</div>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">Resolve aliases to Site IDs, then map rack, ODF, port group, segment, splitter, ATP, and service references without guessing.</p>
          </div>
          <div className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="text-sm font-bold text-slate-950 dark:text-white">3. Schema reconciliation</div>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">Normalize legacy labels such as Used into Active, park new ODF ports as Available, and send corrupt rows to issue review instead of polluting live inventory.</p>
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-lg font-semibold">Site aliases</div>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input-dark min-w-[260px]" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter aliases" />
            <button
              className="btn btn-danger-soft"
              type="button"
              disabled={isDeleting || !selectedIds.length}
              onClick={deleteSelected}
            >
              <Trash2 className="h-4 w-4" />
              Delete Selected ({selectedIds.length})
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-red-300/60 bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              type="button"
              disabled={isDeleting || !aliases.length}
              onClick={flushList}
            >
              <Trash2 className="h-4 w-4" />
              Flush List
            </button>
          </div>
        </div>
        <div className="table-shell mt-5">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={filteredAliases.length > 0 && filteredAliases.every((row) => selected[row.id])}
                    onChange={(event) => toggleVisible(event.target.checked)}
                    aria-label="Select all visible alias rules"
                  />
                </th>
                <th>Site</th>
                <th>Alias</th>
                <th>Normalized</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAliases.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selected[row.id])}
                      onChange={(event) => setSelected((current) => ({ ...current, [row.id]: event.target.checked }))}
                      aria-label={`Select alias ${row.alias}`}
                    />
                  </td>
                  <td>{row.siteCode}</td>
                  <td>{row.alias}</td>
                  <td>{row.aliasNormalized}</td>
                  <td>
                    <button className="btn btn-danger-soft btn-compact" type="button" disabled={isDeleting} onClick={() => deleteOne(row)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!filteredAliases.length ? (
                <tr><td colSpan={5} className="text-sm text-slate-500">No alias rules{query ? " match this filter" : " configured yet"}.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
