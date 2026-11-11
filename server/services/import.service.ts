import { buildAliasLookup, normalizeAlias, resolveAlias } from "@/lib/import/alias-normalizer";
import { buildMirrorKey } from "@/lib/import/mirror-detector";
import { parseNormalizedInventoryCsv } from "@/lib/import/normalized-inventory-template";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { importUploadSchema } from "@/lib/validation/import";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode, normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";
import { prisma } from "@/lib/db/prisma";
import type { Prisma, ImportRowStatus } from "@prisma/client";
import { importRepository } from "@/server/repositories/import.repository";
import { connectionDuplicateService } from "@/server/services/connection-duplicate.service";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { logChange } from "@/server/services/audit.service";
import { INVENTORY_ASSET_REQUIRED_MESSAGE } from "@/server/services/inventory-asset-validation.service";

// ── Import staging query safety ──────────────────────────────────────────────
// Prisma must be able to transparently SPLIT large queries into slices that fit
// the database's host-parameter ceiling. A `notIn` negation filter blocks that
// split and surfaces as: "Query parameter limit exceeded ... the negation
// filters used prevent the query from being split." We therefore (1) express
// row-status filters as POSITIVE `in` lists, and (2) slice oversized id arrays
// ourselves so no single query is ever built with an unbounded parameter list.
// This keeps massive uploads processing chunk-by-chunk without ever crashing.
const COMMITTABLE_ROW_STATUSES: ImportRowStatus[] = ["STAGED", "VALID", "WARNING", "ERROR", "APPROVED"];
const NON_COMMITTED_ROW_STATUSES: ImportRowStatus[] = ["STAGED", "VALID", "WARNING", "ERROR", "APPROVED", "REJECTED", "SKIPPED"];

// Conservative slice size — comfortably under the SQLite host-variable ceiling
// even combined with the other bound parameters in these queries.
const ID_QUERY_CHUNK_SIZE = 500;

// ── Single-pass commit reliability (multi-click import bug fix) ──────────────
// Root cause of the historical "click Import repeatedly until everything lands"
// bug: every staged row commits inside ONE interactive transaction that ran
// with Prisma's DEFAULT limits (maxWait 2s, timeout 5s). Heavy rows — a 48-port
// group alone creates ~100 ODFPort/PortGroupMember upserts plus a full fiber
// ledger via ensureFiberInventory — regularly outlived that 5s budget under
// load. Prisma then killed the transaction (P2028) and the catch block
// permanently marked the row SKIPPED, silently removing it from every future
// pass. Operators had to re-click/re-upload until the survivors trickled in.
// The fix has three parts:
//   1. explicit transaction limits sized for the heaviest real-world row;
//   2. exponential-backoff retries for TRANSIENT failures (lock timeouts,
//      deadlocks, serialization aborts, dropped connections) so one pass
//      self-heals instead of dropping rows;
//   3. rows that STILL fail transiently after retries are left COMMITTABLE
//      (never SKIPPED) and reported as deferredRows, so the caller sweeps them
//      again in the same run. Only genuinely invalid rows are parked.
const ROW_COMMIT_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;
const TRANSIENT_RETRY_DELAYS_MS = [250, 1_000, 4_000];

