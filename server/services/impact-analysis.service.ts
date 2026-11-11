import { prisma } from "@/lib/db/prisma";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { normalizeServiceCodeExact, normalizePortLabel, normalizeRackCode } from "@/lib/telecom/connection-identity";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { isStrandedStrandRemark } from "@/lib/telecom/stranded";
import {
  matchesInventoryFilters,
  normalizeInventoryFilters,
  type InventoryFilters,
} from "@/lib/filters/inventory-filters";
import { inventoryService } from "@/server/services/inventory.service";
import type { CutoverImpactSummary, ImpactBoundaryEndpoint, ImpactBoundaryFootprint, ImpactResource, ImpactService, ImpactSite, IndirectImpactPath } from "@/types/impact";

type InventoryRow = Awaited<ReturnType<typeof inventoryService.listInventory>>[number];
type InventoryMapping = NonNullable<InventoryRow["mappings"]>[number];

function splitServiceIds(value?: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSiteToken(value?: string | null): string | null {
  const cleaned = (value ?? "").replace(/\([^)]*\)/g, "").trim();
  if (!cleaned) return null;
  return normalizeAlias(cleaned) ?? cleaned.toUpperCase();
}

function splitPathTokens(path?: string | null): string[] {
  return (path ?? "")
    .replace(/\b(?:TO|THEN|VIA)\b/gi, "->")
    .split(/\s*(?:->|→|=>|,|;|\||\/|-)\s*|\s{2,}/g)
    .map((site) => site.trim())
    .filter(Boolean);
}

function siteCodesFromPath(path?: string | null): string[] {
  const tokens = splitPathTokens(path);
  if (tokens.length) return tokens.map((site) => normalizeSiteToken(site)).filter(Boolean) as string[];
  return (path ?? "")
    .split(/\s*(?:->|→|-)\s*/g)
    .map((site) => normalizeSiteToken(site))
    .filter(Boolean) as string[];
}

function displaySitesFromPath(path?: string | null): string[] {
  const tokens = splitPathTokens(path);
  if (tokens.length) return tokens;
  return (path ?? "")
    .split(/\s*(?:->|→|-)\s*/g)
    .map((site) => site.trim())
    .filter(Boolean);
}

function pathPairsFromSites(sites: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < sites.length - 1; index += 1) pairs.push([sites[index], sites[index + 1]]);
  return pairs;
}

function pairKey(left?: string | null, right?: string | null): string | null {
  const a = normalizeSiteToken(left);
  const b = normalizeSiteToken(right);
  if (!a || !b) return null;
  return [a, b].sort().join("<>");
}

