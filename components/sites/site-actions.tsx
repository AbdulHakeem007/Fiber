"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, Save } from "lucide-react";

interface SiteActionState {
  code: string;
  name?: string | null;
  region?: string | null;
  city?: string | null;
  siteType?: string | null;
  label?: string | null;
  siteStructure?: string | null;
  coordinateX?: number | string | null;
  coordinateY?: number | string | null;
  isCoreSite: boolean;
  isCriticalSite?: boolean;
  isDatacenter?: boolean;
  coreSiteType?: string | null;
  status: string;
  remarks?: string | null;
}

export function SiteActions({ site }: { site: SiteActionState }) {
  const [editor, setEditor] = useState<SiteActionState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    if (!editor) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/sites/${site.code}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editor),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Site update failed.");
      setEditor(null);
      setMessage("Site updated. Refresh to see all derived counts.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Site update failed.");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn btn-ghost" onClick={() => setEditor(site)}>Edit Site</button>
      <Link className="btn btn-ghost" href={`/inventory?search=${site.code}` as any}>Manual Override</Link>
      <button className="btn btn-ghost" onClick={() => window.open(`/api/sites/${site.code}/overall-inventory`, "_blank")}>Overall site inventory</button>
      <button className="btn bg-cyan-600 text-white" onClick={() => { window.location.href = `/api/export?type=inventory&format=xlsx&site=${site.code}`; }}>
        <Download className="h-4 w-4" />
        Export
      </button>
      {message ? <div className="basis-full text-sm font-medium text-cyan-700 dark:text-cyan-200">{message}</div> : null}

      {editor ? (
        <div className="modal-backdrop">
          <div className="modal-panel modal-small">
            <div className="text-lg font-semibold">Edit site {site.code}</div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {[
                ["Name", "name"],
                ["Region", "region"],
                ["City", "city"],
                ["Site Type", "siteType"],
                ["Label", "label"],
                ["Site Structure", "siteStructure"],
                ["Coordinates X", "coordinateX"],
                ["Coordinates Y", "coordinateY"],
                ["Core Site Type", "coreSiteType"],
              ].map(([label, key]) => (
                <label key={key} className="text-xs uppercase tracking-[0.14em] text-slate-400">
                  {label}
                  <input className="input-dark mt-2 w-full normal-case tracking-normal" value={String(editor[key as keyof SiteActionState] ?? "")} onChange={(event) => setEditor({ ...editor, [key]: event.target.value })} />
                </label>
              ))}
              <label className="flex items-center gap-2 rounded-xl border border-border bg-white/5 px-4 py-3 text-sm">
                <input type="checkbox" checked={editor.isCoreSite} onChange={(event) => setEditor({ ...editor, isCoreSite: event.target.checked })} />
                Highlight as core site
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-border bg-white/5 px-4 py-3 text-sm">
                <input type="checkbox" checked={Boolean(editor.isCriticalSite)} onChange={(event) => setEditor({ ...editor, isCriticalSite: event.target.checked })} />
                Nominate as critical site (operational grid)
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-border bg-white/5 px-4 py-3 text-sm">
                <input type="checkbox" checked={Boolean(editor.isDatacenter)} onChange={(event) => setEditor({ ...editor, isDatacenter: event.target.checked })} />
                Tag as Datacenter (DC)
              </label>
              <label className="text-xs uppercase tracking-[0.14em] text-slate-400">
                Status
                <select className="input-dark mt-2 w-full normal-case tracking-normal" value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value })}>
                  <option>ACTIVE</option>
                  <option>PLANNED</option>
                  <option>INACTIVE</option>
                  <option>DECOMMISSIONED</option>
                </select>
              </label>
              <label className="md:col-span-2 text-xs uppercase tracking-[0.14em] text-slate-400">
                Remarks
                <input className="input-dark mt-2 w-full normal-case tracking-normal" value={editor.remarks ?? ""} onChange={(event) => setEditor({ ...editor, remarks: event.target.value })} />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setEditor(null)}>Cancel</button>
              <button className="btn bg-cyan-600 text-white" onClick={save}>
                <Save className="h-4 w-4" />
                Save Site
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
