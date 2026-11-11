// Tiny in-process snapshot cache with stale-while-revalidate semantics.
//
// Purpose: let a server component serve an expensive, slow-moving payload (e.g.
// the Core & DC Intra-Site ODF Saturation panel) without re-querying the
// database on every page load or client rotation tick. The compute function is
// run at most once per TTL window; while a cached value is still present but
// stale, the previous value is returned IMMEDIATELY and a single background
// refresh is kicked off so the user never waits and the DB is never hammered.
//
// Notes:
// - This is intentionally module/process-local (no external cache dependency).
//   Each Node server instance keeps its own copy; that is exactly what we want
//   for a self-hosted portal and avoids any new infra.
// - Only ONE refresh runs at a time (in-flight de-duplication), so N concurrent
//   requests during a cold/stale window collapse into a single DB read.

export interface SnapshotCache<T> {
  /** Returns the cached value, refreshing in the background when stale. */
  get(): Promise<T>;
  /** Drop the cached value so the next get() recomputes (mainly for tests). */
  invalidate(): void;
}

export const ONE_HOUR_MS = 60 * 60 * 1000;

export function createHourlySnapshot<T>(
  compute: () => Promise<T>,
  ttlMs: number = ONE_HOUR_MS,
): SnapshotCache<T> {
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    if (inflight) return inflight;
    inflight = compute()
      .then((value) => {
        cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async get() {
      const fresh = cached && Date.now() - cached.at < ttlMs;
      if (fresh) return cached!.value;

      // Stale but present: serve the old value now, refresh out of band so the
      // request — and the dashboard rotation — never blocks on the database.
      if (cached) {
        void refresh().catch(() => {
          /* keep serving the last good snapshot on refresh failure */
        });
        return cached.value;
      }

      // First ever load: compute synchronously (concurrent callers share it).
      return refresh();
    },
    invalidate() {
      cached = null;
    },
  };
}
