// Core & DC Intra-Site ODF Saturation — read-only dashboard data service.
//
// This service is ADDITIVE. It never writes, and it does not touch any of the
// existing ODF-mapping mechanics (splits / upgrades / add-segment / port roles).
// It only READS the inventory the operator already maintains and shapes it for
// two new dashboard widgets:
//   1. The "Core & DC Intra-Site ODF Saturation" rotating panel.
//   2. The "Active Services Footprint" bar chart.
//
// Qualifying rule (both must hold):
//   - The parent segment's topology role is the new "Intra-site" tag
//     (LinkSegment.segmentDefaultRole === "INTRA_SITE").
//   - The parent site is a DC / Core site (runtime isDatacenter flag,
//     schema isCoreSite flag, or an operator "DC"/"Core" criticality tag).
//
// Same-site matching: segment endpoints whose Site IDs share the same canonical
// code (e.g. "MU0033(Old Container)" and "MU0033(NEW Container)" both reduce to
// "MU0033") are treated as the SAME parent site, so manual name edits never
// fragment a site into phantom separate sites.
//
// The whole payload is cached for one hour (see lib/cache/hourly-snapshot) and
// refreshed seamlessly in the background, so client rotation never re-hits the DB.

import { prisma } from "@/lib/db/prisma";
import { ensureSiteFlagColumns, getSiteFlags } from "@/lib/telecom/site-flags-db";
import { extractSiteId, displaySiteLabel } from "@/lib/telecom/site-display";
import { createHourlySnapshot } from "@/lib/cache/hourly-snapshot";

export interface IntraSiteSaturationRow {
  segmentId: string;
  /** Segment Name — shown verbatim (may carry manual "(Old/NEW Container)" edits). */
  segmentName: string;
  /** Canonical parent site label this intra-site segment belongs to. */
  parentSiteLabel: string;
  /** Clean canonical parent site ID used by dashboard grids. */
  parentSiteId?: string;
  totalCapacity: number;
  activePorts: number;
  availablePorts: number;
  nearAvailablePorts: number;
  farAvailablePorts: number;
  saturationPct: number;
  /** DC / Core / DWDM / PE … tags for the parent site. */
  siteTags: string[];
}

export interface ServiceFootprintBar {
  tag: string;
  count: number;
}

export interface IntraSiteSaturationSnapshot {
  rows: IntraSiteSaturationRow[];
  equinixRows: IntraSiteSaturationRow[];
  crossBorderRows: IntraSiteSaturationRow[];
  serviceFootprint: ServiceFootprintBar[];
  /** Number of distinct active service types (footprint bar count). */
  totalServiceTypes: number;
  qualifyingSegments: number;
  generatedAt: string;
}

const EMPTY_SNAPSHOT: IntraSiteSaturationSnapshot = {
  rows: [],
  equinixRows: [],
  crossBorderRows: [],
  serviceFootprint: [],
  totalServiceTypes: 0,
  qualifyingSegments: 0,
  generatedAt: new Date(0).toISOString(),
};

const PORT_AVAILABLE_STATUSES = new Set(["AVAILABLE", "SPARE"]);

/** Reduce any endpoint site string to its canonical parent-site key. Prefers the
 *  regex-extracted Site ID ("MU0033"); falls back to the leading 6–8 compacted
 *  characters so two manually renamed endpoints of the same site still collide. */
function canonicalSiteKey(code?: string | null): string {
  const text = String(code ?? "").trim();
  if (!text) return "";
  const id = extractSiteId(text);
  if (id) return id.toUpperCase();
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Tag list for a parent site, mirroring the exchange-grid convention (DC first,
 *  then Core, then site/core type, then operator criticality tags), deduped. */
function buildSiteTags(bucket: ParentSiteFacts): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string | null) => {
    const value = String(raw ?? "").trim();
    if (!value) return;
    const key = value.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(value);
  };
  if (bucket.isDatacenter) add("DC");
  if (bucket.isCoreSite) add("Core");
  add(bucket.coreSiteType);
  add(bucket.siteType);
  for (const tag of bucket.criticalityTags) add(tag);
  return tags;
}

interface ParentSiteFacts {
  isDatacenter: boolean;
  isCoreSite: boolean;
  coreSiteType: string | null;
  siteType: string | null;
  criticalityTags: string[];
}

function emptyFacts(): ParentSiteFacts {
  return { isDatacenter: false, isCoreSite: false, coreSiteType: null, siteType: null, criticalityTags: [] };
}

