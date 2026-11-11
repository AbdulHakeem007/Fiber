export const REGION_OPTIONS = [
  { label: "Muscat (MU)", value: "MU", regionName: "Muscat" },
  { label: "Dhofar (DF)", value: "DF", regionName: "Dhofar" },
  { label: "Musandam (MS)", value: "MS", regionName: "Musandam" },
  { label: "Batinah (BA)", value: "BA", regionName: "Batinah" },
  { label: "Sharqiyah (SH)", value: "SH", regionName: "Sharqiyah" },
  { label: "Dakhiliyah (DA)", value: "DA", regionName: "Dakhiliyah" },
  { label: "Dahira (DH)", value: "DH", regionName: "Dahira" },
  { label: "Wusta (WU)", value: "WU", regionName: "Wusta" },
] as const;

export type RegionPrefix = (typeof REGION_OPTIONS)[number]["value"];

export function normalizeRegionPrefix(value?: string | null): RegionPrefix | "" {
  const normalized = String(value ?? "").trim().toUpperCase();
  return REGION_OPTIONS.some((option) => option.value === normalized) ? (normalized as RegionPrefix) : "";
}

export function regionForSiteCode(siteCode?: string | null): string | null {
  const code = String(siteCode ?? "").trim().toUpperCase();
  const match = REGION_OPTIONS.find((option) => code.startsWith(option.value));
  return match?.regionName ?? null;
}

export function matchesRegionPrefix(siteCode?: string | null, prefix?: string | null): boolean {
  const normalized = normalizeRegionPrefix(prefix);
  if (!normalized) return true;
  return String(siteCode ?? "").trim().toUpperCase().startsWith(normalized);
}
