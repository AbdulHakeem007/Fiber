import { prisma } from "@/lib/db/prisma";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { displaySiteLabel } from "@/lib/telecom/site-display";

const TAKE = 20;

function clean(value?: string | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function containsQuery(value?: string | null) {
  const query = clean(value);
  if (!query) return undefined;
  return { contains: query };
}

async function resolveSiteId(site?: string | null): Promise<string | null> {
  const text = clean(site);
  if (!text) return null;
  const normalized = normalizeAlias(text);
  const or: any[] = [
    { code: text.toUpperCase() },
    { name: containsQuery(text) },
  ];
  if (normalized) or.push({ aliases: { some: { aliasNormalized: normalized } } });
  const direct = await prisma.site.findFirst({
    where: { OR: or },
    select: { id: true },
  });
  return direct?.id ?? null;
}

export const suggestionService = {
  async sites(q?: string | null) {
    const query = clean(q);
    const normalized = normalizeAlias(query);
    const or: any[] = query
      ? [
          { code: { contains: query.toUpperCase() } },
          { name: containsQuery(query) },
          { aliases: { some: { alias: containsQuery(query) } } },
        ]
      : [];
    if (normalized) or.push({ aliases: { some: { aliasNormalized: { contains: normalized } } } });
    const sites = await prisma.site.findMany({
      where: query ? { OR: or } : undefined,
      include: {
        aliases: true,
        racks: { select: { rackCode: true }, orderBy: { rackCode: "asc" }, take: 1 },
        odfs: { select: { odfCode: true, rack: { select: { rackCode: true } } }, orderBy: { odfCode: "asc" }, take: 1 },
        portGroups: { select: { displayLabel: true }, orderBy: { displayLabel: "asc" }, take: 1 },
      },
      orderBy: { code: "asc" },
      take: TAKE,
    });
    return sites.map((site) => {
      const displayName = displaySiteLabel(site.name ?? site.code);
      const defaultOdf = site.odfs[0];
      const defaultRack = defaultOdf?.rack.rackCode ?? site.racks[0]?.rackCode ?? null;
      return {
        value: site.code,
        label: site.name ? `${site.code} (${displayName})` : displayName,
        displayName,
        defaultRack,
        defaultOdf: defaultOdf?.odfCode ?? null,
        defaultPortGroup: site.portGroups[0]?.displayLabel ?? null,
        aliases: site.aliases.map((alias) => alias.alias),
      };
    });
  },

  async services(q?: string | null) {
    const query = clean(q);
    const normalizedQuery = query?.toUpperCase();
    const services = await prisma.service.findMany({
      where: query
        ? { OR: [{ serviceCode: { contains: normalizedQuery } }, { serviceName: containsQuery(query) }] }
        : undefined,
      select: {
        serviceCode: true,
        serviceName: true,
        routes: { where: { isActive: true }, select: { hops: { select: { pathLabel: true }, orderBy: { hopOrder: "asc" } } }, take: 1 },
      },
      orderBy: { serviceCode: "asc" },
      take: TAKE,
    });

    const suggestions = new Map<string, { value: string; label: string; route: string | null }>();
    for (const service of services) {
      suggestions.set(service.serviceCode, {
        value: service.serviceCode,
        label: `${service.serviceCode} - ${service.serviceName}`,
        route: service.routes[0]?.hops.map((hop) => hop.pathLabel).filter(Boolean).join(" -> ") || null,
      });
    }

    // Imported ODF mappings may carry service IDs even before a Service row exists.
    // Include them so Trace/Provision autocomplete can find imported services too.
    const mappingServices = await prisma.segmentEndpointMapping.findMany({
      where: {
        serviceCode: query ? { contains: normalizedQuery } : { not: null },
        status: { not: "DECOMMISSIONED" },
        segment: { status: { not: "DECOMMISSIONED" } },
      },
      select: { serviceCode: true, localSiteCode: true, farSiteCode: true, farEndpointLabel: true },
      orderBy: { serviceCode: "asc" },
      take: TAKE * 2,
    });
    for (const row of mappingServices) {
      const value = clean(row.serviceCode)?.toUpperCase();
      if (!value || suggestions.has(value)) continue;
      const from = row.localSiteCode;
      const to = row.farSiteCode ?? row.farEndpointLabel;
      suggestions.set(value, {
        value,
        label: `${value} - imported ODF mapping${from || to ? ` (${[from, to].filter(Boolean).join(" -> ")})` : ""}`,
        route: [from, to].filter(Boolean).join("-") || null,
      });
    }

    const fiberServices = await prisma.segmentFiber.findMany({
      where: {
        serviceCode: query ? { contains: normalizedQuery } : { not: null },
        status: { not: "DECOMMISSIONED" },
        segment: { status: { not: "DECOMMISSIONED" } },
      },
      select: { serviceCode: true, segment: { select: { endpointA: { select: { rawSiteCode: true, site: { select: { code: true } } } }, endpointB: { select: { rawSiteCode: true, site: { select: { code: true } } } } } } },
      orderBy: { serviceCode: "asc" },
      take: TAKE * 2,
    });
    for (const row of fiberServices) {
      const value = clean(row.serviceCode)?.toUpperCase();
      if (!value || suggestions.has(value)) continue;
      const from = row.segment.endpointA.site?.code ?? row.segment.endpointA.rawSiteCode;
      const to = row.segment.endpointB.site?.code ?? row.segment.endpointB.rawSiteCode;
      suggestions.set(value, {
        value,
        label: `${value} - fiber allocation${from || to ? ` (${[from, to].filter(Boolean).join(" -> ")})` : ""}`,
        route: [from, to].filter(Boolean).join("-") || null,
      });
    }

    return [...suggestions.values()].slice(0, TAKE);
  },

  async segments(q?: string | null) {
    const query = clean(q);
    const segments = await prisma.linkSegment.findMany({
      where: query
        ? {
            OR: [
              { segmentCode: containsQuery(query) },
              { segmentGroupName: containsQuery(query) },
              { routeLabel: containsQuery(query) },
              { cable: { OR: [{ cableCode: containsQuery(query) }, { cableName: containsQuery(query) }] } },
            ],
          }
        : undefined,
      include: {
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
      },
      orderBy: [{ segmentGroupName: "asc" }, { segmentSequence: "asc" }, { segmentCode: "asc" }],
      take: TAKE,
    });
    return segments.map((segment) => ({
      value: segment.segmentCode,
      label: segment.segmentCode,
      segmentGroupName: segment.segmentGroupName,
      segmentSequence: segment.segmentSequence,
      nearSite: segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode,
      farSite: segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode,
      nearRack: segment.endpointA.rack?.rackCode ?? segment.endpointA.rawRackCode,
      farRack: segment.endpointB.rack?.rackCode ?? segment.endpointB.rawRackCode,
      nearOdf: segment.endpointA.odf?.odfCode ?? segment.endpointA.rawOdfCode,
      farOdf: segment.endpointB.odf?.odfCode ?? segment.endpointB.rawOdfCode,
      nearPort: segment.endpointA.portGroup?.displayLabel ?? segment.endpointA.rawPortText,
      farPort: segment.endpointB.portGroup?.displayLabel ?? segment.endpointB.rawPortText,
    }));
  },

  async racks(site?: string | null, q?: string | null) {
    const siteId = await resolveSiteId(site);
    const query = clean(q)?.toUpperCase();
    const racks = await prisma.rack.findMany({
      where: {
        ...(siteId ? { siteId } : {}),
        ...(query ? { rackCode: { contains: query } } : {}),
      },
      select: { rackCode: true, site: { select: { code: true, name: true } } },
      orderBy: { rackCode: "asc" },
      take: TAKE,
    });
    return racks.map((rack) => ({ value: rack.rackCode, label: `${displaySiteLabel(rack.site.name ?? rack.site.code)} / ${rack.rackCode}`, site: rack.site.code }));
  },

  async odfs(site?: string | null, rack?: string | null, q?: string | null) {
    const siteId = await resolveSiteId(site);
    const rackCode = clean(rack)?.toUpperCase();
    const query = clean(q)?.toUpperCase();
    const odfs = await prisma.oDF.findMany({
      where: {
        ...(siteId ? { siteId } : {}),
        ...(rackCode ? { rack: { rackCode } } : {}),
        ...(query ? { odfCode: { contains: query } } : {}),
      },
      select: { odfCode: true, site: { select: { code: true, name: true } }, rack: { select: { rackCode: true } } },
      orderBy: { odfCode: "asc" },
      take: TAKE,
    });
    return odfs.map((odf) => ({ value: odf.odfCode, label: `${displaySiteLabel(odf.site.name ?? odf.site.code)} / ${odf.rack.rackCode} / ${odf.odfCode}`, site: odf.site.code, rack: odf.rack.rackCode }));
  },

  async ports(site?: string | null, rack?: string | null, odf?: string | null, q?: string | null) {
    const siteId = await resolveSiteId(site);
    const rackCode = clean(rack)?.toUpperCase();
    const odfCode = clean(odf)?.toUpperCase();
    const query = clean(q);
    const ports = await prisma.portGroup.findMany({
      where: {
        ...(siteId ? { siteId } : {}),
        ...(rackCode ? { rack: { rackCode } } : {}),
        ...(odfCode ? { odf: { odfCode } } : {}),
        ...(query ? { displayLabel: { contains: query } } : {}),
      },
      include: { site: true, rack: true, odf: true },
      orderBy: [{ displayLabel: "asc" }],
      take: TAKE,
    });
    return ports.map((port) => ({
      value: port.displayLabel,
      label: `${port.site.code} / ${port.rack.rackCode} / ${port.odf.odfCode} / ${port.displayLabel}`,
      status: port.status,
      site: port.site.code,
      rack: port.rack.rackCode,
      odf: port.odf.odfCode,
    }));
  },

  async connectedSites(site?: string | null, q?: string | null) {
    const siteText = clean(site);
    const query = clean(q);
    const normalized = normalizeAlias(siteText);

    // When no parent Site is selected yet, Connected Site should still behave like
    // a useful Site-ID autocomplete instead of returning an empty dropdown.
    if (!siteText) return this.sites(query);

    const segments = await prisma.linkSegment.findMany({
      where: {
        OR: [
          { endpointA: { OR: [{ rawSiteCode: normalized ?? siteText }, { site: { code: normalized ?? siteText.toUpperCase() } }] } },
          { endpointB: { OR: [{ rawSiteCode: normalized ?? siteText }, { site: { code: normalized ?? siteText.toUpperCase() } }] } },
        ],
        status: { not: "DECOMMISSIONED" },
      },
      include: { endpointA: { include: { site: true } }, endpointB: { include: { site: true } } },
      take: 200,
    });
    const values = new Map<string, string>();
    const queryNorm = query ? normalizeAlias(query) ?? query.toUpperCase() : null;
    for (const segment of segments) {
      const a = segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode;
      const b = segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode;
      const aMatches = normalizeAlias(a) === normalized || a?.toUpperCase() === siteText.toUpperCase();
      const other = aMatches ? b : a;
      const otherNorm = other ? normalizeAlias(other) ?? other.toUpperCase() : null;
      if (other && (!queryNorm || otherNorm?.includes(queryNorm))) values.set(other, other);
    }
    return [...values.values()].sort().slice(0, TAKE).map((value) => ({ value, label: value }));
  },

  async splitters(q?: string | null) {
    const query = clean(q);
    const splitters = await prisma.splitter.findMany({
      where: query
        ? {
            OR: [
              { splitterCode: containsQuery(query) },
              { splitterName: containsQuery(query) },
              { location: containsQuery(query) },
              { primaryInputSiteCode: containsQuery(query) },
            ],
          }
        : undefined,
      orderBy: [{ scope: "asc" }, { splitterCode: "asc" }],
      take: TAKE,
    });
    return splitters.map((splitter) => ({
      value: splitter.splitterCode,
      label: `${splitter.splitterCode} (${splitter.scope})`,
      scope: splitter.scope,
      location: splitter.location,
    }));
  },

  async transportTrail(q?: string | null) {
    const query = clean(q);
    const segments = await this.segments(query);
    return segments.map((segment) => ({
      value: [segment.nearSite, segment.farSite].filter(Boolean).join("-"),
      label: `${segment.nearSite ?? "?"}-${segment.farSite ?? "?"} via ${segment.value}`,
      segment: segment.value,
    }));
  },
};
