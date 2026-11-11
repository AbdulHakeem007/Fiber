import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";

export async function GET(_request: Request, { params }: { params: Promise<{ siteCode: string }> }) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "inventoryRead")) {
    return NextResponse.json({ error: "Inventory read access is required." }, { status: 403 });
  }

  const { siteCode } = await params;
  const code = siteCode.trim().toUpperCase();

  // Detail rows are windowed so a single browser-tab JSON dump never tries to
  // serialize a whole large site (the portal targets 200k+ mappings / 50k+
  // outputs). The SUMMARY counts, however, come from real COUNT queries below
  // so they stay accurate at scale instead of capping at the window size.
  const DETAIL_LIMIT = 5000;

  // Shared where-clauses keep each COUNT and its windowed findMany in sync.
  const localMappingWhere: Prisma.SegmentEndpointMappingWhereInput = { localSiteCode: { contains: code }, status: { not: "DECOMMISSIONED" } };
  const farMappingWhere: Prisma.SegmentEndpointMappingWhereInput = { OR: [{ farSiteCode: { contains: code } }, { farEndpointLabel: { contains: code } }], status: { not: "DECOMMISSIONED" } };
  const splitterWhere: Prisma.SplitterWhereInput = {
    OR: [
      { primaryInputSiteCode: { contains: code } },
      { secondaryInputSiteCode: { contains: code } },
      { location: { contains: code } },
      { locationContext: { contains: code } },
    ],
  };
  const splitterOutputWhere: Prisma.SplitterOutputWhereInput = {
    OR: [
      { localSiteCode: { contains: code } },
      { destinationSiteCode: { contains: code } },
      { destinationLabel: { contains: code } },
    ],
  };

  const [
    site, racks, odfs,
    localMappings, farMappings, splitters, splitterOutputs,
    localMappingTotal, farMappingTotal, splitterOutputTotal,
  ] = await Promise.all([
    prisma.site.findUnique({ where: { code } }),
    prisma.rack.findMany({ where: { site: { code } }, include: { odfs: true }, orderBy: { rackCode: "asc" } }),
    prisma.oDF.findMany({ where: { rack: { site: { code } } }, include: { portGroups: true }, orderBy: { odfCode: "asc" } }),
    prisma.segmentEndpointMapping.findMany({
      where: localMappingWhere,
      include: { segment: true },
      orderBy: [{ localRackCode: "asc" }, { localOdfCode: "asc" }, { localPortLabel: "asc" }],
      take: DETAIL_LIMIT,
    }),
    prisma.segmentEndpointMapping.findMany({
      where: farMappingWhere,
      include: { segment: true },
      orderBy: [{ farRackCode: "asc" }, { farOdfCode: "asc" }, { farPortLabel: "asc" }],
      take: DETAIL_LIMIT,
    }),
    prisma.splitter.findMany({
      where: splitterWhere,
      include: { outputs: true },
      orderBy: [{ scope: "asc" }, { splitterCode: "asc" }],
    }),
    prisma.splitterOutput.findMany({
      where: splitterOutputWhere,
      include: { splitter: true },
      orderBy: [{ localRackCode: "asc" }, { localOdfCode: "asc" }, { localPortLabel: "asc" }],
      take: DETAIL_LIMIT,
    }),
    prisma.segmentEndpointMapping.count({ where: localMappingWhere }),
    prisma.segmentEndpointMapping.count({ where: farMappingWhere }),
    prisma.splitterOutput.count({ where: splitterOutputWhere }),
  ]);

  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  return NextResponse.json({
    site,
    summary: {
      racks: racks.length,
      odfs: odfs.length,
      portGroups: odfs.reduce((total, odf) => total + odf.portGroups.length, 0),
      localMappings: localMappingTotal,
      farMappings: farMappingTotal,
      splitters: splitters.length,
      splitterOutputs: splitterOutputTotal,
    },
    // Honest truncation markers so consumers know when a detail list is a window
    // over a larger result set rather than the complete set.
    detail: {
      limit: DETAIL_LIMIT,
      truncated: {
        localMappings: localMappingTotal > localMappings.length,
        farMappings: farMappingTotal > farMappings.length,
        splitterOutputs: splitterOutputTotal > splitterOutputs.length,
      },
    },
    racks,
    odfs,
    localMappings,
    farMappings,
    splitters,
    splitterOutputs,
  });
}
