import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { regionForSiteCode } from "@/lib/config/regions";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { prisma } from "@/lib/db/prisma";
import { attachmentService } from "@/server/services/attachment.service";
import { replaceSiteCriticality } from "@/server/services/site-criticality.service";

const SITE_STATUSES = new Set(["ACTIVE", "PLANNED", "INACTIVE", "DECOMMISSIONED"]);

export async function GET() {
  const [sites, siteDocStatuses] = await Promise.all([
    prisma.site.findMany({
    orderBy: { code: "asc" },
    include: {
      criticalityTags: { include: { tag: true } },
      _count: {
        select: {
          racks: true,
          odfs: true,
          portGroups: true,
          segmentEndpoints: true,
        },
      },
    },
    }),
    attachmentService.siteDocumentStatus(),
  ]);
  const docStatusBySiteId = new Map(siteDocStatuses.map((status) => [status.siteId, status.docStatus]));
  const documentsBySiteId = new Map(siteDocStatuses.map((status) => [status.siteId, status.documents]));

  return NextResponse.json({
    sites: sites.map((site) => ({
      ...site,
      docStatus: docStatusBySiteId.get(site.id) ?? { FDD: false, ODF_PHOTO: false, OTDR_REPORT: false },
      documents: documentsBySiteId.get(site.id) ?? { FDD: null, ODF_PHOTO: null, OTDR_REPORT: null },
    })),
  });
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to create sites." }, { status: 403 });
    }

    const body = await request.json();
    // EDIT HERE: Site identity refactor. The UI now treats Site ID/display name as
    // the primary user-facing identifier; legacy site code is optional. If code is
    // omitted, derive a safe internal code from Site ID so existing foreign-key
    // logic remains stable.
    const siteIdText = String(body.name ?? body.siteId ?? body.displayName ?? body.code ?? "").trim();
    const derivedCode = siteIdText.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const code = String(body.code ?? (derivedCode || `SITE_${Date.now()}`)).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const siteName = siteIdText || code;
    if (!code && !siteName) {
      return NextResponse.json({ error: "Site ID is required when legacy site code is empty.", field: "name" }, { status: 400 });
    }

    const existingName = siteName ? await prisma.site.findFirst({ where: { name: siteName }, select: { id: true, code: true, name: true } }) : null;
    if (existingName) {
      return NextResponse.json(
        { error: `Site ID ${siteName} already exists under legacy code ${existingName.code}. Please edit the existing site.`, field: "name" },
        { status: 409 },
      );
    }

    const existingSite = await prisma.site.findUnique({ where: { code }, select: { id: true, code: true } });
    if (existingSite) {
      return NextResponse.json(
        { error: `Site code ${code} already exists. Please edit the existing site or choose another code.`, field: "code" },
        { status: 409 },
      );
    }

    // Alias keys are stored fully normalized (alphanumeric-only) so lookups by
    // "MOCK-ATN109", "MOCK_ATN109", or "MOCKATN109" all resolve to the same site.
    const aliasKey = normalizeAlias(code) ?? code;
    const existingAlias = await prisma.siteAlias.findFirst({ where: { aliasNormalized: { in: [code, aliasKey] } }, select: { site: { select: { code: true } } } });
    if (existingAlias) {
      return NextResponse.json(
        { error: `Site code ${code} is already registered as an alias for ${existingAlias.site.code}. Please use a different code.`, field: "code" },
        { status: 409 },
      );
    }

    const site = await prisma.site.create({
      data: {
        code,
        name: siteName || code,
        region: typeof body.region === "string" && body.region.trim() ? body.region.trim() : regionForSiteCode(code),
        city: typeof body.city === "string" ? body.city.trim() || null : null,
        siteType: typeof body.siteType === "string" ? body.siteType.trim() || null : null,
        label: typeof body.siteHierarchy === "string" ? body.siteHierarchy.trim() || null : typeof body.label === "string" ? body.label.trim() || null : null,
        siteStructure: typeof body.siteStructure === "string" ? body.siteStructure.trim() || null : null,
        colocationType: typeof body.colocationType === "string" ? body.colocationType.trim() || null : null,
        colocationOwner: typeof body.colocationOwner === "string" ? body.colocationOwner.trim() || null : null,
        coordinateX: body.coordinateX === "" || body.coordinateX === null || body.coordinateX === undefined ? null : Number(body.coordinateX),
        coordinateY: body.coordinateY === "" || body.coordinateY === null || body.coordinateY === undefined ? null : Number(body.coordinateY),
        isFiberNode: false,
        status: SITE_STATUSES.has(body.status) ? body.status : "ACTIVE",
        isCoreSite: false,
        coreSiteType: null,
        remarks: typeof body.remarks === "string" ? body.remarks.trim() || null : null,
        aliases: {
          create: {
            alias: code,
            aliasNormalized: aliasKey,
            isPrimary: true,
            source: "MANUAL",
          },
        },
      },
    });
    await replaceSiteCriticality(site.id, body.siteCriticality ?? body.label);

    return NextResponse.json({ site }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = Array.isArray(error.meta?.target) ? error.meta?.target.join(", ") : String(error.meta?.target ?? "code");
      return NextResponse.json(
        { error: `A site or alias with this ${target} already exists. Please edit the existing record instead of creating a duplicate.`, field: "code" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Site creation failed." },
      { status: 400 },
    );
  }
}
