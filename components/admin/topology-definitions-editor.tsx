"use client";

import { useState } from "react";
import { Save } from "lucide-react";

type Definition = { key: string; label: string; definition: string };

export function TopologyDefinitionsEditor({ definitions }: { definitions: Definition[] }) {
  const [items, setItems] = useState<Definition[]>(definitions);
  const [message, setMessage] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  function update(index: number, patch: Partial<Definition>) {
    setItems((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  async function save(item: Definition) {
    setSavingKey(item.key);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/topology-definitions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Save failed.");
      setMessage(`Saved “${item.label}”.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="card p-5">
      <div className="section-title">Topology alert definitions</div>
      <div className="subtle mt-1">
        Plain-language definitions included with the Topology alert so recipients understand exactly what was detected.
        Rewrite and save each one as your network conventions evolve.
      </div>
      {message ? <div className="mt-3 text-sm text-cyan-700 dark:text-cyan-200">{message}</div> : null}
      <div className="mt-4 space-y-3">
        {items.map((item, index) => (
          <div key={item.key} className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-slate-500/15 px-2 py-0.5 text-xs font-semibold text-slate-500">{item.key}</span>
              <input
                className="input-dark w-full font-semibold"
                value={item.label}
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder="Label"
              />
            </div>
            <textarea
              className="input-dark mt-2 min-h-24 w-full"
              value={item.definition}
              onChange={(event) => update(index, { definition: event.target.value })}
              placeholder="Definition shown to recipients"
            />
            <div className="mt-2 flex justify-end">
              <button className="btn btn-primary btn-compact" onClick={() => save(items[index])} disabled={savingKey === item.key}>
                <Save className="h-4 w-4" />
                {savingKey === item.key ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
