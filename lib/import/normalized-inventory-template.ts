import { createHash } from "crypto";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { normalizeOdfCode } from "@/lib/validation/odf";
import {
  normalizePortLabel,
  normalizeRackCode,
  normalizeServiceCodeExact,
} from "@/lib/telecom/connection-identity";
import { normalizeSegmentDefaultTopologyRole } from "@/lib/telecom/topology-role";

export const NORMALIZED_INVENTORY_HEADERS = [
  "segment_name",
  "segment_group_name",
  "segment_sequence",
  "segment_capacity_fibers",
  "segment_default_role",
  "source_segment_key",
  "source_workbook",
  "source_role",
  "worksheet_name",
  "block_start_row",
  "ports_row",
  "span_index",
  "unit_index",
  "local_site_id",
  "local_standardized_name",
  "local_rack_id",
  "local_odf_id",
  "local_port_or_pair",
  "local_fiber_count",
  "far_end_raw_label",
  "far_end_type",
  "far_end_site_id",
  "far_end_standardized_name",
  "far_end_named_location",
  "far_end_alias_key",
  "far_end_alias_display",
  "far_end_rack_id",
  "far_end_odf_id",
  "far_end_port_or_pair",
  "service_id",
  "service_id_local",
  "service_id_far_end",
  "service_id_resolved",
  "sp_location",
  "sp_status",
  "splitter_metadata",
  "splitter_type_tag",
  "splitter_location_context",
  "splitter_protection_mode",
  "splitter_ref",
  "block_type",
  "span_type",
  "inventory_class",
  "row_status",
  "match_status",
  "issue_reason",
  "far_worksheet_name",
] as const;

export type NormalizedInventoryHeader = (typeof NORMALIZED_INVENTORY_HEADERS)[number];
export type NormalizedInventoryCsvRow = Record<string, string>;

export interface NormalizedInventoryRow {
  rowNumber: number;
  raw: NormalizedInventoryCsvRow;
  normalized: {
    templateType: "NORMALIZED_INVENTORY";
    sourceSheet: string | null;
    sourceWorkbook: string | null;
    sourceRole: string | null;
    segmentName: string | null;
    segmentGroupName: string | null;
    segmentSequence: string | null;
    segmentCapacityFibers: number | null;
    /** Standalone dashboard tag (INTRA_SITE / GPON_SEGMENT); null for normal spans. */
    segmentDefaultRole: string | null;
    sourceSegmentKey: string | null;
    proposedSegmentCode: string;
    blockStartRow: string | null;
    portsRow: string | null;
    spanIndex: string | null;
    unitIndex: string | null;
    sourceSiteRaw: string | null;
    sourceSiteCanonical: string | null;
    sourceSiteDisplay: string | null;
    rackCode: string | null;
    odfCode: string | null;
    portGroupLabel: string | null;
    localFiberCount: number | null;
    farSiteRaw: string | null;
    farSiteCanonical: string | null;
    farSiteDisplay: string | null;
    farNamedLocation: string | null;
    farAliasKey: string | null;
    farAliasDisplay: string | null;
    farEndType: string | null;
    farRackCode: string | null;
    farOdfCode: string | null;
    farPortGroupLabel: string | null;
    directionText: string | null;
    serviceId: string | null;
    serviceIdLocal: string | null;
    serviceIdFarEnd: string | null;
    serviceIdResolved: string | null;
    cableId: string | null;
    tubeNo: number | null;
    tubeColor: string | null;
    fiberNo: number | null;
    operationalStatus: string | null;
    remarks: string | null;
    splitterRef: string | null;
    splitterCode: string | null;
    splitterLocation: string | null;
    splitterStatus: string | null;
    splitterMetadata: string | null;
    splitterTypeTag: "OSP_SPL" | "ISP_SPL" | string | null;
    splitterLocationContext: string | null;
    splitterProtectionMode: "PROTECTED" | "UNPROTECTED" | "UNKNOWN" | string | null;
    blockType: string | null;
    spanType: string | null;
    inventoryClass: string | null;
    splitterScope: "OSP" | "ISP" | null;
    rowStatus: string | null;
    matchStatus: string | null;
    issueReason: string | null;
    farWorksheetName: string | null;
    statusHint: "ACTIVE" | "DUMMY" | "SPLITTER" | "UNKNOWN";
    rowHash: string;
  };
}

