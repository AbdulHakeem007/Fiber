"use client";

/**
 * Lightweight yes/no confirmation dialog styled to match the portal (solid,
 * light-mode-correct surface via the shared modal variables). Replaces native
 * window.confirm() popups so confirmations look consistent across the app.
 * Behaviour-neutral: it only gates the caller's existing action behind onConfirm.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  const confirmClass = tone === "danger" ? "btn btn-danger-soft" : "btn btn-primary";
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--backdrop)] p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] p-5 text-[var(--text-main)] shadow-lift">
        <div className="text-lg font-semibold">{title}</div>
        {message ? <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{message}</div> : null}
        <div className="mt-5 flex justify-end gap-3">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button className={confirmClass} disabled={busy} onClick={onConfirm} type="button">
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
