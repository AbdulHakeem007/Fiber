"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Info, Trash2, Undo2, X, XCircle } from "lucide-react";

/**
 * Portal-wide toast notifications. Unlike the inline StatusBanner (which renders
 * at a component's own position and is easy to miss when scrolled away), toasts
 * render in a fixed viewport that is always visible regardless of scroll.
 *
 * Deletion toasts are PERSISTENT by design: once something is deleted or marked
 * for deletion, the note stays until the operator dismisses it, so a removed row
 * is never silent. Every toast is interactive (dismissible; optional action).
 */

export type ToastTone = "success" | "error" | "info" | "delete";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  message: string;
  title?: string;
  tone?: ToastTone;
  /** When true the toast never auto-dismisses (default true for the "delete" tone). */
  persistent?: boolean;
  /** Auto-dismiss delay for non-persistent toasts. */
  durationMs?: number;
  /** Optional interactive action (e.g. Undo, View). */
  action?: ToastAction;
}

interface ToastItem {
  id: string;
  message: string;
  title?: string;
  tone: ToastTone;
  persistent: boolean;
  action?: ToastAction;
}

interface ToastApi {
  notify: (options: ToastOptions) => string;
  /** Convenience for deletions: persistent "<subject> has been <verb>." toast. */
  deleted: (subject: string, options?: { markedForDeletion?: boolean; action?: ToastAction; title?: string }) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Throwing hook — use inside the portal (always wrapped by ToastProvider). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider.");
  return ctx;
}

/** Non-throwing variant for components that may mount outside the provider. */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}

const DEFAULT_DURATION_MS = 6000;
// Cap the visible stack so a burst of deletions cannot bury the viewport; the
// newest toasts are kept.
const MAX_VISIBLE = 6;

const TONE_STYLES: Record<ToastTone, { wrap: string; Icon: typeof CheckCircle2; iconClass: string }> = {
  success: {
    wrap: "border-emerald-500/40 bg-[var(--glass-bg-solid)] text-emerald-900 dark:text-emerald-100",
    Icon: CheckCircle2,
    iconClass: "text-emerald-600 dark:text-emerald-300",
  },
  error: {
    wrap: "border-red-500/45 bg-[var(--glass-bg-solid)] text-red-900 dark:text-red-100",
    Icon: XCircle,
    iconClass: "text-red-600 dark:text-red-300",
  },
  info: {
    wrap: "border-slate-400/40 bg-[var(--glass-bg-solid)] text-slate-800 dark:text-slate-100",
    Icon: Info,
    iconClass: "text-slate-500 dark:text-slate-300",
  },
  delete: {
    wrap: "border-amber-500/45 bg-[var(--glass-bg-solid)] text-amber-900 dark:text-amber-100",
    Icon: Trash2,
    iconClass: "text-amber-600 dark:text-amber-300",
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, [clearTimer]);

  const dismissAll = useCallback(() => {
    for (const id of timers.current.keys()) clearTimer(id);
    setToasts([]);
  }, [clearTimer]);

  const notify = useCallback((options: ToastOptions): string => {
    const tone = options.tone ?? "info";
    const persistent = options.persistent ?? tone === "delete";
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const item: ToastItem = {
      id,
      message: options.message,
      title: options.title,
      tone,
      persistent,
      action: options.action,
    };
    setToasts((current) => [...current, item].slice(-MAX_VISIBLE));
    if (!persistent) {
      const handle = window.setTimeout(() => dismiss(id), options.durationMs ?? DEFAULT_DURATION_MS);
      timers.current.set(id, handle);
    }
    return id;
  }, [dismiss]);

  const deleted = useCallback((subject: string, options?: { markedForDeletion?: boolean; action?: ToastAction; title?: string }): string => {
    const verb = options?.markedForDeletion ? "has been marked for deletion" : "has been deleted";
    return notify({
      tone: "delete",
      persistent: true,
      title: options?.title ?? (options?.markedForDeletion ? "Marked for deletion" : "Deleted"),
      message: `${subject} ${verb}.`,
      action: options?.action,
    });
  }, [notify]);

  // Clear every pending timer on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) window.clearTimeout(handle);
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ notify, deleted, dismiss, dismissAll }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} onDismissAll={dismissAll} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
  onDismissAll,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-4 z-[120] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
      role="region"
      aria-label="Notifications"
    >
      {toasts.length > 1 ? (
        <button
          type="button"
          className="pointer-events-auto rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg-solid)] px-3 py-1 text-[11px] font-semibold text-[var(--text-main)] shadow-lift hover:opacity-90"
          onClick={onDismissAll}
        >
          Dismiss all ({toasts.length})
        </button>
      ) : null}
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(handle);
  }, []);
  const { wrap, Icon, iconClass } = TONE_STYLES[toast.tone];
  return (
    <div
      className={`pointer-events-auto w-full max-w-sm rounded-xl border p-3 shadow-lift transition-all duration-200 ${wrap} ${entered ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"}`}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 h-5 w-5 flex-none ${iconClass}`} aria-hidden />
        <div className="min-w-0 flex-1">
          {toast.title ? <div className="text-sm font-semibold leading-5">{toast.title}</div> : null}
          <div className="text-sm leading-5 break-words">{toast.message}</div>
          {toast.action ? (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-current/30 px-2.5 py-1 text-xs font-semibold hover:opacity-80"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
              {toast.action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="flex-none rounded-md p-0.5 opacity-70 hover:opacity-100"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
