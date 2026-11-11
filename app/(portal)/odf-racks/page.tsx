import { OdfRackExplorer, type OdfRackRow } from "@/components/odf/odf-rack-explorer";
import { hasPermission } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { chunkArray } from "@/lib/db/chunk-helper";
import type { Prisma, SegmentEndpointMapping, LinkSegment } from "@prisma/client";

export default async function OdfRacksPage({ searchParams }: { searchParams?: Promise<{ search?: string; page?: string; pageSize?: string }> }) {
  const params = await searchParams;
  const user = await getSessionUser();
  const page = Math.max(1, Number(params?.page ?? "1") || 1);
  const pageSize = Math.min(250, Math.max(25, Number(params?.pageSize ?? "100") || 100));
  const search = String(params?.search ?? "").trim();
  const where: Prisma.ODFWhereInput = {
    ...(search
      ? {
          OR: [
            { odfCode: { contains: search } },
            { name: { contains: search } },
            { remarks: { contains: search } },
            { site: { is: { code: { contains: search } } } },
            { site: { is: { name: { contains: search } } } },
            { rack: { is: { rackCode: { contains: search } } } },
          ],
        }
      : {}),
  };
  const [total, odfs] = await Promise.all([
    prisma.oDF.count({ where }),
    prisma.oDF.findMany({
      where,
      include: {
        site: true,
        rack: true,
        portGroups: {
          include: { splitterOutputs: true },
        },
        // Capacity fix: load ALL ports (including DECOMMISSIONED). Previously
        // decommissioned ports were filtered out here, which forced
        // decommissionedCount to always be 0 and hid the retired ports the
        // decommission-then-delete workflow depends on. Total Ports Count and
        // the Port Status-wise breakdown are derived from this full set.
        ports: true,
      },
      orderBy: [{ site: { code: "asc" } }, { rack: { rackCode: "asc" } }, { odfCode: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const odfIds = odfs.map((odf) => odf.id);
  const portGroupIds = odfs.flatMap((odf) => odf.portGroups.map((group) => group.id));

  // CRITICAL FIX: Use chunking to avoid Prisma parameter limit when there are many port groups
  const mappings = portGroupIds.length
    ? await (async () => {
        const allMappings: SegmentEndpointMapping[] = [];
        const chunks = chunkArray(portGroupIds, 500);
        for (const chunk of chunks) {
          const chunkMappings = await prisma.segmentEndpointMapping.findMany({
            where: {
              status: { not: "DECOMMISSIONED" },
              segment: { status: { not: "DECOMMISSIONED" } },
              OR: [{ localPortGroupId: { in: chunk } }, { farPortGroupId: { in: chunk } }],
            },
            orderBy: { createdAt: "asc" },
          });
          allMappings.push(...chunkMappings);
        }
        return allMappings;
      })()
    : [];
  const mappingByPortGroup = new Map<string, typeof mappings[number][]>();
  for (const mapping of mappings) {
    for (const id of [mapping.localPortGroupId, mapping.farPortGroupId].filter(Boolean) as string[]) {
      mappingByPortGroup.set(id, [...(mappingByPortGroup.get(id) ?? []), mapping]);
    }
  }
  // CRITICAL FIX: Use chunking to avoid Prisma parameter limit for segments query
  const segments = odfIds.length
    ? await (async () => {
        const allSegments: (LinkSegment & { endpointA: any; endpointB: any })[] = [];
        const chunks = chunkArray(odfIds, 500);
        for (const chunk of chunks) {
          const chunkSegments = await prisma.linkSegment.findMany({
            where: {
              status: { not: "DECOMMISSIONED" },
              OR: [
                { endpointA: { odfId: { in: chunk } } },
                { endpointB: { odfId: { in: chunk } } },
              ],
            },
            include: {
              endpointA: { include: { site: true } },
              endpointB: { include: { site: true } },
            },
          });
          allSegments.push(...chunkSegments);
        }
        return allSegments;
      })()
    : [];
  const capacityByOdf = new Map<string, {
    totalFibers: number;
    usedFibers: number;
    reservedFibers: number;
    faultyFibers: number;
    availableFibers: number;
    farEnds: Set<string>;
  }>();

  for (const segment of segments) {
    for (const [local, remote] of [[segment.endpointA, segment.endpointB], [segment.endpointB, segment.endpointA]] as const) {
      if (!local.odfId) continue;
      const bucket = capacityByOdf.get(local.odfId) ?? {
        totalFibers: 0,
        usedFibers: 0,
        reservedFibers: 0,
        faultyFibers: 0,
        availableFibers: 0,
        farEnds: new Set<string>(),
      };
      bucket.totalFibers += segment.totalFiberCapacity;
      bucket.usedFibers += segment.usedFiberCount;
      bucket.reservedFibers += segment.reservedFiberCount;
      bucket.faultyFibers += segment.faultyFiberCount;
      bucket.availableFibers += segment.availableFiberCount;
      const farSite = remote.site?.code ?? remote.rawSiteCode;
      if (farSite) bucket.farEnds.add(farSite);
      capacityByOdf.set(local.odfId, bucket);
    }
  }

  const splitterLabelsForOdf = (odf: typeof odfs[number]) => {
    const labels = odf.portGroups
      .flatMap((group) => group.splitterOutputs)
      .map((output) => output.destinationLabel || output.serviceCode)
      .filter(Boolean) as string[];
    return [...new Set(labels)].join(", ") || null;
  };

  // ATP visibility upgrade: the summary column used to show only how many ATPs
  // hang off an ODF. Operators also need the PORT count those ATPs terminate,
  // so we aggregate, per distinct ATP label, the number of splitter-output
  // ports (excluding decommissioned outputs) and expose both figures plus a
  // per-ATP breakdown for the hover tooltip.
  const atpSummaryForOdf = (odf: typeof odfs[number]) => {
    const portsByAtp = new Map<string, number>();
    for (const output of odf.portGroups.flatMap((group) => group.splitterOutputs)) {
      if (output.status === "DECOMMISSIONED") continue;
      const label = (output.destinationLabel || output.serviceCode || "").trim();
      if (!label) continue;
      portsByAtp.set(label, (portsByAtp.get(label) ?? 0) + 1);
    }
    const atpCount = portsByAtp.size;
    const atpPortCount = [...portsByAtp.values()].reduce((sum, count) => sum + count, 0);
    const atpBreakdown = [...portsByAtp.entries()]
      .map(([label, count]) => `${label}: ${count} port${count === 1 ? "" : "s"}`)
      .join("\n") || null;
    return { atpCount, atpPortCount, atpBreakdown };
  };

  const customerLabelsForOdf = (odf: typeof odfs[number]) => {
    const labels = odf.portGroups
      .flatMap((group) => group.splitterOutputs)
      .map((output) => output.destinationLabel || output.serviceCode)
      .filter(Boolean) as string[];
    return [...new Set(labels)].join(", ") || null;
  };

  const rows: OdfRackRow[] = odfs.map((odf) => ({
    ...atpSummaryForOdf(odf),
    odfId: odf.id,
    siteCode: odf.site.code,
    siteName: odf.site.name,
    rackCode: odf.rack.rackCode,
    odfCode: odf.odfCode,
    status: odf.status,
    maxPorts: odf.maxPorts,
    portGroupCount: odf.portGroups.length,
    usedCount: odf.ports.filter((port) => port.status === "USED" || port.status === "ACTIVE").length,
    spareCount: odf.ports.filter((port) => port.status === "SPARE").length,
    freeCount: odf.ports.filter((port) => port.status === "AVAILABLE").length,
    dummyCount: odf.ports.filter((port) => port.status === "DUMMY").length,
    reservedCount: odf.ports.filter((port) => port.status === "RESERVED").length,
    faultyCount: odf.ports.filter((port) => port.status === "FAULTY").length,
    decommissionedCount: odf.ports.filter((port) => port.status === "DECOMMISSIONED").length,
    splitterOutputCount: odf.portGroups.filter((group) => group.splitterOutputs.length > 0).length,
    atpLabels: splitterLabelsForOdf(odf),
    customerLabels: customerLabelsForOdf(odf),
    totalOdfPorts: odf.ports.length,
    usedOdfPorts: odf.ports.filter((port) => port.status === "USED" || port.status === "ACTIVE").length,
    freeOdfPorts: odf.ports.filter((port) => port.status === "AVAILABLE" || port.status === "SPARE").length,
    mappedFarEnds: [...(capacityByOdf.get(odf.id)?.farEnds ?? new Set<string>())].join(", "),
    remarks: odf.remarks,
    ports: odf.portGroups.flatMap((group) => {
      const groupMappings = mappingByPortGroup.get(group.id) ?? [];
      if (!groupMappings.length) {
        return [{
          id: group.id,
          siteCode: odf.site.code,
          siteName: odf.site.name,
          rackCode: odf.rack.rackCode,
          odfCode: odf.odfCode,
          portPair: group.displayLabel,
          farSite: null,
          farRack: null,
          farOdf: null,
          farPort: null,
          serviceId: null,
          status: group.status,
          remarks: group.remarks,
          // Distinct ATP labels only — one ATP fed by several output ports must
          // count once; the port volume is carried by atpPortCount.
          atpLabel: [...new Set(group.splitterOutputs.map((output) => output.destinationLabel || output.serviceCode).filter(Boolean))].join(", ") || null,
          atpPortCount: group.splitterOutputs.filter((output) => output.status !== "DECOMMISSIONED").length,
          customerName: group.splitterOutputs.map((output) => output.destinationLabel || output.serviceCode).filter(Boolean).join(", ") || null,
        }];
      }
      return groupMappings.map((mapping) => {
        const isLocal = mapping.localPortGroupId === group.id;
        return {
          id: `${group.id}-${mapping.id}`,
          siteCode: odf.site.code,
          siteName: odf.site.name,
          rackCode: odf.rack.rackCode,
          odfCode: odf.odfCode,
          portPair: group.displayLabel,
          farSite: isLocal ? mapping.farSiteCode : mapping.localSiteCode,
          farRack: isLocal ? mapping.farRackCode : mapping.localRackCode,
          farOdf: isLocal ? mapping.farOdfCode : mapping.localOdfCode,
          farPort: isLocal ? mapping.farPortLabel : mapping.localPortLabel,
          serviceId: mapping.serviceCode ?? null,
          status: group.status,
          remarks: mapping.remarks ?? group.remarks,
          // Distinct ATP labels only — one ATP fed by several output ports must
          // count once; the port volume is carried by atpPortCount.
          atpLabel: [...new Set(group.splitterOutputs.map((output) => output.destinationLabel || output.serviceCode).filter(Boolean))].join(", ") || null,
          atpPortCount: group.splitterOutputs.filter((output) => output.status !== "DECOMMISSIONED").length,
          customerName: group.splitterOutputs.map((output) => output.destinationLabel || output.serviceCode).filter(Boolean).join(", ") || null,
        };
      });
    }),
  }));

  return (
    <OdfRackExplorer
      initialRows={rows}
      initialQuery={search}
      serverPage={{ page, pageSize, total }}
      canDelete={hasPermission(user?.roleCode, "childLinkDelete")}
      canBulkDelete={hasPermission(user?.roleCode, "bulkDelete")}
    />
  );
}
