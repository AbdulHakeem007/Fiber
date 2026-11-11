export function normalizeSelectedSiteIds(siteIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const siteId of siteIds) {
    const clean = String(siteId ?? "").trim();
    if (!clean) continue;
    const key = clean.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }

  return result;
}

export function parseSelectedSiteIds(value: string): string[] {
  return normalizeSelectedSiteIds(value.split(/\s*&\s*|[;,]/));
}

export function formatSelectedSiteIds(siteIds: readonly string[]): string {
  const sites = normalizeSelectedSiteIds(siteIds);
  if (sites.length <= 2) return sites.join(" & ");
  return `${sites.slice(0, -1).join(", ")} & ${sites[sites.length - 1]}`;
}
