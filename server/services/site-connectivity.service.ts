import type { Prisma } from "@prisma/client";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { prisma } from "@/lib/db/prisma";
import { resolveNearFarView } from "@/lib/telecom/endpoint-display";
import { isCanvasHiddenSegmentRole, normalizeTopologyRole } from "@/lib/telecom/topology-role";
import { CHILD_LINK_TAGS } from "@/lib/config/child-link-tags";
import type { SiteConnectivityNode, SiteConnectivityRow, SiteConnectivitySummary } from "@/types/site-connectivity";

type SegmentRecord = Awaited<ReturnType<typeof loadSegmentsForSite>>[number];

// Bucket for a "normal" transport segment — no access-specific (GPON/B2B) tag
// and not explicitly Backbone. These general-purpose segments can be used by any
// service type, so they collapse into a single "default" filter bucket rather
// than fragmenting into A-MPLS / MPLS Core / Interconnect / ISP-SPL / OSP-SPL.
const DEFAULT_LINK_TYPE = "default";

/** True when a raw tag string matches a known child-link tag (case-insensitive). */
function tagEquals(value: string | null | undefined, target: string): boolean {
  const token = value?.trim();
  return Boolean(token && CHILD_LINK_TAGS.includes(target as (typeof CHILD_LINK_TAGS)[number]) && token.toUpperCase() === target.toUpperCase());
}

/**
 * The distinct link/segment TYPES a physical segment represents for the canvas
 * filter. Only the access-specific and Backbone buckets are broken out —
 * everything else (untagged transport, A-MPLS, MPLS Core, Interconnect, …) is a
 * general-purpose "default" segment usable by any service:
 *   • GPON  ← GPON_SEGMENT role
 *   • B2B   ← B2B_SEGMENT role or a "B2B" child tag
 *   • Backbone ← a "Backbone" child tag
 *   • default ← anything not matched above
 * Every segment yields at least one type so it is never dropped from the filter.
 */
function segmentLinkTypes(segment: SegmentRecord): string[] {
  const types = new Set<string>();
  for (const mapping of segment.endpointMappings) {
    if (tagEquals(mapping.tag, "Backbone")) types.add("Backbone");
    if (tagEquals(mapping.tag, "B2B")) types.add("B2B");
  }
  const role = normalizeTopologyRole(segment.segmentDefaultRole);
  if (role === "GPON_SEGMENT") types.add("GPON");
  else if (role === "B2B_SEGMENT") types.add("B2B");
  if (!types.size) types.add(DEFAULT_LINK_TYPE);
  return [...types];
}

function liveMappingSome(where: Prisma.SegmentEndpointMappingWhereInput): Prisma.LinkSegmentWhereInput {
  return { endpointMappings: { some: { status: { not: "DECOMMISSIONED" }, ...where } } };
}

function liveInventoryWhere(siteId: string, siteCode: string): Prisma.LinkSegmentWhereInput {
  const normalizedCode = normalizeAlias(siteCode) ?? siteCode;
  return {
    AND: [
      {
        OR: [
          { endpointA: { siteId } },
          { endpointB: { siteId } },
          { endpointA: { rawSiteCode: siteCode } },
          { endpointB: { rawSiteCode: siteCode } },
          { endpointA: { rawSiteCode: normalizedCode } },
          { endpointB: { rawSiteCode: normalizedCode } },
          liveMappingSome({ localSiteCode: siteCode }),
          liveMappingSome({ farSiteCode: siteCode }),
          liveMappingSome({ localSiteCode: normalizedCode }),
          liveMappingSome({ farSiteCode: normalizedCode }),
          liveMappingSome({ farEndpointLabel: { contains: normalizedCode } }),
        ],
      },
      { status: { in: ["ACTIVE", "AVAILABLE", "SPARE", "RESERVED", "USED", "PLANNED"] } },
      ...(process.env.FEATURE_DEMO_DATA === "true" ? [] : [{ NOT: { importBatch: { sourceSystem: "DEMO_SEED" } } }]),
    ],
  };
}

async function loadSegmentsForSite(siteId: string, siteCode: string) {
  return prisma.linkSegment.findMany({
    where: liveInventoryWhere(siteId, siteCode),
    include: {
      cable: true,
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
      fibers: { where: { serviceCode: { not: null } }, orderBy: { fiberNumber: "asc" } },
      serviceAllocations: { include: { service: true }, orderBy: { pathOrder: "asc" } },
      serviceRouteHops: { include: { serviceRoute: { include: { service: true } } } },
      endpointMappings: { where: { status: { not: "DECOMMISSIONED" } } },
    },
    orderBy: [{ sitePairKey: "asc" }, { segmentCode: "asc" }],
    take: 5000,
  });
}

