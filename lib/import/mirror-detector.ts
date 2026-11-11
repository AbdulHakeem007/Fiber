import { buildSitePairKey } from "@/lib/telecom/site-pair";

function normalizeText(value?: string | null): string {
  return value?.trim().toUpperCase().replace(/\s+/g, " ") || "?";
}

export function buildMirrorKey(siteA?: string | null, siteB?: string | null, portA?: string | null, portB?: string | null): string {
  const pair = buildSitePairKey(siteA, siteB);
  const ports = [portA?.trim() || "?", portB?.trim() || "?"].sort();
  return `${pair}__${ports[0]}__${ports[1]}`;
}

export function buildLegacyMirrorKey(input: {
  siteA?: string | null;
  siteB?: string | null;
  definition?: string | null;
  ordinalInBand?: number | null;
  odfCode?: string | null;
}): string {
  const pair = buildSitePairKey(input.siteA, input.siteB);
  const definition = normalizeText(input.definition);
  const ordinal = input.ordinalInBand ?? -1;
  return `${pair}__${definition}__ORD${ordinal}`;
}
