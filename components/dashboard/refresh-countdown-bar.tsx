"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Sleek horizontal "time-to-next-refresh" bar shown under the two hour-cached
 * dashboard cards (Core & DC Intra-Site ODF Saturation and the Core/DataCenter
 * Operation Grid). It fills from 0 → 100% across the cache TTL window measured
 * from the snapshot's `generatedAt`, so both cards — which share the same 1h
 * stale-while-revalidate cache and were first computed on the same page load —
 * stay visually in lock-step. When the window elapses it issues a single
 * router.refresh() to pull the freshly revalidated server snapshot.
 */
export function RefreshCountdownBar({
  generatedAt,
  intervalMs = 60 * 60 * 1000,
  label = "Next data refresh",
}: {
  generatedAt: string;
  intervalMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const refreshedRef = useRef(false);
  // null until mounted so the server render and the first client render agree
  // (progress 0), avoiding a hydration mismatch on the animated width.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A fresh generatedAt (the server just revalidated) re-arms the one-shot refresh.
  useEffect(() => {
    refreshedRef.current = false;
  }, [generatedAt]);

  const anchorRaw = new Date(generatedAt).getTime();
  const anchor = Number.isFinite(anchorRaw) && anchorRaw > 0 ? anchorRaw : Date.now();
  const nextRefreshAt = anchor + intervalMs;
  const current = now ?? anchor;
  const remaining = nextRefreshAt - current;
  const progress = Math.min(1, Math.max(0, (intervalMs - remaining) / intervalMs));

  useEffect(() => {
    // Only refresh after watching it count past zero (remaining was positive then
    // hit 0), never on a stale-anchor mount — that would loop on an empty snapshot.
    if (now !== null && remaining <= 0 && !refreshedRef.current) {
      refreshedRef.current = true;
      router.refresh();
    }
  }, [now, remaining, router]);

  const countdownLabel = remaining > 0 ? formatCountdown(remaining) : "refreshing…";

  return (
    <div className="mt-3" aria-label={`${label} in ${countdownLabel}`}>
      <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: "var(--muted-text)" }}>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--accent)", boxShadow: "0 0 0 2px var(--accent-soft, rgba(59,130,246,0.18))" }}
          />
          {label}
        </span>
        <span className="font-mono tabular-nums">{countdownLabel}</span>
      </div>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--border-strong, rgba(148,163,184,0.25))" }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-1000 ease-linear"
          style={{
            width: `${progress * 100}%`,
            background: "linear-gradient(90deg, var(--accent), var(--accent-strong, var(--accent)))",
          }}
        />
      </div>
    </div>
  );
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
