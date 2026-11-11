export function normalizeAlias(value?: string | null): string | null {
  if (!value) return null;

  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/\(.*?\)/g, "")
    .replace(/^TO\s+/i, "")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");

  return cleaned || null;
}

export function buildAliasLookup(entries: Array<{ canonicalCode: string; aliases: string[] }>): Record<string, string> {
  const lookup: Record<string, string> = {};

  for (const entry of entries) {
    const canonical = entry.canonicalCode.trim().toUpperCase();
    const keys = [canonical, ...entry.aliases].map((alias) => normalizeAlias(alias)).filter(Boolean) as string[];

    for (const key of keys) {
      lookup[key] = canonical;
    }
  }

  return lookup;
}

export function resolveAlias(value: string | null | undefined, aliasLookup: Record<string, string>): string | null {
  const normalized = normalizeAlias(value);
  if (!normalized) return null;
  return aliasLookup[normalized] ?? null;
}
