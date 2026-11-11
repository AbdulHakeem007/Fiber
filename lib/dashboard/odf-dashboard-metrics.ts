import { normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";
import { extractSiteId } from "@/lib/telecom/site-display";

export interface DashboardOdfMappingInput {
  id: string;
  localSiteCode?: string | null;
  farSiteCode?: string | null;
  farEndpointLabel?: string | null;
  localPortLabel?: string | null;
  farPortLabel?: string | null;
  fiberNumbersJson?: string | null;
  serviceCode?: string | null;
  tag?: string | null;
  status: string;
}

export interface DashboardOdfSegmentInput {
  id: string;
  segmentCode: string;
  sitePairKey?: string | null;
  segmentDefaultRole?: string | null;
  totalFiberCapacity: number;
  fiberCount?: number | null;
  availableFiberCount: number;
  endpointA: { siteCode?: string | null };
  endpointB: { siteCode?: string | null };
  endpointMappings: DashboardOdfMappingInput[];
}

export interface DashboardCoreSiteInput {
  id: string;
  code: string;
  label: string;
  tags: string[];
  isDatacenter?: boolean;
  isCoreSite?: boolean;
}

export interface IntraSiteSaturationRow {
  key: string;
  segmentName: string;
  totalCapacity: number;
  nearEndAvailablePorts: number;
  farEndAvailablePorts: number;
  saturationPct: number;
  siteCode: string;
  siteLabel: string;
  siteTag: string;
}

export interface IntraSiteSaturationGroup {
  siteCode: string;
  siteLabel: string;
  siteTag: string;
  rows: IntraSiteSaturationRow[];
}

export interface ActiveServiceFootprintBar {
  tag: string;
  count: number;
}

export interface IntraSiteDashboardMetrics {
  saturationGroups: IntraSiteSaturationGroup[];
  activeServiceFootprint: ActiveServiceFootprintBar[];
}

interface QualifiedIntraSiteSegment {
  segment: DashboardOdfSegmentInput;
  site: DashboardCoreSiteInput;
  mappings: DashboardOdfMappingInput[];
}

const NON_SERVICE_CODES = new Set([
  "-",
  "AVAILABLE",
  "DARK",
  "EMPTY",
  "FREE",
  "N/A",
  "NA",
  "NONE",
  "NULL",
  "RESERVED",
  "SPARE",
  "UNASSIGNED",
  "USED",
]);

const SITE_ID_TOKEN = /(?:MUTR|MU|DH|BA|SH|MS|DA|DF|WU)\d{3,6}/gi;

function normalizeRole(value?: string | null): string {
  return String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * Returns a stable parent-site identity while ignoring room/container modifiers.
 * Known telecom IDs remain exact; unknown IDs compare on their first 6-8
 * alphanumeric characters, which covers labels such as SITE01(OLD ROOM).
 */
export function parentSiteIdentity(value?: string | null): string | null {
  const knownSiteId = extractSiteId(value);
  if (knownSiteId) return knownSiteId.toUpperCase();

  const base = String(value ?? "")
    .trim()
    .replace(/^\s*to\s+/i, "")
    .split(/[([]/, 1)[0]
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!base) return null;
  return base.length >= 6 ? base.slice(0, 8) : base;
}

export function isSameParentSite(left?: string | null, right?: string | null): boolean {
  const leftKey = parentSiteIdentity(left);
  const rightKey = parentSiteIdentity(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;

  return leftKey.length >= 6
    && rightKey.length >= 6
    && leftKey.slice(0, 6) === rightKey.slice(0, 6);
}

function segmentNameSitePair(segment: DashboardOdfSegmentInput): [string, string] | null {
  for (const value of [segment.segmentCode, segment.sitePairKey]) {
    const ids = String(value ?? "").toUpperCase().match(SITE_ID_TOKEN) ?? [];
    if (ids.length >= 2) return [ids[0]!, ids[1]!];
  }
  return null;
}

function mappingParentSite(segment: DashboardOdfSegmentInput, mapping: DashboardOdfMappingInput): string | null {
  const localSite = mapping.localSiteCode ?? segment.endpointA.siteCode;
  const farSite = mapping.farSiteCode ?? mapping.farEndpointLabel ?? segment.endpointB.siteCode;
  if (isSameParentSite(localSite, farSite)) return parentSiteIdentity(localSite);

  // A manually corrected segment name is authoritative for an explicitly
  // INTRA_SITE parent, even when imported endpoint labels still contain room or
  // container-era text.
  const namedPair = segmentNameSitePair(segment);
  if (namedPair && isSameParentSite(namedPair[0], namedPair[1])) return parentSiteIdentity(namedPair[0]);
  return null;
}

function isCoreOrDcSite(site: DashboardCoreSiteInput): boolean {
  if (site.isDatacenter || site.isCoreSite) return true;
  return site.tags.some((tag) => ["CORE", "DC", "DATACENTER", "DATA CENTER"].includes(tag.trim().toUpperCase()));
}

function siteMatchesIdentity(site: DashboardCoreSiteInput, identity: string): boolean {
  return isCoreOrDcSite(site) && isSameParentSite(site.code, identity);
}

function qualifiedIntraSiteSegments(
  segments: DashboardOdfSegmentInput[],
  sites: DashboardCoreSiteInput[],
): QualifiedIntraSiteSegment[] {
  const qualified: QualifiedIntraSiteSegment[] = [];

  for (const segment of segments) {
    if (normalizeRole(segment.segmentDefaultRole) !== "INTRA_SITE") continue;

    const mappingsBySite = new Map<string, { site: DashboardCoreSiteInput; mappings: DashboardOdfMappingInput[] }>();
    for (const mapping of segment.endpointMappings) {
      const parentIdentity = mappingParentSite(segment, mapping);
      if (!parentIdentity) continue;
      const site = sites.find((candidate) => siteMatchesIdentity(candidate, parentIdentity));
      if (!site) continue;

      const bucket = mappingsBySite.get(site.id) ?? { site, mappings: [] };
      bucket.mappings.push(mapping);
      mappingsBySite.set(site.id, bucket);
    }

    for (const { site, mappings } of mappingsBySite.values()) {
      if (mappings.length) qualified.push({ segment, site, mappings });
    }
  }

  return qualified;
}

function fiberUnitCount(label?: string | null, fiberNumbersJson?: string | null): number {
  const jsonNumbers = String(fiberNumbersJson ?? "").match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (jsonNumbers.length) return new Set(jsonNumbers).size;

  const numbers = String(label ?? "")
    .replace(/\([^)]*\)/g, " ")
    .match(/\d+/g)
    ?.map(Number)
    .filter(Number.isFinite) ?? [];
  if (numbers.length >= 2) return Math.max(1, Math.abs(numbers[1] - numbers[0]) + 1);
  return numbers.length === 1 ? 1 : 0;
}

function isAvailableMapping(mapping: DashboardOdfMappingInput): boolean {
  return String(mapping.status).toUpperCase() === "AVAILABLE" && !String(mapping.serviceCode ?? "").trim();
}

function siteTagLabel(tags: string[]): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const key = tag.toUpperCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    values.push(tag);
  }
  return values.join(" · ") || "Unclassified";
}

function saturationGroupsFromQualified(qualified: QualifiedIntraSiteSegment[]): IntraSiteSaturationGroup[] {
  const groupsBySite = new Map<string, IntraSiteSaturationGroup>();

  for (const { site, segment, mappings } of qualified) {
    let mappedCapacity = 0;
    let mappedAvailable = 0;
    let nearAvailable = 0;
    let farAvailable = 0;

    for (const mapping of mappings) {
      const unitCount = fiberUnitCount(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson);
      const available = isAvailableMapping(mapping);
      mappedCapacity += unitCount;
      if (available) {
        mappedAvailable += unitCount;
        if (mapping.localPortLabel?.trim()) nearAvailable += unitCount;
        if (mapping.farPortLabel?.trim()) farAvailable += unitCount;
      }
    }

    const totalCapacity = mappedCapacity || segment.totalFiberCapacity || segment.fiberCount || 0;
    const availableFallback = mappedCapacity ? mappedAvailable : Math.max(0, segment.availableFiberCount);
    if (!mappedCapacity) {
      nearAvailable = availableFallback;
      farAvailable = availableFallback;
    }
    const saturationPct = totalCapacity
      ? Math.round(((totalCapacity - Math.min(totalCapacity, availableFallback)) / totalCapacity) * 100)
      : 0;

    const siteTag = siteTagLabel(site.tags);
    const group = groupsBySite.get(site.id) ?? {
      siteCode: site.code,
      siteLabel: site.label,
      siteTag,
      rows: [],
    };
    group.rows.push({
      key: `${site.id}:${segment.id}`,
      segmentName: segment.segmentCode || segment.sitePairKey || "Unnamed segment",
      totalCapacity,
      nearEndAvailablePorts: nearAvailable,
      farEndAvailablePorts: farAvailable,
      saturationPct,
      siteCode: site.code,
      siteLabel: site.label,
      siteTag,
    });
    groupsBySite.set(site.id, group);
  }

  return [...groupsBySite.values()]
    .map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) => b.saturationPct - a.saturationPct || a.segmentName.localeCompare(b.segmentName)),
    }))
    .sort((a, b) => a.siteLabel.localeCompare(b.siteLabel));
}

