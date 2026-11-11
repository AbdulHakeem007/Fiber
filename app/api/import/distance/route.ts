import { NextResponse } from "next/server";
import { read, utils } from "xlsx";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { prisma } from "@/lib/db/prisma";
import { buildSitePairKey } from "@/lib/telecom/site-pair";

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function guessColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map((header) => ({ header, key: header.toLowerCase().replace(/[^a-z0-9]/g, "") }));
  for (const candidate of candidates) {
    const key = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = normalized.find((item) => item.key === key || item.key.includes(key));
    if (match) return match.header;
  }
  return null;
}

function parseDistance(value: unknown): number | null {
  const number = Number(String(value ?? "").replace(/km/gi, "").replace(/,/g, "").trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to import segment distances." }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Missing distance file." }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = read(buffer, { type: "buffer", cellDates: false, raw: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return NextResponse.json({ error: "Distance file has no readable worksheet." }, { status: 400 });

    const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    if (!rows.length) return NextResponse.json({ error: "Distance file contains no data rows." }, { status: 400 });
    const headers = Object.keys(rows[0] ?? {});
    const nearColumn = clean(formData.get("nearColumn")) ?? guessColumn(headers, ["near site", "site a", "from", "a end", "local site"]);
    const farColumn = clean(formData.get("farColumn")) ?? guessColumn(headers, ["far site", "site b", "to", "b end", "connected site"]);
    const distanceColumn = clean(formData.get("distanceColumn")) ?? guessColumn(headers, ["distance km", "distance", "length km", "fiber length"]);
    const remarksColumn = clean(formData.get("remarksColumn")) ?? guessColumn(headers, ["remarks", "route", "cable"]);
    const overwrite = String(formData.get("overwrite") ?? "").toLowerCase() === "true";

    if (!nearColumn || !farColumn || !distanceColumn) {
      return NextResponse.json({ error: "Map near site, far site, and distance km columns before importing." }, { status: 400 });
    }

    let matchedRows = 0;
    let updatedSegments = 0;
    const unmatchedRows: Array<Record<string, unknown>> = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const nearSite = normalizeAlias(clean(row[nearColumn]));
      const farSite = normalizeAlias(clean(row[farColumn]));
      const distanceKm = parseDistance(row[distanceColumn]);
      if (!nearSite || !farSite || distanceKm === null) {
        unmatchedRows.push({ rowNumber: index + 2, nearSite: row[nearColumn], farSite: row[farColumn], distanceKm: row[distanceColumn], reason: "Missing site or distance value" });
        continue;
      }

      const sitePairKey = buildSitePairKey(nearSite, farSite);
      const where = {
        sitePairKey,
        status: { not: "DECOMMISSIONED" as const },
        ...(overwrite ? {} : { distanceKm: null }),
      };
      const result = await prisma.linkSegment.updateMany({
        where,
        data: {
          distanceKm,
          comments: remarksColumn && clean(row[remarksColumn])
            ? `Distance import: ${clean(row[remarksColumn])}`
            : undefined,
        },
      });
      if (result.count === 0) {
        unmatchedRows.push({ rowNumber: index + 2, nearSite, farSite, distanceKm, reason: overwrite ? "No active matching segment" : "No active matching segment without existing distance" });
        continue;
      }
      matchedRows += 1;
      updatedSegments += result.count;
    }

    await writeAuditLog({
      entityType: "DistanceImport",
      entityId: file.name,
      action: "IMPORT",
      newValue: { fileName: file.name, matchedRows, updatedSegments, unmatchedRows: unmatchedRows.length, overwrite },
      changedById: session?.id ?? null,
      reason: "Segment-level distance import",
    });

    return NextResponse.json({
      fileName: file.name,
      totalRows: rows.length,
      matchedRows,
      updatedSegments,
      unmatchedRowCount: unmatchedRows.length,
      // Preview only — the full count above keeps large imports from
      // silently hiding unmatched rows.
      unmatchedRows: unmatchedRows.slice(0, 100),
      columns: { nearColumn, farColumn, distanceColumn, remarksColumn },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Distance import failed." }, { status: 500 });
  }
}