function factsHasTag(bucket: ParentSiteFacts, expected: string): boolean {
  const normalized = expected.trim().toUpperCase();
  return buildSiteTags(bucket).some((tag) => tag.trim().toUpperCase() === normalized);
}

function textIsBackbone(value?: string | null): boolean {
  return String(value ?? "").trim().toUpperCase() === "BACKBONE";
}

async function computeSnapshot(): Promise<IntraSiteSaturationSnapshot> {
  // Make sure the runtime DC flag column exists before we read it (idempotent).
  await ensureSiteFlagColumns(prisma);

  // 1) Pull every live "Intra-site"-tagged parent segment with its endpoints and
  //    child mappings (for the service footprint). segmentDefaultRole is a real
  //    schema column, written by the existing ODF-mapping edit form.
  const segments = await prisma.linkSegment.findMany({
    where: {
      status: { not: "DECOMMISSIONED" },
      OR: [
        { segmentDefaultRole: "INTRA_SITE" },
        { segmentDefaultRole: "BACKBONE" },
        { inventoryClass: { equals: "BACKBONE", mode: "insensitive" } },
        { spanType: { equals: "BACKBONE", mode: "insensitive" } },
        { endpointMappings: { some: { tag: { equals: "Backbone", mode: "insensitive" } } } },
      ],
    },
    select: {
      id: true,
      segmentCode: true,
      routeLabel: true,
      segmentGroupName: true,
      segmentDefaultRole: true,
      inventoryClass: true,
      spanType: true,
      totalFiberCapacity: true,
      usedFiberCount: true,
      reservedFiberCount: true,
      faultyFiberCount: true,
      availableFiberCount: true,
      utilizationPct: true,
      endpointA: { select: { odfId: true, rawSiteCode: true, site: { select: { code: true, name: true } } } },
      endpointB: { select: { odfId: true, rawSiteCode: true, site: { select: { code: true, name: true } } } },
      endpointMappings: {
        where: { status: { not: "DECOMMISSIONED" } },
        select: { tag: true, serviceCode: true },
      },
    },
    take: 2000,
  });
  if (!segments.length) return { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString() };

  const endpointCode = (endpoint: { site: { code: string | null } | null; rawSiteCode: string | null }) =>
    String(endpoint.site?.code ?? endpoint.rawSiteCode ?? "").toUpperCase();

  // 2) Resolve DC/Core facts per CANONICAL parent site (same-site matching). We
  //    look up flags for both the raw endpoint codes and their canonical keys so
  //    a flag set on the canonical "MU0033" site still covers a renamed endpoint.
  const lookupCodes = new Set<string>();
  for (const segment of segments) {
    for (const endpoint of [segment.endpointA, segment.endpointB]) {
      const code = endpointCode(endpoint);
      if (code) lookupCodes.add(code);
      const key = canonicalSiteKey(code);
      if (key) lookupCodes.add(key);
    }
  }
  const codeList = [...lookupCodes];

  const [siteFlags, sites] = await Promise.all([
    getSiteFlags(prisma, codeList), // runtime isDatacenter / isCriticalSite
    prisma.site.findMany({
      where: { code: { in: codeList } },
      select: {
        code: true,
        isCoreSite: true,
        coreSiteType: true,
        siteType: true,
        criticalityTags: { select: { tag: { select: { label: true } } } },
      },
    }),
  ]);

  const facts = new Map<string, ParentSiteFacts>();
  const factsFor = (key: string): ParentSiteFacts => {
    let bucket = facts.get(key);
    if (!bucket) {
      bucket = emptyFacts();
      facts.set(key, bucket);
    }
    return bucket;
  };
  for (const [code, flag] of siteFlags) {
    const bucket = factsFor(canonicalSiteKey(code));
    bucket.isDatacenter = bucket.isDatacenter || flag.isDatacenter;
  }
  for (const site of sites) {
    const bucket = factsFor(canonicalSiteKey(site.code));
    bucket.isCoreSite = bucket.isCoreSite || Boolean(site.isCoreSite);
    bucket.coreSiteType = bucket.coreSiteType ?? site.coreSiteType ?? null;
    bucket.siteType = bucket.siteType ?? site.siteType ?? null;
    for (const assignment of site.criticalityTags) {
      const label = assignment.tag?.label?.trim();
      if (!label) continue;
      const upper = label.toUpperCase();
      if (upper === "DC") bucket.isDatacenter = true;
      if (upper === "CORE") bucket.isCoreSite = true;
      if (!bucket.criticalityTags.some((existing) => existing.toUpperCase() === upper)) {
        bucket.criticalityTags.push(label);
      }
    }
  }

  // Keep only segments whose parent site is DC / Core.
  const parentKeyFor = (segment: (typeof segments)[number]): string =>
    canonicalSiteKey(endpointCode(segment.endpointA)) || canonicalSiteKey(endpointCode(segment.endpointB));
  const matchingEndpointKey = (segment: (typeof segments)[number], tag: string): string => {
    const aKey = canonicalSiteKey(endpointCode(segment.endpointA));
    const bKey = canonicalSiteKey(endpointCode(segment.endpointB));
    if (aKey && factsHasTag(factsFor(aKey), tag)) return aKey;
    if (bKey && factsHasTag(factsFor(bKey), tag)) return bKey;
    return parentKeyFor(segment);
  };
  const isBackboneSegment = (segment: (typeof segments)[number]): boolean =>
    textIsBackbone(segment.segmentDefaultRole) ||
    textIsBackbone(segment.inventoryClass) ||
    textIsBackbone(segment.spanType) ||
    segment.endpointMappings.some((mapping) => textIsBackbone(mapping.tag));

  const qualifying = segments.filter((segment) => {
    if (segment.segmentDefaultRole !== "INTRA_SITE") return false;
    const a = factsFor(canonicalSiteKey(endpointCode(segment.endpointA)));
    const b = factsFor(canonicalSiteKey(endpointCode(segment.endpointB)));
    return a.isDatacenter || a.isCoreSite || b.isDatacenter || b.isCoreSite;
  });
  const equinixSegments = segments.filter((segment) =>
    segment.segmentDefaultRole === "INTRA_SITE" &&
    (factsHasTag(factsFor(canonicalSiteKey(endpointCode(segment.endpointA))), "Equinix") ||
      factsHasTag(factsFor(canonicalSiteKey(endpointCode(segment.endpointB))), "Equinix")),
  );
  const crossBorderSegments = segments.filter((segment) =>
    isBackboneSegment(segment) &&
    (factsHasTag(factsFor(canonicalSiteKey(endpointCode(segment.endpointA))), "C-BI") ||
      factsHasTag(factsFor(canonicalSiteKey(endpointCode(segment.endpointB))), "C-BI")),
  );

  // 3) ODF port availability for the near/far ODFs of qualifying segments.
  const odfIds = new Set<string>();
  for (const segment of [...qualifying, ...equinixSegments, ...crossBorderSegments]) {
    if (segment.endpointA.odfId) odfIds.add(segment.endpointA.odfId);
    if (segment.endpointB.odfId) odfIds.add(segment.endpointB.odfId);
  }
  const portStats = odfIds.size
    ? await prisma.oDFPort.groupBy({
        by: ["odfId", "status"],
        where: { odfId: { in: [...odfIds] } },
        _count: { _all: true },
      })
    : [];
  const portsByOdf = new Map<string, { total: number; available: number }>();
  for (const stat of portStats) {
    if (!stat.odfId) continue;
    const status = String(stat.status).toUpperCase();
    if (status === "DECOMMISSIONED") continue;
    const bucket = portsByOdf.get(stat.odfId) ?? { total: 0, available: 0 };
    const count = stat._count?._all ?? 0;
    bucket.total += count;
    if (PORT_AVAILABLE_STATUSES.has(status)) bucket.available += count;
    portsByOdf.set(stat.odfId, bucket);
  }
  const odfPorts = (odfId: string | null) => (odfId ? portsByOdf.get(odfId) ?? { total: 0, available: 0 } : { total: 0, available: 0 });

  // 4) Build the panel rows.
  const buildRow = (segment: (typeof segments)[number], parentKeyOverride?: string): IntraSiteSaturationRow => {
    const near = odfPorts(segment.endpointA.odfId);
    const far = odfPorts(segment.endpointB.odfId);

    // A true intra-site span has BOTH endpoints on the same canonical parent site.
    // Then the near/far ODFs are the two FACES of ONE physical in-building riser
    // (e.g. MU0282 rooftop ⇄ MU0282 basement), so their port counts must NEVER be
    // summed — doing so turned a 48F riser into a phantom 96.
    const sameSiteSpan =
      canonicalSiteKey(endpointCode(segment.endpointA)) === canonicalSiteKey(endpointCode(segment.endpointB)) &&
      Boolean(canonicalSiteKey(endpointCode(segment.endpointA)));

    // Physical capacity is authoritative from the segment's configured fiber count;
    // fall back to a SINGLE ODF face (max, not the sum) when no capacity is set.
    const faceTotal = sameSiteSpan ? Math.max(near.total, far.total) : near.total + far.total;
    const totalCapacity =
      segment.totalFiberCapacity && segment.totalFiberCapacity > 0 ? segment.totalFiberCapacity : faceTotal;

    // Saturation & availability come from the segment's REAL fiber accounting — not
    // the raw ODF port ACTIVE flag. An intra-site cross-connect can be fully patched
    // (every port status ACTIVE) yet carry zero services; that must read as available,
    // not 100% saturated. usedFiberCount/availableFiberCount are the same figures the
    // inventory and ODF-mapping views already maintain for the segment.
    const usedFibers = Math.min(
      totalCapacity,
      Math.max(0, (segment.usedFiberCount ?? 0) + (segment.reservedFiberCount ?? 0)),
    );
    const availableFibers =
      segment.availableFiberCount != null && segment.availableFiberCount >= 0
        ? Math.min(segment.availableFiberCount, totalCapacity)
        : Math.max(0, totalCapacity - usedFibers);
    const saturationPct =
      totalCapacity > 0 ? clampPct((usedFibers / totalCapacity) * 100) : clampPct(segment.utilizationPct ?? 0);

    // Per-face spare shown in the Near/Far columns. One riser ⇒ both faces share the
    // same span-level spare; an inter-site span shows each ODF face's free ports.
    const nearAvailablePorts = sameSiteSpan ? availableFibers : Math.min(near.available, totalCapacity);
    const farAvailablePorts = sameSiteSpan ? availableFibers : Math.min(far.available, totalCapacity);

    const parentKey = parentKeyOverride || parentKeyFor(segment);
    const parentSiteLabel =
      displaySiteLabel(segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode) || parentKey || "—";
    return {
      segmentId: segment.id,
      segmentName:
        segment.routeLabel?.trim() ||
        segment.segmentGroupName?.trim() ||
        segment.segmentCode ||
        parentKey ||
        "Unnamed segment",
      parentSiteLabel,
      parentSiteId: parentKey || undefined,
      totalCapacity,
      activePorts: usedFibers,
      availablePorts: availableFibers,
      nearAvailablePorts,
      farAvailablePorts,
      saturationPct,
      siteTags: buildSiteTags(factsFor(parentKey)),
    };
  };
  const rows: IntraSiteSaturationRow[] = qualifying.map((segment) => buildRow(segment));
  const equinixRows: IntraSiteSaturationRow[] = equinixSegments.map((segment) => buildRow(segment, matchingEndpointKey(segment, "Equinix")));
  const crossBorderRows: IntraSiteSaturationRow[] = crossBorderSegments.map((segment) => buildRow(segment, matchingEndpointKey(segment, "C-BI")));
  rows.sort((a, b) => b.saturationPct - a.saturationPct || b.totalCapacity - a.totalCapacity);
  equinixRows.sort((a, b) => b.saturationPct - a.saturationPct || b.totalCapacity - a.totalCapacity);
  crossBorderRows.sort((a, b) => b.saturationPct - a.saturationPct || b.totalCapacity - a.totalCapacity);

  // 5) Active Services Footprint — one bar per distinct ODF-mapping tag inside the
  //    qualifying intra-site scope. A service spanning multiple segments is counted
  //    ONCE (deduped by serviceCode; tagged rows without a serviceCode dedupe by
  //    their segment) so each bar shows the true unique-service footprint.
  const footprint = new Map<string, Set<string>>();
  for (const segment of qualifying) {
    for (const mapping of segment.endpointMappings) {
      const tag = mapping.tag?.trim();
      if (!tag) continue;
      const dedupeKey = mapping.serviceCode?.trim().toUpperCase() || `seg:${segment.id}`;
      const set = footprint.get(tag) ?? new Set<string>();
      set.add(dedupeKey);
      footprint.set(tag, set);
    }
  }
  const serviceFootprint: ServiceFootprintBar[] = [...footprint.entries()]
    .map(([tag, set]) => ({ tag, count: set.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {
    rows,
    equinixRows,
    crossBorderRows,
    serviceFootprint,
    totalServiceTypes: serviceFootprint.length,
    qualifyingSegments: qualifying.length,
    generatedAt: new Date().toISOString(),
  };
}

const snapshot = createHourlySnapshot(computeSnapshot);

/** Cached (1h, stale-while-revalidate) snapshot for the two intra-site widgets. */
export async function getIntraSiteSaturationSnapshot(): Promise<IntraSiteSaturationSnapshot> {
  try {
    return await snapshot.get();
  } catch {
    // Never let a dashboard panel take the whole page down.
    return { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString() };
  }
}