function endpointSiteCode(endpoint: SegmentRecord["endpointA"]): string | null {
  return endpoint.site?.code ?? endpoint.rawSiteCode ?? null;
}

function serviceCodes(segment: SegmentRecord): string[] {
  return [
    segment.allocatedServiceCode,
    ...segment.fibers.map((fiber) => fiber.serviceCode),
    ...segment.serviceAllocations.map((allocation) => allocation.service.serviceCode),
    ...segment.serviceRouteHops.map((hop) => hop.serviceRoute.service.serviceCode),
  ].filter(Boolean) as string[];
}

function statusFromUtilization(value?: number | null): SiteConnectivityNode["status"] {
  if (value === null || value === undefined) return "No Data";
  if (value >= 95) return "Critical";
  if (value >= 80) return "High";
  if (value >= 50) return "Moderate";
  return "Low";
}

function compact(values: Array<string | null | undefined>, limit = 3): string | null {
  const unique = [...new Set(values.filter(Boolean) as string[])];
  if (!unique.length) return null;
  return unique.length > limit ? `${unique.slice(0, limit).join(", ")} +${unique.length - limit}` : unique.join(", ");
}


function extractSiteCodeToken(value?: string | null): string | null {
  const compact = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) return null;
  for (const pattern of [/MUTR\d{3,6}/, /MU\d{3,6}/, /DH\d{3,6}/, /BA\d{3,6}/, /SH\d{3,6}/, /MS\d{3,6}/, /DA\d{3,6}/, /DF\d{3,6}/]) {
    const match = compact.match(pattern);
    if (match) return match[0];
  }
  if (compact.includes("BOUSHER") && compact.includes("MSC")) return "BOUSHERMSCBSC";
  if (compact.includes("GHUBRAH") && compact.includes("MSC")) return "GHUBRAHMSCBSC";
  return null;
}

function displayEndpoint(value?: string | null): string | null {
  return extractSiteCodeToken(value) ?? value?.trim() ?? null;
}

function normalized(value?: string | null): string | null {
  return extractSiteCodeToken(value) ?? normalizeAlias(value) ?? null;
}

function siteEquals(left?: string | null, right?: string | null): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return Boolean(a && b && a === b);
}

function mappingEndpointLabel(value?: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  const token = extractSiteCodeToken(text);
  if (token) return token;
  // For long labels like "QATARNATIONALBANK / 01A01 / A / 1", keep the first endpoint token.
  return text.split("/")[0]?.trim() || text;
}

function connectedLabelFromMapping(mapping: { localSiteCode?: string | null; farSiteCode?: string | null; farEndpointLabel?: string | null }, searchedSite: string): { connectedSite: string; localMatch: boolean } {
  const localMatch = siteEquals(mapping.localSiteCode, searchedSite);
  const connectedSite = localMatch
    ? mapping.farSiteCode ?? mappingEndpointLabel(mapping.farEndpointLabel) ?? "UNKNOWN"
    : mapping.localSiteCode ?? "UNKNOWN";
  return { connectedSite, localMatch };
}

function endpointForNearSite(segment: SegmentRecord, siteCode: string) {
  return endpointSiteCode(segment.endpointA)?.toUpperCase() === siteCode.toUpperCase()
    ? { near: segment.endpointA, far: segment.endpointB }
    : { near: segment.endpointB, far: segment.endpointA };
}


function addUniqueSegment(bucket: { remote: SegmentRecord["endpointA"]; segments: SegmentRecord[] }, segment: SegmentRecord) {
  if (!bucket.segments.some((item) => item.id === segment.id)) bucket.segments.push(segment);
}

