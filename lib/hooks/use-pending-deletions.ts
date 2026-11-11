"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultGccCalendarConfig,
  formatRemainingHold,
  remainingHoldMillis,
  DELETION_HOLD_MILLIS,
  type GccCalendarConfig,
} from "@/lib/utils/gcc-calendar";

export interface PendingDeletionHold {
  id: string;
  entityType: "ODF" | "SEGMENT";
  entityId: string;
  entityLabel: string | null;
  deleteGroupId: string | null;
  mergeTopology: boolean;
  requestedAt: string;
  scheduledPurgeAt: string;
  remainingMs: number;
}

/**
 * Live view of the 24 working-hour soft-delete holds for one entity type.
 * The countdown is recomputed client-side with the same GCC calendar the
 * server uses (working days + holidays arrive with the listing), corrected
 * for client/server clock skew, and re-rendered every 30 seconds.
 */
export function usePendingDeletions(entityType: "ODF" | "SEGMENT", enabled = true) {
  const [holdsByEntity, setHoldsByEntity] = useState<Record<string, PendingDeletionHold>>({});
  const [calendar, setCalendar] = useState<GccCalendarConfig>(defaultGccCalendarConfig());
  const [holdMillis, setHoldMillis] = useState(DELETION_HOLD_MILLIS);
  const clockSkewRef = useRef(0);
  const locallyRemovedRef = useRef(new Set<string>());
  const [, setTick] = useState(0);
  const [purgedEntityIds, setPurgedEntityIds] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/pending-deletions?entityType=${entityType}`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      if (!Array.isArray(payload.holds)) return;
      if (payload.calendar?.workingDays?.length) setCalendar(payload.calendar);
      if (Number.isFinite(payload.holdMillis)) setHoldMillis(payload.holdMillis);
      if (payload.now) clockSkewRef.current = new Date(payload.now).getTime() - Date.now();
      const next: Record<string, PendingDeletionHold> = {};
      for (const hold of payload.holds as PendingDeletionHold[]) next[hold.entityId] = hold;
      setHoldsByEntity((previous) => {
        // Holds that vanished without a local undo were purged (or undone
        // elsewhere): surface them so the page can refresh its rows.
        const vanished = Object.keys(previous).filter(
          (entityId) => !next[entityId] && !locallyRemovedRef.current.has(entityId),
        );
        if (vanished.length) setPurgedEntityIds((current) => [...new Set([...current, ...vanished])]);
        locallyRemovedRef.current = new Set();
        return next;
      });
    } catch {
      // Network hiccup: keep the last known holds; the next poll retries.
    }
  }, [entityType]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    // Poll every 2 minutes (also triggers the server-side purge sweep) and
    // re-render the countdown labels every 30 seconds in between.
    const poll = setInterval(() => void refresh(), 120_000);
    const ticker = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(ticker);
    };
  }, [enabled, refresh]);

  /** Register a hold returned inline by a delete request (no extra fetch). */
  const applyHolds = useCallback((holds: PendingDeletionHold | PendingDeletionHold[]) => {
    const list = Array.isArray(holds) ? holds : [holds];
    if (!list.length) return;
    setHoldsByEntity((previous) => {
      const next = { ...previous };
      for (const hold of list) if (hold?.entityId) next[hold.entityId] = hold;
      return next;
    });
  }, []);

  const holdFor = useCallback(
    (entityId: string): PendingDeletionHold | null => holdsByEntity[entityId] ?? null,
    [holdsByEntity],
  );

  /** Live remaining working-time for an entity's hold, or null when none. */
  const remainingFor = useCallback(
    (entityId: string): { millis: number; label: string } | null => {
      const hold = holdsByEntity[entityId];
      if (!hold) return null;
      const now = new Date(Date.now() + clockSkewRef.current);
      const millis = remainingHoldMillis(new Date(hold.requestedAt), now, calendar, holdMillis);
      return { millis, label: formatRemainingHold(millis) };
    },
    [holdsByEntity, calendar, holdMillis],
  );

  const undo = useCallback(
    async (entityId: string): Promise<{ ok: boolean; message: string }> => {
      const hold = holdsByEntity[entityId];
      if (!hold) return { ok: false, message: "No scheduled deletion found for this record." };
      try {
        const response = await fetch(`/api/pending-deletions/${hold.id}/undo`, { method: "POST" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return { ok: false, message: payload.error ?? "Undo failed." };
        locallyRemovedRef.current.add(entityId);
        setHoldsByEntity((previous) => {
          const next = { ...previous };
          delete next[entityId];
          return next;
        });
        void refresh();
        return { ok: true, message: payload.message ?? "Scheduled deletion was undone." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Undo failed." };
      }
    },
    [holdsByEntity, refresh],
  );

  const acknowledgePurged = useCallback(() => setPurgedEntityIds([]), []);

  return { holdsByEntity, holdFor, remainingFor, undo, applyHolds, refresh, purgedEntityIds, acknowledgePurged };
}