function footprintFromQualified(qualified: QualifiedIntraSiteSegment[]): ActiveServiceFootprintBar[] {
  const servicesByTag = new Map<string, { label: string; services: Set<string> }>();

  for (const { mappings } of qualified) {
    for (const mapping of mappings) {
      const status = String(mapping.status).trim().toUpperCase();
      const tag = String(mapping.tag ?? "").trim();
      const service = normalizeServiceCodeExact(mapping.serviceCode);
      if (!tag || !service || !["ACTIVE", "USED"].includes(status) || NON_SERVICE_CODES.has(service)) continue;

      const tagKey = tag.toUpperCase().replace(/\s+/g, " ");
      const bucket = servicesByTag.get(tagKey) ?? { label: tag, services: new Set<string>() };
      bucket.services.add(service);
      servicesByTag.set(tagKey, bucket);
    }
  }

  return [...servicesByTag.values()]
    .map((bucket) => ({ tag: bucket.label, count: bucket.services.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Builds both components from one strictly qualified INTRA_SITE + Core/DC pool. */
export function buildIntraSiteDashboardMetrics(
  segments: DashboardOdfSegmentInput[],
  sites: DashboardCoreSiteInput[],
): IntraSiteDashboardMetrics {
  const qualified = qualifiedIntraSiteSegments(segments, sites);
  return {
    saturationGroups: saturationGroupsFromQualified(qualified),
    activeServiceFootprint: footprintFromQualified(qualified),
  };
}

export function buildIntraSiteSaturationGroups(
  segments: DashboardOdfSegmentInput[],
  sites: DashboardCoreSiteInput[],
): IntraSiteSaturationGroup[] {
  return buildIntraSiteDashboardMetrics(segments, sites).saturationGroups;
}

export function buildIntraSiteActiveServiceFootprint(
  segments: DashboardOdfSegmentInput[],
  sites: DashboardCoreSiteInput[],
): ActiveServiceFootprintBar[] {
  return buildIntraSiteDashboardMetrics(segments, sites).activeServiceFootprint;
}

export function nextRotationIndex(current: number, itemCount: number): number {
  return itemCount > 0 ? (current + 1) % itemCount : 0;
}
