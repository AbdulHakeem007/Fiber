export interface SiteTagSource {
  isDatacenter?: boolean;
  isCoreSite?: boolean;
  siteType?: string | null;
  coreSiteType?: string | null;
  criticalityTags?: readonly string[] | null;
}

const TAG_LABELS: Record<string, string> = {
  DC: "DC",
  DATACENTER: "DC",
  DATACENTRE: "DC",
  CORE: "Core",
  CORESITE: "Core",
  DWDM: "DWDM",
};

function canonicalTag(raw?: string | null): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const key = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return TAG_LABELS[key] ?? value;
}

export function siteTagList(source: SiteTagSource): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string | null) => {
    const value = canonicalTag(raw);
    if (!value) return;
    const key = value.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(value);
  };

  if (source.isDatacenter) add("DC");
  if (source.isCoreSite) add("Core");
  add(source.coreSiteType);
  add(source.siteType);
  for (const tag of source.criticalityTags ?? []) add(tag);

  return tags;
}

export function prioritySiteTag(source: SiteTagSource, fallback = "Standard"): string {
  const tags = siteTagList(source);
  const upperTags = new Set(tags.map((tag) => tag.toUpperCase()));

  if (upperTags.has("DC")) return "DC";
  if (upperTags.has("CORE")) return "Core";

  return tags[0] ?? fallback;
}
