import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { REGION_OPTIONS, regionForSiteCode } from "@/lib/config/regions";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { replaceSiteCriticality } from "@/server/services/site-criticality.service";

const SITE_STATUSES = new Set(["ACTIVE", "PLANNED", "INACTIVE", "DECOMMISSIONED"]);

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function pick(row: Record<string, unknown>, names: string[]): string | null {
  const entries = Object.entries(row);
  for (const name of names) {
    const match = entries.find(([key]) => key.trim().toLowerCase() === name.trim().toLowerCase());
    const value = clean(match?.[1]);
    if (value) return value;
  }
  return null;
}

function normalizeRegion(value: string | null, code: string): string | null {
  if (!value) return regionForSiteCode(code);
  const match = REGION_OPTIONS.find((option) => {
    const text = value.toUpperCase();
    return text === option.value || text === option.regionName.toUpperCase() || text === option.label.toUpperCase();
  });
  return match?.regionName ?? value;
}

function optionalNumber(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write access is required to import master sites." }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload a master site Excel or CSV file." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const sheets: Array<{ sheetName: string; rows: number; created: number; updated: number; skipped: number }> = [];

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null, raw: false });
      let sheetCreated = 0;
      let sheetUpdated = 0;
      let sheetSkipped = 0;

      for (const row of rows) {
        const code = pick(row, ["Site ID", "siteId", "site id", "siteCode", "site code", "code", "site"])?.toUpperCase();
        if (!code) {
          skipped += 1;
          sheetSkipped += 1;
          continue;
        }

        const status = pick(row, ["status"])?.toUpperCase() ?? "ACTIVE";
        const regionInput = pick(row, ["region", "area", "governorate"]);
        const siteLabel = pick(row, ["Site Hierarchy", "site hierarchy", "Hierarchy", "Label", "site label"]);
        const siteCriticality = pick(row, ["Site Criticality", "criticality", "site criticality", "Label", "site label", "role", "core type"]);
        const siteStructure = pick(row, ["Site Structure", "siteStructure", "structure"]);
        const colocationType = pick(row, ["Colocation Type", "colocationType", "colocation type"]);
        const colocationOwner = pick(row, ["Colocation Owner", "colocationOwner", "colocation owner"]);
        const coordinateX = optionalNumber(pick(row, ["Coordinates X", "Coordinate X", "coord x", "x", "latitude", "lat"]));
        const coordinateY = optionalNumber(pick(row, ["Coordinates Y", "Coordinate Y", "Coordinate", "coord y", "y", "longitude", "long", "lon", "lng"]));
        const existing = await prisma.site.findUnique({ where: { code }, select: { id: true } });
        const site = await prisma.site.upsert({
          where: { code },
          update: {
            name: pick(row, ["name", "siteName", "site name"]),
            region: normalizeRegion(regionInput, code),
            city: pick(row, ["city", "wilayat", "location"]),
            siteType: pick(row, ["Site Type", "siteType", "site type", "type"]),
            label: siteLabel,
            siteStructure,
            colocationType,
            colocationOwner,
            coordinateX,
            coordinateY,
            status: SITE_STATUSES.has(status) ? (status as any) : "ACTIVE",
            remarks: pick(row, ["remarks", "comment", "comments"]),
          },
          create: {
            code,
            name: pick(row, ["name", "siteName", "site name"]),
            region: normalizeRegion(regionInput, code),
            city: pick(row, ["city", "wilayat", "location"]),
            siteType: pick(row, ["Site Type", "siteType", "site type", "type"]),
            label: siteLabel,
            siteStructure,
            colocationType,
            colocationOwner,
            coordinateX,
            coordinateY,
            isCoreSite: false,
            coreSiteType: null,
            isFiberNode: false,
            status: SITE_STATUSES.has(status) ? (status as any) : "ACTIVE",
            remarks: pick(row, ["remarks", "comment", "comments"]),
          },
          select: { id: true },
        });

        await prisma.siteAlias.upsert({
          where: { aliasNormalized: code },
          update: { siteId: site.id, alias: code, isPrimary: true, source: "IMPORT" },
          create: { siteId: site.id, alias: code, aliasNormalized: code, isPrimary: true, source: "IMPORT" },
        });
        await replaceSiteCriticality(site.id, siteCriticality);

        if (existing) {
          updated += 1;
          sheetUpdated += 1;
        } else {
          created += 1;
          sheetCreated += 1;
        }
      }

      sheets.push({ sheetName, rows: rows.length, created: sheetCreated, updated: sheetUpdated, skipped: sheetSkipped });
    }

    await writeAuditLog({
      entityType: "Site",
      entityId: "MASTER_IMPORT",
      action: "IMPORT",
      newValue: { fileName: file.name, created, updated, skipped, sheets },
      changedById: session?.id ?? null,
      reason: "Site master import",
    });

    return NextResponse.json({ created, updated, skipped, sheets });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Master site import failed." },
      { status: 500 },
    );
  }
}
