"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

export type StatusTone = "success" | "error" | "info";
export type StatusMessage = { text: string; tone: StatusTone } | null;

/**
 * Shared status-feedback state. Distinguishes success (green) from error (red)
 * so an operator can no longer mistake a failure for a success, and auto-clears
 * transient success/info messages. Errors persist until replaced or dismissed so
 * they can be read. Pure presentation — no portal logic depends on this.
 */
export function useStatusMessage(autoDismissMs = 5000) {
  const [status, setStatus] = useState<StatusMessage>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback((text: string, tone: StatusTone = "info") => {
    clearTimer();
    if (!text) {
      setStatus(null);
      return;
    }
    setStatus({ text, tone });
    // Errors stay put until the next action; successes/info fade on their own.
    if (tone !== "error" && autoDismissMs > 0) {
      timerRef.current = window.setTimeout(() => setStatus(null), autoDismissMs);
    }
  }, [autoDismissMs, clearTimer]);

  const showSuccess = useCallback((text: string) => show(text, "success"), [show]);
  const showError = useCallback((text: string) => show(text, "error"), [show]);
  const showInfo = useCallback((text: string) => show(text, "info"), [show]);
  const clear = useCallback(() => {
    clearTimer();
    setStatus(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { status, show, showSuccess, showError, showInfo, clear };
}

const TONE_STYLES: Record<StatusTone, { wrap: string; Icon: typeof CheckCircle2 }> = {
  success: { wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200", Icon: CheckCircle2 },
  error: { wrap: "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200", Icon: XCircle },
  info: { wrap: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-200", Icon: Info },
};

export function StatusBanner({
  status,
  onDismiss,
  className = "",
}: {
  status: StatusMessage;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!status) return null;
  const { wrap, Icon } = TONE_STYLES[status.tone];
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-lg border p-3 text-sm font-medium ${wrap} ${className}`}
      role={status.tone === "error" ? "alert" : "status"}
    >
      <span className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
        <span>{status.text}</span>
      </span>
      {onDismiss ? (
        <button className="flex-none opacity-70 hover:opacity-100" onClick={onDismiss} aria-label="Dismiss message" type="button">
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