function rowEndpointPairs(row: InventoryRow): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const parent = pairKey(row.nearSite, row.farSite);
  if (parent && row.nearSite && row.farSite) pairs.push([normalizeSiteToken(row.nearSite)!, normalizeSiteToken(row.farSite)!]);
  for (const mapping of row.mappings ?? []) {
    const local = normalizeSiteToken(mapping.localSite);
    const far = normalizeSiteToken(mapping.farSite ?? mapping.farEndpoint);
    if (local && far) pairs.push([local, far]);
  }
  const seen = new Set<string>();
  return pairs.filter(([a, b]) => {
    const key = [a, b].sort().join("<>");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowPairKeys(row: InventoryRow): Set<string> {
  return new Set(rowEndpointPairs(row).map(([a, b]) => [a, b].sort().join("<>")));
}

function matchesPathPair(row: InventoryRow, pair: [string, string]): boolean {
  const wanted = [pair[0], pair[1]].sort().join("<>");
  const segmentText = [row.segmentCode, row.segmentGroupName].filter(Boolean).join(" ").toUpperCase();
  return rowPairKeys(row).has(wanted) || (segmentText.includes(pair[0]) && segmentText.includes(pair[1]));
}

function classifyFacing(sites: ImpactSite[], serviceCount: number): CutoverImpactSummary["facing"] {
  if (!serviceCount) return "NO_LIVE_IMPACT";
  if (sites.some((site) => /DWDM|DATA CENTER|CORE/i.test(site.coreSiteType ?? ""))) return "CORE_BACKBONE_FACING";
  if (sites.some((site) => /PE|AGG/i.test(site.coreSiteType ?? "") || /aggregation/i.test(site.siteType ?? ""))) return "AGGREGATION_FACING";
  if (serviceCount > 0) return "CUSTOMER_FACING";
  return "ACCESS_FACING";
}

function classifyScope(linkCount: number, serviceCount: number, coreCount: number): CutoverImpactSummary["impactScope"] {
  if (linkCount === 0 && serviceCount === 0) return "NONE";
  if (coreCount > 0) return "CORE_CRITICAL";
  if (serviceCount > 3 || linkCount > 10) return "WIDESPREAD";
  if (serviceCount > 1) return "MULTI_SERVICE";
  return "LIMITED";
}

function rowServices(row: InventoryRow): string[] {
  return [...new Set([
    ...splitServiceIds(row.serviceIds),
    ...((row.mappings ?? []).map((mapping) => mapping.serviceId).filter(Boolean) as string[]),
  ])];
}

function serviceLinkRows(rows: InventoryRow[], section: "Direct" | "Indirect", requestedService?: string | null, allowedServices?: Set<string>) {
  const requested = normalizedService(requestedService);
  const output: Array<{
    section: "Direct" | "Indirect";
    serviceId: string;
    segmentCode: string;
    nearSite?: string | null;
    nearRack?: string | null;
    nearOdf?: string | null;
    nearPort?: string | null;
    farSite?: string | null;
    farRack?: string | null;
    farOdf?: string | null;
    farPort?: string | null;
    status?: string | null;
  }> = [];

  for (const row of rows) {
    for (const mapping of row.mappings ?? []) {
      const serviceId = mapping.serviceId ?? "";
      if (!serviceId) continue;
      // Direct impact covers every ACTIVE circuit traversing the physical
      // segment, not only the requested service ID; dead inventory stays out.
      if (!mappingCarriesLiveTraffic(mapping)) continue;
      const normalized = normalizedService(serviceId);
      if (allowedServices?.size && (!normalized || !allowedServices.has(normalized))) continue;
      if (requested && !allowedServices?.size && normalized && normalized !== requested && !normalized.includes(requested) && !requested.includes(normalized)) continue;
      output.push({
        section,
        serviceId,
        segmentCode: row.segmentCode,
        nearSite: mapping.localSite,
        nearRack: mapping.localRack,
        nearOdf: mapping.localOdf,
        nearPort: mapping.localPort,
        farSite: mapping.farSite ?? mapping.farEndpoint,
        farRack: mapping.farRack,
        farOdf: mapping.farOdf,
        farPort: mapping.farPort,
        status: mapping.status ?? row.status,
      });
    }
  }
  return output;
}

function normalizedService(value?: string | null): string | null {
  const normalized = normalizeServiceCodeExact(value ?? "");
  return normalized || (value?.trim().toUpperCase() ?? null);
}

function rowHasRequestedService(row: InventoryRow, requestedService?: string | null): boolean {
  const requested = normalizedService(requestedService);
  if (!requested) return false;
  return rowServices(row).some((service) => {
    const current = normalizedService(service);
    return Boolean(current && (current === requested || current.includes(requested) || requested.includes(current)));
  });
}


function normalizeId(value?: string | null): string | null {
  const text = String(value ?? "").trim();
  if (!text || text === "-") return null;
  return text.toUpperCase().replace(/\s+/g, " ");
}

function endpointFromParts(site?: string | null, rack?: string | null, odf?: string | null): ImpactBoundaryEndpoint | null {
  const siteId = normalizeSiteToken(site);
  const rackId = normalizeId(rack);
  const odfId = normalizeId(odf);
  if (!siteId || !rackId || !odfId) return null;
  return { siteId, rackId, odfId };
}

function endpointFromMappingSide(mapping: InventoryMapping, side: "LOCAL" | "FAR"): ImpactBoundaryEndpoint | null {
  return side === "LOCAL"
    ? endpointFromParts(mapping.localSite, mapping.localRack, mapping.localOdf)
    : endpointFromParts(mapping.farSite ?? mapping.farEndpoint, mapping.farRack, mapping.farOdf);
}

function mappingCarriesLiveTraffic(mapping: InventoryMapping): boolean {
  if (!mapping.serviceId?.trim()) return false;
  // A mid-span-tap stranded tail sits physically on the sheath but has no outbound
  // continuity, so a cut anywhere reports ZERO operational impact on it.
  if (isStrandedStrandRemark(mapping.remarks)) return false;
  const status = String(mapping.status ?? "").toUpperCase();
  return !["AVAILABLE", "DUMMY", "DECOMMISSIONED", "FAULTY"].includes(status);
}


// Cable-aware reference-point impact engine.
// Blast radius is keyed by the PHYSICAL FEEDER CABLE when a cable id is mapped, and
// falls back to the Site+Rack+ODF footprint otherwise:
//   DIRECT   = a LIVE service on the same physical SEGMENT you are touching (your
//              work scope), or (fallback) on the same Site+Rack+ODF+Port.
//   INDIRECT = a LIVE service on the same FEEDER CABLE but a DIFFERENT segment, or
//              (fallback) the same Site+Rack+ODF on a different port. At risk, not
//              certain loss.
// Cable membership is at SEGMENT granularity: a feeder is manually built from many
// segments, and fiber numbers are segment-local, so they cannot be compared across
// segments. Within a single segment, each child mapping is evaluated independently
// (not as a contiguous start->end range), so fibers redirected mid-span to another
// site are still handled. The target service is excluded; Available/dummy/faulty
// never impact. One in-memory pass — no trace fan-out, no DB-wide scan.
function impactRefKey(site?: string | null, rack?: string | null, odf?: string | null): string | null {
  const s = normalizeSiteToken(site);
  if (!s) return null;
  const r = (normalizeRackCode(rack ?? "") ?? "").toUpperCase().trim();
  const o = (normalizeOdfCode(odf ?? "") ?? "").toUpperCase().trim();
  if (!r || !o) return null;
  return `${s}|${r}|${o}`;
}

function impactExactKey(refKey: string, port?: string | null): string {
  return `${refKey}#${(normalizePortLabel(port ?? "") ?? "").toUpperCase().trim()}`;
}

// Cable = the physical blast-radius key: a sheath cut drops EVERY fiber in it,
// regardless of which ODF/port each lands on. Used in preference to the
// Site/Rack/ODF footprint whenever a cable identifier is present on the segment.
function normalizeCableId(value?: string | null): string | null {
  const text = String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return text && text !== "-" ? text : null;
}

type IndirectReason = "SAME_CABLE" | "SAME_ODF";

interface TargetReferenceSet {
  // Physical-cable blast radius (preferred signal when a cable id is mapped).
  // Membership is at SEGMENT granularity: fiber numbers are segment-local (fiber 1
  // on segment A is a different strand than fiber 1 on segment B), so they cannot be
  // compared across the multiple segments that make up one manually-mapped feeder.
  cableKeys: Set<string>;
  // Site/Rack/ODF footprint fallback (used when no cable identifier is present).
  refPoints: Set<string>;
  exactIds: Set<string>;
  segmentIds: Set<string>;
}

type MappingSide = [string | null | undefined, string | null | undefined, string | null | undefined, string | null | undefined];

function mappingSides(mapping: InventoryMapping): MappingSide[] {
  return [
    [mapping.localSite, mapping.localRack, mapping.localOdf, mapping.localPort],
    [mapping.farSite ?? mapping.farEndpoint, mapping.farRack, mapping.farOdf, mapping.farPort],
  ];
}

function targetReferenceSet(rows: InventoryRow[], requested: string | null): TargetReferenceSet {
  const cableKeys = new Set<string>();
  const refPoints = new Set<string>();
  const exactIds = new Set<string>();
  const segmentIds = new Set<string>();
  for (const row of rows) {
    for (const mapping of row.mappings ?? []) {
      if (requested && normalizedService(mapping.serviceId) !== requested) continue;
      segmentIds.add(row.segmentId);
      const cable = normalizeCableId(mapping.cableId);
      if (cable) cableKeys.add(cable);
      for (const [site, rack, odf, port] of mappingSides(mapping)) {
        const rk = impactRefKey(site, rack, odf);
        if (!rk) continue;
        refPoints.add(rk);
        exactIds.add(impactExactKey(rk, port));
      }
    }
  }
  return { cableKeys, refPoints, exactIds, segmentIds };
}

function referencePointImpacts(params: { liveRows: InventoryRow[]; target: TargetReferenceSet; requested: string | null }) {
  const { liveRows, target, requested } = params;
  const directById = new Map<string, InventoryRow>();
  const indirectById = new Map<string, InventoryRow>();
  const directServiceIds = new Set<string>();
  const indirectServiceIds = new Set<string>();
  // Why each indirect row is at risk, so the UI/export can show the proxy that
  // fired (shared physical cable vs. shared termination footprint).
  const indirectReason = new Map<string, IndirectReason>();
  const segmentServices = new Map<string, Set<string>>();
  const addService = (segmentId: string, code: string) => {
    const set = segmentServices.get(segmentId) ?? new Set<string>();
    set.add(code);
    segmentServices.set(segmentId, set);
  };

  for (const row of liveRows) {
    const sameSegment = target.segmentIds.has(row.segmentId);
    let rowDirect = false;
    let rowIndirect = false;
    let rowIndirectReason: IndirectReason | null = null;
    for (const mapping of row.mappings ?? []) {
      if (!mappingCarriesLiveTraffic(mapping)) continue; // Available/dummy/faulty never impact
      const normalized = normalizedService(mapping.serviceId);
      if (!normalized || normalized === requested) continue; // exclude the target service itself
      const display = mapping.serviceId?.trim() || normalized;

      // The same physical span you are touching is always Direct.
      let mappingDirect = sameSegment;
      let mappingIndirect = false;
      let mappingIndirectReason: IndirectReason | null = null;

      const cable = normalizeCableId(mapping.cableId);
      if (cable && target.cableKeys.has(cable)) {
        // Cable blast radius — same physical feeder as the target. Direct vs Indirect
        // stays distinct even though the whole cable is shared, because the split is
        // by SEGMENT (your work scope): a service on a segment you are touching is
        // Direct (handled by sameSegment); a service on ANY OTHER segment of the same
        // feeder is Indirect collateral. (Fiber numbers are segment-local, so they
        // are not comparable across the segments that share one feeder.)
        if (!sameSegment) {
          mappingIndirect = true;
          mappingIndirectReason = "SAME_CABLE";
        }
      } else {
        // Fallback footprint (no cable id): same Site+Rack+ODF.
        //   same exact port -> Direct ; different port -> Indirect
        for (const [site, rack, odf, port] of mappingSides(mapping)) {
          const rk = impactRefKey(site, rack, odf);
          if (!rk || !target.refPoints.has(rk)) continue;
          if (target.exactIds.has(impactExactKey(rk, port))) mappingDirect = true;
          else {
            mappingIndirect = true;
            mappingIndirectReason = mappingIndirectReason ?? "SAME_ODF";
          }
        }
      }

      if (mappingDirect) {
        rowDirect = true;
        directServiceIds.add(normalized);
        addService(row.segmentId, display);
      } else if (mappingIndirect) {
        rowIndirect = true;
        rowIndirectReason = rowIndirectReason ?? mappingIndirectReason;
        indirectServiceIds.add(normalized);
        addService(row.segmentId, display);
      }
    }
    if (rowDirect) {
      directById.set(row.segmentId, row);
    } else if (rowIndirect) {
      indirectById.set(row.segmentId, row);
      indirectReason.set(row.segmentId, rowIndirectReason ?? "SAME_ODF");
    }
  }

  // A service counted as Direct anywhere is not also reported as Indirect.
  for (const code of directServiceIds) indirectServiceIds.delete(code);

  return {
    directRows: [...directById.values()],
    indirectRows: [...indirectById.values()],
    directServiceIds,
    indirectServiceIds,
    indirectReason,
    segmentServices,
  };
}

function boundaryFromTargetRows(rows: InventoryRow[], requested: string | null): ImpactBoundaryFootprint | null {
  const endpoints: ImpactBoundaryEndpoint[] = [];
  for (const row of rows) {
    for (const mapping of row.mappings ?? []) {
      if (requested && normalizedService(mapping.serviceId) !== requested) continue;
      const local = endpointFromMappingSide(mapping, "LOCAL");
      const far = endpointFromMappingSide(mapping, "FAR");
      if (local) endpoints.push(local);
      if (far) endpoints.push(far);
    }
  }
  if (!endpoints.length) return null;
  return { start: endpoints[0], end: endpoints[endpoints.length - 1] };
}

function boundaryFromRowSelf(row: InventoryRow): ImpactBoundaryFootprint | null {
  const start = endpointFromParts(row.nearSite, row.nearRack, row.nearOdf);
  const end = endpointFromParts(row.farSite, row.farRack, row.farOdf);
  if (!start || !end) return null;
  return { start, end };
}

export const impactAnalysisService = {
  // Neutral, zero-cost summary used to render the Impact workbench on first load
  // WITHOUT running any graph traversal or relational segment scan. The heavy
  // analyze() pass only runs when the operator explicitly triggers it (or deep
  // links with active filters), so the page never freezes scanning the whole
  // network on mount — critical at the thousands-of-segments scale target.
  emptySummary(filters: InventoryFilters = {}): CutoverImpactSummary {
    return {
      filters: normalizeInventoryFilters(filters),
      selectedResources: [],
      counts: { impactedServices: 0, impactedLinks: 0, impactedSites: 0, coreSites: 0 },
      directLinks: [],
      activeServiceLinks: [],
      indirectPaths: [],
      boundaryFootprint: null,
      riskFactors: [],
      riskFactorTotal: 0,
      impactedServices: [],
      impactedSites: [],
      criticalCoreSites: [],
      facing: "NO_LIVE_IMPACT",
      impactScope: "NONE",
      notes: [],
      exportRows: [],
    };
  },

  async analyze(filters: InventoryFilters): Promise<CutoverImpactSummary> {
    const activeFilters = normalizeInventoryFilters(filters);
    const calculationTime = new Date().toISOString();
    const liveRows = (await inventoryService.listInventory(activeFilters.site)).filter(
      (row) => row.status !== "DECOMMISSIONED",
    );

    const requested = normalizedService(activeFilters.serviceId);
    const chainDisplaySites = displaySitesFromPath(activeFilters.transportTrail);
    const chainSites = siteCodesFromPath(activeFilters.transportTrail);
    const trailPairs = pathPairsFromSites(chainSites);
    const transportChain = chainDisplaySites.length ? chainDisplaySites.join("-") : activeFilters.transportTrail ?? null;

    // TARGET (failure point) rows: Service ID -> transport trail -> field filters.
    const targetRows = activeFilters.serviceId
      ? liveRows.filter((row) => rowHasRequestedService(row, activeFilters.serviceId))
      : trailPairs.length
        ? liveRows.filter((row) => trailPairs.some((pair) => matchesPathPair(row, pair)))
        : liveRows.filter((row) => matchesInventoryFilters(row, activeFilters));

    // Guard against an unscoped whole-network match (the page only runs analyze()
    // on an explicit selection, but never let an empty selection scan everything).
    //
    // A Site / Rack / ODF / Port / field selection IS a valid scope. Crucially,
    // when a site filter is present, listInventory(site) has ALREADY narrowed
    // liveRows to that site — so the field filter trivially matches 100% of the
    // (already-scoped) rows, making targetRows.length === liveRows.length even
    // though the operator made a real selection. Only treat "matched everything"
    // as an empty selection when there is genuinely no scoping criterion at all,
    // otherwise a site-only search wrongly returns zero records.
    const hasScopingSelection = Boolean(
      activeFilters.site ||
      activeFilters.connectedSite ||
      activeFilters.rackId ||
      activeFilters.odfId ||
      activeFilters.portPair ||
      activeFilters.fiberPortNumber ||
      activeFilters.cableId ||
      activeFilters.tubeNumber ||
      activeFilters.tubeColor ||
      activeFilters.fiberNumber ||
      activeFilters.status ||
      activeFilters.siteType ||
      activeFilters.regionPrefix ||
      activeFilters.search,
    );
    if (!activeFilters.serviceId && !trailPairs.length && !hasScopingSelection && targetRows.length === liveRows.length) {
      return {
        ...this.emptySummary(filters),
        notes: ["Select a Service ID, transport trail, or a Site / Rack / ODF / Port to run impact analysis."],
      };
    }

    // Reference-point engine: no per-service trace fan-out, no DB-wide scan.
    //   Direct   = another LIVE service on the SAME Site+Rack+ODF+Port (or same segment).
    //   Indirect = another LIVE service on the SAME Site+Rack+ODF, DIFFERENT port/fiber.
    // The target service is excluded; Available ports never impact.
    const target = targetReferenceSet(targetRows, requested);
    const {
      directRows,
      indirectRows,
      directServiceIds,
      indirectServiceIds,
      indirectReason,
      segmentServices,
    } = referencePointImpacts({ liveRows, target, requested });
    const indirectSegmentServices = segmentServices;
    const directServiceSet = directServiceIds;

    const targetBoundary = boundaryFromTargetRows(targetRows, requested);
    const impactBoundary = targetBoundary;

    const indirectPaths: IndirectImpactPath[] = indirectRows
      .map((row): IndirectImpactPath | null => {
        const boundary = targetBoundary ?? boundaryFromRowSelf(row);
        if (!boundary) return null;
        const services = [...(segmentServices.get(row.segmentId) ?? new Set<string>())];
        const kind = indirectReason.get(row.segmentId) ?? "SAME_ODF";
        return {
          serviceId: services[0] ?? row.segmentCode,
          fullPathLabel: [row.nearSite, row.farSite].filter(Boolean).join(" -> ") || null,
          totalDistanceKm: Math.round((Number(row.distanceKm ?? 0) || 0) * 100) / 100,
          boundary,
          reason:
            kind === "SAME_CABLE"
              ? "Indirect/risked impact: a live service rides the SAME physical feeder cable as the target on a different fiber, so a cut / OSP cutover puts it at risk."
              : "Indirect/risked impact: a live service shares the same Site/Rack/ODF footprint as the target but on a different port/fiber, so it is at risk during the cutover/OSP work.",
          segments: [
            {
              segmentId: row.segmentId,
              segmentCode: row.segmentCode,
              fromSite: row.nearSite,
              toSite: row.farSite,
              distanceKm: Number(row.distanceKm ?? 0) || 0,
            },
          ],
        };
      })
      .filter((path): path is IndirectImpactPath => path !== null);

    const allImpactRows = [...directRows, ...indirectRows];

    const serviceTrailByCode = new Map<string, string | null>();
    const downstreamSiteCodes = new Set<string>();

    // Impacted services derived in-memory from the matched rows — no per-service
    // trace fan-out. fullPathLabel is the set of sites each service touches in scope.
    const rowsByService = new Map<string, InventoryRow[]>();
    for (const row of allImpactRows) {
      for (const code of segmentServices.get(row.segmentId) ?? []) {
        if (normalizedService(code) === requested) continue;
        const arr = rowsByService.get(code) ?? [];
        arr.push(row);
        rowsByService.set(code, arr);
      }
    }
    const impactedServices: ImpactService[] = [...rowsByService.entries()].map(([serviceCode, rows]) => {
      const sites = [...new Set(rows.flatMap((row) => [row.nearSite, row.farSite].filter(Boolean) as string[]))];
      const label = sites.join(" - ") || null;
      serviceTrailByCode.set(serviceCode, label);
      for (const site of sites) {
        const token = normalizeSiteToken(site);
        if (token) downstreamSiteCodes.add(token);
      }
      return { serviceCode, serviceName: null, routeType: null, fullPathLabel: label, isProtectionPath: false };
    });

    for (const site of chainSites) downstreamSiteCodes.add(site);
    for (const path of indirectPaths) {
      downstreamSiteCodes.add(path.boundary.start.siteId);
      downstreamSiteCodes.add(path.boundary.end.siteId);
      for (const segment of path.segments) {
        const from = normalizeSiteToken(segment.fromSite);
        const to = normalizeSiteToken(segment.toSite);
        if (from) downstreamSiteCodes.add(from);
        if (to) downstreamSiteCodes.add(to);
      }
    }
    for (const row of allImpactRows) {
      if (row.nearSite) downstreamSiteCodes.add(normalizeSiteToken(row.nearSite) ?? row.nearSite);
      if (row.farSite) downstreamSiteCodes.add(normalizeSiteToken(row.farSite) ?? row.farSite);
      for (const mapping of row.mappings ?? []) {
        const local = normalizeSiteToken(mapping.localSite);
        const far = normalizeSiteToken(mapping.farSite ?? mapping.farEndpoint);
        if (local) downstreamSiteCodes.add(local);
        if (far) downstreamSiteCodes.add(far);
      }
    }

    const siteRecords = await prisma.site.findMany({
      where: { code: { in: [...downstreamSiteCodes] } },
      select: { code: true, siteType: true, isCoreSite: true, coreSiteType: true },
    });
    const impactedSites: ImpactSite[] = siteRecords.map((site) => ({
      siteCode: site.code,
      siteType: site.siteType,
      isCoreSite: site.isCoreSite,
      coreSiteType: site.coreSiteType,
    }));
    const criticalCoreSites = impactedSites.filter((site) => site.isCoreSite);

    const selectedResources: ImpactResource[] = targetRows.map((row) => ({
      siteCode: row.nearSite,
      rackCode: row.nearRack,
      odfCode: row.nearOdf,
      portGroup: row.nearPortGroup,
      fiberPortNumber: row.fiberPortNumber,
      cableLabel: row.cableLabel,
      tubeNumber: row.tubeNumber,
      tubeColor: row.tubeColor,
      fiberNumber: row.fiberNumber,
      status: row.status,
    }));

    const directLinks = directRows.map((row) => ({
      segmentId: row.segmentId,
      segmentCode: row.segmentCode,
      serviceIds: rowServices(row).join(", ") || row.serviceIds,
      nearSite: row.nearSite,
      nearRack: row.nearRack,
      nearOdf: row.nearOdf,
      nearPortGroup: row.nearPortGroup,
      farSite: row.farSite,
      farRack: row.farRack,
      farOdf: row.farOdf,
      farPortGroup: row.farPortGroup,
      cableLabel: row.cableLabel,
      tubeNumber: row.tubeNumber,
      tubeColor: row.tubeColor,
      fiberPortNumber: row.fiberPortNumber,
      fiberNumber: row.fiberNumber,
      status: row.status,
    }));

    const riskFactors = indirectRows.slice(0, 300).map((row) => {
      const kind = indirectReason.get(row.segmentId) ?? "SAME_ODF";
      return {
        segmentId: row.segmentId,
        segmentCode: row.segmentCode,
        riskType: kind,
        siteCode: row.nearSite,
        rackCode: row.nearRack,
        odfCode: row.nearOdf,
        reason:
          kind === "SAME_CABLE"
            ? "Indirect/risk impact: a live service rides the SAME physical feeder cable as the target on a different fiber, so a cut / OSP cutover puts it at risk."
            : "Indirect/risk impact: a live service shares the same Site/Rack/ODF as the target on a different port/fiber, so it is at risk during the cutover/OSP work.",
        status: row.status,
      };
    });

    const cableIndirectCount = [...indirectReason.values()].filter((reason) => reason === "SAME_CABLE").length;

    const notes = [];
    if (!directRows.length) notes.push("No direct segment matched the selected Service ID / Transport Trail.");
    if (!impactBoundary) notes.push("No complete boundary footprint found. Indirect matching needs two exact Site/Rack/ODF boundary blocks.");
    if (!impactedServices.length) notes.push("No active service ID is currently assigned to the direct or indirect impact rows.");
    if (criticalCoreSites.length) notes.push("Selected resource touches core-classified infrastructure.");
    if (indirectPaths.length) notes.push(`${indirectPaths.length} indirect/risked service path(s) are at risk during the cutover.`);
    if (cableIndirectCount) {
      notes.push(`${cableIndirectCount} indirect row(s) detected via a shared physical feeder cable (different fibers on the same sheath).`);
    } else if (indirectRows.length) {
      notes.push("Indirect impact was computed from the Site/Rack/ODF footprint — no feeder-cable identifier is mapped on these segments. Map cable IDs to detect co-routed fibers that terminate on different ODFs.");
    }

    const facing = classifyFacing(impactedSites, impactedServices.length);
    const impactScope = classifyScope(directRows.length + indirectRows.length, impactedServices.length, criticalCoreSites.length);

    // Matrix row 1: every live circuit traversing the direct physical segments
    // is a Direct impact (total traffic loss), including services co-riding the
    // same segment as the requested target. Pass no service filter here.
    const activeServiceLinks = [
      ...serviceLinkRows(directRows, "Direct", null, directServiceIds),
      ...serviceLinkRows(indirectRows, "Indirect", null, indirectServiceIds),
    ];

    const exportRows: Record<string, unknown>[] = [];
    let srNo = 1;
    const pushExportLink = (link: ReturnType<typeof serviceLinkRows>[number], fallbackSegmentId?: string | null) => {
      exportRows.push({
        srNo: srNo,
        impactCalculationTime: calculationTime,
        segmentCode: link.segmentCode,
        impactSection: link.section,
        serviceId: link.serviceId,
        nearSite: link.nearSite,
        nearRack: link.nearRack,
        nearOdf: link.nearOdf,
        nearPort: link.nearPort,
        farSite: link.farSite,
        farRack: link.farRack,
        farOdf: link.farOdf,
        farPort: link.farPort,
        segmentId: fallbackSegmentId ?? null,
        transportChain: serviceTrailByCode.get(link.serviceId) ?? transportChain,

        "Sr.No": srNo++,
        "Impact Calculation Time": calculationTime,
        "Segment Name": link.segmentCode,
        "Impact Type": link.section,
        "Service ID": link.serviceId,
        "Near Site ID": link.nearSite ?? "-",
        "Near Rack ID": link.nearRack ?? "-",
        "Near ODF ID": link.nearOdf ?? "-",
        "Near Port ID": link.nearPort ?? "-",
        "Far Site ID": link.farSite ?? "-",
        "Far Rack ID": link.farRack ?? "-",
        "Far ODF ID": link.farOdf ?? "-",
        "Far Port ID": link.farPort ?? "-",
      });
    };

    // Exports use real matched data only — no placeholder / fabricated service rows.
    for (const link of activeServiceLinks) pushExportLink(link);

    return {
      filters: activeFilters,
      selectedResources,
      counts: {
        impactedServices: impactedServices.length,
        impactedLinks: directRows.length + indirectRows.length,
        impactedSites: impactedSites.length,
        coreSites: criticalCoreSites.length,
      },
      directLinks,
      activeServiceLinks,
      indirectPaths,
      boundaryFootprint: impactBoundary,
      riskFactors,
      riskFactorTotal: indirectRows.length,
      impactedServices,
      impactedSites,
      criticalCoreSites,
      facing,
      impactScope,
      notes,
      exportRows,
    };
  },
};
