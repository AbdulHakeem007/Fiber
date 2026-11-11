import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { assertIndividualDeleteAllowed, DeletePolicyError } from "@/lib/auth/delete-policy";
import { destructiveDeleteService } from "@/server/services/destructive-delete.service";
import { prisma } from "@/lib/db/prisma";
import { replaceSiteCriticality } from "@/server/services/site-criticality.service";
import { siteCodeService } from "@/server/services/site-code.service";
import { setSiteFlag, getSiteFlags } from "@/lib/telecom/site-flags-db";

const SITE_STATUSES = new Set(["ACTIVE", "PLANNED", "INACTIVE", "DECOMMISSIONED"]);

export async function PATCH(request: Request, { params }: { params: Promise<{ siteCode: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to update sites." }, { status: 403 });
    }

    const { siteCode } = await params;
    const body = await request.json();
    const currentCode = siteCode.toUpperCase();

    // Legacy site code is editable: rename in place, or MERGE into an existing
    // site when the new code is already taken ("unify accordingly"). Handled
    // first so the remaining field edits below land on the surviving site.
    let codeChange: Awaited<ReturnType<typeof siteCodeService.changeSiteCode>> | null = null;
    let effectiveCode = currentCode;
    if (typeof body.code === "string" && body.code.trim()) {
      codeChange = await siteCodeService.changeSiteCode(currentCode, body.code, session?.id);
      effectiveCode = codeChange.code;
    }

    const site = await prisma.site.update({
      where: { code: effectiveCode },
      data: {
        name: typeof body.name === "string" ? body.name : undefined,
        region: typeof body.region === "string" ? body.region : undefined,
        city: typeof body.city === "string" ? body.city : undefined,
        siteType: typeof body.siteType === "string" ? body.siteType : undefined,
        label: typeof body.siteHierarchy === "string" ? body.siteHierarchy || null : typeof body.label === "string" ? body.label || null : undefined,
        siteStructure: typeof body.siteStructure === "string" ? body.siteStructure || null : undefined,
        colocationType: typeof body.colocationType === "string" ? body.colocationType || null : undefined,
        colocationOwner: typeof body.colocationOwner === "string" ? body.colocationOwner || null : undefined,
        coordinateX: body.coordinateX === "" || body.coordinateX === null ? null : body.coordinateX === undefined ? undefined : Number(body.coordinateX),
        coordinateY: body.coordinateY === "" || body.coordinateY === null ? null : body.coordinateY === undefined ? undefined : Number(body.coordinateY),
        isFiberNode: undefined,
        isCoreSite: undefined,
        coreSiteType: undefined,
        status: SITE_STATUSES.has(body.status) ? body.status : undefined,
        remarks: typeof body.remarks === "string" ? body.remarks : undefined,
      },
    });
    if (body.siteCriticality !== undefined || body.label !== undefined) {
      await replaceSiteCriticality(site.id, body.siteCriticality ?? body.label);
    }

    // Operator-nominated critical / explicit Datacenter (DC) tags drive the
    // dashboard "Central Exchange Operational Grid". Stored on runtime-managed
    // columns (lib/telecom/site-flags-db) so the live DB is never migrate-reset.
    if (typeof body.isCriticalSite === "boolean") {
      await setSiteFlag(prisma, site.code, "isCriticalSite", body.isCriticalSite);
    }
    if (typeof body.isDatacenter === "boolean") {
      await setSiteFlag(prisma, site.code, "isDatacenter", body.isDatacenter);
    }
    const flags = (await getSiteFlags(prisma, [site.code])).get(site.code) ?? { isCriticalSite: false, isDatacenter: false };

    return NextResponse.json({ site: { ...site, ...flags }, codeChange });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Site update failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ siteCode: string }> }) {
  try {
    const session = await getSessionUser();
    const { siteCode } = await params;

    // RBAC: ADMIN may delete any site directly; READ_WRITE may delete an
    // individual site only once it is Decommissioned. Bulk/flush stays elsewhere.
    const site = await prisma.site.findUnique({ where: { code: siteCode.toUpperCase() }, select: { status: true } });
    if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });
    assertIndividualDeleteAllowed(session?.roleCode, site.status, "site");

    const result = await destructiveDeleteService.deleteSite(siteCode, session?.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeletePolicyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Site delete failed.";
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("This site cannot be deleted") ? 409 : 500 },
    );
  }
}
