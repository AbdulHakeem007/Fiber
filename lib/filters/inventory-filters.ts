import type { InventorySegmentRow } from "@/types/telecom";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { matchesRegionPrefix } from "@/lib/config/regions";

export interface InventoryFilters {
  search?: string;
  site?: string;
  connectedSite?: string;
  serviceId?: string;
  rackId?: string;
  odfId?: string;
  portPair?: string;
  fiberPortNumber?: string;
  cableId?: string;
  tubeNumber?: string;
  tubeColor?: string;
  fiberNumber?: string;
  transportTrail?: string;
  status?: string;
  siteType?: string;
  regionPrefix?: string;
  dateFrom?: string;
  dateTo?: string;
}

const FILTER_KEYS = [
  "search",
  "site",
  "connectedSite",
  "serviceId",
  "rackId",
  "odfId",
  "portPair",
  "fiberPortNumber",
  "cableId",
  "tubeNumber",
  "tubeColor",
  "fiberNumber",
  "transportTrail",
  "status",
  "siteType",
  "regionPrefix",
  "dateFrom",
  "dateTo",
] as const;

function text(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function includes(value: unknown, needle?: string): boolean {
  const query = text(needle);
  if (!query) return true;
  const candidate = text(value);
  return candidate.includes(query) || (normalizeAlias(candidate)?.includes(normalizeAlias(query) ?? query) ?? false);
}

function numberEquals(value: unknown, needle?: string): boolean {
  const query = text(needle);
  if (!query) return true;
  return String(value ?? "").trim() === query;
}

function dateInRange(value?: string | null, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (!value) return false;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  if (from && time < new Date(from).getTime()) return false;
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    if (time > end.getTime()) return false;
  }
  return true;
}

export function normalizeInventoryFilters(filters: InventoryFilters): InventoryFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "" && String(value).trim().toUpperCase() !== "ALL"),
  ) as InventoryFilters;
}

export function activeInventoryFilterEntries(filters: InventoryFilters): Array<[string, string]> {
  return Object.entries(normalizeInventoryFilters(filters)).map(([key, value]) => [key, String(value)]);
}

export function parseInventoryFilters(searchParams: URLSearchParams): InventoryFilters {
  const filters: InventoryFilters = {};
  for (const key of FILTER_KEYS) {
    const value = searchParams.get(key);
    if (value) filters[key] = value;
  }
  // Alias used by the consolidated ODF delete-blocker link (?siteId=&rackId=&odfId=):
  // rackId/odfId already match the canonical filter names; map siteId -> site.
  const siteId = searchParams.get("siteId");
  if (siteId && !filters.site) filters.site = siteId;
  return normalizeInventoryFilters(filters);
}

export function inventoryFiltersToParams(filters: InventoryFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of activeInventoryFilterEntries(filters)) {
    params.set(key, value);
  }
  return params;
}

export function matchesInventoryFilters(row: InventorySegmentRow, filters: InventoryFilters): boolean {
  const active = normalizeInventoryFilters(filters);
  const haystack = [
    row.segmentCode,
    row.segmentGroupName,
    row.segmentSequence,
    row.segmentCapacityFibers,
    row.serviceIds,
    row.nearSite,
    row.nearRack,
    row.nearOdf,
    row.nearPortGroup,
    row.farSite,
    row.farRack,
    row.farOdf,
    row.farPortGroup,
    row.cableLabel,
    row.tubeNumber,
    row.tubeColor,
    row.fiberPortNumber,
    row.fiberNumber,
    row.fiberLabel,
    row.segmentGroupName,
    row.status,
    row.nearSiteType,
    row.farSiteType,
    row.nearCoreSiteType,
    row.farCoreSiteType,
    ...(row.mappings ?? []).flatMap((mapping) => [
      mapping.serviceId,
      mapping.localSite,
      mapping.localRack,
      mapping.localOdf,
      mapping.localPort,
      mapping.farSite,
      mapping.farEndpoint,
      mapping.farRack,
      mapping.farOdf,
      mapping.farPort,
      mapping.cableId,
    ]),
  ].filter(Boolean).join(" ");

  return (
    includes(haystack, active.search) &&
    (!active.site || includes(row.nearSite, active.site) || includes(row.farSite, active.site)) &&
    (!active.connectedSite || includes(row.farSite, active.connectedSite) || includes(row.nearSite, active.connectedSite)) &&
    includes(row.serviceIds, active.serviceId) &&
    (!active.rackId || includes(row.nearRack, active.rackId) || includes(row.farRack, active.rackId)) &&
    (!active.odfId || includes(row.nearOdf, active.odfId) || includes(row.farOdf, active.odfId)) &&
    (!active.portPair || includes(row.nearPortGroup, active.portPair) || includes(row.farPortGroup, active.portPair)) &&
    numberEquals(row.fiberPortNumber, active.fiberPortNumber) &&
    includes(row.cableLabel, active.cableId) &&
    numberEquals(row.tubeNumber, active.tubeNumber) &&
    includes(row.tubeColor, active.tubeColor) &&
    numberEquals(row.fiberNumber, active.fiberNumber) &&
    includes(haystack, active.transportTrail) &&
    includes(row.status, active.status) &&
    (!active.siteType || includes(row.nearSiteType, active.siteType) || includes(row.farSiteType, active.siteType)) &&
    (!active.regionPrefix || matchesRegionPrefix(row.nearSite, active.regionPrefix) || matchesRegionPrefix(row.farSite, active.regionPrefix)) &&
    dateInRange(row.updatedAt ?? row.createdAt, active.dateFrom, active.dateTo)
  );
}
