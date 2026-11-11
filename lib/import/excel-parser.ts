import * as XLSX from "xlsx";
import { normalizeAlias, resolveAlias } from "@/lib/import/alias-normalizer";

export interface LegacyTemplateParsedRow {
  sourceSheet: string;
  sourceTitle: string | null;
  sourceSiteRaw: string;
  sourceSiteCanonical: string | null;
  rackCode: string | null;
  odfCode: string;
  portGroupLabel: string | null;
  directionText: string | null;
  farSiteRaw: string | null;
  farSiteCanonical: string | null;
  definitionText: string | null;
  statusHint: "ACTIVE" | "DUMMY" | "PLANNED" | "UNKNOWN";
  blockIndex: number;
  ordinalInBand: number;
  sourceRowNumber: number;
  sourceColumnNumber: number;
  rawRecord: Record<string, unknown>;
}

export interface LegacyTemplateParseSummary {
  workbookName?: string;
  totalSheets: number;
  parsedRows: number;
  unknownFarSites: number;
  dummyRows: number;
  malformedPortRows: number;
  sheetStats: Array<{
    sheetName: string;
    parsedRows: number;
    rackCodes: string[];
    odfCodes: string[];
  }>;
}

export interface LegacyTemplateParseResult {
  rows: LegacyTemplateParsedRow[];
  summary: LegacyTemplateParseSummary;
}

interface ParseOptions {
  workbookName?: string;
  aliasLookup?: Record<string, string>;
}

type CellValue = string | number | boolean | null | undefined;

type SheetMatrix = CellValue[][];

const ODF_POSITION_REGEX = /^ODF\s+(.+?)\s+Position$/i;
const PORT_REGEX = /^\d+\s*(?:-\s*\d+)?$/;

function cellToText(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r?\n/g, " ").trim();
  return text || null;
}

function normalizePortLabel(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  if (!PORT_REGEX.test(compact)) return value.trim();
  return compact;
}

function isTitleRow(value: string | null): boolean {
  return Boolean(value && /site\s+ODF\s+distribution/i.test(value));
}

function isOdfHeaderRow(value: string | null): boolean {
  return Boolean(value && ODF_POSITION_REGEX.test(value));
}

function isContinuationRow(row: CellValue[], activeOdfCode: string | null): boolean {
  if (!activeOdfCode) return false;
  const first = cellToText(row[0]);
  const second = normalizePortLabel(cellToText(row[1]));
  return !first && Boolean(second && PORT_REGEX.test(second));
}

function extractRackCode(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/Rack\s*#:\s*([^)]+)\)/i);
  return match?.[1]?.trim() || null;
}

function extractSourceSiteFromTitle(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(.*?)\s+site\s+ODF\s+distribution/i);
  return match?.[1]?.trim() || null;
}

function extractFarSite(directionText: string | null): string | null {
  if (!directionText) return null;
  const cleaned = directionText.replace(/^Direction$/i, "").trim();
  if (!cleaned) return null;

  const toMatch = cleaned.match(/^To\s+(.+)$/i);
  if (toMatch?.[1]) return toMatch[1].trim();
  return cleaned;
}

function inferStatus(directionText: string | null, definitionText: string | null): "ACTIVE" | "DUMMY" | "PLANNED" | "UNKNOWN" {
  const combined = `${directionText || ""} ${definitionText || ""}`.toUpperCase();
  if (!combined.trim()) return "UNKNOWN";
  if (combined.includes("DUMMY")) return "DUMMY";
  if (combined.includes("PLAN")) return "PLANNED";
  return "ACTIVE";
}

function canonicalOrFallback(rawSite: string | null, aliasLookup: Record<string, string>): string | null {
  return resolveAlias(rawSite, aliasLookup) ?? normalizeAlias(rawSite);
}

function readSheetMatrix(workbook: XLSX.WorkBook, sheetName: string): SheetMatrix {
  const worksheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<CellValue[]>(worksheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  });
}

