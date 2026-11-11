// Multi-sheet .xlsx workbook builder using ExcelJS.
// Replaces the legacy SheetJS (xlsx) implementation to gain full cell styling:
// bold/coloured header rows, auto-fit column widths, frozen header, and
// sortable auto-filters — all without native chart objects (pure data-driven).
//
// IMPORTANT: buildWorkbookBuffer is now async (ExcelJS writeBuffer is async).
// Every caller must await the result.

import ExcelJS from "exceljs";

export interface WorkbookSheet {
  /** Worksheet tab name (Excel caps this at 31 chars; sliced defensively). */
  name: string;
  rows: Record<string, unknown>[];
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1E3A5F" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
const HEADER_ALIGNMENT: Partial<ExcelJS.Alignment> = { vertical: "middle", horizontal: "left" };

/** Build a multi-sheet .xlsx workbook buffer. Empty sheets get a placeholder row. */
export async function buildWorkbookBuffer(sheets: WorkbookSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  wb.modified = new Date();

  const usable = sheets.length ? sheets : [{ name: "Report", rows: [] as Record<string, unknown>[] }];

  for (const sheet of usable) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31));

    const dataRows = sheet.rows.length ? sheet.rows : [{ message: "No rows found." }];
    const keys = Object.keys(dataRows[0]);

    // Define columns — widths are tightened after data is loaded.
    ws.columns = keys.map((key) => ({
      header: key,
      key,
      width: Math.max(key.length + 6, 16),
    }));

    // Style the auto-generated header row (row 1).
    const headerRow = ws.getRow(1);
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = HEADER_ALIGNMENT;
    });

    // Add data.
    for (const row of dataRows) {
      ws.addRow(row);
    }

    // Auto-fit column widths based on actual cell content.
    ws.columns.forEach((col) => {
      let maxLen = (col.header as string | undefined ?? "").length + 4;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = cell.value != null ? String(cell.value).length : 0;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 4, 64);
    });

    // Sortable auto-filter spanning the header row.
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: keys.length },
    };

    // Freeze the header row so it stays visible when scrolling.
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Render a value as a proportional in-cell bar (used by the legacy individual
 * weekly reports' "Graphs" sheet). Not used by the Mega Alert workbook.
 * barCell(42, 100) → "██████████░░░░░░░░░░░░░░  42"
 */
export function barCell(value: number, max: number, width = 24): string {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const filled = safeMax > 0 ? Math.round((safeValue / safeMax) * width) : 0;
  const clamped = Math.max(0, Math.min(width, filled));
  return `${"█".repeat(clamped)}${"░".repeat(width - clamped)}  ${safeValue}`;
}
