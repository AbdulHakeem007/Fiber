import ExcelJS from "exceljs";

// ─────────────────────────────────────────────────────────────────────────────
// STYLED TRACE WORKBOOK — Excel export with canvas fault-state synchronization.
//
// The live A-MPLS / service-trace canvas lets an operator tag a node, service or
// site RED (double-click → "Ready for Integration" / fault highlight). This
// builder mirrors that state into the exported spreadsheet: every row whose site
// identifier matches a red-tagged site gets a bold, soft-red cell fill so the
// workbook reads the same as the canvas at a glance.
//
// It is a drop-in alternative to the plain SheetJS (`xlsx`) `json_to_sheet`
// writer used for un-highlighted exports — that community build cannot emit cell
// fills, whereas `exceljs` (already a project dependency) can. The plain writer
// is kept for non-trace exports; trace exports use this writer so jumper and
// ready-for-integration site styling survives in downloaded workbooks.
// ─────────────────────────────────────────────────────────────────────────────

/** Bold soft-red fault fill + dark-red bold text applied to matched site rows. */
const FAULT_FILL_ARGB = "FFF9D2D2"; // soft red background
const FAULT_FONT_ARGB = "FF991B1B"; // dark red, bold
const FAULT_BORDER_ARGB = "FFDC2626"; // red-600 hairline
const JUMPER_FONT_ARGB = "FFDC2626"; // red-600 italic text for "(Jumper)" cells

// Excel single-cell hard ceiling; oversized strings are clamped like the plain
// writer so a large serialized value can never abort the whole workbook.
const EXCEL_CELL_LIMIT = 32767;
const SAFE_CELL_LIMIT = EXCEL_CELL_LIMIT - 64;

/** Column keys that hold a site identifier, checked against the red-site set. */
const DEFAULT_SITE_COLUMNS = [
  "Near Site ID",
  "Far Site ID",
  "Site ID",
  "siteCode",
  "searchedSite",
  "connectedSite",
] as const;

/** Normalize a site label for comparison — drops the "(Jumper)" marker + case. */
export function normalizeSiteToken(value: unknown): string {
  return String(value ?? "")
    .replace(/\(\s*jumper\s*\)/gi, "")
    .trim()
    .toUpperCase();
}

function hasJumperMarker(value: unknown): boolean {
  return /\(\s*jumper\s*\)/i.test(String(value ?? ""));
}

function clampCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= EXCEL_CELL_LIMIT) return value;
  const removed = value.length - SAFE_CELL_LIMIT;
  return `${value.slice(0, SAFE_CELL_LIMIT)}…[truncated ${removed.toLocaleString()} chars]`;
}

export interface StyledWorkbookOptions {
  rows: Record<string, unknown>[];
  sheetName: string;
  /** Site codes highlighted RED on the live canvas (any form; normalized here). */
  redSites: Iterable<string>;
  /** Row keys that carry a site identifier. Defaults to the trace/inventory set. */
  siteColumns?: readonly string[];
}

/**
 * Build an .xlsx buffer whose rows matching a red-tagged canvas site are filled
 * with the soft-red fault highlight. Header order is the stable union of every
 * row's keys (matching SheetJS behaviour), so mixed rows — data rows, blank
 * separator rows, and section-heading rows — all line up.
 */
export async function buildStyledTraceWorkbook(options: StyledWorkbookOptions): Promise<Buffer> {
  const { rows, sheetName } = options;
  const siteColumns = options.siteColumns ?? DEFAULT_SITE_COLUMNS;
  const redSet = new Set(
    Array.from(options.redSites, (site) => normalizeSiteToken(site)).filter(Boolean),
  );

  const safeRows = (rows.length ? rows : [{ message: "No rows found" }]).map((row) => {
    const clamped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) clamped[key] = clampCell(value);
    return clamped;
  });

  const headers = [...new Set(safeRows.flatMap((row) => Object.keys(row)))];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName.slice(0, 31) || "Sheet1");
  worksheet.columns = headers.map((header) => ({ header, key: header }));

  // Header styling — neutral, bold, so the fault rows stand out against it.
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  });

  const rowMatchesRed = (row: Record<string, unknown>): boolean => {
    if (!redSet.size) return false;
    return siteColumns.some((column) => {
      const token = normalizeSiteToken(row[column]);
      return token.length > 0 && redSet.has(token);
    });
  };

  for (const row of safeRows) {
    const excelRow = worksheet.addRow(row);
    const isRedSiteRow = rowMatchesRed(row);
    for (let column = 1; column <= headers.length; column += 1) {
      const header = headers[column - 1];
      const cell = excelRow.getCell(column);
      if (isRedSiteRow) {
        // Fill the FULL row (across the whole header span) so the integration
        // site reads as one continuous red band, matching the red canvas node.
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FAULT_FILL_ARGB } };
        cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: FAULT_FONT_ARGB } };
        cell.border = {
          top: { style: "thin", color: { argb: FAULT_BORDER_ARGB } },
          bottom: { style: "thin", color: { argb: FAULT_BORDER_ARGB } },
        };
      }
      if (hasJumperMarker(row[header])) {
        // Jumper cells keep the value as SITE(Jumper), then use red italic text.
        cell.font = { ...(cell.font ?? {}), italic: true, color: { argb: JUMPER_FONT_ARGB } };
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
