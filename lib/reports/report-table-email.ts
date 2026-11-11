// Pure HTML rendering for the weekly alert report emails. No Prisma/Next here so
// it stays unit-testable. The email BODY is intentionally a compact summary table
// (category -> value); the detailed rows and the graphical view live in the Excel
// attachment built by report-workbook.ts.
//
// The page chrome (dark header, card, footer) mirrors the existing Critical Links
// report (server/services/critical-links-report.service.ts) so all portal emails
// look consistent.

export interface SummaryRow {
  /** Category / item name shown in the left column. */
  label: string;
  /** Value shown in the right column (a count or short string). */
  value: string | number;
  /** Optional emphasis tier for value colouring (e.g. critical counts in red). */
  tone?: "normal" | "warn" | "critical" | "ok";
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char),
  );
}

function toneColor(tone: SummaryRow["tone"], value: string | number): string {
  if (tone === "critical") return "#dc2626";
  if (tone === "warn") return "#ea580c";
  if (tone === "ok") return "#16a34a";
  // Default: emphasise any non-zero numeric count, mute a clean zero.
  if (typeof value === "number") return value > 0 ? "#0f172a" : "#64748b";
  return "#0f172a";
}

export function buildSummaryEmailText(input: {
  title: string;
  generatedAt: Date;
  summaryRows: SummaryRow[];
}): string {
  const lines = input.summaryRows.map((row) => `- ${row.label}: ${row.value}`);
  return `${input.title} (${input.generatedAt.toISOString()})\n\n${lines.join("\n")}\n\nFull details are attached as an Excel workbook (Data + Graphs sheets).`;
}

export function buildSummaryEmailHtml(input: {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  summaryRows: SummaryRow[];
}): string {
  const stamp = escapeHtml(input.generatedAt.toUTCString());
  const subtitle = input.subtitle ? escapeHtml(input.subtitle) : "";

  const headerCells = ["Category", "Value"]
    .map((label) => `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #cbd5e1;font-size:12px;color:#334155;">${escapeHtml(label)}</th>`)
    .join("");

  const rows = input.summaryRows
    .map((row, index) => {
      const bg = index % 2 === 0 ? "#ffffff" : "#f8fafc";
      const valueColor = toneColor(row.tone, row.value);
      return `<tr style="background:${bg};">`
        + `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;">${escapeHtml(row.label)}</td>`
        + `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;font-weight:700;color:${valueColor};">${escapeHtml(String(row.value))}</td>`
        + `</tr>`;
    })
    .join("");

  const table = input.summaryRows.length
    ? `<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table>`
    : `<p style="font-family:Arial,Helvetica,sans-serif;color:#16a34a;font-weight:600;">✓ Nothing to report for this period.</p>`;

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#eef2f7;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:#0f172a;padding:18px 24px;">
      <div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;">Fiber Inventory — ${escapeHtml(input.title)}</div>
      <div style="color:#94a3b8;font-family:Arial,Helvetica,sans-serif;font-size:12px;margin-top:4px;">Generated ${stamp}</div>
    </div>
    ${subtitle ? `<div style="padding:16px 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#475569;">${subtitle}</div>` : ""}
    <div style="padding:20px 24px;">${table}</div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#64748b;">
      Detailed rows and the graphical view are attached as an Excel workbook (Data &amp; Graphs sheets). Automated weekly report from the Fiber Inventory Management Portal.
    </div>
  </div></body></html>`;
}