function mergeText(values: Array<string | null | undefined>, limit = 4): string | null {
  const unique = [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
  if (!unique.length) return null;
  return unique.length > limit ? `${unique.slice(0, limit).join(", ")} +${unique.length - limit}` : unique.join(", ");
}

function aggregateSegmentRows(rows: SiteConnectivityRow[], segmentCountBySite: Map<string, number>): SiteConnectivityRow[] {
  // Graphical/direct connectivity view should summarize physical segments, not child port rows.
  const groups = new Map<string, SiteConnectivityRow[]>();
  for (const row of rows) {
    const key = `${row.segmentId}|${row.connectedSite}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((items) => {
    const first = items[0];
    return {
      ...first,
      directSegmentCount: segmentCountBySite.get(first.connectedSite) ?? first.directSegmentCount ?? 1,
      rackId: mergeText(items.map((item) => item.rackId)),
      odfId: mergeText(items.map((item) => item.odfId)),
      portPair: mergeText(items.map((item) => item.portPair), 6),
      farRackId: mergeText(items.map((item) => item.farRackId)),
      farOdfId: mergeText(items.map((item) => item.farOdfId)),
      farPortPair: mergeText(items.map((item) => item.farPortPair), 6),
      cableId: mergeText(items.map((item) => item.cableId)),
      tubeColor: mergeText(items.map((item) => item.tubeColor)),
      serviceIds: mergeText(items.flatMap((item) => (item.serviceIds ?? "").split(",").map((service) => service.trim()).filter(Boolean)), 8),
      serviceCount: new Set(items.flatMap((item) => (item.serviceIds ?? "").split(",").map((service) => service.trim()).filter(Boolean))).size || Math.max(...items.map((item) => item.serviceCount ?? 0)),
      utilizationPct: Math.max(...items.map((item) => item.utilizationPct ?? 0)),
    };
  }).sort((a, b) => a.connectedSite.localeCompare(b.connectedSite) || a.segmentCode.localeCompare(b.segmentCode));
}

export const siteConnectivityService = {
  async resolveSiteCode(search?: string | null): Promise<string | null> {
    const normalized = normalizeAlias(search);
    if (!normalized) return null;
    const site = await prisma.site.findFirst({
      where: {
        OR: [
          { code: normalized },
          { aliases: { some: { aliasNormalized: normalized } } },
        ],
      },
      select: { code: true },
    });
    return site?.code ?? null;
  },

  async getBySearch(search?: string | null): Promise<SiteConnectivitySummary | null> {
    const siteCode = await this.resolveSiteCode(search);
    return siteCode ? this.getForSite(siteCode) : null;
  },

  async getForSite(siteCode: string): Promise<SiteConnectivitySummary | null> {
    const site = await prisma.site.findUnique({
      where: { code: siteCode.toUpperCase() },
      select: {
        id: true,
        code: true,
        name: true,
        region: true,
        city: true,
        siteType: true,
        status: true,
        isCoreSite: true,
        coreSiteType: true,
      },
    });
    if (!site) return null;

    const segments = await loadSegmentsForSite(site.id, site.code);
    const sitePairKeys = [...new Set(segments.map((segment) => segment.sitePairKey))];
    const metrics = await prisma.utilizationMetric.findMany({
      where: {
        metricType: "SITE_PAIR_UTILIZATION",
        sitePairKey: { in: sitePairKeys },
      },
      orderBy: { measuredAt: "desc" },
    });
    const utilizationByPair = new Map<string, number>();
    for (const metric of metrics) {
      if (metric.sitePairKey && !utilizationByPair.has(metric.sitePairKey)) {
        utilizationByPair.set(metric.sitePairKey, metric.utilizationPct);
      }
    }

    const rows: SiteConnectivityRow[] = [];
    const groups = new Map<string, { remote: SegmentRecord["endpointA"]; segments: SegmentRecord[] }>();

    for (const segment of segments) {
      let mappingMatches = segment.endpointMappings.filter((mapping) =>
        siteEquals(mapping.localSiteCode, site.code) ||
        siteEquals(mapping.farSiteCode, site.code) ||
        siteEquals(mappingEndpointLabel(mapping.farEndpointLabel), site.code)
      );
      if (!mappingMatches.length && segment.endpointMappings.length) {
        // If the parent segment itself belongs to the searched site, its imported endpointMappings may still contain
        // many child far-end directions. Include them so topology does not collapse to only the parent endpoint.
        const parentMatches = siteEquals(endpointSiteCode(segment.endpointA), site.code) || siteEquals(endpointSiteCode(segment.endpointB), site.code);
        if (parentMatches) mappingMatches = segment.endpointMappings;
      }
      if (mappingMatches.length) {
        for (const mapping of mappingMatches) {
          const endpoints = endpointForNearSite(segment, site.code);
          const localMatchesSearch = siteEquals(mapping.localSiteCode, site.code);
          const farMatchesSearch = siteEquals(mapping.farSiteCode, site.code) || siteEquals(mappingEndpointLabel(mapping.farEndpointLabel), site.code);
          const connectedCandidates = localMatchesSearch
            ? [{ connectedSite: mapping.farSiteCode ?? mappingEndpointLabel(mapping.farEndpointLabel) ?? "UNKNOWN", localMatch: true }]
            : farMatchesSearch
              ? [{ connectedSite: mapping.localSiteCode ?? "UNKNOWN", localMatch: false }]
              : [
                  { connectedSite: mapping.localSiteCode ?? "UNKNOWN", localMatch: false },
                  { connectedSite: mapping.farSiteCode ?? mappingEndpointLabel(mapping.farEndpointLabel) ?? "UNKNOWN", localMatch: true },
                ];
          const services = [...new Set([...serviceCodes(segment), mapping.serviceCode].filter(Boolean) as string[])];
          for (const candidate of connectedCandidates) {
            const connectedSite = displayEndpoint(candidate.connectedSite);
            if (!connectedSite || connectedSite === "UNKNOWN" || siteEquals(connectedSite, site.code)) continue;
            const bucket = groups.get(connectedSite) ?? { remote: endpoints.far, segments: [] };
            addUniqueSegment(bucket, segment);
            groups.set(connectedSite, bucket);
            const localMatch = candidate.localMatch;
            rows.push({
              segmentId: segment.id,
              segmentCode: segment.segmentCode,
              searchedSite: site.code,
              connectedSite,
              directSegmentCount: 0,
              rackId: localMatch ? mapping.localRackCode : mapping.farRackCode,
              odfId: localMatch ? mapping.localOdfCode : mapping.farOdfCode,
              portPair: localMatch ? mapping.localPortLabel : mapping.farPortLabel,
              farRackId: localMatch ? mapping.farRackCode : mapping.localRackCode,
              farOdfId: localMatch ? mapping.farOdfCode : mapping.localOdfCode,
              farPortPair: localMatch ? mapping.farPortLabel : mapping.localPortLabel,
              cableId: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
              tubeNumber: segment.tubeNumber ?? null,
              tubeColor: segment.tubeColor ?? null,
              fiberPortNumber: segment.fiberPortNumber ?? null,
              fiberNumber: segment.fiberNumber ?? null,
              fiberLabel: segment.fiberLabel,
              distanceKm: segment.distanceKm,
              utilizationPct: segment.utilizationPct || utilizationByPair.get(segment.sitePairKey) || null,
              serviceIds: services.join(", ") || null,
              serviceCount: services.length,
              status: segment.status,
            });
          }
        }
        continue;
      }

      const view = resolveNearFarView({
        contextSiteCode: site.code,
        endpointA: {
          siteCode: endpointSiteCode(segment.endpointA),
          rackCode: segment.endpointA.rack?.rackCode ?? segment.endpointA.rawRackCode,
          odfCode: segment.endpointA.odf?.odfCode ?? segment.endpointA.rawOdfCode,
          portLabel: segment.endpointA.portGroup?.displayLabel ?? segment.endpointA.displayPortText ?? segment.endpointA.rawPortText,
        },
        endpointB: {
          siteCode: endpointSiteCode(segment.endpointB),
          rackCode: segment.endpointB.rack?.rackCode ?? segment.endpointB.rawRackCode,
          odfCode: segment.endpointB.odf?.odfCode ?? segment.endpointB.rawOdfCode,
          portLabel: segment.endpointB.portGroup?.displayLabel ?? segment.endpointB.displayPortText ?? segment.endpointB.rawPortText,
        },
      });
      const endpoints = endpointForNearSite(segment, site.code);
      const connectedSite = view.far.siteCode ?? endpointSiteCode(endpoints.far) ?? "UNKNOWN";
      const bucket = groups.get(connectedSite) ?? { remote: endpoints.far, segments: [] };
      addUniqueSegment(bucket, segment);
      groups.set(connectedSite, bucket);

      const services = serviceCodes(segment);
      rows.push({
        segmentId: segment.id,
        segmentCode: segment.segmentCode,
        searchedSite: site.code,
        connectedSite,
        directSegmentCount: 0,
        rackId: view.near.rackCode,
        odfId: view.near.odfCode,
        portPair: view.near.portLabel,
        farRackId: view.far.rackCode,
        farOdfId: view.far.odfCode,
        farPortPair: view.far.portLabel,
        cableId: segment.cable?.cableCode ?? segment.cable?.cableName ?? null,
        tubeNumber: segment.tubeNumber ?? endpoints.near.portGroup?.tubeNumber ?? endpoints.far.portGroup?.tubeNumber ?? null,
        tubeColor: segment.tubeColor ?? endpoints.near.portGroup?.tubeColor ?? endpoints.far.portGroup?.tubeColor ?? null,
        fiberPortNumber: segment.fiberPortNumber ?? endpoints.near.portGroup?.fiberPortNumber ?? endpoints.far.portGroup?.fiberPortNumber ?? null,
        fiberNumber: segment.fiberNumber ?? endpoints.near.portGroup?.fiberNumber ?? endpoints.far.portGroup?.fiberNumber ?? null,
        fiberLabel: segment.fiberLabel,
        distanceKm: segment.distanceKm,
        utilizationPct: segment.utilizationPct || utilizationByPair.get(segment.sitePairKey) || null,
        serviceIds: services.join(", ") || null,
        serviceCount: new Set(services).size,
        status: segment.status,
      });
    }

    const segmentCountBySite = new Map([...groups.entries()].map(([code, group]) => [code, group.segments.length]));
    const rowsWithCounts = aggregateSegmentRows(rows, segmentCountBySite);

    const nodes: SiteConnectivityNode[] = [...groups.entries()]
      .map(([connectedSite, group]) => {
        const utilizationValues = group.segments.map((segment) => utilizationByPair.get(segment.sitePairKey)).filter((value): value is number => value !== undefined);
        const utilizationPct = utilizationValues.length ? Math.max(...utilizationValues) : Math.max(...group.segments.map((segment) => segment.utilizationPct || 0));
        const services = new Set(group.segments.flatMap((segment) => [
          ...serviceCodes(segment),
          ...((segment.endpointMappings.map((mapping) => mapping.serviceCode).filter(Boolean)) as string[]),
        ]));
        return {
          siteCode: connectedSite,
          siteName: group.remote.site?.name ?? null,
          siteType: group.remote.site?.siteType ?? null,
          isCoreSite: Boolean(group.remote.site?.isCoreSite),
          coreSiteType: group.remote.site?.coreSiteType ?? null,
          segmentCount: group.segments.length,
          serviceCount: services.size,
          utilizationPct,
          distanceKm: group.segments.find((segment) => segment.distanceKm !== null)?.distanceKm ?? null,
          status: statusFromUtilization(utilizationPct),
          hasParallelLinks: group.segments.length > 1,
          // Hidden by default only when the site is reachable solely via GPON / B2B
          // access segments (segment-level tag). Mixed sites with any transport
          // segment stay visible.
          hiddenByDefault: group.segments.length > 0 && group.segments.every((segment) => isCanvasHiddenSegmentRole(segment.segmentDefaultRole)),
          // Every distinct link type this site connects through, for the canvas
          // type filter (replaces the blanket GPON/B2B hide).
          linkTypes: [...new Set(group.segments.flatMap((segment) => segmentLinkTypes(segment)))].sort(),
          rackSummary: compact(group.segments.map((segment) => endpointForNearSite(segment, site.code).near.rack?.rackCode ?? endpointForNearSite(segment, site.code).near.rawRackCode)),
          odfSummary: compact(group.segments.map((segment) => endpointForNearSite(segment, site.code).near.odf?.odfCode ?? endpointForNearSite(segment, site.code).near.rawOdfCode)),
          portSummary: compact(group.segments.map((segment) => endpointForNearSite(segment, site.code).near.portGroup?.displayLabel ?? endpointForNearSite(segment, site.code).near.displayPortText ?? endpointForNearSite(segment, site.code).near.rawPortText)),
          cableSummary: compact(group.segments.map((segment) => segment.cable?.cableCode ?? segment.cable?.cableName)),
        };
      })
      .sort((a, b) => b.segmentCount - a.segmentCount || a.siteCode.localeCompare(b.siteCode));

    return {
      site: {
        code: site.code,
        name: site.name,
        region: site.region,
        city: site.city,
        siteType: site.siteType,
        status: site.status,
        isCoreSite: site.isCoreSite,
        coreSiteType: site.coreSiteType,
      },
      directConnectedSiteCount: nodes.length,
      directPhysicalSegmentCount: segments.length,
      nodes,
      rows: rowsWithCounts,
    };
  },
};
