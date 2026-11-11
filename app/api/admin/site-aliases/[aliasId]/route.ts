import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { prisma } from "@/lib/db/prisma";

/**
 * Full Admin alias-record rights: edit and delete named endpoint overrides
 * without middleware exceptions. ADMIN tier only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ aliasId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to edit site aliases." }, { status: 403 });
    }

    const { aliasId } = await params;
    const body = (await request.json()) as { alias?: string; siteCode?: string; isPrimary?: boolean };
    const existing = await prisma.siteAlias.findUnique({ where: { id: aliasId }, include: { site: { select: { id: true, code: true } } } });
    if (!existing) return NextResponse.json({ error: "Alias record not found." }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (typeof body.alias === "string" && body.alias.trim()) {
      const alias = body.alias.trim();
      const aliasNormalized = normalizeAlias(alias);
      if (!aliasNormalized) return NextResponse.json({ error: "Alias could not be normalized." }, { status: 400 });
      const conflict = await prisma.siteAlias.findUnique({ where: { aliasNormalized }, select: { id: true } });
      if (conflict && conflict.id !== aliasId) {
        return NextResponse.json({ error: "Another alias record already uses this normalized value." }, { status: 409 });
      }
      data.alias = alias;
      data.aliasNormalized = aliasNormalized;
    }
    if (typeof body.siteCode === "string" && body.siteCode.trim()) {
      const siteCode = normalizeAlias(body.siteCode);
      const site = siteCode ? await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } }) : null;
      if (!site) return NextResponse.json({ error: `Site ${body.siteCode} not found.` }, { status: 404 });
      data.siteId = site.id;
    }
    if (typeof body.isPrimary === "boolean") data.isPrimary = body.isPrimary;
    if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

    const updated = await prisma.siteAlias.update({
      where: { id: aliasId },
      data,
      include: { site: { select: { code: true } } },
    });
    await writeAuditLog({
      entityType: "SiteAlias",
      entityId: aliasId,
      action: "UPDATE",
      oldValue: { alias: existing.alias, siteCode: existing.site.code },
      newValue: { alias: updated.alias, siteCode: updated.site.code, isPrimary: updated.isPrimary },
      changedById: session?.id ?? null,
      reason: "Admin alias record update",
    });

    return NextResponse.json({
      alias: {
        id: updated.id,
        siteCode: updated.site.code,
        alias: updated.alias,
        aliasNormalized: updated.aliasNormalized,
        isPrimary: updated.isPrimary,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Alias update failed." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ aliasId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to delete site aliases." }, { status: 403 });
    }

    const { aliasId } = await params;
    const existing = await prisma.siteAlias.findUnique({ where: { id: aliasId }, include: { site: { select: { code: true } } } });
    if (!existing) return NextResponse.json({ error: "Alias record not found." }, { status: 404 });

    await prisma.siteAlias.delete({ where: { id: aliasId } });
    await writeAuditLog({
      entityType: "SiteAlias",
      entityId: aliasId,
      action: "DELETE",
      oldValue: { alias: existing.alias, siteCode: existing.site.code },
      changedById: session?.id ?? null,
      reason: "Admin alias record deletion",
    });

    return NextResponse.json({ deletedId: aliasId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Alias delete failed." }, { status: 500 });
  }
}
