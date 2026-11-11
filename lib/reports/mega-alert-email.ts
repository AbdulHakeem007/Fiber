// HTML + plain-text renderers for the unified Mega Alert email.
//
// Design constraints (cross-client email compatibility):
//   • Table-based layout — no flexbox or grid (Outlook / older clients).
//   • All styles inline — no external CSS.
//   • Vertical bar charts rendered purely with HTML/CSS:
//       – Only the numeric count is displayed on each bar (no raw data table).
//       – Category label sits below the x-axis baseline.
//   • No images, no embedded chart objects.

export interface MegaAlertSummaryRow {
  label: string;
  value: number | string;
  tone?: "normal" | "warn" | "critical" | "ok";
}

export interface MegaAlertSection {
  title: string;
  summaryRows: MegaAlertSummaryRow[];
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );
}

// High-contrast categorical palette. Each bar in a chart is assigned the next
// colour by index so that every individual data point — e.g. each distinct
// vulnerability type in the "Network Vulnerabilities" section — is visually
// differentiated in the email client, rather than every bar sharing one flat tone.
const BAR_PALETTE = [
  "#dc2626", // crimson
  "#4f46e5", // indigo
  "#059669", // emerald
  "#d97706", // amber
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
] as const;

function paletteColor(index: number): string {
  return BAR_PALETTE[index % BAR_PALETTE.length];
}

const CHART_HEIGHT = 140; // px — height of the tallest bar
const MIN_BAR_PX = 6;    // minimum visible height for non-zero values

function buildBarChart(rows: MegaAlertSummaryRow[]): string {
  const numericValues = rows.map((r) => (typeof r.value === "number" ? r.value : 0));
  const maxVal = Math.max(1, ...numericValues);
  const colPct = Math.floor(100 / rows.length);

  // Value + bar cells (top section, aligned to bottom)
  const barCells = rows
    .map((row, index) => {
      const val = typeof row.value === "number" ? row.value : 0;
      const barH = val > 0 ? Math.max(MIN_BAR_PX, Math.round((val / maxVal) * CHART_HEIGHT)) : MIN_BAR_PX;
      // Every bar gets its own distinct colour from the categorical palette.
      const color = paletteColor(index);
      const isZero = val === 0;
      const barBg = isZero ? "#e2e8f0" : color;
      return (
        `<td width="${colPct}%" style="vertical-align:bottom;text-align:center;padding:0 6px;">` +
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;` +
        `color:${isZero ? "#94a3b8" : "#0f172a"};margin-bottom:5px;">${esc(String(val))}</div>` +
        `<div style="background:${barBg};height:${barH}px;border-radius:4px 4px 0 0;` +
        `display:block;"></div>` +
        `</td>`
      );
    })
    .join("");

  // Category label cells (bottom section)
  const labelCells = rows
    .map((row) => {
      const short = row.label.length > 28 ? row.label.slice(0, 25) + "…" : row.label;
      return (
        `<td width="${colPct}%" style="text-align:center;padding:6px 4px 0;vertical-align:top;">` +
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#64748b;` +
        `line-height:1.35;">${esc(short)}</div>` +
        `</td>`
      );
    })
    .join("");

  return (
    `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">` +
    `<tr style="border-bottom:2px solid #cbd5e1;">${barCells}</tr>` +
    `<tr>${labelCells}</tr>` +
    `</table>`
  );
}

function buildSection(section: MegaAlertSection): string {
  return (
    `<div style="margin-bottom:28px;">` +
    `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-radius:8px 8px 0 0;` +
    `overflow:hidden;border-collapse:collapse;">` +
    `<tr><td style="background:#1e3a5f;padding:10px 18px;">` +
    `<span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;` +
    `color:#ffffff;letter-spacing:0.03em;">${esc(section.title)}</span>` +
    `</td></tr></table>` +
    `<div style="border:1px solid #e2e8f0;border-top:none;padding:20px 16px;` +
    `border-radius:0 0 8px 8px;">` +
    buildBarChart(section.summaryRows) +
    `</div>` +
    `</div>`
  );
}

export function buildMegaAlertEmailHtml(input: {
  emailBody: string;
  sections: MegaAlertSection[];
  generatedAt: Date;
}): string {
  const stamp = esc(input.generatedAt.toUTCString());
  const sectionsHtml = input.sections.map(buildSection).join("");

  return (
    `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#eef2f7;">` +
    `<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;` +
    `border-radius:12px;overflow:hidden;">` +

    // ── header ──
    `<div style="background:#0f172a;padding:18px 24px;">` +
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:18px;` +
    `font-weight:700;">Fiber Inventory — Network Statistics</div>` +
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#94a3b8;font-size:11px;` +
    `margin-top:4px;">Generated ${stamp}</div>` +
    `</div>` +

    // ── greeting ──
    `<div style="padding:20px 24px 4px;">` +
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#334155;` +
    `margin:0 0 20px 0;line-height:1.65;">${esc(input.emailBody)}</p>` +
    sectionsHtml +
    `</div>` +

    // ── footer ──
    `<div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#64748b;">` +
    `Detailed records for each section are in the attached Excel workbook (three tabs). ` +
    `Automated weekly report — Fiber Inventory Management Portal.` +
    `</div>` +

    `</div></body></html>`
  );
}

export function buildMegaAlertEmailText(input: {
  emailBody: string;
  sections: MegaAlertSection[];
  generatedAt: Date;
}): string {
  const lines: string[] = [
    `Fiber Network Statistics (${input.generatedAt.toISOString()})`,
    "",
    input.emailBody,
    "",
  ];
  for (const section of input.sections) {
    lines.push(`=== ${section.title} ===`);
    for (const row of section.summaryRows) {
      lines.push(`  ${row.label}: ${row.value}`);
    }
    lines.push("");
  }
  lines.push("Full details are in the attached Excel workbook (three tabs).");
  return lines.join("\n");
}
