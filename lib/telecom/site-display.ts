import { normalizeAlias } from "@/lib/import/alias-normalizer";

const SITE_ID_PATTERNS = [
  /MUTR\d{3,6}/,
  /MU\d{3,6}/,
  /DH\d{3,6}/,
  /BA\d{3,6}/,
  /SH\d{3,6}/,
  /MS\d{3,6}/,
  /DA\d{3,6}/,
  /DF\d{3,6}/,
];

function clean(value?: string | null): string | null {
  const text = String(value ?? "").replace(/^\s*to\s+/i, "").trim();
  return text || null;
}

export function extractSiteId(value?: string | null): string | null {
  const text = clean(value);
  if (!text) return null;
  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const pattern of SITE_ID_PATTERNS) {
    const match = compact.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export function displayCleanSiteId(value?: string | null): string {
  const id = extractSiteId(value);
  if (id) return id;

  const text = clean(value);
  if (!text) return "-";

  return text
    .replace(/\((?:DC|CORE|DWDM|DATACENT(?:ER|RE)|CORE SITE)\)/gi, "")
    .replace(/\b(?:DC|CORE|DWDM|DATACENT(?:ER|RE)|CORE SITE)\b$/gi, "")
    .replace(/[|/,-]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim() || "-";
}


const COMPACT_LABEL_OVERRIDES: Record<string, string> = {
  BOUSHERMSCBSC: "Bousher MSC & BSC",
  BOWSHERMSCBSC: "Bousher MSC & BSC",
  BOWSHARMSCBSC: "Bousher MSC & BSC",
  BOUSHERMSC: "Bousher MSC",
  BOWSHERMSC: "Bousher MSC",
  BOWSHARMSC: "Bousher MSC",
  GHUBRAHMSCBSC: "Ghubrah MSC & BSC",
  GHUBRAHMSC: "Ghubrah MSC",
  AMETROOTNSHELTER: "A Metro OTN Shelter",
  COLLEGEOFFORENSIC: "College Of Forensic",
  COLLEGEOFFORENSICSCIENCE: "College Of Forensic Science",
  MINISTRYOFHEALTH: "Ministry Of Health",
  WATTAYAHILL: "Wattaya Hill",
  WATTAIYAHILL: "Wattaya Hill",
  ALMUNAGARDENSMDU: "Al Muna Gardens MDU",
  ALMUNAGARDENS: "Al Muna Gardens",
  DARSAIT: "Darsait",
  DARSIT: "Darsit",
  MALLLOFOMAN: "Mall Of Oman",
  MALLOFOMAN: "Mall Of Oman",
};

function compactOverride(value?: string | null): string | null {
  const normalized = normalizeAlias(value);
  return normalized ? COMPACT_LABEL_OVERRIDES[normalized] ?? null : null;
}

const COMPACT_WORDS = [
  "MINISTRY", "HEALTH", "COLLEGE", "FORENSIC", "SCIENCE", "SHELTER", "BOUSHER", "BOWSHER",
  "GHUBRAH", "GHUBRA", "WATTAYA", "WATTAIYA", "HILL", "DARSIT", "RUWI", "QURUM", "GHALA",
  "MALL", "OMAN", "MUSCAT", "MABELLA", "MABELA", "SEEB", "KHOUWIR", "KHUWAIR",
  "BUILDING", "ELECTRICAL", "GARDENS", "GARDEN", "AMETRO", "METRO", "OTN", "SUBRING", "SUB", "RING",
  "HEIGHTS", "PALACE", "OFFICE", "AIRPORT", "STADIUM", "SCHOOL", "HOSPITAL", "BANK",
  "MSCBSC", "MSC", "BSC", "MDU", "POP", "DC", "ATN", "ODF", "OLT", "PE", "OSP", "ISP", "NOC", "DWDM", "TTC", "OBC", "OF",
  "AL", "NEW", "OLD", "EXCHANGE", "CABINET", "ROOFTOP", "ROOF", "TOP", "BASEMENT", "OUTDOOR", "INDOOR"
].sort((a, b) => b.length - a.length);

function splitKnownCompactWords(text: string): string {
  const upper = text.toUpperCase();
  if (!/^[A-Z0-9&]+$/.test(upper) || upper.length < 6) return text;

  const tokens: string[] = [];
  let index = 0;
  while (index < upper.length) {
    const siteId = upper.slice(index).match(/^(?:MUTR|MU|DH|BA|SH|MS|DA|DF)\d{3,6}/)?.[0];
    if (siteId) {
      tokens.push(siteId);
      index += siteId.length;
      continue;
    }

    const number = upper.slice(index).match(/^\d+/)?.[0];
    if (number) {
      tokens.push(number);
      index += number.length;
      continue;
    }

    const word = COMPACT_WORDS.find((candidate) => upper.startsWith(candidate, index));
    if (word) {
      tokens.push(word === "MSCBSC" ? "MSC BSC" : word === "AMETRO" ? "A Metro" : word);
      index += word.length;
      continue;
    }

    // Collect unknown letters until the next known token to avoid losing characters.
    let next = index + 1;
    while (next < upper.length && !COMPACT_WORDS.some((candidate) => upper.startsWith(candidate, next)) && !upper.slice(next).match(/^(?:MUTR|MU|DH|BA|SH|MS|DA|DF)\d{3,6}/)) {
      next += 1;
    }
    tokens.push(upper.slice(index, next));
    index = next;
  }

  return tokens.join(" ").replace(/\bMSC\s+BSC\b/g, "MSC & BSC").replace(/\s+/g, " ").trim() || text;
}

function wordsFromCompact(text: string): string {
  const known = splitKnownCompactWords(text);
  const spaced = known
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/(MSC|BSC|MDU|POP|DC|ATN|ODF|OLT|PE|OSP|ISP)/gi, " $1 ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced || text;
}

function titleCaseName(value?: string | null): string | null {
  const text = clean(value)
    ?.replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const directOverride = compactOverride(text);
  if (directOverride) return directOverride;

  // Keep telecom/network acronyms readable.
  return wordsFromCompact(text)
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (["MSC", "BSC", "MDU", "POP", "DC", "ATN", "ODF", "OLT", "PE", "OSP", "ISP", "NOC", "DWDM", "OTN"].includes(upper)) return upper;
      if (/^(MU|MUTR|DH|BA|SH|MS|DA|DF)\d+/i.test(word)) return upper;
      if (word.length <= 2 && /^[A-Z]+$/.test(word)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function contextCandidates(context?: string | null): string[] {
  const text = clean(context);
  if (!text) return [];
  // Split gently: segment groups are usually SiteA-SiteB-C01-36F.
  // Ignore cable suffix tokens like C01/36F.
  return text
    .split(/\s+-\s+|-(?=(?:MU|MUTR|DH|BA|SH|MS|DA|DF)\d|[A-Z][a-z]|[A-Z]{3,})/g)
    .map((item) => item.trim())
    .filter((item) => item && !/^C\d+$/i.test(item) && !/^\d+F$/i.test(item));
}

function findContextName(value: string, context?: string | null): string | null {
  const wanted = normalizeAlias(value);
  if (!wanted) return null;
  for (const candidate of contextCandidates(context)) {
    const normalizedCandidate = normalizeAlias(candidate);
    if (!normalizedCandidate) continue;
    const wantedId = extractSiteId(value);
    const candidateId = extractSiteId(candidate);
    if (
      normalizedCandidate === wanted
      || normalizedCandidate.includes(wanted)
      || wanted.includes(normalizedCandidate)
      || (wantedId && candidateId && wantedId === candidateId)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Display a site without destroying spaces.
 *
 * Internal keys may still be normalized as MINISTRYOFHEALTH or WATTAYAHILL,
 * but the UI should show Ministry of Health / Wattaya Hill where possible.
 */
export function displaySiteLabel(value?: string | null, context?: string | null): string {
  const text = clean(value);
  if (!text) return "-";

  const directOverride = compactOverride(text);
  if (directOverride) return directOverride;

  const readableContext = clean(context);
  if (readableContext && normalizeAlias(readableContext) === normalizeAlias(text) && /\s|&|\(|\)/.test(readableContext)) {
    return titleCaseName(readableContext) ?? readableContext;
  }

  const contextMatch = findContextName(text, context);
  const source = contextMatch ?? text;
  const id = extractSiteId(source) ?? extractSiteId(text);
  const parenName = source.match(/\(([^)]+)\)/)?.[1]?.trim();

  if (id && parenName) return `${id} (${titleCaseName(parenName)})`;

  if (id) {
    const withoutId = source
      .replace(new RegExp(id, "ig"), " ")
      .replace(/[()\-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const name = titleCaseName(withoutId);
    return name && normalizeAlias(name) !== normalizeAlias(id) ? `${id} (${name})` : id;
  }

  return titleCaseName(source) ?? text;
}

export function displaySiteHrefKey(value?: string | null): string {
  return extractSiteId(value) ?? normalizeAlias(value) ?? String(value ?? "").trim();
}