function isTransientCommitError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  // P2028 = interactive transaction closed/expired; P2034 = write conflict or
  // deadlock; P1008 = operation timeout; P1001/P1002/P1017 = database
  // unreachable / connection timed out / server closed the connection.
  if (["P2028", "P2034", "P1008", "P1001", "P1002", "P1017"].includes(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return ["deadlock", "serialization", "timed out", "timeout", "connection reset", "econnreset", "transaction already closed"]
    .some((needle) => message.includes(needle));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkIds<T>(items: T[], size = ID_QUERY_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

const STAGING_REVIEW_INCLUDE = {
  normalizedSiteA: { select: { id: true, code: true, name: true } },
  normalizedSiteB: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ImportStagingRowInclude;

type CommittableStagingRow = Prisma.ImportStagingRowGetPayload<{ include: typeof STAGING_REVIEW_INCLUDE }>;

/** Build one or more committable-row WHERE clauses, slicing an oversized rowIds
 *  selection into database-parameter-safe chunks. Used for both count + fetch. */
function committableStagingWheres(
  batchId: string,
  rowIds: string[] | undefined,
  extra: Prisma.ImportStagingRowWhereInput = {},
): Prisma.ImportStagingRowWhereInput[] {
  const base: Prisma.ImportStagingRowWhereInput = {
    importBatchId: batchId,
    status: { in: COMMITTABLE_ROW_STATUSES },
    ...extra,
  };
  if (!rowIds?.length) return [base];
  return chunkIds(rowIds).map((idChunk) => ({ ...base, id: { in: idChunk } }));
}

/** Fetch the next committable window, chunking a large rowIds selection so the
 *  IN list never exceeds the provider's parameter limit. */
async function fetchCommittableStagingRows(
  batchId: string,
  rowIds: string[] | undefined,
  afterRowNumber: number,
  take: number,
): Promise<CommittableStagingRow[]> {
  const wheres = committableStagingWheres(batchId, rowIds, { rowNumber: { gt: afterRowNumber } });
  if (wheres.length === 1) {
    return prisma.importStagingRow.findMany({ where: wheres[0], orderBy: { rowNumber: "asc" }, take, include: STAGING_REVIEW_INCLUDE });
  }
  const merged: CommittableStagingRow[] = [];
  for (const where of wheres) {
    merged.push(...(await prisma.importStagingRow.findMany({ where, orderBy: { rowNumber: "asc" }, take, include: STAGING_REVIEW_INCLUDE })));
  }
  // Chunks are disjoint by id, so just order by rowNumber and cap to the window.
  merged.sort((a, b) => a.rowNumber - b.rowNumber);
  return merged.slice(0, take);
}

/** Count committable rows after a cursor, chunking the rowIds filter. */
async function countCommittableStagingRows(batchId: string, rowIds: string[] | undefined, afterRowNumber: number): Promise<number> {
  let total = 0;
  for (const where of committableStagingWheres(batchId, rowIds, { rowNumber: { gt: afterRowNumber } })) {
    total += await prisma.importStagingRow.count({ where });
  }
  return total;
}

interface RawImportRow {
  siteA?: string | null;
  siteB?: string | null;
  portA?: string | null;
  portB?: string | null;
  raw: Record<string, unknown>;
}

interface StageLegacyWorkbookInput {
  fileName: string;
  workbookBuffer: Buffer;
  uploadedById: string;
  templateVersion?: string | null;
  sourceSystem?: string | null;
}

function readJsonObject(value?: string | null): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parsePortNumbers(label?: string | null): number[] {
  const match = label?.replace(/\s+/g, "").match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return [];
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isInteger(first) || !Number.isInteger(second)) return [];
  if (first <= 0 || second <= 0) return [];
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  if (end - start > 998) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function groupTypeForPortLabel(label?: string | null): "SINGLE" | "PAIR" | "CUSTOM" {
  const ports = parsePortNumbers(label);
  if (ports.length === 1) return "SINGLE";
  if (ports.length === 2) return "PAIR";
  return "CUSTOM";
}

function inferImportedFiberCapacity(portLabel?: string | null, raw?: Record<string, any> | null): number {
  const explicit = [
    raw?.totalFibers,
    raw?.fiberCount,
    raw?.cableSize,
    raw?.["Cable Size"],
    raw?.["Total Fibers"],
  ].map((value) => Number(value)).find((value) => Number.isInteger(value) && value > 0);
  if (explicit) return explicit;
  const ports = parsePortNumbers(portLabel);
  const highestPort = ports.length ? Math.max(...ports) : 0;
  return Math.max(48, highestPort);
}

async function ensureEndpointAssets(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: {
    siteId?: string | null;
    siteCode?: string | null;
    displayName?: string | null;
    rackCode?: string | null;
    odfCode?: string | null;
    portLabel?: string | null;
    statusHint?: "ACTIVE" | "DUMMY" | "PLANNED" | "UNKNOWN";
    portStatus?: "ACTIVE" | "AVAILABLE" | "USED" | "SPARE" | "RESERVED" | "FAULTY" | "DUMMY" | "PLANNED" | "UNKNOWN";
  },
) {
  const siteCode = normalizeAlias(input.siteCode);
  const rackCode = normalizeRackCode(input.rackCode);
  const odfCode = normalizeOdfCode(input.odfCode);
  const portLabel = normalizePortLabel(input.portLabel);

  if ((!input.siteId && !siteCode) || !rackCode || !odfCode) throw new Error(INVENTORY_ASSET_REQUIRED_MESSAGE);

  // BULK/IMPORT PATH = soft fallback. Unlike the manual UI form (which enforces a
  // strict "register Site/Rack/ODF first" barrier via resolveRegisteredEndpointAssets),
  // batch/CSV/API ingestion must not stall on missing masters: auto-provision any
  // Site/Rack/ODF that is referenced but not yet registered, so the raw network
  // structure flows in fluidly.
  let site = await tx.site.findFirst({
    where: input.siteId
      ? { id: input.siteId }
      : { OR: [{ code: siteCode! }, { aliases: { some: { aliasNormalized: siteCode! } } }] },
    select: { id: true },
  });
  if (!site) {
    if (!siteCode) throw new Error(INVENTORY_ASSET_REQUIRED_MESSAGE);
    site = await tx.site.create({
      data: { code: siteCode, name: input.displayName ?? siteCode, isFiberNode: true, status: "ACTIVE" },
      select: { id: true },
    });
    await tx.siteAlias.upsert({
      where: { aliasNormalized: siteCode },
      update: { siteId: site.id },
      create: { siteId: site.id, alias: siteCode, aliasNormalized: siteCode, isPrimary: true, source: "IMPORT" },
    });
  }

  const rack = await tx.rack.upsert({
    where: { siteId_rackCode: { siteId: site.id, rackCode } },
    update: {},
    create: { siteId: site.id, rackCode, name: rackCode, status: "ACTIVE" },
    select: { id: true },
  });

  const odf = await tx.oDF.upsert({
    where: { siteId_rackId_odfCode: { siteId: site.id, rackId: rack.id, odfCode } },
    update: {},
    create: { siteId: site.id, rackId: rack.id, odfCode, name: odfCode, status: "ACTIVE" },
    select: { id: true },
  });

  if (!portLabel) {
    return { siteId: site.id, rackId: rack.id, odfId: odf.id, portGroupId: null };
  }

  const ports = parsePortNumbers(portLabel);
  const portStatus = input.portStatus ?? (input.statusHint === "DUMMY" ? "DUMMY" : input.statusHint === "PLANNED" ? "PLANNED" : "AVAILABLE");
  const portGroup = await tx.portGroup.upsert({
    where: { odfId_displayLabel: { odfId: odf.id, displayLabel: portLabel } },
    update: {
      status: portStatus,
    },
    create: {
      siteId: site.id,
      rackId: rack.id,
      odfId: odf.id,
      groupType: groupTypeForPortLabel(portLabel),
      displayLabel: portLabel,
      startPortNumber: ports[0] ?? null,
      endPortNumber: ports[ports.length - 1] ?? null,
      status: portStatus,
      source: "IMPORT",
    },
    select: { id: true },
  });

  for (let index = 0; index < ports.length; index += 1) {
    const odfPort = await tx.oDFPort.upsert({
      where: { odfId_portNumber: { odfId: odf.id, portNumber: ports[index] } },
      update: { status: portStatus },
      create: {
        odfId: odf.id,
        portNumber: ports[index],
        label: String(ports[index]),
        status: portStatus,
      },
      select: { id: true },
    });

    await tx.portGroupMember.upsert({
      where: { portGroupId_odfPortId: { portGroupId: portGroup.id, odfPortId: odfPort.id } },
      update: { sequence: index + 1 },
      create: { portGroupId: portGroup.id, odfPortId: odfPort.id, sequence: index + 1 },
    });
  }

  return { siteId: site.id, rackId: rack.id, odfId: odf.id, portGroupId: portGroup.id };
}

async function uniqueSegmentCode(baseCode: string): Promise<string> {
  let code = baseCode;
  let suffix = 1;
  while (await prisma.linkSegment.findUnique({ where: { segmentCode: code }, select: { id: true } })) {
    suffix += 1;
    code = `${baseCode}-${suffix}`;
  }
  return code;
}

function sourceEndpointForRow(normalized: Record<string, any>, raw: Record<string, any>) {
  return {
    siteCode: (normalized.sourceSiteCanonical || normalized.sourceSiteRaw || raw.sourceSiteCanonical || raw.sourceSiteRaw || raw.siteA || null) as string | null,
    rackCode: (normalized.rackCode || raw.rackCode || null) as string | null,
    odfCode: (normalized.odfCode || raw.odfCode || null) as string | null,
    portLabel: (normalized.portGroupLabel || raw.portGroupLabel || null) as string | null,
  };
}

function farEndpointForRow(normalized: Record<string, any>, raw: Record<string, any>) {
  return {
    siteCode: (normalized.farSiteCanonical || normalized.farSiteRaw || raw.farSiteCanonical || raw.farSiteRaw || raw.siteB || null) as string | null,
    rackCode: (normalized.farRackCode || raw.far_end_rack_id || raw.farRackCode || null) as string | null,
    odfCode: (normalized.farOdfCode || raw.far_end_odf_id || raw.farOdfCode || null) as string | null,
    portLabel: (normalized.farPortGroupLabel || raw.far_end_port_or_pair || raw.farPortGroupLabel || null) as string | null,
  };
}

function identityPart(value?: string | null): string | null {
  const cleaned = String(value ?? "").trim();
  if (!cleaned || cleaned === "-") return null;
  return cleaned.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function odfBoundaryKey(endpoint: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null }) {
  const site = identityPart(normalizeAlias(endpoint.siteCode ?? "") ?? endpoint.siteCode);
  const rack = identityPart(normalizeRackCode(endpoint.rackCode));
  const odf = identityPart(normalizeOdfCode(endpoint.odfCode));
  return [site, rack, odf].filter(Boolean).join("-");
}

function stripPortSuffixFromImportedName(value?: string | null): string | null {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) return null;
  return cleaned
    .replace(/(?:^|[-_\s])(?:P(?:ORT)?S?|ODFPORTS?)[-_\s]*\d+(?:[-–]\d+)?$/i, "")
    .replace(/[-_\s]+(?:PORT|PORTS|PAIR|PAIRS)[-_\s]*\d+(?:[-–]\d+)?$/i, "")
    .replace(/[-_\s]+\d+(?:[-–]\d+)?$/i, "")
    .replace(/[-_\s]+$/g, "")
    .trim() || cleaned;
}

function hierarchicalSegmentCodeForImport(
  normalized: Record<string, any>,
  endpointA: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null },
  endpointB: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null },
  fallbackA?: string | null,
  fallbackB?: string | null,
): string {
  // EDIT HERE: Import hierarchy key. Parent segment = physical ODF boundary, child rows = port groups.
  // We intentionally do NOT include local/far port labels here. This prevents each ODF port pair
  // from becoming a fake standalone segment during import approval.
  const groupName = stripPortSuffixFromImportedName(normalized.segmentGroupName ?? normalized.segmentName ?? normalized.proposedSegmentCode);
  const left = odfBoundaryKey(endpointA) || identityPart(fallbackA) || "LOCAL";
  const right = odfBoundaryKey(endpointB) || identityPart(fallbackB) || "FAR";
  const sequence = identityPart(normalized.segmentSequence) || identityPart(normalized.sourceSegmentKey) || "ODF";
  const boundaryCode = `${left}-${right}-${sequence}`;
  return groupName && groupName.length > 4 ? groupName : boundaryCode;
}

function isReciprocalEndpoint(first: Record<string, any>, second: Record<string, any>): boolean {
  const firstSource = normalizeAlias(first.sourceSiteCanonical ?? first.sourceSiteRaw);
  const firstFar = normalizeAlias(first.farSiteCanonical ?? first.farSiteRaw);
  const secondSource = normalizeAlias(second.sourceSiteCanonical ?? second.sourceSiteRaw);
  const secondFar = normalizeAlias(second.farSiteCanonical ?? second.farSiteRaw);
  return Boolean(firstSource && firstFar && firstSource === secondFar && firstFar === secondSource);
}

function hasBlockingIssues(issues: Array<{ blocking: boolean; severity: string }>): boolean {
  return issues.some((issue) => issue.blocking || issue.severity === "ERROR" || issue.severity === "CRITICAL");
}

function firstClean(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function positiveInt(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function serviceCodeForNormalized(normalized: Record<string, any>): string | null {
  return normalizeServiceCodeExact(firstClean(
    normalized.serviceId,
    normalized.serviceIdResolved,
    normalized.serviceIdLocal,
    normalized.serviceIdFarEnd,
  ));
}

async function findOrCreateCableInTx(tx: any, cableLabel?: string | null): Promise<string | null> {
  const label = firstClean(cableLabel);
  if (!label) return null;
  const existing = await tx.cable.findFirst({
    where: { OR: [{ cableCode: label }, { cableName: label }] },
    select: { id: true },
  });
  if (existing) return existing.id;
  const cable = await tx.cable.create({
    data: { cableCode: label, cableName: label, status: "ACTIVE" },
    select: { id: true },
  });
  return cable.id;
}

export const importService = {
  async createBatch(input: { fileName: string; templateVersion?: string | null; sourceSystem?: string | null; uploadedById: string }) {
    const parsed = importUploadSchema.parse(input);
    return importRepository.createBatch({
      batchCode: `IMP-${Date.now()}`,
      fileName: parsed.fileName,
      templateVersion: parsed.templateVersion ?? null,
      sourceSystem: parsed.sourceSystem ?? null,
      uploadedById: input.uploadedById,
    });
  },

  async stageRows(batchId: string, rows: RawImportRow[]) {
    const data = rows.map((row, index) => ({
      importBatchId: batchId,
      rowNumber: index + 1,
      status: "STAGED" as const,
      rawJson: JSON.stringify(row.raw),
      normalizedJson: JSON.stringify({
        siteA: normalizeAlias(row.siteA),
        siteB: normalizeAlias(row.siteB),
        portA: normalizePortLabel(row.portA),
        portB: normalizePortLabel(row.portB),
      }),
      proposedSegmentCode: `SEG-${normalizeAlias(row.siteA) ?? "UNK"}-${normalizeAlias(row.siteB) ?? "UNK"}-${String(index + 1).padStart(3, "0")}`,
      mirrorKey: buildMirrorKey(normalizeAlias(row.siteA), normalizeAlias(row.siteB), normalizePortLabel(row.portA), normalizePortLabel(row.portB)),
    }));

    await importRepository.createStagingRows(data);
    await importRepository.updateBatchCounts(batchId, {
      totalRows: rows.length,
      summaryText: `Staged ${rows.length} generic import rows.`,
    });
    return importRepository.getBatchReviewWindow(batchId);
  },

  async stageNormalizedInventoryCsv(input: StageLegacyWorkbookInput) {
    const batch = await this.createBatch({
      fileName: input.fileName,
      templateVersion: input.templateVersion ?? "normalized-inventory-csv-v1",
      sourceSystem: input.sourceSystem ?? "python-normalized-migration-template",
      uploadedById: input.uploadedById,
    });

    const parsed = parseNormalizedInventoryCsv(input.workbookBuffer);
    // Store a HUMAN-READABLE uploader (name/email) in the upload-history summary.
    // Previously the raw user id (a cuid like "cmqomxzul0…") was stored here and
    // surfaced verbatim in the Report Upload Summary's "Uploaded By" column.
    const uploader = await prisma.user.findUnique({
      where: { id: input.uploadedById },
      select: { name: true, email: true },
    });
    await prisma.importMetadata.create({
      data: {
        filename: input.fileName,
        uploadedBy: uploader?.name?.trim() || uploader?.email?.trim() || input.uploadedById,
        status: "STAGED",
        batchId: batch.id,
      },
    });
    const sites = await prisma.site.findMany({ include: { aliases: true }, orderBy: { code: "asc" } });
    const aliasLookup = buildAliasLookup(
      sites.map((site) => ({
        canonicalCode: site.code,
        aliases: [site.code, site.name ?? "", ...site.aliases.map((alias) => alias.alias)],
      })),
    );
    const siteIdByCode = new Map(sites.map((site) => [site.code, site.id]));

    const stagedRows = await importRepository.createStagingRows(
      parsed.rows.map((row) => {
        const sourceCanonical = resolveAlias(row.raw.local_site_id, aliasLookup) ?? row.normalized.sourceSiteCanonical;
        const farCanonical =
          resolveAlias(row.raw.far_end_site_id, aliasLookup) ??
          resolveAlias(row.raw.far_end_alias_display, aliasLookup) ??
          resolveAlias(row.raw.far_end_standardized_name, aliasLookup) ??
          resolveAlias(row.raw.far_end_named_location, aliasLookup) ??
          resolveAlias(row.raw.far_end_raw_label, aliasLookup) ??
          row.normalized.farSiteCanonical;
        const normalized = {
          ...row.normalized,
          sourceSiteCanonical: sourceCanonical,
          farSiteCanonical: farCanonical,
        };

        return {
          importBatchId: batch.id,
          rowNumber: row.rowNumber,
          status: "STAGED" as const,
          rawJson: JSON.stringify(row.raw),
          normalizedJson: JSON.stringify(normalized),
          normalizedSiteAId: sourceCanonical ? siteIdByCode.get(sourceCanonical) ?? null : null,
          normalizedSiteBId: farCanonical ? siteIdByCode.get(farCanonical) ?? null : null,
          proposedSegmentCode: normalized.proposedSegmentCode,
          mirrorKey: buildMirrorKey(sourceCanonical, farCanonical, normalized.portGroupLabel, normalized.farPortGroupLabel),
          rowHash: row.normalized.rowHash,
        };
      }),
    );

    const issues = [] as Prisma.ImportIssueCreateManyInput[];
    const seenHashes = new Map<string, string>();

    for (let index = 0; index < parsed.rows.length; index += 1) {
      const row = parsed.rows[index];
      const stagingRow = stagedRows[index];
      const normalized = readJsonObject(stagingRow.normalizedJson);
      const statusHint = String(normalized.statusHint ?? "").toUpperCase();

      if (seenHashes.has(row.normalized.rowHash)) {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "WARNING",
          issueCode: "TEMPLATE_DUPLICATE_ROW",
          message: "This normalized CSV row has the same source values as another staged row.",
          blocking: false,
        });
      }
      seenHashes.set(row.normalized.rowHash, stagingRow.id);

      if (!normalized.sourceSiteCanonical) {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "ERROR",
          issueCode: "MISSING_LOCAL_SITE",
          fieldName: "local_site_id",
          message: "Local site is missing or could not be normalized.",
          suggestedFix: "Correct the normalized CSV or create a site/alias before approval.",
          blocking: true,
        });
      } else if (!stagingRow.normalizedSiteAId) {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "WARNING",
          issueCode: "MISSING_LOCAL_SITE_MASTER",
          fieldName: "local_site_id",
          message: `Local site ${normalized.sourceSiteCanonical} is not in Site Database. Approval will create it as a controlled fiber-node reference.`,
          blocking: false,
        });
      }

      if (statusHint !== "DUMMY" && !normalized.farSiteCanonical && !normalized.farNamedLocation) {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: statusHint === "SPLITTER" ? "WARNING" : "ERROR",
          issueCode: "MISSING_FAR_ENDPOINT",
          fieldName: "far_end_site_id",
          message: "Far-end site or named endpoint is missing.",
          suggestedFix: "Correct the normalized CSV or reject the row during staging review.",
          blocking: statusHint !== "SPLITTER",
        });
      } else if (normalized.farSiteCanonical && !stagingRow.normalizedSiteBId && statusHint !== "DUMMY") {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "WARNING",
          issueCode: "MISSING_FAR_SITE_MASTER",
          fieldName: "far_end_site_id",
          message: `Far-end site ${normalized.farSiteCanonical} is not in Site Database. Approval will create it as a controlled fiber-node reference.`,
          blocking: false,
        });
      }

      if (!normalized.rackCode || !normalized.odfCode || !normalized.portGroupLabel) {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "ERROR",
          issueCode: "MISSING_LOCAL_ODF_MAPPING",
          fieldName: "local_rack_id/local_odf_id/local_port_or_pair",
          message: "Local rack, ODF, and port/pair are required for physical ODF inventory.",
          blocking: true,
        });
      }

      if (statusHint === "ACTIVE" && (!normalized.farRackCode || !normalized.farOdfCode || !normalized.farPortGroupLabel)) {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "WARNING",
          issueCode: "PARTIAL_FAR_END_MAPPING",
          fieldName: "far_end_rack_id/far_end_odf_id/far_end_port_or_pair",
          message: "Far-end rack, ODF, or port/pair is missing. The row can be reviewed, but the mapping is partial.",
          blocking: false,
        });
      }

      if (String(normalized.matchStatus ?? "").toUpperCase() === "NO_REVERSE_FOUND") {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "WARNING",
          issueCode: "NO_REVERSE_FOUND",
          fieldName: "match_status",
          message: "The Python migration did not find a reverse endpoint row.",
          blocking: false,
        });
      }
      if (String(normalized.matchStatus ?? "").toUpperCase() === "PARTIAL_PORT_ALIGNMENT") {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "WARNING",
          issueCode: "PARTIAL_PORT_ALIGNMENT",
          fieldName: "match_status",
          message: "The Python migration found only partial port alignment.",
          blocking: false,
        });
      }
      if (statusHint === "DUMMY") {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "INFO",
          issueCode: "DUMMY_PORT",
          fieldName: "inventory_class",
          message: "Dummy/free port will be committed to ODF inventory only; no service allocation will be created.",
          blocking: false,
        });
      }
      if (statusHint === "SPLITTER") {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "ERROR",
          issueCode: "SPLITTER_UPLOAD_REQUIRED",
          fieldName: "inventory_class/span_type",
          message: "Splitter rows must be uploaded from the Splitters Inventory import flow. They are not committed from ODF Mappings uploads.",
          suggestedFix: "Upload the matching _Spl CSV from the Splitters Inventory page, or reject/flush this staged row.",
          blocking: true,
        });
      }
      if (statusHint === "UNKNOWN") {
        issues.push({
          importBatchId: batch.id,
          stagingRowId: stagingRow.id,
          severity: "ERROR",
          issueCode: "UNKNOWN_INVENTORY_CLASS",
          fieldName: "inventory_class",
          message: "Row could not be classified as transport or dummy ODF inventory for this upload flow.",
          blocking: true,
        });
      }
    }

    await importRepository.createIssues(issues);
    await importRepository.updateBatchCounts(batch.id, {
      totalRows: parsed.summary.parsedRows,
      summaryText: JSON.stringify(parsed.summary),
      status: issues.some((issue) => issue.blocking) ? "REVIEW_REQUIRED" : "VALIDATED",
    });

    return this.validateBatch(batch.id);
  },

  async stageLegacyWorkbook(_input: StageLegacyWorkbookInput) {
    throw new Error("Raw Excel ODF workbooks are not accepted by the portal. Run the Python migration script and upload migration_template_inventory.csv.");
  },

  async validateBatch(batchId: string) {
    await prisma.importIssue.deleteMany({
      where: {
        importBatchId: batchId,
        issueCode: { in: ["MIRROR_DUPLICATE", "LIVE_DUPLICATE"] },
      },
    });

    const batch = await importRepository.getBatchReview(batchId);
    if (!batch) throw new Error("Import batch not found");

    const mirrorBuckets = new Map<string, string[]>();
    for (const row of batch.stagingRows) {
      if (!row.mirrorKey) continue;
      const ids = mirrorBuckets.get(row.mirrorKey) ?? [];
      ids.push(row.id);
      mirrorBuckets.set(row.mirrorKey, ids);
    }

    const mirrorIssues = [] as Prisma.ImportIssueCreateManyInput[];
    for (const [, rowIds] of mirrorBuckets) {
      if (rowIds.length < 2) continue;
      for (const rowId of rowIds.slice(1)) {
        mirrorIssues.push({
          importBatchId: batchId,
          stagingRowId: rowId,
          severity: "WARNING",
          issueCode: "MIRROR_DUPLICATE",
          message: "Possible mirrored duplicate from opposite site sheet or reciprocal ODF section.",
          blocking: false,
        });
      }
    }

    await importRepository.createIssues(mirrorIssues);

    const liveDuplicateIssues = [] as Prisma.ImportIssueCreateManyInput[];
    for (const row of batch.stagingRows) {
      const normalized = readJsonObject(row.normalizedJson);
      const raw = readJsonObject(row.rawJson);
      if (["DUMMY", "SPLITTER"].includes(String(normalized.statusHint ?? "").toUpperCase())) continue;
      const sourceEndpoint = sourceEndpointForRow(normalized, raw);
      const farEndpoint = farEndpointForRow(normalized, raw);
      if (!sourceEndpoint.siteCode || !farEndpoint.siteCode) continue;
      const duplicate = await connectionDuplicateService.findDuplicateSegment(prisma as any, sourceEndpoint, farEndpoint);
      if (!duplicate) continue;
      liveDuplicateIssues.push({
        importBatchId: batchId,
        stagingRowId: row.id,
        severity: "WARNING",
        issueCode: "LIVE_DUPLICATE",
        message: `Existing live segment ${duplicate.segmentCode} already matches this effective site/rack/ODF/port mapping. It will be skipped during approval.`,
        blocking: false,
        suggestedFix: "Review the staged row against live inventory before approval.",
      });
      await prisma.importStagingRow.update({
        where: { id: row.id },
        data: { duplicateOfSegmentId: duplicate.id },
      });
    }

    await importRepository.createIssues(liveDuplicateIssues);

    const review = await importRepository.getBatchReview(batchId);
    if (!review) throw new Error("Import batch not found after validation");

    const issuesByRowId = new Map<string, typeof review.issues>();
    for (const issue of review.issues) {
      if (!issue.stagingRowId) continue;
      const bucket = issuesByRowId.get(issue.stagingRowId) ?? [];
      bucket.push(issue);
      issuesByRowId.set(issue.stagingRowId, bucket);
    }

    let validRows = 0;
    let warningRows = 0;
    let errorRows = 0;

    for (const row of review.stagingRows) {
      const rowIssues = issuesByRowId.get(row.id) ?? [];
      const hasBlocking = rowIssues.some((issue) => issue.blocking || issue.severity === "ERROR" || issue.severity === "CRITICAL");
      const hasWarning = rowIssues.some((issue) => issue.severity === "WARNING");
      const status = hasBlocking ? "ERROR" : hasWarning ? "WARNING" : "VALID";

      if (status === "ERROR") errorRows += 1;
      else if (status === "WARNING") warningRows += 1;
      else validRows += 1;

      await prisma.importStagingRow.update({
        where: { id: row.id },
        data: { status },
      });
    }

    await importRepository.updateBatchCounts(batchId, {
      status: errorRows > 0 || warningRows > 0 ? "REVIEW_REQUIRED" : "VALIDATED",
      totalRows: review.stagingRows.length,
      validRows,
      warningRows,
      errorRows,
    });

    return importRepository.getBatchReviewWindow(batchId);
  },

  async commitBatch(batchId: string, committedById: string, options: { sheetName?: string | null } = {}) {
    return this.approveBatchRows(batchId, committedById, { sheetName: options.sheetName ?? null });
  },

  async approveBatchRows(
    batchId: string,
    committedById: string,
    options: {
      rowIds?: string[];
      sheetName?: string | null;
      approveCleanOnly?: boolean;
      reviewerComment?: string | null;
      /** Commit budget per invocation — keeps every HTTP request bounded. */
      maxRows?: number;
      /** Resume cursor: continue after this staging rowNumber. */
      afterRowNumber?: number;
      /**
       * Background-worker mode: skip the heavy review-window payload and only
       * return commit progress. The worker loops hundreds of windows; fetching
       * 2000 staging rows plus every issue per window would dwarf the commit
       * work itself.
       */
      progressOnly?: boolean;
    } = {},
  ) {
    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { id: true, batchCode: true, fileName: true, summaryText: true },
    });
    if (!batch) throw new Error("Import batch not found");

    // RESUMABLE COMMIT WINDOW: the previous implementation walked the entire
    // batch (every row = its own multi-statement transaction) inside ONE HTTP
    // request. Large batches outlived browser/proxy timeouts, the connection
    // dropped, and the loop died mid-batch — the portal looked frozen and only
    // a subset of rows (e.g. 108) ever reached COMMITTED. Each invocation now
    // processes a bounded window and returns a cursor so the client continues
    // until every row is committed, with visible progress.
    const maxRows = Math.min(Math.max(options.maxRows ?? 250, 1), 1000);
    const afterRowNumber = Math.max(0, options.afterRowNumber ?? 0);
    // Sheet filtering lives inside normalizedJson, so it cannot be pushed into
    // SQL; pull a larger window when a sheet filter is active so filtered-out
    // rows do not starve the commit budget.
    const fetchSize = options.sheetName?.trim() ? maxRows * 5 : maxRows;
    // Positive status `in` + chunked id slices so even a multi-thousand-row
    // "approve selected" never trips the query parameter limit.
    const stagingRows = await fetchCommittableStagingRows(batchId, options.rowIds, afterRowNumber, fetchSize);

    const batchIssues: Awaited<ReturnType<typeof prisma.importIssue.findMany>> = [];
    for (const idChunk of chunkIds(stagingRows.map((row) => row.id))) {
      if (!idChunk.length) continue;
      batchIssues.push(...(await prisma.importIssue.findMany({ where: { importBatchId: batchId, stagingRowId: { in: idChunk } } })));
    }
    const issuesByRowId = new Map<string, typeof batchIssues>();
    for (const issue of batchIssues) {
      if (!issue.stagingRowId) continue;
      issuesByRowId.set(issue.stagingRowId, [...(issuesByRowId.get(issue.stagingRowId) ?? []), issue]);
    }

    const routeCache = new Map<string, { serviceId: string; routeId: string; nextOrder: number }>();
    let committedRows = 0;
    let skippedRows = 0;
    // Rows that hit a transient DB failure even after retries. They keep their
    // committable status (never SKIPPED) and the caller re-sweeps them.
    let deferredRows = 0;
    let outOfScopeRows = 0;
    let processedRows = 0;
    let lastScannedRowNumber = afterRowNumber;
    let budgetExhausted = false;

    for (const row of stagingRows) {
      if (processedRows >= maxRows) {
        budgetExhausted = true;
        break;
      }
      lastScannedRowNumber = row.rowNumber;
      const normalized = readJsonObject(row.normalizedJson);
      const raw = readJsonObject(row.rawJson);
      if (options.sheetName?.trim() && normalized.sourceSheet !== options.sheetName.trim()) {
        outOfScopeRows += 1;
        continue;
      }
      if (["COMMITTED", "REJECTED", "SKIPPED"].includes(row.status)) {
        skippedRows += 1;
        continue;
      }
      processedRows += 1;

      const rowIssues = issuesByRowId.get(row.id) ?? [];
      const hasBlocking = hasBlockingIssues(rowIssues);
      const duplicateCandidate = rowIssues.some((issue) =>
        issue.issueCode === "MIRROR_DUPLICATE" ||
        issue.issueCode === "LIVE_DUPLICATE" ||
        issue.issueCode === "TEMPLATE_DUPLICATE_ROW"
      );
      if (options.approveCleanOnly && row.status !== "VALID") {
        skippedRows += 1;
        continue;
      }
      if (hasBlocking) {
        skippedRows += 1;
        await prisma.importStagingRow.update({ where: { id: row.id }, data: { status: "ERROR" } });
        continue;
      }
      if (duplicateCandidate) {
        skippedRows += 1;
        await prisma.importStagingRow.update({
          where: { id: row.id },
          data: { status: "SKIPPED", reviewerComment: options.reviewerComment ?? "Skipped duplicate candidate during approval." },
        });
        continue;
      }

      const endpointAInput = sourceEndpointForRow(normalized, raw);
      const endpointBInput = farEndpointForRow(normalized, raw);
      const sourceSiteCode = endpointAInput.siteCode;
      const farSiteCode = endpointBInput.siteCode ?? (normalized.farNamedLocation as string | null) ?? (normalized.farSiteRaw as string | null);
      const statusHint = String(normalized.statusHint ?? "ACTIVE").toUpperCase();
      if (statusHint === "SPLITTER") {
        skippedRows += 1;
        await prisma.importStagingRow.update({
          where: { id: row.id },
          data: { status: "SKIPPED", reviewerComment: "Splitter row skipped from transport approval. Use Splitters Inventory import." },
        });
        continue;
      }
      const serviceCode = serviceCodeForNormalized(normalized);
      const localFiberNumbers = parsePortNumbers(endpointAInput.portLabel);
      const farFiberNumbers = parsePortNumbers(endpointBInput.portLabel);
      const fiberNumbers = localFiberNumbers.length ? localFiberNumbers : farFiberNumbers;
      const requestedCapacity = Math.max(
        positiveInt(normalized.segmentCapacityFibers) ?? 0,
        positiveInt(normalized.localFiberCount) ?? 0,
        inferImportedFiberCapacity(endpointAInput.portLabel, raw),
        ...localFiberNumbers,
        ...farFiberNumbers,
      );

      // Read-only duplicate probe — wrapping it in an interactive transaction
      // added one transaction handshake per row for no isolation benefit.
      const duplicate = statusHint === "ACTIVE"
        ? await connectionDuplicateService.findDuplicateSegment(prisma, endpointAInput, endpointBInput)
        : null;
      if (duplicate) {
        skippedRows += 1;
        await prisma.importIssue.create({
          data: {
            importBatchId: batchId,
            stagingRowId: row.id,
            severity: "WARNING",
            issueCode: "LIVE_DUPLICATE",
            message: `Existing live segment ${duplicate.segmentCode} already matches this effective mapping. The staged row was skipped and kept for review/export.`,
            blocking: false,
          },
        });
        await prisma.importStagingRow.update({
          where: { id: row.id },
          data: { status: "SKIPPED", duplicateOfSegmentId: duplicate.id },
        });
        continue;
      }

      // TRANSACTION FIX (multi-click import bug): the row commit is a closure so
      // it can be re-invoked by the transient-retry loop below. It always runs
      // with explicit limits (ROW_COMMIT_TX_OPTIONS) instead of Prisma's 5s
      // default, which the heaviest rows could not survive.
      const commitRowTransaction = () => prisma.$transaction(async (tx) => {
        const endpointAAssets = await ensureEndpointAssets(tx, {
          siteId: row.normalizedSiteAId,
          siteCode: endpointAInput.siteCode,
          displayName: normalized.sourceSiteDisplay ?? normalized.sourceSiteRaw ?? endpointAInput.siteCode,
          rackCode: endpointAInput.rackCode,
          odfCode: endpointAInput.odfCode,
          portLabel: endpointAInput.portLabel,
          statusHint: statusHint === "DUMMY" ? "DUMMY" : "ACTIVE",
          portStatus: statusHint === "DUMMY" ? "DUMMY" : serviceCode ? "ACTIVE" : "AVAILABLE",
        });

        if (statusHint === "DUMMY") {
          await tx.importStagingRow.update({
            where: { id: row.id },
            data: { status: "COMMITTED", reviewerComment: options.reviewerComment ?? "Committed as dummy ODF inventory only." },
          });
          return;
        }

        const endpointBAssets = await ensureEndpointAssets(tx, {
          siteId: row.normalizedSiteBId,
          siteCode: endpointBInput.siteCode,
          displayName: normalized.farSiteDisplay ?? normalized.farAliasDisplay ?? normalized.farNamedLocation ?? endpointBInput.siteCode,
          rackCode: endpointBInput.rackCode,
          odfCode: endpointBInput.odfCode,
          portLabel: endpointBInput.portLabel,
          statusHint: "ACTIVE",
          portStatus: serviceCode ? "ACTIVE" : "AVAILABLE",
        });

        const segmentCode = hierarchicalSegmentCodeForImport(
          normalized,
          endpointAInput,
          endpointBInput,
          sourceSiteCode,
          farSiteCode,
        );
        const cableId = await findOrCreateCableInTx(tx, normalized.cableId ?? raw.cable_id ?? null);
        let segment = await tx.linkSegment.findUnique({
          where: { segmentCode },
          select: { id: true, endpointAId: true, endpointBId: true },
        });

        if (!segment) {
          const endpointA = await tx.segmentEndpoint.create({
            data: {
              endpointSide: "A",
              siteId: endpointAAssets.siteId,
              rackId: endpointAAssets.rackId,
              odfId: endpointAAssets.odfId,
              portGroupId: endpointAAssets.portGroupId,
              rawSiteCode: sourceSiteCode,
              rawRackCode: endpointAInput.rackCode,
              rawOdfCode: endpointAInput.odfCode,
              rawPortText: endpointAInput.portLabel,
              displayPortText: endpointAInput.portLabel,
              terminationStatus: "ACTIVE",
              remarks: `Imported from ${normalized.sourceSheet ?? batch.fileName}`,
            },
          });
          const endpointB = await tx.segmentEndpoint.create({
            data: {
              endpointSide: "B",
              siteId: endpointBAssets.siteId,
              rackId: endpointBAssets.rackId,
              odfId: endpointBAssets.odfId,
              portGroupId: endpointBAssets.portGroupId,
              rawSiteCode: farSiteCode,
              rawRackCode: endpointBInput.rackCode,
              rawOdfCode: endpointBInput.odfCode,
              rawPortText: endpointBInput.portLabel,
              displayPortText: endpointBInput.portLabel,
              terminationStatus: "ACTIVE",
              remarks: normalized.directionText ?? null,
            },
          });
          segment = await tx.linkSegment.create({
            data: {
              segmentCode,
              segmentGroupName: normalized.segmentGroupName ?? null,
              segmentSequence: normalized.segmentSequence ?? null,
              segmentCapacityFibers: positiveInt(normalized.segmentCapacityFibers),
              // Standalone dashboard tag carried from the extractor (e.g. INTRA_SITE
              // for MU0282(basement)<->MU0282(rooftop)); never affects routing/tracing.
              segmentDefaultRole: (normalized.segmentDefaultRole as string | null) ?? null,
              sourceSegmentKey: normalized.sourceSegmentKey ?? null,
              sourceWorkbook: normalized.sourceWorkbook ?? null,
              sourceWorksheetName: normalized.sourceSheet ?? null,
              spanType: normalized.spanType ?? null,
              inventoryClass: normalized.inventoryClass ?? null,
              matchStatus: normalized.matchStatus ?? null,
              sitePairKey: buildSitePairKey(sourceSiteCode, farSiteCode),
              endpointAId: endpointA.id,
              endpointBId: endpointB.id,
              cableId,
              routeLabel: normalized.segmentName ?? normalized.directionText ?? null,
              totalFiberCapacity: requestedCapacity,
              status: "ACTIVE",
              comments: `Committed from normalized CSV batch ${batch.batchCode}.`,
              source: "IMPORT",
              importBatchId: batchId,
              isMirrorCandidate: Boolean(row.mirrorKey),
            },
            select: { id: true, endpointAId: true, endpointBId: true },
          });
          const createdSegment = await tx.linkSegment.findUnique({ where: { id: segment.id } });
          // Log the two endpoints as INSERTs as well, so audit reconstruction
          // deletes them with the segment instead of leaving orphaned
          // SegmentEndpoint rows behind. Logged before the LinkSegment so the
          // reversal (which deletes the segment first) frees the endpoint FK.
          await logChange(tx, { operatorId: committedById, actionType: "INSERT", targetTable: "SegmentEndpoint", targetId: endpointA.id, newState: endpointA, batchId });
          await logChange(tx, { operatorId: committedById, actionType: "INSERT", targetTable: "SegmentEndpoint", targetId: endpointB.id, newState: endpointB, batchId });
          await logChange(tx, {
            operatorId: committedById,
            actionType: "INSERT",
            targetTable: "LinkSegment",
            targetId: segment.id,
            newState: createdSegment,
            batchId,
          });
        } else {
          const beforeSegment = await tx.linkSegment.findUnique({ where: { id: segment.id } });
          await tx.linkSegment.update({
            where: { id: segment.id },
            data: {
              segmentGroupName: normalized.segmentGroupName ?? undefined,
              segmentSequence: normalized.segmentSequence ?? undefined,
              // Apply an intra-site/GPON tag from the extractor without clobbering a
              // role an operator may have set manually (undefined = leave unchanged).
              segmentDefaultRole: (normalized.segmentDefaultRole as string | null) || undefined,
              // Keep parent capacity as the maximum physical/core capacity seen for the ODF boundary.
              // Child port rows below this segment carry the individual service/ODF-port mapping.
              segmentCapacityFibers: positiveInt(normalized.segmentCapacityFibers) ?? undefined,
              sourceSegmentKey: normalized.sourceSegmentKey ?? undefined,
              sourceWorkbook: normalized.sourceWorkbook ?? undefined,
              sourceWorksheetName: normalized.sourceSheet ?? undefined,
              spanType: normalized.spanType ?? undefined,
              inventoryClass: normalized.inventoryClass ?? undefined,
              matchStatus: normalized.matchStatus ?? undefined,
              cableId: cableId ?? undefined,
              routeLabel: normalized.segmentName ?? normalized.directionText ?? undefined,
            },
          });
          const afterSegment = await tx.linkSegment.findUnique({ where: { id: segment.id } });
          await logChange(tx, {
            operatorId: committedById,
            actionType: "UPDATE",
            targetTable: "LinkSegment",
            targetId: segment.id,
            originalState: beforeSegment,
            newState: afterSegment,
            batchId,
          });
        }

        await segmentCapacityService.ensureFiberInventory(tx, segment.id, requestedCapacity);
        const createdMapping = await tx.segmentEndpointMapping.create({
          data: {
            segmentId: segment.id,
            importStagingRowId: row.id,
            localSiteCode: sourceSiteCode,
            localRackCode: endpointAInput.rackCode,
            localOdfCode: endpointAInput.odfCode,
            localPortLabel: endpointAInput.portLabel,
            farSiteCode,
            farEndpointLabel: normalized.farAliasDisplay ?? normalized.farSiteDisplay ?? normalized.farNamedLocation ?? normalized.farSiteRaw ?? null,
            farRackCode: endpointBInput.rackCode,
            farOdfCode: endpointBInput.odfCode,
            farPortLabel: endpointBInput.portLabel,
            localPortGroupId: endpointAAssets.portGroupId,
            farPortGroupId: endpointBAssets.portGroupId,
            fiberNumbersJson: JSON.stringify(fiberNumbers),
            serviceCode,
            status: serviceCode ? "ACTIVE" : "AVAILABLE",
            source: "IMPORT",
            remarks: normalized.remarks ?? normalized.issueReason ?? null,
          },
        });
        await logChange(tx, {
          operatorId: committedById,
          actionType: "INSERT",
          targetTable: "SegmentEndpointMapping",
          targetId: createdMapping.id,
          newState: createdMapping,
          batchId,
        });

        if (serviceCode) {
          let routeRef = routeCache.get(serviceCode);
          if (!routeRef) {
            const service = await tx.service.upsert({
              where: { serviceCode },
              update: { status: "ACTIVE" },
              create: {
                serviceCode,
                serviceName: `Imported allocation ${serviceCode}`,
                serviceType: "Fiber Service",
                status: "ACTIVE",
              },
            });
            const route = await tx.serviceRoute.create({
              data: {
                serviceId: service.id,
                routeName: `Imported ${batch.batchCode} ${serviceCode}`,
                routeType: "WORKING",
                isActive: true,
                remarks: "Normalized CSV import allocation",
              },
            });
            routeRef = { serviceId: service.id, routeId: route.id, nextOrder: 1 };
            routeCache.set(serviceCode, routeRef);
          }
          const hopOrder = routeRef.nextOrder;
          routeRef.nextOrder += 1;
          const allocated = await segmentCapacityService.allocateSpecificFibers(tx, {
            segmentId: segment.id,
            serviceId: routeRef.serviceId,
            serviceRouteId: routeRef.routeId,
            serviceCode,
            allocationGroup: routeRef.routeId,
            pathOrder: hopOrder,
            fiberNumbers,
            fromSiteId: endpointAAssets.siteId,
            toSiteId: endpointBAssets.siteId,
            endpointAId: segment.endpointAId,
            endpointBId: segment.endpointBId,
            endpointAPortGroupId: endpointAAssets.portGroupId,
            endpointBPortGroupId: endpointBAssets.portGroupId,
            pathLabel: `${sourceSiteCode ?? "LOCAL"} -> ${farSiteCode ?? "FAR"}`,
            remarks: serviceCode,
            requestedCapacity,
          });
          await tx.serviceRouteHop.create({
            data: {
              serviceRouteId: routeRef.routeId,
              hopOrder,
              siteId: endpointAAssets.siteId,
              rackId: endpointAAssets.rackId,
              odfId: endpointAAssets.odfId,
              portGroupId: endpointAAssets.portGroupId,
              segmentId: segment.id,
              pathLabel: `${sourceSiteCode ?? "LOCAL"} -> ${farSiteCode ?? "FAR"}`,
              remarks: `Allocated fibers ${allocated.fiberNumbers.join("-")} for ${serviceCode}`,
            },
          });
        }

        // Capacity-drift fix: ensureFiberInventory() above recomputes BEFORE this
        // row's child mapping is inserted, so a segment's trailing AVAILABLE row
        // (no serviceCode to trigger allocateSpecificFibers' post-insert refresh)
        // was never counted and the stored total fell 1-2 below the live truth.
        // Recompute now that this row's mapping and any allocation both exist.
        await segmentCapacityService.refreshSegmentCapacity(tx, segment.id);

        await tx.importStagingRow.update({
          where: { id: row.id },
          data: { status: "COMMITTED", duplicateOfSegmentId: segment.id, reviewerComment: options.reviewerComment ?? null },
        });
      }, ROW_COMMIT_TX_OPTIONS);

      try {
        // RETRY FIX (multi-click import bug): transient failures — lock
        // timeouts, deadlocks, dropped connections — no longer abort the row.
        // The whole row transaction is atomic, so a failed attempt rolled back
        // cleanly and can simply be re-executed after an exponential backoff.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await commitRowTransaction();
            break;
          } catch (transientError) {
            // A rolled-back attempt may have cached a Service/Route that no
            // longer exists — always invalidate before retrying or bailing.
            if (serviceCode) routeCache.delete(serviceCode);
            if (isTransientCommitError(transientError) && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
              await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
              continue;
            }
            throw transientError;
          }
        }
        committedRows += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Staged row could not be approved.";
        // DEFERRAL FIX (multi-click import bug): a transient error that survived
        // every retry must NOT park the row as SKIPPED (the old behavior that
        // silently dropped rows from all future passes). The row keeps its
        // committable status and is reported as deferred so the same run's
        // sweep — or the next click — picks it up automatically.
        if (isTransientCommitError(error)) {
          deferredRows += 1;
          await prisma.importIssue.create({
            data: {
              importBatchId: batchId,
              stagingRowId: row.id,
              severity: "WARNING",
              issueCode: "APPROVAL_DEFERRED_TRANSIENT",
              message: `Transient database error during commit; the row stays committable and is retried automatically. Last error: ${message}`,
              blocking: false,
            },
          });
          continue;
        }
        skippedRows += 1;
        await prisma.importIssue.create({
          data: {
            importBatchId: batchId,
            stagingRowId: row.id,
            severity: "WARNING",
            issueCode: "APPROVAL_SKIPPED",
            message,
            blocking: false,
            suggestedFix: "Review the row, correct duplicate or unavailable fiber mapping, then approve it again.",
          },
        });
        await prisma.importStagingRow.update({
          where: { id: row.id },
          data: { status: "SKIPPED", reviewerComment: message },
        });
      }
    }

    // Cursor for client-driven continuation: rows are pending whenever the
    // commit budget ran out or the fetch window was full.
    const remainingRows = budgetExhausted || stagingRows.length === fetchSize
      ? await countCommittableStagingRows(batchId, options.rowIds, lastScannedRowNumber)
      : 0;
    const isFinalChunk = remainingRows === 0;

    await importRepository.updateBatchCounts(batchId, {
      // Intermediate chunks must not flip the batch to COMMITTED early. A batch
      // with deferred (transiently failed) rows is not fully committed either.
      ...(isFinalChunk ? { status: skippedRows > 0 || outOfScopeRows > 0 || deferredRows > 0 ? "PARTIAL_FAILED" : "COMMITTED" } : {}),
      committedRows: { increment: committedRows },
      committedById,
      committedAt: new Date(),
      summaryText: `${batch.summaryText ?? ""}\nApproved ${committedRows} normalized staging rows. Skipped ${skippedRows}. Deferred ${deferredRows} transient failure(s) for automatic re-sweep. Left outside selected scope ${outOfScopeRows}.${remainingRows ? ` ${remainingRows} row(s) pending continuation.` : ""}`.trim(),
    });
    await prisma.importMetadata.updateMany({
      where: { batchId },
      data: {
        successCount: { increment: committedRows },
        // Deferred rows are NOT failures — they stay committable and are
        // re-swept automatically, so they never inflate failedCount.
        failedCount: { increment: skippedRows },
        ...(isFinalChunk ? { status: skippedRows > 0 || outOfScopeRows > 0 || deferredRows > 0 ? "PARTIAL_FAILED" : "COMMITTED" } : {}),
      },
    });

    await writeAuditLog({
      entityType: "ImportBatch",
      entityId: batchId,
      action: "IMPORT",
      fieldName: "approveRows",
      newValue: { committedRows, skippedRows, deferredRows, outOfScopeRows, remainingRows, sheetName: options.sheetName ?? null, rowIds: options.rowIds ?? null },
      changedById: committedById,
      importBatchId: batchId,
      reason: "Approved normalized import rows into live inventory",
    });

    const commitProgress = {
      committedRows,
      skippedRows,
      // Transiently failed rows left committable for the caller's re-sweep —
      // the background worker and the client loop both restart from cursor 0
      // while this stays > 0, so a single click still commits 100%.
      deferredRows,
      outOfScopeRows,
      remainingRows,
      nextCursor: remainingRows > 0 ? lastScannedRowNumber : null,
    };
    type ApproveResult = NonNullable<Awaited<ReturnType<typeof importRepository.getBatchReviewWindow>>> & {
      commitProgress: typeof commitProgress;
    };
    if (options.progressOnly) {
      // The background worker is the only progressOnly caller and consumes
      // commitProgress exclusively; the cast keeps the public return type
      // stable for every review-window caller without fetching 2000 rows.
      return { commitProgress } as unknown as ApproveResult;
    }

    const review = await importRepository.getBatchReviewWindow(batchId);
    if (!review) throw new Error("Import batch not found after approval");
    return {
      ...review,
      commitProgress,
    } satisfies ApproveResult;
  },

  async rejectRows(batchId: string, reviewerId: string, options: { rowIds: string[]; reviewerComment?: string | null }) {
    if (!options.rowIds.length) throw new Error("Select at least one staged row to reject.");
    // Chunk the id filter (and use a positive status `in` instead of `notIn`) so
    // a huge selection is applied in parameter-safe slices rather than crashing.
    for (const idChunk of chunkIds(options.rowIds)) {
      await prisma.importStagingRow.updateMany({
        where: { importBatchId: batchId, id: { in: idChunk }, status: { in: NON_COMMITTED_ROW_STATUSES } },
        data: { status: "REJECTED", reviewerComment: options.reviewerComment ?? "Rejected during staging review." },
      });
    }
    await writeAuditLog({
      entityType: "ImportBatch",
      entityId: batchId,
      action: "IMPORT",
      fieldName: "rejectRows",
      newValue: { rowIds: options.rowIds, reviewerComment: options.reviewerComment ?? null },
      changedById: reviewerId,
      importBatchId: batchId,
      reason: "Rejected selected import staging rows",
    });
    return importRepository.getBatchReviewWindow(batchId);
  },

  async flushRows(batchId: string, reviewerId: string, options: { rowIds?: string[]; flushAll?: boolean; reviewerComment?: string | null }) {
    if (!options.flushAll && !options.rowIds?.length) throw new Error("Select staged rows or request a full batch flush.");
    const flushData = { status: "SKIPPED" as const, reviewerComment: options.reviewerComment ?? "Flushed from staging review." };
    if (options.flushAll) {
      // No id array — a positive status `in` is splittable by Prisma on its own.
      await prisma.importStagingRow.updateMany({
        where: { importBatchId: batchId, status: { in: NON_COMMITTED_ROW_STATUSES } },
        data: flushData,
      });
    } else {
      for (const idChunk of chunkIds(options.rowIds ?? [])) {
        await prisma.importStagingRow.updateMany({
          where: { importBatchId: batchId, id: { in: idChunk }, status: { in: NON_COMMITTED_ROW_STATUSES } },
          data: flushData,
        });
      }
    }
    await writeAuditLog({
      entityType: "ImportBatch",
      entityId: batchId,
      action: "IMPORT",
      fieldName: "flushRows",
      newValue: { flushAll: Boolean(options.flushAll), rowIds: options.rowIds ?? null },
      changedById: reviewerId,
      importBatchId: batchId,
      reason: options.flushAll ? "Flushed complete import batch from staging" : "Flushed selected import staging rows",
    });
    return importRepository.getBatchReviewWindow(batchId);
  },
};
