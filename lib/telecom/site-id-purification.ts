const REGIONAL_PREFIXES = ["MUTR", "BA", "MU", "MS", "SH", "DA", "DH", "DF", "WU"] as const;
const PREFIX_PATTERN = REGIONAL_PREFIXES.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const SITE_CODE_PATTERN = `(?:${PREFIX_PATTERN})\\d{4}`;
const SITE_WITH_ROUTE_SUFFIX_RE = new RegExp(`^\\s*(${SITE_CODE_PATTERN})(?:-\\d+)+\\s*$`, "i");
const SITE_TOKEN_RE = new RegExp(`\\b(${SITE_CODE_PATTERN})(?:-\\d+)*\\b`, "gi");
const MALFORMED_CONCATENATED_ROUTE_RE = new RegExp(`\\b(${SITE_CODE_PATTERN})\\d+\\b`, "gi");
const PROTECTED_LITERAL_DESTINATIONS = new Set([
  "BOUSHER DC",
  "SOHAR DC",
  "NIZWA DC",
  "BOUSHER MSC/BSC",
  "GHUBRAH MSC/BSC",
]);

export function purifyTransportSiteToken(value?: string | null): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const upper = text.toUpperCase().replace(/\s+/g, " ");
  if (PROTECTED_LITERAL_DESTINATIONS.has(upper)) return text;

  const whole = text.match(SITE_WITH_ROUTE_SUFFIX_RE);
  if (whole) return whole[1].toUpperCase();

  // First remove valid route suffixes: BA2000-2 / BA2000-22 -> BA2000.
  // Then repair already-corrupted impossible 5+ digit site labels that came from
  // old string concatenation bugs: BA20000 -> BA2000.
  return text
    .replace(SITE_TOKEN_RE, (_match, siteCode: string) => siteCode.toUpperCase())
    .replace(MALFORMED_CONCATENATED_ROUTE_RE, (_match, siteCode: string) => siteCode.toUpperCase())
    .trim();
}

export function extractPurifiedSiteCodes(value?: string | null): string[] {
  const text = purifyTransportSiteToken(value);
  const matches = [...text.matchAll(SITE_TOKEN_RE)].map((match) => match[1].toUpperCase());
  if (matches.length) return matches;

  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const compactMatches: string[] = [];
  for (const prefix of REGIONAL_PREFIXES) {
    const regex = new RegExp(`${prefix}\\d{4}`, "g");
    for (const match of compact.matchAll(regex)) compactMatches.push(match[0]);
  }
  return compactMatches;
}

export function extractPurifiedSiteCode(value?: string | null, preference: "first" | "last" = "first"): string | null {
  const matches = extractPurifiedSiteCodes(value);
  if (!matches.length) return null;
  return preference === "last" ? matches[matches.length - 1] : matches[0];
}

export function splitTransportPathSites(pathInput?: string | null): string[] {
  const text = String(pathInput ?? "").trim();
  if (!text) return [];

  // Split on explicit path delimiters: arrows (->, →) and dash variants
  // (hyphen, en-dash, em-dash) that are surrounded by whitespace. Requiring
  // whitespace around bare dashes preserves route suffixes like "BA0242-2"
  // (no spaces) while still splitting "Majis – BA0255 – … – Sohar Exchange".
  // Splitting on the delimiter keeps NAMED endpoint sites ("Majis", "Sohar
  // Exchange") that are not regex-matchable site codes, so the first and last
  // edge exchanges are never dropped. Previously a dash-separated chain fell
  // through to the code-token branch below, which silently removed every
  // non-code token (i.e. the boundary exchanges).
  const delimitedParts = text
    .split(/\s*(?:->|→)\s*|\s+[-–—]\s+/g)
    .map((part) => purifyTransportSiteToken(part.replace(/\([^)]*\)/g, "")).trim())
    .filter(Boolean);
  if (delimitedParts.length > 1) return collapseConsecutiveSites(delimitedParts);

  const siteTokens = extractPurifiedSiteCodes(text);
  if (siteTokens.length >= 2) return collapseConsecutiveSites(siteTokens);

  return collapseConsecutiveSites(
    text
      .split(/\s*-\s*/g)
      .map((part) => purifyTransportSiteToken(part.replace(/\([^)]*\)/g, "")).trim())
      .filter((part) => part && !/^\d+$/.test(part)),
  );
}

function collapseConsecutiveSites(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const purified = purifyTransportSiteToken(value);
    const key = extractPurifiedSiteCode(purified) ?? purified.toUpperCase();
    const previous = result[result.length - 1];
    const previousKey = previous ? (extractPurifiedSiteCode(previous) ?? previous.toUpperCase()) : null;
    if (!previousKey || previousKey !== key) result.push(purified);
  }
  return result;
}
