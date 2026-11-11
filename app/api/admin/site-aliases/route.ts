import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { prisma } from "@/lib/db/prisma";

/**
 * Bulk administration: delete the selected alias rules in one call, or flush
 * the entire list. ADMIN tier only; every removal is audit-logged.
 */
export async function DELETE(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to delete site aliases." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { aliasIds?: unknown; flushAll?: unknown };
    const flushAll = body.flushAll === true;
    const aliasIds = Array.isArray(body.aliasIds) ? body.aliasIds.map(String).filter(Boolean) : [];
    if (!flushAll && !aliasIds.length) {
      return NextResponse.json({ error: "Select at least one alias rule, or request a full list flush." }, { status: 400 });
    }

    const where = flushAll ? {} : { id: { in: aliasIds } };
    const preview = await prisma.siteAlias.findMany({
      where,
      select: { id: true, alias: true, site: { select: { code: true } } },
      take: 100,
    });
    const result = await prisma.siteAlias.deleteMany({ where });

    await writeAuditLog({
      entityType: "SiteAlias",
      entityId: flushAll ? "FLUSH_ALL" : `BULK:${aliasIds.length}`,
      action: "DELETE",
      oldValue: {
        deletedCount: result.count,
        flushAll,
        sample: preview.map((row) => `${row.site.code}:${row.alias}`),
      },
      changedById: session?.id ?? null,
      reason: flushAll ? "Admin flushed the entire site-alias rule list." : "Admin bulk-deleted selected site-alias rules.",
    });

    return NextResponse.json({ deletedCount: result.count, flushAll });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bulk alias delete failed." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required to view site aliases." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search")?.trim();
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(500, Math.max(25, Number(searchParams.get("pageSize") ?? 100) || 100));
  const where = search
    ? {
        OR: [
          { alias: { contains: search } },
          { aliasNormalized: { contains: search.toUpperCase() } },
          { site: { code: { contains: search.toUpperCase() } } },
        ],
      }
    : undefined;

  const [rows, total] = await Promise.all([
    prisma.siteAlias.findMany({
      where,
      include: { site: { select: { code: true, name: true } } },
      orderBy: [{ site: { code: "asc" } }, { alias: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.siteAlias.count({ where }),
  ]);

  return NextResponse.json({
    rows: rows.map((row) => ({
      id: row.id,
      siteCode: row.site.code,
      siteName: row.site.name,
      alias: row.alias,
      aliasNormalized: row.aliasNormalized,
      isPrimary: row.isPrimary,
      source: row.source,
    })),
    total,
    page,
    pageSize,
  });
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to manage site aliases." }, { status: 403 });
    }

    const body = (await request.json()) as { siteCode?: string; alias?: string };
    const siteCode = normalizeAlias(body.siteCode);
    const alias = body.alias?.trim();
    const aliasNormalized = normalizeAlias(alias);

    if (!siteCode || !alias || !aliasNormalized) {
      return NextResponse.json({ error: "Site code and alias are required." }, { status: 400 });
    }

    const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true, code: true } });
    if (!site) {
      return NextResponse.json({ error: `Site ${siteCode} not found.` }, { status: 404 });
    }

    const created = await prisma.siteAlias.upsert({
      where: { aliasNormalized },
      update: { siteId: site.id, alias, source: "MANUAL" },
      create: { siteId: site.id, alias, aliasNormalized, source: "MANUAL" },
      include: { site: { select: { code: true } } },
    });

    return NextResponse.json({ alias: { id: created.id, siteCode: created.site.code, alias: created.alias, aliasNormalized: created.aliasNormalized } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Alias update failed." },
      { status: 500 },
    );
  }
}
