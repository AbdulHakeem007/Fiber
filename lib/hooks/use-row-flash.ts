"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Light amber tint applied to a row that was just created/updated, so the
 *  operator can visually track exactly which node changed. Translucent so it
 *  reads correctly over both light and dark table rows. */
export const ROW_FLASH_BG = "rgba(245, 158, 11, 0.18)";

/**
 * Transient row-highlight tracker. Call `flash(id | ids)` after a successful
 * create/update; the affected rows tint amber and auto-clear after `durationMs`.
 * Pair `isFlashing(id)` with `rowFlashStyle(isFlashing(id))` on each <tr>.
 */
export function useRowFlash(durationMs = 2600) {
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const flash = useCallback(
    (ids: string | null | undefined | Array<string | null | undefined>) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter((id): id is string => Boolean(id));
      if (!list.length) return;
      setFlashIds((current) => {
        const next = new Set(current);
        for (const id of list) next.add(id);
        return next;
      });
      for (const id of list) {
        const existing = timersRef.current.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setFlashIds((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          timersRef.current.delete(id);
        }, durationMs);
        timersRef.current.set(id, timer);
      }
    },
    [durationMs],
  );

  const isFlashing = useCallback((id?: string | null) => Boolean(id && flashIds.has(id)), [flashIds]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { flash, isFlashing };
}

/** Inline style for a table row; the always-present transition lets the tint
 *  fade out smoothly when the flash clears. Merge into any existing row style. */
export function rowFlashStyle(active: boolean): React.CSSProperties {
  return { backgroundColor: active ? ROW_FLASH_BG : undefined, transition: "background-color 700ms ease" };
}
