import { buildSitePairKey } from "@/lib/telecom/site-pair";

export interface EndpointIdentityInput {
  siteCode?: string | null;
  rackCode?: string | null;
  odfCode?: string | null;
  portLabel?: string | null;
}

export interface OdfNormalizationResult {
  value: string | null;
  warning: string | null;
}

function cleanText(value?: string | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export function normalizeSiteCode(value?: string | null): string | null {
  const text = cleanText(value);
  return text ? text.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
}

export function normalizeRackCode(value?: string | null): string | null {
  const text = cleanText(value);
  return text ? text.toUpperCase().replace(/\s+/g, "") : null;
}

export function normalizePortLabel(value?: string | null): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const withoutExcelTextWrapper = text
    .replace(/^=\s*"/, "")
    .replace(/^="/, "")
    .replace(/^=/, "")
    .replace(/^"+|"+$/g, "");
  return withoutExcelTextWrapper.toUpperCase().replace(/\s+/g, "").replace(/\u2013|\u2014/g, "-");
}

export function normalizeServiceCodeExact(value?: string | null): string | null {
  const text = cleanText(value);
  return text ? text.toUpperCase().replace(/\s+/g, " ") : null;
}

export function normalizeOdfIdentifier(value?: string | null): OdfNormalizationResult {
  const original = cleanText(value);
  if (!original) return { value: null, warning: null };

  const withoutPrefix = original.toUpperCase().replace(/^ODF/i, "");
  const letters = withoutPrefix.replace(/[^A-Z]/g, "");
  const fallbackLetters = original.toUpperCase().replace(/^ODF/i, "").replace(/[^A-Z]/g, "");
  const normalizedLetters = letters || fallbackLetters;
  const valueToStore = normalizedLetters.slice(0, 2) || null;
  const warning = normalizedLetters.length > 2
    ? `ODF '${original}' was normalized to '${valueToStore}'. ODF identifiers are limited to two alphabetic characters.`
    : null;

  return { value: valueToStore, warning };
}

export function normalizeEndpointIdentity(input: EndpointIdentityInput): Required<EndpointIdentityInput> {
  return {
    siteCode: normalizeSiteCode(input.siteCode) ?? "?",
    rackCode: normalizeRackCode(input.rackCode) ?? "?",
    odfCode: normalizeOdfIdentifier(input.odfCode).value ?? "?",
    portLabel: normalizePortLabel(input.portLabel) ?? "?",
  };
}

export function endpointIdentityKey(input: EndpointIdentityInput): string {
  const normalized = normalizeEndpointIdentity(input);
  return [normalized.siteCode, normalized.rackCode, normalized.odfCode, normalized.portLabel].join("|");
}

export function physicalConnectionIdentity(endpointA: EndpointIdentityInput, endpointB: EndpointIdentityInput): string {
  const endpoints = [endpointIdentityKey(endpointA), endpointIdentityKey(endpointB)].sort();
  return `${endpoints[0]}<->${endpoints[1]}`;
}

export function sitePairKeyForEndpoints(endpointA: EndpointIdentityInput, endpointB: EndpointIdentityInput): string {
  return buildSitePairKey(normalizeSiteCode(endpointA.siteCode), normalizeSiteCode(endpointB.siteCode));
}