export interface ParsedNormalizedInventoryCsv {
  rows: NormalizedInventoryRow[];
  summary: {
    parsedRows: number;
    blockTypeCounts: Record<string, number>;
    spanTypeCounts: Record<string, number>;
    inventoryClassCounts: Record<string, number>;
    matchStatusCounts: Record<string, number>;
    serviceRows: number;
    dummyRows: number;
    splitterRows: number;
  };
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function csvParse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        field += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function countBy(rows: NormalizedInventoryRow[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = clean(row.raw[key]) ?? "BLANK";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function sanitizeSegmentCode(value?: string | null): string {
  const normalized = (value ?? "SEGMENT").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "SEGMENT";
}

function parsePositiveInt(value?: string | null): number | null {
  const text = clean(value);
  if (!text) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanUpper(value?: string | null): string | null {
  return clean(value)?.toUpperCase() ?? null;
}

function proposedSegmentName(row: NormalizedInventoryCsvRow, localSite?: string | null, farSite?: string | null): string {
  const explicit = clean(row.segment_name);
  if (explicit) return explicit;
  const group = [clean(row.segment_group_name), clean(row.segment_sequence)].filter(Boolean).join("-");
  if (group) return group;
  const capacity = parsePositiveInt(row.segment_capacity_fibers);
  const generated = [
    clean(row.local_standardized_name) ?? clean(row.local_site_id) ?? localSite ?? "LOCAL",
    clean(row.far_end_alias_display) ?? clean(row.far_end_standardized_name) ?? clean(row.far_end_site_id) ?? clean(row.far_end_named_location) ?? farSite ?? "FAR",
    clean(row.segment_sequence) ?? "C01",
    capacity ? `${capacity}F` : null,
  ].filter(Boolean).join("-");
  return generated || sanitizeSegmentCode(row.source_segment_key);
}

function splitterScopeFor(row: NormalizedInventoryCsvRow): "OSP" | "ISP" | null {
  const explicit = cleanUpper(row.splitter_type_tag);
  if (explicit === "OSP_SPL") return "OSP";
  if (explicit === "ISP_SPL") return "ISP";
  const spanType = cleanUpper(row.span_type);
  if (spanType === "OSP_SPLITTER_SPAN") return "OSP";
  if (spanType === "ISP_SPLITTER_SPAN") return "ISP";
  return null;
}

function inferSplitterCode(row: NormalizedInventoryCsvRow): string | null {
  const scope = splitterScopeFor(row);
  if (!scope) return null;
  const explicit = clean(row.splitter_ref);
  if (explicit) return sanitizeSegmentCode(explicit);
  return sanitizeSegmentCode([
    row.segment_name,
    row.worksheet_name,
    row.block_start_row,
    row.span_index,
  ].filter(Boolean).join("-"));
}

function statusHint(row: NormalizedInventoryCsvRow): NormalizedInventoryRow["normalized"]["statusHint"] {
  const inventoryClass = cleanUpper(row.inventory_class);
  const spanType = cleanUpper(row.span_type);
  const blockType = cleanUpper(row.block_type);
  const matchStatus = cleanUpper(row.match_status);
  if (splitterScopeFor(row)) return "SPLITTER";
  if (inventoryClass === "DUMMY_PORT" || spanType === "DUMMY_SPAN" || matchStatus === "DUMMY") return "DUMMY";
  if (inventoryClass === "ACTIVE_TRANSPORT" || spanType === "TRANSPORT_SPAN" || spanType === "STRAIGHT_SPAN" || blockType === "TRANSPORT") return "ACTIVE";
  return "UNKNOWN";
}


function readableImportedSiteDisplay(...values: Array<string | null | undefined>): string | null {
  const first = values.map((value) => clean(value)).find(Boolean);
  if (!first) return null;
  const naturallyReadable = values
    .map((value) => clean(value))
    .find((value) => Boolean(value && /[\s&()]/.test(value) && value !== normalizeAlias(value)));
  return naturallyReadable ?? displaySiteLabel(first);
}

export function parseNormalizedInventoryCsv(buffer: Buffer): ParsedNormalizedInventoryCsv {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const csvRows = csvParse(text);
  if (csvRows.length < 2) throw new Error("Normalized inventory CSV has no data rows.");

  const headers = csvRows[0].map((header) => header.trim());
  const optionalHeaders = ["segment_default_role", "splitter_metadata", "splitter_type_tag", "splitter_location_context", "splitter_protection_mode"];
  const expected = [...NORMALIZED_INVENTORY_HEADERS].filter((header) => !optionalHeaders.includes(header));
  const missing = expected.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(`Normalized inventory CSV headers do not match the expected v27-compatible template. Missing: ${missing.join(", ")}.`);
  }

  const rows = csvRows.slice(1).map((values, index) => {
    const raw = Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex]?.trim() ?? ""])) as NormalizedInventoryCsvRow;
    const hint = statusHint(raw);
    const localSite = normalizeAlias(raw.local_site_id);
    const farSite = normalizeAlias(raw.far_end_site_id) ?? normalizeAlias(raw.far_end_named_location);
    const serviceId = normalizeServiceCodeExact(raw.service_id || raw.service_id_resolved || raw.service_id_local || raw.service_id_far_end);
    const splitterCode = inferSplitterCode(raw);
    const proposedSegmentCode = proposedSegmentName(raw, localSite, farSite);
    const rowHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");

    return {
      rowNumber: index + 1,
      raw,
      normalized: {
        templateType: "NORMALIZED_INVENTORY" as const,
        sourceSheet: clean(raw.worksheet_name),
        sourceWorkbook: clean(raw.source_workbook),
        sourceRole: clean(raw.source_role),
        segmentName: clean(raw.segment_name),
        segmentGroupName: clean(raw.segment_group_name),
        segmentSequence: clean(raw.segment_sequence),
        segmentCapacityFibers: parsePositiveInt(raw.segment_capacity_fibers),
        segmentDefaultRole: normalizeSegmentDefaultTopologyRole(raw.segment_default_role),
        sourceSegmentKey: clean(raw.source_segment_key),
        proposedSegmentCode,
        blockStartRow: clean(raw.block_start_row),
        portsRow: clean(raw.ports_row),
        spanIndex: clean(raw.span_index),
        unitIndex: clean(raw.unit_index),
        sourceSiteRaw: clean(raw.local_site_id),
        sourceSiteCanonical: localSite,
        sourceSiteDisplay: readableImportedSiteDisplay(raw.local_standardized_name, raw.local_site_id),
        rackCode: normalizeRackCode(raw.local_rack_id),
        odfCode: normalizeOdfCode(raw.local_odf_id),
        portGroupLabel: normalizePortLabel(raw.local_port_or_pair),
        localFiberCount: parsePositiveInt(raw.local_fiber_count),
        farSiteRaw: clean(raw.far_end_site_id) ?? clean(raw.far_end_named_location) ?? clean(raw.far_end_raw_label),
        farSiteCanonical: farSite,
        farSiteDisplay: readableImportedSiteDisplay(raw.far_end_alias_display, raw.far_end_standardized_name, raw.far_end_named_location, raw.far_end_site_id, raw.far_end_raw_label),
        farNamedLocation: clean(raw.far_end_named_location),
        farAliasKey: clean(raw.far_end_alias_key),
        farAliasDisplay: clean(raw.far_end_alias_display),
        farEndType: clean(raw.far_end_type),
        farRackCode: normalizeRackCode(raw.far_end_rack_id),
        farOdfCode: normalizeOdfCode(raw.far_end_odf_id),
        farPortGroupLabel: normalizePortLabel(raw.far_end_port_or_pair),
        directionText: clean(raw.far_end_raw_label),
        serviceId: normalizeServiceCodeExact(raw.service_id),
        serviceIdLocal: normalizeServiceCodeExact(raw.service_id_local),
        serviceIdFarEnd: normalizeServiceCodeExact(raw.service_id_far_end),
        serviceIdResolved: serviceId,
        cableId: clean(raw.cable_id),
        tubeNo: parsePositiveInt(raw.tube_no),
        tubeColor: clean(raw.tube_color),
        fiberNo: parsePositiveInt(raw.fiber_no),
        operationalStatus: cleanUpper(raw.status),
        remarks: clean(raw.remarks),
        splitterRef: clean(raw.splitter_ref),
        splitterCode,
        splitterLocation: clean(raw.splitter_location_context) ?? clean(raw.sp_location) ?? clean(raw.splitter_metadata),
        splitterStatus: clean(raw.sp_status),
        splitterMetadata: clean(raw.splitter_metadata),
        splitterTypeTag: cleanUpper(raw.splitter_type_tag),
        splitterLocationContext: clean(raw.splitter_location_context),
        splitterProtectionMode: cleanUpper(raw.splitter_protection_mode),
        blockType: cleanUpper(raw.block_type),
        spanType: cleanUpper(raw.span_type),
        inventoryClass: cleanUpper(raw.inventory_class),
        splitterScope: splitterScopeFor(raw),
        rowStatus: cleanUpper(raw.row_status),
        matchStatus: cleanUpper(raw.match_status),
        issueReason: clean(raw.issue_reason),
        farWorksheetName: clean(raw.far_worksheet_name),
        statusHint: hint,
        rowHash,
      },
    };
  });

  return {
    rows,
    summary: {
      parsedRows: rows.length,
      blockTypeCounts: countBy(rows, "block_type"),
      spanTypeCounts: countBy(rows, "span_type"),
      inventoryClassCounts: countBy(rows, "inventory_class"),
      matchStatusCounts: countBy(rows, "match_status"),
      serviceRows: rows.filter((row) => row.normalized.serviceIdResolved).length,
      dummyRows: rows.filter((row) => row.normalized.statusHint === "DUMMY").length,
      splitterRows: rows.filter((row) => row.normalized.statusHint === "SPLITTER").length,
    },
  };
}