function parseSheet(
  sheetName: string,
  rows: SheetMatrix,
  aliasLookup: Record<string, string>,
): { rows: LegacyTemplateParsedRow[]; rackCodes: string[]; odfCodes: string[]; malformedPortRows: number } {
  const parsedRows: LegacyTemplateParsedRow[] = [];
  const rackCodes = new Set<string>();
  const odfCodes = new Set<string>();

  let activeTitle: string | null = null;
  let activeRackCode: string | null = null;
  let activeSourceSiteRaw = sheetName;
  let activeOdfCode: string | null = null;
  let blockIndex = 0;
  let malformedPortRows = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const firstCell = cellToText(row[0]);

    if (isTitleRow(firstCell)) {
      activeTitle = firstCell;
      activeRackCode = extractRackCode(firstCell);
      activeSourceSiteRaw = extractSourceSiteFromTitle(firstCell) ?? sheetName;
      if (activeRackCode) rackCodes.add(activeRackCode);
      continue;
    }

    if (isOdfHeaderRow(firstCell)) {
      const match = firstCell?.match(ODF_POSITION_REGEX);
      activeOdfCode = match?.[1]?.trim() || null;
      if (activeOdfCode) odfCodes.add(activeOdfCode);
      blockIndex += 1;
    } else if (!isContinuationRow(row, activeOdfCode)) {
      continue;
    }

    if (!activeOdfCode) continue;

    const positionRow = row;
    const directionRow = rows[rowIndex + 1] ?? [];
    const definitionRow = rows[rowIndex + 2] ?? [];
    const maxColumns = Math.max(positionRow.length, directionRow.length, definitionRow.length);

    for (let columnIndex = 1; columnIndex < maxColumns; columnIndex += 1) {
      const portGroupLabel = normalizePortLabel(cellToText(positionRow[columnIndex]));
      const directionText = cellToText(directionRow[columnIndex]);
      const definitionText = cellToText(definitionRow[columnIndex]);

      if (!portGroupLabel && !directionText && !definitionText) continue;
      if (portGroupLabel && !PORT_REGEX.test(portGroupLabel.replace(/\s+/g, ""))) {
        malformedPortRows += 1;
      }

      const farSiteRaw = extractFarSite(directionText);
      const statusHint = inferStatus(directionText, definitionText);
      const sourceSiteCanonical = canonicalOrFallback(activeSourceSiteRaw, aliasLookup);
      const farSiteCanonical = statusHint === "DUMMY" ? null : canonicalOrFallback(farSiteRaw, aliasLookup);

      parsedRows.push({
        sourceSheet: sheetName,
        sourceTitle: activeTitle,
        sourceSiteRaw: activeSourceSiteRaw,
        sourceSiteCanonical,
        rackCode: activeRackCode,
        odfCode: activeOdfCode,
        portGroupLabel,
        directionText,
        farSiteRaw,
        farSiteCanonical,
        definitionText,
        statusHint,
        blockIndex,
        ordinalInBand: columnIndex,
        sourceRowNumber: rowIndex + 1,
        sourceColumnNumber: columnIndex + 1,
        rawRecord: {
          sheetName,
          titleRow: activeTitle,
          rackCode: activeRackCode,
          odfCode: activeOdfCode,
          portGroupLabel,
          directionText,
          farSiteRaw,
          definitionText,
          sourceRowNumber: rowIndex + 1,
          sourceColumnNumber: columnIndex + 1,
        },
      });
    }

    rowIndex += 2;
  }

  return {
    rows: parsedRows,
    rackCodes: [...rackCodes],
    odfCodes: [...odfCodes],
    malformedPortRows,
  };
}

export function parseLegacyFiberWorkbookFromBuffer(buffer: Buffer, options: ParseOptions = {}): LegacyTemplateParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const aliasLookup = options.aliasLookup ?? {};

  const allRows: LegacyTemplateParsedRow[] = [];
  const sheetStats: LegacyTemplateParseSummary["sheetStats"] = [];
  let malformedPortRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const rows = readSheetMatrix(workbook, sheetName);
    const parsed = parseSheet(sheetName, rows, aliasLookup);
    allRows.push(...parsed.rows);
    malformedPortRows += parsed.malformedPortRows;

    sheetStats.push({
      sheetName,
      parsedRows: parsed.rows.length,
      rackCodes: parsed.rackCodes,
      odfCodes: parsed.odfCodes,
    });
  }

  const unknownFarSites = allRows.filter((row) => row.farSiteRaw && !row.farSiteCanonical && row.statusHint !== "DUMMY").length;
  const dummyRows = allRows.filter((row) => row.statusHint === "DUMMY").length;

  return {
    rows: allRows,
    summary: {
      workbookName: options.workbookName,
      totalSheets: workbook.SheetNames.length,
      parsedRows: allRows.length,
      unknownFarSites,
      dummyRows,
      malformedPortRows,
      sheetStats,
    },
  };
}

export async function parseLegacyFiberWorkbookFromFile(filePath: string, options: ParseOptions = {}): Promise<LegacyTemplateParseResult> {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  return parseLegacyFiberWorkbookFromBuffer(buffer, {
    ...options,
    workbookName: options.workbookName ?? filePath.split(/[\\/]/).pop(),
  });
}
