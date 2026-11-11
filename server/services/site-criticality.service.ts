import { prisma } from "@/lib/db/prisma";

// Well-known criticality tags get canonical casing; any other operator-entered
// value is still accepted (see normalizeCriticalityList).
const ALLOWED_CRITICALITY = ["DWDM", "PE", "PE/DWDM", "Access"] as const;

export function normalizeCriticalityList(value?: string | string[] | null) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[;,]/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Canonicalize known tags, but KEEP unknown values instead of dropping them.
    // The old code filtered out anything outside the allow-list, so editing a
    // site's criticality to any other value saved nothing — the PATCH returned
    // 200 ("saved") while the criticality stayed effectively unchanged.
    const canonical = ALLOWED_CRITICALITY.find((allowed) => allowed.toUpperCase() === trimmed.toUpperCase()) ?? trimmed;
    const key = canonical.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

export async function replaceSiteCriticality(siteId: string, value?: string | string[] | null) {
  const tags = normalizeCriticalityList(value);
  await prisma.siteCriticalityAssignment.deleteMany({ where: { siteId } });
  for (const label of tags) {
    const tag = await prisma.siteCriticalityTag.upsert({
      where: { code: label.toUpperCase().replace(/[^A-Z0-9]+/g, "_") },
      update: { label },
      create: { code: label.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), label },
    });
    await prisma.siteCriticalityAssignment.create({
      data: { siteId, tagId: tag.id },
    });
  }
}
