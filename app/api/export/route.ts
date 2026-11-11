import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { exportDataService } from "@/server/services/export-data.service";
import { buildStyledTraceWorkbook } from "@/lib/export/styled-trace-workbook";
import { writeAuditLog } from "@/lib/audit/audit-log";

/** Split a red-sites query token list (comma/semicolon separated) into codes. */
function parseRedSites(value: string | null): string[] {
  if (!value) return [];
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

// Excel hard limit: a single worksheet cell cannot hold more than 32,767
// characters. The xlsx writer throws "Text length must not exceed 32767
// characters" the moment any cell exceeds it — which happened on the Activity
// Log export because audit rows can carry very large serialized old/new value
// JSON blobs in a single column. We defensively clamp every string cell below
// the ceiling and, for the log ledger, prefer a row-delimited CSV stream that
// has no per-cell cap at all.
const EXCEL_CELL_LIMIT = 32767;
// Leave headroom for the truncation marker so the final string still fits.
const SAFE_CELL_LIMIT = EXCEL_CELL_LIMIT - 64;

function clampCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= EXCEL_CELL_LIMIT) return value;
  const removed = value.length - SAFE_CELL_LIMIT;
  return `${value.slice(0, SAFE_CELL_LIMIT)}…[truncated ${removed.toLocaleString()} chars]`;
}

/** Clamp every cell in every row so no value can overflow the Excel cell cap. */
function sanitizeRowsForXlsx(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) safe[key] = clampCell(value);
    return safe;
  });
}

function workbookResponse(rows: Record<string, unknown>[], sheetName: string, fileName: string) {
  const safeRows = sanitizeRowsForXlsx(rows.length ? rows : [{ message: "No rows found" }]);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(safeRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

/**
 * Fault-highlighted workbook: same rows, but every row whose site matches one
 * tagged RED on the live canvas gets a bold soft-red cell fill (exceljs). Used
 * for trace exports and when the caller passes redSites, so non-trace plain
 * exports remain untouched.
 */
async function styledWorkbookResponse(
  rows: Record<string, unknown>[],
  sheetName: string,
  fileName: string,
  redSites: string[],
) {
  const buffer = await buildStyledTraceWorkbook({ rows, sheetName, redSites });
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

/** RFC 4180 cell escaping — quote when the value holds a comma, quote, or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Streaming CSV download. Headers are the union of every row's keys (stable
 * column set even when later rows carry extra fields). The body is emitted one
 * log entry per line through a ReadableStream so the response is written down
 * incrementally and never materialised as one oversized string/buffer — CSV has
 * no per-cell length ceiling, so large diagnostic payloads survive intact.
 */
function csvStreamResponse(rows: Record<string, unknown>[], fileName: string) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // UTF-8 BOM so Excel opens accented/Unicode content correctly.
      controller.enqueue(encoder.encode("﻿"));
      controller.enqueue(encoder.encode(`${headers.map(csvCell).join(",")}\r\n`));
      for (const row of rows) {
        const line = headers.map((header) => csvCell(row[header])).join(",");
        controller.enqueue(encoder.encode(`${line}\r\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/\.xlsx$/i, ".csv")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "exportData")) {
      return NextResponse.json({ error: "A valid portal session is required to export data." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "inventory";
    const format = searchParams.get("format") ?? "json";
    const siteCode = searchParams.get("site") ?? undefined;
    const serviceCode = searchParams.get("service") ?? undefined;
    const batchId = searchParams.get("batchId") ?? undefined;
    // Sites tagged RED on the live canvas — mirror their fault state into the
    // spreadsheet with a soft-red row fill.
    const redSites = parseRedSites(searchParams.get("redSites"));
    const { rows, sheetName, fileName } = await exportDataService.buildRows({
      type,
      siteCode,
      serviceCode,
      batchId,
      search: searchParams.get("search"),
      connectedSite: searchParams.get("connectedSite"),
      serviceId: searchParams.get("serviceId"),
      rackId: searchParams.get("rackId"),
      odfId: searchParams.get("odfId"),
      portPair: searchParams.get("portPair"),
      fiberPortNumber: searchParams.get("fiberPortNumber"),
      cableId: searchParams.get("cableId"),
      tubeNumber: searchParams.get("tubeNumber"),
      tubeColor: searchParams.get("tubeColor"),
      fiberNumber: searchParams.get("fiberNumber"),
      transportTrail: searchParams.get("transportTrail"),
      status: searchParams.get("status"),
      siteType: searchParams.get("siteType"),
      regionPrefix: searchParams.get("regionPrefix"),
      dateFrom: searchParams.get("dateFrom"),
      dateTo: searchParams.get("dateTo"),
      tag: searchParams.get("tag"),
    });

    await writeAuditLog({
      entityType: "Export",
      entityId: type,
      action: "EXPORT",
      newValue: { type, format, rowCount: rows.length, fileName, site: siteCode ?? null, service: serviceCode ?? null, batchId: batchId ?? null, redSites: redSites.length },
      changedById: session?.id ?? null,
      reason: `Exported ${type} as ${format}`,
    });

    if (format === "csv") {
      return csvStreamResponse(rows.length ? rows : [{ message: "No rows found" }], fileName);
    }

    if (format === "xlsx") {
      const traceWorkbookNeedsStyles = type === "trace" || type === "trace-path";
      return redSites.length || traceWorkbookNeedsStyles
        ? await styledWorkbookResponse(rows, sheetName, fileName, redSites)
        : workbookResponse(rows, sheetName, fileName);
    }

    return NextResponse.json({ rows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 400 },
    );
  }
}
