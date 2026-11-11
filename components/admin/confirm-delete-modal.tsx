"use client";

import { useEffect, useState } from "react";

const DEFAULT_MESSAGE = "WARNING: This action is permanent. This data will be completely purged from the primary database tables. However, historical segments utilization data and search logs will retain a cached reference. Are you sure you want to proceed?";

export function ConfirmDeleteModal({
  open,
  title,
  message = DEFAULT_MESSAGE,
  requiredText = "CONFIRM DELETE",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  requiredText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open, requiredText]);
  if (!open) return null;
  const canConfirm = typed === requiredText;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6" style={{ background: "var(--backdrop)" }} role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
        <div className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>{title}</div>
        <div className="mt-4 rounded-xl border p-3 text-sm font-medium" style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)", color: "var(--accent-text)" }}>{message}</div>
        <label className="mt-4 block text-sm font-medium">
          Type {requiredText} to continue
          <input
            className="input-dark mt-2 w-full"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoFocus
          />
        </label>
        <div className="mt-5 flex justify-end gap-3">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canConfirm} onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
