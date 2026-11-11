export interface ReadThroughCacheOptions {
  ttlMs: number;
  maxEntries?: number;
}

interface CacheEntry<T> {
  value?: T;
  expiresAt: number;
  inflight?: Promise<T>;
}

export function createReadThroughCache<T>({ ttlMs, maxEntries = 50 }: ReadThroughCacheOptions) {
  const entries = new Map<string, CacheEntry<T>>();

  function trim() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (!oldest) return;
      entries.delete(oldest);
    }
  }

  return {
    async get(key: string, load: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const existing = entries.get(key);
      if (existing?.value !== undefined && existing.expiresAt > now) return existing.value;
      if (existing?.inflight) return existing.inflight;

      const entry: CacheEntry<T> = existing ?? { expiresAt: 0 };
      const inflight = load()
        .then((value) => {
          entries.set(key, { value, expiresAt: Date.now() + ttlMs });
          trim();
          return value;
        })
        .finally(() => {
          const latest = entries.get(key);
          if (latest?.inflight === inflight) {
            latest.inflight = undefined;
          }
        });

      entry.inflight = inflight;
      entries.set(key, entry);
      return inflight;
    },
    clear() {
      entries.clear();
    },
  };
}
