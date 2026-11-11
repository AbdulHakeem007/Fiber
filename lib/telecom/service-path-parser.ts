import { normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";
import { purifyTransportSiteToken, splitTransportPathSites } from "@/lib/telecom/site-id-purification";

export interface ParsedServicePathSite {
  code: string;
  label: string;
  isJumper: boolean;
}

export interface ParsedServicePath {
  serviceCode: string;
  sites: ParsedServicePathSite[];
  fullPathLabel: string;
}

function normalizePathLabel(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\(\s*jumper\s*\)/i, " (Jumper)");
}

function normalizeSiteCode(value: string): string {
  return purifyTransportSiteToken(value.replace(/\([^)]*\)/g, "")).trim().toUpperCase();
}

export function parseServicePathInput(input: string, explicitServiceCode?: string | null): ParsedServicePath {
  const text = input.trim();
  if (!text) throw new Error("Enter an ordered site path before allocating a service.");

  const separatorIndex = text.indexOf(":");
  const pathText = separatorIndex >= 0 ? text.slice(0, separatorIndex).trim() : text;
  const serviceCode = normalizeServiceCodeExact(explicitServiceCode || (separatorIndex >= 0 ? text.slice(separatorIndex + 1).trim() : ""));

  if (!serviceCode) {
    throw new Error("Add the service ID after ':' or provide serviceCode in the request.");
  }

  const rawSites = splitTransportPathSites(pathText)
    .map(normalizePathLabel)
    .filter(Boolean)
    .map((label) => ({
      label: purifyTransportSiteToken(label),
      code: normalizeSiteCode(label),
      isJumper: /\(\s*jumper\s*\)/i.test(label),
    }))
    .filter((site) => site.code);

  // EDIT HERE: Prevent false self-hops such as DH0000 -> DH0000.
  // A split path should be X -> Y -> Z, not X -> Y -> Y -> Z.
  const sites = rawSites.filter((site, index) => index === 0 || site.code !== rawSites[index - 1]?.code);

  if (sites.length < 2) {
    throw new Error("A service path must contain at least two sites.");
  }

  return {
    serviceCode,
    sites,
    fullPathLabel: sites.map((site) => site.label).join(" -> "),
  };
}
