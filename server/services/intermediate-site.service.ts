import { ResourceStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeOdfCode } from "@/lib/validation/odf";
import {
  normalizePortLabel,
  normalizeRackCode,
  normalizeSiteCode,
} from "@/lib/telecom/connection-identity";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { manualSegmentService } from "@/server/services/manual-segment.service";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { inventoryService } from "@/server/services/inventory.service";
import { buildRehomedOutRemark, isRehomedOutRemark } from "@/lib/telecom/rehome";
import { resolveRegisteredEndpointAssets } from "@/server/services/inventory-asset-validation.service";

interface IntermediateInput {
  // FULL_SPLIT  = Case 1 full termination (A-C retired; A-B and B-C created).
  // PARTIAL_BRANCH = Case 2 branch breakout (A-C stays; N fibers borrowed to B and back).
  // STUB_INTERCEPT = Case 3 dead-end stub: intercept N fibers from the A side
  //   only, terminate them at B, and leave the matching C-facing fibers as an
  //   un-terminated open tail that the operator can mark open/dead manually.
  mode: "FULL_SPLIT" | "PARTIAL_BRANCH" | "STUB_INTERCEPT";
  nearSite: string;
  nearRack: string;
  nearOdf: string;
  nearPortGroup?: string | null;
  farSite: string;
  farRack: string;
  farOdf: string;
  farPortGroup?: string | null;
  insertedSite: string;
  insertedRack: string;
  insertedOdf: string;
  insertedPortGroup?: string | null;
  insertedNearRack?: string | null;
  insertedNearOdf?: string | null;
  insertedNearPortGroup?: string | null;
  insertedFarRack?: string | null;
  insertedFarOdf?: string | null;
  insertedFarPortGroup?: string | null;
  borrowedPortGroup?: string | null;
  segmentCapacity?: number | null;
  borrowedFibers?: number | null;
  carryServices?: boolean | null;
  distanceKm?: number | null;
  comments?: string | null;
}

interface SegmentSplitInput {
  mode: "FULL_SPLIT" | "PARTIAL_SPLIT";
  insertedSite: string;
  insertedNearRack: string;
  insertedNearOdf: string;
  insertedNearPortGroup: string;
  insertedFarRack: string;
  insertedFarOdf: string;
  insertedFarPortGroup: string;
  selectedFiberNumbers: number[];
  // EDIT HERE: UI child-link multi-select. When present, the split uses these
  // exact SegmentEndpointMapping rows as the source of truth for local/far
  // rack, ODF and port labels. This prevents the near-end port sequence from
  // being blindly applied to the far end.
  selectedMappingIds?: string[];
  distanceKmNear?: number | null;
  distanceKmFar?: number | null;
  comments?: string | null;
  overrideReason?: string | null;
  /** Operator confirmed the pre-split warning that the inserted site's
   * ODF/ports are already mapped to another network route. */
  acknowledgeMappedConflict?: boolean;
}

/** Pre-split infrastructure mapping conflict — surfaced to the UI as a
 * confirmable warning instead of a hard failure. */
export class MappedFiberConflictError extends Error {
  readonly conflictSites: string[];

  constructor(conflictSites: string[]) {
    super(`Warning: These fibers are mapped with another site: ${conflictSites.join(", ")}. Do you still want to proceed?`);
    this.name = "MappedFiberConflictError";
    this.conflictSites = conflictSites;
  }
}

function portNumbersFromLabelText(label?: string | null): number[] {
  const text = String(label ?? "").replace(/\s+/g, "");
  const match = text.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return [];
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) return [];
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  if (end - start > 999) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/**
 * Pre-split infrastructure mapping check: if the incoming intercept site's
 * declared ODF/port footprint is already actively mapped on a DIFFERENT
 * segment/route, the operator must explicitly confirm before committing.
 */
async function findInsertedSiteMappingConflicts(input: {
  parentSegmentId: string;
  insertedSite: string;
  insertedNearOdf: string;
  insertedNearPortGroup: string;
  insertedFarOdf: string;
  insertedFarPortGroup: string;
}): Promise<string[]> {
  const odfCodes = [...new Set([input.insertedNearOdf, input.insertedFarOdf].filter(Boolean))];
  if (!odfCodes.length) return [];

  const candidates = await prisma.segmentEndpointMapping.findMany({
    where: {
      segmentId: { not: input.parentSegmentId },
      status: { notIn: [ResourceStatus.DECOMMISSIONED, ResourceStatus.DUMMY] },
      OR: [
        { localSiteCode: input.insertedSite, localOdfCode: { in: odfCodes } },
        { farSiteCode: input.insertedSite, farOdfCode: { in: odfCodes } },
      ],
    },
    select: {
      localSiteCode: true,
      localOdfCode: true,
      localPortLabel: true,
      farSiteCode: true,
      farEndpointLabel: true,
      farOdfCode: true,
      farPortLabel: true,
      remarks: true,
      segment: { select: { segmentCode: true } },
    },
    take: 500,
  });

  const portsByOdf = new Map<string, Set<number>>();
  for (const [odf, label] of [
    [input.insertedNearOdf, input.insertedNearPortGroup],
    [input.insertedFarOdf, input.insertedFarPortGroup],
  ] as const) {
    if (!odf) continue;
    const existing = portsByOdf.get(odf) ?? new Set<number>();
    for (const port of portNumbersFromLabelText(label)) existing.add(port);
    portsByOdf.set(odf, existing);
  }

  const conflicts = new Set<string>();
  for (const mapping of candidates) {
    if (isRehomedOutRemark(mapping.remarks)) continue;
    const localPorts = portsByOdf.get(mapping.localOdfCode ?? "");
    const farPorts = portsByOdf.get(mapping.farOdfCode ?? "");
    const localHit =
      mapping.localSiteCode === input.insertedSite &&
      Boolean(localPorts?.size) &&
      portNumbersFromLabelText(mapping.localPortLabel).some((port) => localPorts!.has(port));
    const farHit =
      mapping.farSiteCode === input.insertedSite &&
      Boolean(farPorts?.size) &&
      portNumbersFromLabelText(mapping.farPortLabel).some((port) => farPorts!.has(port));
    if (!localHit && !farHit) continue;
    const otherSite = localHit
      ? mapping.farSiteCode ?? mapping.farEndpointLabel ?? "UNKNOWN"
      : mapping.localSiteCode ?? "UNKNOWN";
    conflicts.add(`${otherSite}${mapping.segment?.segmentCode ? ` (${mapping.segment.segmentCode})` : ""}`);
  }
  return [...conflicts].sort();
}

// EDIT HERE: Segment split validation supports both normalized SegmentFiber rows
// and imported child mapping rows. Some migrated records only have
// SegmentEndpointMapping.fiberNumbersJson, so validating only LinkSegment.fibers
// causes false errors like “selected fibers do not belong to parent segment”.
type ParentFiberSource = {
  fiberNumber: number;
  status: ResourceStatus;
  serviceCode?: string | null;
  mappingId?: string | null;
  /** False for faulty/dummy/decommissioned/rehomed-out records — these are
   * never part of the live split domain the operator selects from. */
  isLive: boolean;
};

type ParentMappingSource = {
  id: string;
  localSiteCode?: string | null;
  localRackCode?: string | null;
  localOdfCode?: string | null;
  localPortLabel?: string | null;
  farSiteCode?: string | null;
  farEndpointLabel?: string | null;
  farRackCode?: string | null;
  farOdfCode?: string | null;
  farPortLabel?: string | null;
  localPortGroupId?: string | null;
  farPortGroupId?: string | null;
  fiberNumbersJson?: string | null;
  serviceCode?: string | null;
  status: ResourceStatus;
  remarks?: string | null;
};

type AffectedServiceForSplit = {
  serviceId?: string | null;
  serviceCode: string;
  fiberNumbers: number[];
  isJumper: boolean;
  remarks?: string | null;
  existingAllocationId?: string | null;
};

type SplitEndpointPort = {
  siteCode: string | null;
  rackCode: string | null;
  odfCode: string | null;
  portLabel: string | null;
  portGroupId?: string | null;
};

type SplitChildMapping = {
  sourceMappingId: string | null;
  fiberNumbers: number[];
  status: ResourceStatus;
  serviceCode?: string | null;
  remarks?: string | null;
  originalA: SplitEndpointPort;
  originalB: SplitEndpointPort;
};

function endpoint(site: string, rack: string, odf: string, port?: string | null) {
  return {
    rawSiteCode: normalizeSiteCode(site),
    rawRackCode: normalizeRackCode(rack),
    rawOdfCode: normalizeOdfCode(odf),
    rawPortText: normalizePortLabel(port),
  };
}

async function findActiveDirectSegment(siteA: string, siteB: string) {
  const pairKey = buildSitePairKey(normalizeSiteCode(siteA), normalizeSiteCode(siteB));
  return prisma.linkSegment.findFirst({
    where: {
      sitePairKey: pairKey,
      status: { not: ResourceStatus.DECOMMISSIONED },
    },
    include: {
      endpointA: { include: { site: true } },
      endpointB: { include: { site: true } },
      fibers: { orderBy: { fiberNumber: "desc" } },
      serviceAllocations: {
        where: { status: ResourceStatus.ACTIVE },
        include: { service: true },
        orderBy: { pathOrder: "asc" },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
  });
}

function fiberNumbersForAllocation(allocation: { fiberNumbersJson?: string | null; fiberStart: number; fiberEnd: number }): number[] {
  try {
    const parsed = JSON.parse(allocation.fiberNumbersJson ?? "[]");
    if (Array.isArray(parsed)) {
      const values = parsed.map(Number).filter((value) => Number.isInteger(value) && value > 0);
      if (values.length) return [...new Set(values)].sort((a, b) => a - b);
    }
  } catch {
    // Fall back to the stored allocation range below.
  }
  const start = Math.min(allocation.fiberStart, allocation.fiberEnd);
  const end = Math.max(allocation.fiberStart, allocation.fiberEnd);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function parsePortNumbers(label?: string | null): number[] {
  // EDIT HERE: Split ODF port range parser.
  // A label like "1-6" is a sequential ODF port range: 1,2,3,4,5,6.
  // Manual overrides such as "1,3,5" or "1-2,5-6" are also supported.
  // This parser is for ODF ports only; it must not infer extra ports from tube/fiber metadata.
  const cleaned = String(label ?? "").replace(/\s+/g, "").trim();
  if (!cleaned) return [];

  const ports: number[] = [];
  for (const token of cleaned.split(",").filter(Boolean)) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : first;
    if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) continue;
    const start = Math.min(first, second);
    const end = Math.max(first, second);
    if (end - start > 999) continue;
    for (let value = start; value <= end; value += 1) ports.push(value);
  }

  return [...new Set(ports)].sort((a, b) => a - b);
}

function compactPortLabelFromNumbers(values: number[]): string | null {
  const clean = [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!clean.length) return null;
  const isConsecutive = clean.every((value, index) => index === 0 || value === clean[index - 1] + 1);
  if (clean.length === 1) return String(clean[0]);
  return isConsecutive ? `${clean[0]}-${clean[clean.length - 1]}` : clean.join(",");
}

function odfPortCount(label?: string | null, fallback = 1): number {
  // EDIT HERE: One ODF port remains one ODF port. Do not scale a 1-port
  // service to two inserted-site ports just because migrated fiber metadata
  // contains two fiber numbers.
  const ports = parsePortNumbers(label);
  return ports.length || Math.max(1, fallback);
}

function portLabelForSelectedMapping(
  sourceLabel: string | null | undefined,
  allMappingFibers: number[],
  selectedFibers: number[],
  preserveWholeMapping: boolean,
): string | null {
  const normalized = normalizePortLabel(sourceLabel);
  if (preserveWholeMapping) return normalized;
  return remapPortLabelForSelectedFibers(normalized, allMappingFibers, selectedFibers);
}

function labelForFiber(fiberNumber: number): string {
  return String(fiberNumber);
}

function normalizePortLabelOrFallback(value?: string | null, fallback?: string | null): string | null {
  return normalizePortLabel(value) ?? normalizePortLabel(fallback) ?? null;
}

// EDIT HERE: Split port-alignment logic. Existing parent child links are the
// source of truth. The far-end side must keep its existing ODF/rack/port labels;
// only the inserted site receives the new user-entered ascending port sequence.
function sideFromParentMapping(mapping: ParentMappingSource, siteCode: string, fallbackSide: "A" | "B"): SplitEndpointPort {
  const normalizedSite = normalizeSiteCode(siteCode);
  const localSite = normalizeSiteCode(mapping.localSiteCode);
  const farSite = normalizeSiteCode(mapping.farSiteCode ?? mapping.farEndpointLabel);
  const useLocal = localSite && normalizedSite && localSite === normalizedSite
    ? true
    : farSite && normalizedSite && farSite === normalizedSite
      ? false
      : fallbackSide === "A";

  return useLocal
    ? {
        siteCode: localSite ?? normalizedSite,
        rackCode: normalizeRackCode(mapping.localRackCode),
        odfCode: normalizeOdfCode(mapping.localOdfCode),
        portLabel: normalizePortLabel(mapping.localPortLabel),
        portGroupId: mapping.localPortGroupId ?? null,
      }
    : {
        siteCode: farSite ?? normalizedSite,
        rackCode: normalizeRackCode(mapping.farRackCode),
        odfCode: normalizeOdfCode(mapping.farOdfCode),
        portLabel: normalizePortLabel(mapping.farPortLabel),
        portGroupId: mapping.farPortGroupId ?? null,
      };
}

function remapPortLabelForSelectedFibers(sourceLabel: string | null | undefined, allMappingFibers: number[], selectedFibers: number[]): string | null {
  const normalized = normalizePortLabel(sourceLabel);
  const sourcePorts = parsePortNumbers(normalized);
  if (sourcePorts.length && sourcePorts.length === allMappingFibers.length) {
    const selectedPorts = selectedFibers
      .map((fiberNumber) => allMappingFibers.indexOf(fiberNumber))
      .filter((index) => index >= 0)
      .map((index) => sourcePorts[index])
      .filter((value) => Number.isInteger(value) && value > 0);
    return compactPortLabelFromNumbers(selectedPorts) ?? normalized;
  }
  return selectedFibers.length === allMappingFibers.length ? normalized : compactPortLabelFromNumbers(selectedFibers) ?? normalized;
}

function allocateInsertedPortLabels(portGroupLabel: string, chunkSizes: number[]): string[] {
  const ports = parsePortNumbers(portGroupLabel);
  if (!ports.length) return chunkSizes.map((_, index) => index === 0 ? normalizePortLabel(portGroupLabel) ?? null : null).map((value) => value ?? "");
  const labels: string[] = [];
  let cursor = 0;
  for (const size of chunkSizes) {
    const chunk = ports.slice(cursor, cursor + size);
    if (chunk.length < size) throw new Error("New node port count is less than the selected child-link fiber count. Add ODF/Rack inventory or enter a larger port range.");
    labels.push(compactPortLabelFromNumbers(chunk) ?? String(chunk[0]));
    cursor += size;
  }
  return labels;
}

function selectedChildMappingsFromParent(
  parent: { endpointMappings: ParentMappingSource[] },
  selectedFiberNumbers: number[],
  selectedMappingIds?: string[],
  siteA?: string,
  siteB?: string,
): SplitChildMapping[] {
  const selected = new Set(selectedFiberNumbers);
  const selectedIds = new Set((selectedMappingIds ?? []).filter(Boolean));
  const mappings = parent.endpointMappings
    .filter((mapping) => {
      if (selectedIds.size) return selectedIds.has(mapping.id);
      return fiberNumbersFromMapping(mapping).some((fiberNumber) => selected.has(fiberNumber));
    })
    .map((mapping) => {
      const allFibers = fiberNumbersFromMapping(mapping);
      const fiberNumbers = selectedIds.size ? allFibers : allFibers.filter((fiberNumber) => selected.has(fiberNumber));
      const originalA = sideFromParentMapping(mapping, siteA ?? mapping.localSiteCode ?? "", "A");
      const originalB = sideFromParentMapping(mapping, siteB ?? mapping.farSiteCode ?? "", "B");
      return {
        sourceMappingId: mapping.id,
        fiberNumbers,
        status: mapping.serviceCode?.trim() ? ResourceStatus.ACTIVE : mapping.status,
        serviceCode: mapping.serviceCode ?? null,
        remarks: mapping.remarks ?? null,
        originalA: {
          ...originalA,
          // EDIT HERE: Port preservation for partial split.
          // If the user selected the child ODF-port mapping row, preserve that
          // row's original port label exactly. Never re-number 19-24 into 13-18.
          portLabel: portLabelForSelectedMapping(originalA.portLabel, allFibers, fiberNumbers, selectedIds.has(mapping.id)),
        },
        originalB: {
          ...originalB,
          portLabel: portLabelForSelectedMapping(originalB.portLabel, allFibers, fiberNumbers, selectedIds.has(mapping.id)),
        },
      } satisfies SplitChildMapping;
    })
    .filter((mapping) => mapping.fiberNumbers.length)
    .sort((a, b) => Math.min(...a.fiberNumbers) - Math.min(...b.fiberNumbers));

  return mappings;
}

function sortedUniqueFiberNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function cleanSiteCode(value?: string | null): string | null {
  return normalizeSiteCode(value);
}

function endpointCode(endpoint: { site?: { code: string } | null; rawSiteCode?: string | null }): string | null {
  return cleanSiteCode(endpoint.site?.code ?? endpoint.rawSiteCode);
}

function requireSegmentEndpointCodes(segment: {
  endpointA: { site?: { code: string } | null; rawSiteCode?: string | null };
  endpointB: { site?: { code: string } | null; rawSiteCode?: string | null };
}) {
  const siteA = endpointCode(segment.endpointA);
  const siteB = endpointCode(segment.endpointB);
  if (!siteA || !siteB) throw new Error("Parent segment endpoints are incomplete. Correct the segment endpoints before splitting.");
  return { siteA, siteB };
}

async function ensureEndpointAssetsInTx(
  tx: any,
  input: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null; portLabel?: string | null },
) {
  const assets = await resolveRegisteredEndpointAssets(tx, input);
  const { siteId, rackId, odfId, siteCode, rackCode, odfCode } = assets;
  const portLabel = normalizePortLabel(input.portLabel);

  if (!portLabel) {
    return { siteId, rackId, odfId, portGroupId: null, siteCode, rackCode, odfCode, portLabel };
  }

  const ports = parsePortNumbers(portLabel);
  const portGroup = await tx.portGroup.upsert({
    where: { odfId_displayLabel: { odfId, displayLabel: portLabel } },
    update: {},
    create: {
      siteId,
      rackId,
      odfId,
      groupType: ports.length === 1 ? "SINGLE" : ports.length === 2 ? "PAIR" : "CUSTOM",
      displayLabel: portLabel,
      startPortNumber: ports[0] ?? null,
      endPortNumber: ports[ports.length - 1] ?? null,
      status: "ACTIVE",
      source: "MANUAL",
    },
    select: { id: true },
  });

  for (let index = 0; index < ports.length; index += 1) {
    const odfPort = await tx.oDFPort.upsert({
      where: { odfId_portNumber: { odfId, portNumber: ports[index] } },
      update: {},
      create: { odfId, portNumber: ports[index], label: String(ports[index]), status: "ACTIVE" },
      select: { id: true },
    });
    await tx.portGroupMember.upsert({
      where: { portGroupId_odfPortId: { portGroupId: portGroup.id, odfPortId: odfPort.id } },
      update: { sequence: index + 1 },
      create: { portGroupId: portGroup.id, odfPortId: odfPort.id, sequence: index + 1 },
    });
  }

  return { siteId, rackId, odfId, portGroupId: portGroup.id, siteCode, rackCode, odfCode, portLabel };
}

function endpointPayloadFromExisting(endpoint: any, siteCode: string) {
  return {
    siteCode,
    rackCode: endpoint.rack?.rackCode ?? endpoint.rawRackCode,
    odfCode: endpoint.odf?.odfCode ?? endpoint.rawOdfCode,
    portLabel: endpoint.portGroup?.displayLabel ?? endpoint.displayPortText ?? endpoint.rawPortText,
  };
}

// EDIT HERE: Split segment naming convention.
// New split segments must be named by the actual endpoints they connect, not by
// appending the inserted site to the old parent name. Example:
// Parent X-Z-C01-12F + inserted Y + 6 selected fibers becomes:
//   X-Y-C01-6F
//   Y-Z-C01-6F
function segmentDetailsFromParentCode(parentCode: string, siteA: string, siteB: string): string | null {
  const normalizedParent = parentCode.trim();
  const forwardPrefix = `${siteA}-${siteB}-`;
  const reversePrefix = `${siteB}-${siteA}-`;
  if (normalizedParent.startsWith(forwardPrefix)) return normalizedParent.slice(forwardPrefix.length) || null;
  if (normalizedParent.startsWith(reversePrefix)) return normalizedParent.slice(reversePrefix.length) || null;

  // Fallback for parent codes that are not exactly `${siteA}-${siteB}-…`
  // (e.g. a manual `SEG-A-B`, or a leading token before the site pair). Take only
  // the trailing descriptor AFTER the last endpoint-site token, and defensively
  // strip any residual site token. This prevents the old `tokens.slice(2)` from
  // echoing the far-site code back into the name (which produced doubled split
  // codes like `X-Z-Z-6F`). Naming/display only — no mapping or capacity logic.
  const tokens = normalizedParent.split("-").filter(Boolean);
  const siteTokens = new Set([siteA, siteB]);
  let lastSiteIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (siteTokens.has(tokens[index])) lastSiteIndex = index;
  }
  const detailTokens = (lastSiteIndex >= 0 ? tokens.slice(lastSiteIndex + 1) : tokens.slice(2))
    .filter((token) => !siteTokens.has(token));
  return detailTokens.join("-") || null;
}

function detailsWithCapacity(details: string | null, fiberCount: number): string {
  const fallback = `${fiberCount}F`;
  if (!details?.trim()) return fallback;
  const clean = details.trim();
  if (/\d+\s*F$/i.test(clean)) return clean.replace(/\d+\s*F$/i, `${fiberCount}F`);
  return `${clean}-${fallback}`;
}

async function uniqueSegmentCodeInTx(tx: any, baseCode: string): Promise<string> {
  let segmentCode = baseCode;
  let suffix = 1;
  while (await tx.linkSegment.findUnique({ where: { segmentCode }, select: { id: true } })) {
    suffix += 1;
    segmentCode = `${baseCode}-${suffix}`;
  }
  return segmentCode;
}

function splitSegmentCodeBase(endpointA: string, endpointB: string, details: string): string {
  return `${endpointA}-${endpointB}-${details}`;
}

async function createSplitSegmentInTx(
  tx: any,
  input: {
    parent: any;
    segmentCodeBase: string;
    segmentGroupName: string;
    endpointA: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null; portLabel?: string | null };
    endpointB: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null; portLabel?: string | null };
    mappingRows: Array<{
      fiberNumbers: number[];
      status: ResourceStatus;
      serviceCode?: string | null;
      remarks?: string | null;
      local: SplitEndpointPort;
      far: SplitEndpointPort;
    }>;
    // EDIT HERE: Live capacity comes from ODF port count, not migrated helper fiber IDs.
    liveCapacityFibers?: number | null;
    distanceKm?: number | null;
    comments?: string | null;
  },
) {
  const endpointAAssets = await ensureEndpointAssetsInTx(tx, input.endpointA);
  const endpointBAssets = await ensureEndpointAssetsInTx(tx, input.endpointB);
  if (!endpointAAssets.siteCode || !endpointBAssets.siteCode || !endpointAAssets.rackCode || !endpointAAssets.odfCode || !endpointBAssets.rackCode || !endpointBAssets.odfCode) {
    throw new Error("Both new split segment endpoints require site, rack, and ODF values.");
  }

  const selectedFibers = [...new Set(input.mappingRows.flatMap((mapping) => mapping.fiberNumbers))].sort((a, b) => a - b);
  if (!selectedFibers.length) throw new Error("No child fiber links were selected for the split.");
  const liveCapacity = Math.max(1, Number(input.liveCapacityFibers ?? selectedFibers.length));
  const segmentCode = await uniqueSegmentCodeInTx(tx, input.segmentCodeBase);

  const endpointA = await tx.segmentEndpoint.create({
    data: {
      endpointSide: "A",
      siteId: endpointAAssets.siteId,
      rackId: endpointAAssets.rackId,
      odfId: endpointAAssets.odfId,
      portGroupId: endpointAAssets.portGroupId,
      rawSiteCode: endpointAAssets.siteCode,
      rawRackCode: endpointAAssets.rackCode,
      rawOdfCode: endpointAAssets.odfCode,
      rawPortText: endpointAAssets.portLabel,
      displayPortText: endpointAAssets.portLabel,
      terminationStatus: "ACTIVE",
      remarks: input.comments,
    },
  });
  const endpointB = await tx.segmentEndpoint.create({
    data: {
      endpointSide: "B",
      siteId: endpointBAssets.siteId,
      rackId: endpointBAssets.rackId,
      odfId: endpointBAssets.odfId,
      portGroupId: endpointBAssets.portGroupId,
      rawSiteCode: endpointBAssets.siteCode,
      rawRackCode: endpointBAssets.rackCode,
      rawOdfCode: endpointBAssets.odfCode,
      rawPortText: endpointBAssets.portLabel,
      displayPortText: endpointBAssets.portLabel,
      terminationStatus: "ACTIVE",
      remarks: input.comments,
    },
  });

  const segment = await tx.linkSegment.create({
    data: {
      segmentCode,
      segmentGroupName: input.segmentGroupName,
      segmentCapacityFibers: liveCapacity,
      sitePairKey: buildSitePairKey(endpointAAssets.siteCode, endpointBAssets.siteCode),
      endpointAId: endpointA.id,
      endpointBId: endpointB.id,
      cableId: input.parent.cableId,
      routeLabel: input.comments,
      totalFiberCapacity: liveCapacity,
      usableFiberCapacity: liveCapacity,
      availableFiberCount: liveCapacity,
      distanceKm: input.distanceKm ?? null,
      status: "ACTIVE",
      source: "MANUAL",
      manualOverride: true,
      overrideReason: `Split from ${input.parent.segmentCode}`,
      comments: input.comments,
    },
    include: { endpointA: true, endpointB: true },
  });

  for (const fiberNumber of selectedFibers) {
    await tx.segmentFiber.create({
      data: {
        segmentId: segment.id,
        fiberNumber,
        status: "AVAILABLE",
        tubeNumber: input.parent.tubeNumber,
        tubeColor: input.parent.tubeColor,
        tubeLabel: input.parent.tubeLabel,
        fiberPortNumber: input.parent.fiberPortNumber ? input.parent.fiberPortNumber + fiberNumber - 1 : null,
        fiberLabel: input.parent.fiberLabel,
      },
    });
  }

  for (const mapping of input.mappingRows) {
    // EDIT HERE: Child mapping preservation. Do not generate far-end ports from
    // the near-end sequence. local/far are already prepared from the selected
    // child-link payload so existing endpoint ports remain aligned.
    await tx.segmentEndpointMapping.create({
      data: {
        segmentId: segment.id,
        localSiteCode: normalizeSiteCode(mapping.local.siteCode) ?? endpointAAssets.siteCode,
        localRackCode: normalizeRackCode(mapping.local.rackCode) ?? endpointAAssets.rackCode,
        localOdfCode: normalizeOdfCode(mapping.local.odfCode) ?? endpointAAssets.odfCode,
        localPortLabel: normalizePortLabelOrFallback(mapping.local.portLabel, endpointAAssets.portLabel),
        farSiteCode: normalizeSiteCode(mapping.far.siteCode) ?? endpointBAssets.siteCode,
        farRackCode: normalizeRackCode(mapping.far.rackCode) ?? endpointBAssets.rackCode,
        farOdfCode: normalizeOdfCode(mapping.far.odfCode) ?? endpointBAssets.odfCode,
        farPortLabel: normalizePortLabelOrFallback(mapping.far.portLabel, endpointBAssets.portLabel),
        localPortGroupId: mapping.local.portGroupId ?? endpointAAssets.portGroupId,
        farPortGroupId: mapping.far.portGroupId ?? endpointBAssets.portGroupId,
        fiberNumbersJson: JSON.stringify(mapping.fiberNumbers),
        serviceCode: mapping.serviceCode?.trim() || null,
        status: mapping.serviceCode?.trim() ? ResourceStatus.ACTIVE : mapping.status,
        source: "MANUAL",
        remarks: mapping.remarks ?? input.comments,
      },
    });
  }

  return segment;
}

function allocationFiberNumbers(allocation: { fiberNumbersJson?: string | null; fiberStart: number; fiberEnd: number }): number[] {
  try {
    const parsed = JSON.parse(allocation.fiberNumbersJson ?? "[]");
    if (Array.isArray(parsed)) {
      const values = parsed.map(Number).filter((value) => Number.isInteger(value) && value > 0);
      if (values.length) return [...new Set(values)].sort((a, b) => a - b);
    }
  } catch {
    // Fall back to allocation range.
  }
  const start = Math.min(allocation.fiberStart, allocation.fiberEnd);
  const end = Math.max(allocation.fiberStart, allocation.fiberEnd);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function fiberNumbersFromMapping(mapping: ParentMappingSource): number[] {
  try {
    const parsed = JSON.parse(mapping.fiberNumbersJson ?? "[]");
    if (Array.isArray(parsed)) {
      const values = parsed.map(Number).filter((value) => Number.isInteger(value) && value > 0);
      if (values.length) return [...new Set(values)].sort((a, b) => a - b);
    }
  } catch {
    // Fall through to port-label parsing.
  }

  const text = String(mapping.localPortLabel ?? mapping.farPortLabel ?? "").replace(/\s+/g, "");
  const match = text.match(/^(\d+)(?:-(\d+))?$/);
  if (match) {
    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : first;
    if (Number.isInteger(first) && Number.isInteger(second) && first > 0 && second > 0) {
      const start = Math.min(first, second);
      const end = Math.max(first, second);
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }

  return [];
}

const LIVE_PARENT_FIBER_STATUSES = new Set<ResourceStatus>([
  ResourceStatus.ACTIVE,
  ResourceStatus.AVAILABLE,
  ResourceStatus.SPARE,
  ResourceStatus.USED,
  ResourceStatus.RESERVED,
]);

function resolvedParentFibers(parent: {
  fibers: Array<{ fiberNumber: number; status: ResourceStatus; serviceCode?: string | null; remarks?: string | null }>;
  endpointMappings: ParentMappingSource[];
}): ParentFiberSource[] {
  const byFiberNumber = new Map<number, ParentFiberSource>();

  // DOMAIN ISOLATION FIX: when imported port-to-port mapping rows exist they
  // are the authoritative split domain — they carry the ODF port numbering the
  // operator sees and selects in the UI. The internal SegmentFiber ledger can
  // use a DIFFERENT numbering domain (sequential 1..capacity vs physical ODF
  // ports like 25-36), and unioning both double-counted the parent, so a full
  // split that covered every visible child link was still rejected with
  // "Full split must include all live parent fibers".
  if (parent.endpointMappings.length) {
    for (const mapping of parent.endpointMappings) {
      const rehomedOut = isRehomedOutRemark(mapping.remarks);
      const mappingStatus = mapping.serviceCode?.trim() ? ResourceStatus.ACTIVE : mapping.status;
      const isLive = !rehomedOut && LIVE_PARENT_FIBER_STATUSES.has(mappingStatus);
      for (const fiberNumber of fiberNumbersFromMapping(mapping)) {
        const existing = byFiberNumber.get(fiberNumber);
        if (!existing) {
          byFiberNumber.set(fiberNumber, {
            fiberNumber,
            status: mappingStatus,
            serviceCode: mapping.serviceCode ?? null,
            mappingId: mapping.id,
            isLive,
          });
        } else if (!existing.serviceCode && mapping.serviceCode) {
          byFiberNumber.set(fiberNumber, {
            ...existing,
            serviceCode: mapping.serviceCode,
            status: ResourceStatus.ACTIVE,
            mappingId: mapping.id,
            isLive: existing.isLive || isLive,
          });
        } else if (isLive && !existing.isLive) {
          byFiberNumber.set(fiberNumber, { ...existing, isLive: true });
        }
      }
    }
    return [...byFiberNumber.values()].sort((a, b) => a.fiberNumber - b.fiberNumber);
  }

  // Fallback for segments with no mapping rows: the fiber ledger is the only
  // available domain.
  for (const fiber of parent.fibers) {
    byFiberNumber.set(fiber.fiberNumber, {
      fiberNumber: fiber.fiberNumber,
      status: fiber.status,
      serviceCode: fiber.serviceCode ?? null,
      isLive: !isRehomedOutRemark(fiber.remarks) && LIVE_PARENT_FIBER_STATUSES.has(fiber.status),
    });
  }

  return [...byFiberNumber.values()].sort((a, b) => a.fiberNumber - b.fiberNumber);
}

function mappingIdsOverlappingFibers(mappings: ParentMappingSource[], selectedFiberNumbers: number[]): string[] {
  const selected = new Set(selectedFiberNumbers);
  return mappings
    .filter((mapping) => fiberNumbersFromMapping(mapping).some((fiberNumber) => selected.has(fiberNumber)))
    .map((mapping) => mapping.id);
}

function affectedServicesFromParent(
  parent: {
    serviceAllocations: Array<{
      id: string;
      serviceId: string;
      service?: { serviceCode: string } | null;
      fiberNumbersJson?: string | null;
      fiberStart: number;
      fiberEnd: number;
      isJumper: boolean;
      remarks?: string | null;
    }>;
    endpointMappings: ParentMappingSource[];
  },
  selectedFiberNumbers: number[],
): AffectedServiceForSplit[] {
  const selected = new Set(selectedFiberNumbers);
  const byService = new Map<string, AffectedServiceForSplit>();

  function merge(serviceCode: string, fiberNumbers: number[], item: Partial<AffectedServiceForSplit>) {
    const cleanServiceCode = serviceCode.trim();
    if (!cleanServiceCode || !fiberNumbers.length) return;
    const existing = byService.get(cleanServiceCode);
    const mergedFibers = [...new Set([...(existing?.fiberNumbers ?? []), ...fiberNumbers])].sort((a, b) => a - b);
    byService.set(cleanServiceCode, {
      serviceCode: cleanServiceCode,
      fiberNumbers: mergedFibers,
      isJumper: existing?.isJumper ?? item.isJumper ?? false,
      serviceId: existing?.serviceId ?? item.serviceId ?? null,
      existingAllocationId: existing?.existingAllocationId ?? item.existingAllocationId ?? null,
      remarks: existing?.remarks ?? item.remarks ?? null,
    });
  }

  for (const allocation of parent.serviceAllocations) {
    const serviceCode = allocation.service?.serviceCode;
    if (!serviceCode) continue;
    const fibers = allocationFiberNumbers(allocation).filter((fiberNumber) => selected.has(fiberNumber));
    merge(serviceCode, fibers, {
      serviceId: allocation.serviceId,
      existingAllocationId: allocation.id,
      isJumper: allocation.isJumper,
      remarks: allocation.remarks,
    });
  }

  for (const mapping of parent.endpointMappings) {
    if (!mapping.serviceCode?.trim()) continue;
    const fibers = fiberNumbersFromMapping(mapping).filter((fiberNumber) => selected.has(fiberNumber));
    merge(mapping.serviceCode, fibers, { isJumper: false, remarks: mapping.remarks });
  }

  return [...byService.values()].sort((a, b) => a.serviceCode.localeCompare(b.serviceCode));
}

async function materializeParentFibersInTx(
  tx: any,
  parent: { id: string; tubeNumber?: number | null; tubeColor?: string | null; tubeLabel?: string | null; fiberPortNumber?: number | null; fiberLabel?: string | null },
  fibers: ParentFiberSource[],
) {
  for (const fiber of fibers) {
    await tx.segmentFiber.upsert({
      where: { segmentId_fiberNumber: { segmentId: parent.id, fiberNumber: fiber.fiberNumber } },
      update: {
        status: fiber.status,
        serviceCode: fiber.serviceCode ?? null,
      },
      create: {
        segmentId: parent.id,
        fiberNumber: fiber.fiberNumber,
        status: fiber.status,
        serviceCode: fiber.serviceCode ?? null,
        tubeNumber: parent.tubeNumber,
        tubeColor: parent.tubeColor,
        tubeLabel: parent.tubeLabel,
        fiberPortNumber: parent.fiberPortNumber ? parent.fiberPortNumber + fiber.fiberNumber - 1 : null,
        fiberLabel: parent.fiberLabel,
        remarks: fiber.mappingId ? `Materialized from imported mapping ${fiber.mappingId} during split validation.` : "Materialized during split validation.",
      },
    });
  }
}

function overlaps(left: number[], right: number[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function assertRequired(input: IntermediateInput) {
  const insertedNearRack = input.insertedNearRack ?? input.insertedRack;
  const insertedNearOdf = input.insertedNearOdf ?? input.insertedOdf;
  const insertedFarRack = input.insertedFarRack ?? input.insertedRack;
  const insertedFarOdf = input.insertedFarOdf ?? input.insertedOdf;
  const missing = [
    ["Near site", input.nearSite],
    ["Near rack", input.nearRack],
    ["Near ODF", input.nearOdf],
    ["Far site", input.farSite],
    ["Far rack", input.farRack],
    ["Far ODF", input.farOdf],
    ["Inserted site", input.insertedSite],
    ["B rack facing near side", insertedNearRack],
    ["B ODF facing near side", insertedNearOdf],
    ["B rack facing far side", insertedFarRack],
    ["B ODF facing far side", insertedFarOdf],
  ].filter(([, value]) => !String(value ?? "").trim()).map(([label]) => label);
  if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`);
}

export const intermediateSiteService = {
  async splitSegment(segmentId: string, input: SegmentSplitInput, changedById?: string | null) {
    const selectedFiberNumbers = sortedUniqueFiberNumbers(input.selectedFiberNumbers);
    const selectedMappingIds = Array.isArray(input.selectedMappingIds)
      ? [...new Set(input.selectedMappingIds.map(String).filter(Boolean))]
      : [];
    if (!selectedFiberNumbers.length) throw new Error("Select at least one live fiber before splitting a segment.");

    const insertedSite = normalizeSiteCode(input.insertedSite);
    const insertedNearRack = normalizeRackCode(input.insertedNearRack);
    const insertedNearOdf = normalizeOdfCode(input.insertedNearOdf);
    const insertedNearPortGroup = normalizePortLabel(input.insertedNearPortGroup);
    const insertedFarRack = normalizeRackCode(input.insertedFarRack);
    const insertedFarOdf = normalizeOdfCode(input.insertedFarOdf);
    const insertedFarPortGroup = normalizePortLabel(input.insertedFarPortGroup);
    const missing = [
      ["Inserted site", insertedSite],
      ["Inserted rack facing A", insertedNearRack],
      ["Inserted ODF facing A", insertedNearOdf],
      ["Inserted port group facing A", insertedNearPortGroup],
      ["Inserted rack facing B", insertedFarRack],
      ["Inserted ODF facing B", insertedFarOdf],
      ["Inserted port group facing B", insertedFarPortGroup],
    ].filter(([, value]) => !String(value ?? "").trim()).map(([label]) => label);
    if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`);

    // Pre-split infrastructure mapping warning: the inserted site's declared
    // ODF/port footprint may already belong to another live route. Surface a
    // confirmable warning before any data is written.
    if (!input.acknowledgeMappedConflict) {
      const conflictSites = await findInsertedSiteMappingConflicts({
        parentSegmentId: segmentId,
        insertedSite: insertedSite ?? "",
        insertedNearOdf: insertedNearOdf ?? "",
        insertedNearPortGroup: insertedNearPortGroup ?? "",
        insertedFarOdf: insertedFarOdf ?? "",
        insertedFarPortGroup: insertedFarPortGroup ?? "",
      });
      if (conflictSites.length) throw new MappedFiberConflictError(conflictSites);
    }

    const parent = await prisma.linkSegment.findUnique({
      where: { id: segmentId },
      include: {
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
        fibers: { orderBy: { fiberNumber: "asc" } },
        endpointMappings: { orderBy: [{ localPortLabel: "asc" }, { farPortLabel: "asc" }] },
        serviceAllocations: {
          where: { status: ResourceStatus.ACTIVE },
          include: { service: true },
          orderBy: { pathOrder: "asc" },
        },
      },
    });
    if (!parent) throw new Error("Parent segment was not found.");
    if (parent.status === ResourceStatus.DECOMMISSIONED) throw new Error("A decommissioned segment cannot be split.");

    const { siteA, siteB } = requireSegmentEndpointCodes(parent);
    const selectedSet = new Set(selectedFiberNumbers);
    const parentFibersForSplit = resolvedParentFibers(parent);
    const parentFiberNumbers = new Set(parentFibersForSplit.map((fiber) => fiber.fiberNumber));
    const missingFibers = selectedFiberNumbers.filter((fiberNumber) => !parentFiberNumbers.has(fiberNumber));
    if (missingFibers.length) {
      throw new Error(`Selected fibers do not belong to parent segment ${parent.segmentCode}: ${missingFibers.join(", ")}. Parent has ${parentFibersForSplit.length} mapped fiber(s). Refresh the row or check imported child mappings.`);
    }

    const invalidFibers = parentFibersForSplit.filter((fiber) => selectedSet.has(fiber.fiberNumber) && !fiber.isLive);
    if (invalidFibers.length) {
      throw new Error(`Selected fibers include faulty/dummy/decommissioned/rehomed fibers: ${invalidFibers.map((fiber) => fiber.fiberNumber).join(", ")}.`);
    }

    // Mode validation runs against the LIVE parent fiber set only. Dead or
    // rehomed-out remnants from earlier splits are not part of the selectable
    // domain, so they must never block a full split or force a partial one.
    const liveParentFibers = parentFibersForSplit.filter((fiber) => fiber.isLive);
    if (input.mode === "PARTIAL_SPLIT" && liveParentFibers.length > 0 && selectedFiberNumbers.length === liveParentFibers.length) {
      throw new Error("Partial split selected all live parent fibers. Use Split Fully for a complete termination.");
    }
    if (input.mode === "FULL_SPLIT") {
      const unselectedLive = liveParentFibers.filter((fiber) => !selectedSet.has(fiber.fiberNumber));
      if (unselectedLive.length) {
        throw new Error(
          `Full split must include all live parent fibers. Missing live fiber(s): ${unselectedLive.map((fiber) => fiber.fiberNumber).join(", ")}. Use Split Partially for selected fibers only.`,
        );
      }
    }

    if (!selectedMappingIds.length) {
      const incompleteChildSelections = parent.endpointMappings
        .map((mapping) => ({ mapping, fibers: fiberNumbersFromMapping(mapping) }))
        .filter(({ fibers }) => {
          const matched = fibers.filter((fiberNumber) => selectedSet.has(fiberNumber));
          return matched.length > 0 && matched.length < fibers.length;
        });
      if (incompleteChildSelections.length) {
        throw new Error(`Split selection cuts through a child link/pair on ${parent.segmentCode}. Select the complete child link row instead of only part of ${incompleteChildSelections.map(({ mapping }) => mapping.localPortLabel ?? mapping.farPortLabel ?? mapping.id).join(", ")}.`);
      }
    }

    const selectedChildMappings = selectedChildMappingsFromParent(parent, selectedFiberNumbers, selectedMappingIds, siteA, siteB);
    if (!selectedChildMappings.length) {
      throw new Error("No selected child links were found on the parent segment. Expand the row and select child links/fibers from the child table before splitting.");
    }
    const selectedChildFibers = [...new Set(selectedChildMappings.flatMap((mapping) => mapping.fiberNumbers))].sort((a, b) => a - b);
    const selectedChildFiberSet = new Set(selectedChildFibers);
    const requestedButUnmapped = selectedFiberNumbers.filter((fiberNumber) => !selectedChildFiberSet.has(fiberNumber));
    if (requestedButUnmapped.length) {
      throw new Error(`Selected fibers are not aligned to complete child-link mappings on ${parent.segmentCode}: ${requestedButUnmapped.join(", ")}. Select the child link row/pair instead of an isolated fiber.`);
    }

    // EDIT HERE: Inserted-site port allocation is based on selected ODF port-link size,
    // not raw fiber metadata. This prevents a 1-port service like E:9 -> A:9 from
    // becoming a false 2-port inserted-site mapping.
    const nearChildPortSizes = selectedChildMappings.map((mapping) => odfPortCount(mapping.originalA.portLabel, mapping.fiberNumbers.length));
    const farChildPortSizes = selectedChildMappings.map((mapping) => odfPortCount(mapping.originalB.portLabel, mapping.fiberNumbers.length));
    const mismatchedPortLinks = selectedChildMappings
      .map((mapping, index) => ({ mapping, near: nearChildPortSizes[index], far: farChildPortSizes[index] }))
      .filter(({ near, far }) => near !== far);
    if (mismatchedPortLinks.length) {
      throw new Error(`Selected child links have local/far ODF port-count mismatch. Fix the child mapping before split: ${mismatchedPortLinks.map(({ mapping, near, far }) => `${mapping.originalA.odfCode ?? "A"}:${mapping.originalA.portLabel ?? "?"} (${near}) -> ${mapping.originalB.odfCode ?? "B"}:${mapping.originalB.portLabel ?? "?"} (${far})`).join("; ")}`);
    }
    const selectedLivePortCount = nearChildPortSizes.reduce((sum, count) => sum + count, 0);
    const nearInsertedLabels = allocateInsertedPortLabels(insertedNearPortGroup!, nearChildPortSizes);
    const farInsertedLabels = allocateInsertedPortLabels(insertedFarPortGroup!, farChildPortSizes);

    const affectedServices = affectedServicesFromParent(parent, selectedChildFibers);
    const selectedMappingIdsForRetire = selectedMappingIds.length ? selectedMappingIds : mappingIdsOverlappingFibers(parent.endpointMappings, selectedChildFibers);

    const splitDetails = detailsWithCapacity(
      segmentDetailsFromParentCode(parent.segmentCode, siteA, siteB),
      selectedLivePortCount,
    );
    const axSegmentCodeBase = splitSegmentCodeBase(siteA, insertedSite!, splitDetails);
    const xbSegmentCodeBase = splitSegmentCodeBase(insertedSite!, siteB, splitDetails);
    const axSegmentGroupName = `${siteA}-${insertedSite}`;
    const xbSegmentGroupName = `${insertedSite}-${siteB}`;

    const result = await prisma.$transaction(async (tx) => {
      await materializeParentFibersInTx(tx, parent, parentFibersForSplit);

      const ax = await createSplitSegmentInTx(tx, {
        parent,
        segmentCodeBase: axSegmentCodeBase,
        segmentGroupName: axSegmentGroupName,
        endpointA: endpointPayloadFromExisting(parent.endpointA, siteA),
        endpointB: { siteCode: insertedSite, rackCode: insertedNearRack, odfCode: insertedNearOdf, portLabel: insertedNearPortGroup },
        mappingRows: selectedChildMappings.map((mapping, index) => ({
          fiberNumbers: mapping.fiberNumbers,
          status: mapping.status,
          serviceCode: mapping.serviceCode,
          remarks: mapping.remarks,
          local: mapping.originalA,
          far: { siteCode: insertedSite, rackCode: insertedNearRack, odfCode: insertedNearOdf, portLabel: nearInsertedLabels[index] },
        })),
        liveCapacityFibers: selectedLivePortCount,
        distanceKm: input.distanceKmNear ?? null,
        comments: input.comments ?? `${input.mode === "FULL_SPLIT" ? "Full" : "Partial"} split from ${parent.segmentCode}`,
      });
      const xb = await createSplitSegmentInTx(tx, {
        parent,
        segmentCodeBase: xbSegmentCodeBase,
        segmentGroupName: xbSegmentGroupName,
        endpointA: { siteCode: insertedSite, rackCode: insertedFarRack, odfCode: insertedFarOdf, portLabel: insertedFarPortGroup },
        endpointB: endpointPayloadFromExisting(parent.endpointB, siteB),
        mappingRows: selectedChildMappings.map((mapping, index) => ({
          fiberNumbers: mapping.fiberNumbers,
          status: mapping.status,
          serviceCode: mapping.serviceCode,
          remarks: mapping.remarks,
          local: { siteCode: insertedSite, rackCode: insertedFarRack, odfCode: insertedFarOdf, portLabel: farInsertedLabels[index] },
          far: mapping.originalB,
        })),
        liveCapacityFibers: selectedLivePortCount,
        distanceKm: input.distanceKmFar ?? null,
        comments: input.comments ?? `${input.mode === "FULL_SPLIT" ? "Full" : "Partial"} split from ${parent.segmentCode}`,
      });

      for (const affectedService of affectedServices) {
        const service = affectedService.serviceId
          ? await tx.service.findUnique({ where: { id: affectedService.serviceId } })
          : await tx.service.upsert({
              where: { serviceCode: affectedService.serviceCode },
              update: {},
              create: {
                serviceCode: affectedService.serviceCode,
                serviceName: affectedService.serviceCode,
                serviceType: "UNKNOWN",
                status: "ACTIVE",
                remarks: `Created from imported segment mapping during split of ${parent.segmentCode}.`,
              },
            });
        if (!service?.id) continue;

        await tx.serviceRoute.updateMany({
          where: { serviceId: service.id, isActive: true },
          data: { isActive: false, remarks: `Superseded by ${input.mode === "FULL_SPLIT" ? "full" : "partial"} split of ${parent.segmentCode}.` },
        });
        if (affectedService.existingAllocationId) {
          await tx.serviceAllocation.update({
            where: { id: affectedService.existingAllocationId },
            data: { status: ResourceStatus.DECOMMISSIONED, remarks: `Moved through ${insertedSite} during segment split.` },
          });
        }

        const route = await tx.serviceRoute.create({
          data: {
            serviceId: service.id,
            routeName: `Split route ${affectedService.serviceCode} via ${insertedSite}`,
            routeType: "WORKING",
            isActive: true,
            remarks: `Automatically remapped from ${parent.segmentCode}; selected fibers ${affectedService.fiberNumbers.join(", ")}.`,
          },
        });

        for (const [index, segment] of [ax, xb].entries()) {
          const pathLabel = index === 0 ? `${siteA} -> ${insertedSite}` : `${insertedSite} -> ${siteB}`;
          const fiberNumbers = affectedService.fiberNumbers.filter((fiberNumber) => selectedChildFiberSet.has(fiberNumber));
          if (!fiberNumbers.length) continue;
          const allocationRecord = await tx.serviceAllocation.create({
            data: {
              serviceId: service.id,
              serviceRouteId: route.id,
              segmentId: segment.id,
              allocationGroup: route.id,
              pathOrder: index + 1,
              fromSiteId: segment.endpointA.siteId,
              toSiteId: segment.endpointB.siteId,
              endpointAId: segment.endpointAId,
              endpointBId: segment.endpointBId,
              endpointAPortGroupId: segment.endpointA.portGroupId,
              endpointBPortGroupId: segment.endpointB.portGroupId,
              fiberStart: Math.min(...fiberNumbers),
              fiberEnd: Math.max(...fiberNumbers),
              fiberNumbersJson: JSON.stringify(fiberNumbers),
              status: ResourceStatus.ACTIVE,
              isJumper: affectedService.isJumper,
              pathLabel,
              remarks: affectedService.remarks,
            },
          });
          await tx.segmentFiber.updateMany({
            where: { segmentId: segment.id, fiberNumber: { in: fiberNumbers } },
            data: {
              status: ResourceStatus.ACTIVE,
              serviceId: service.id,
              serviceRouteId: route.id,
              serviceAllocationId: allocationRecord.id,
              serviceCode: affectedService.serviceCode,
              allocationGroup: route.id,
              pathOrder: index + 1,
              isJumper: affectedService.isJumper,
              allocatedAt: new Date(),
              remarks: pathLabel,
            },
          });
          await tx.segmentEndpointMapping.updateMany({
            where: { segmentId: segment.id, fiberNumbersJson: { in: fiberNumbers.map((fiberNumber) => JSON.stringify([fiberNumber])) } },
            data: { status: ResourceStatus.ACTIVE, serviceCode: affectedService.serviceCode },
          });
          await tx.serviceRouteHop.create({
            data: {
              serviceRouteId: route.id,
              hopOrder: index + 1,
              siteId: segment.endpointA.siteId,
              rackId: segment.endpointA.rackId,
              odfId: segment.endpointA.odfId,
              portGroupId: segment.endpointA.portGroupId,
              segmentId: segment.id,
              pathLabel,
              distanceKm: segment.distanceKm,
              remarks: `Remapped fibers ${fiberNumbers.join(", ")} from ${parent.segmentCode}`,
            },
          });
        }
      }

      const rehomedOutRemark = buildRehomedOutRemark({
        viaSite: insertedSite!,
        oldSegmentCode: parent.segmentCode,
        newSegmentCodes: [ax.segmentCode, xb.segmentCode],
        selectedPorts: selectedChildMappings
          .map((mapping) => `${mapping.originalA.odfCode ?? "ODF"}:${mapping.originalA.portLabel ?? "?"} -> ${mapping.originalB.odfCode ?? "ODF"}:${mapping.originalB.portLabel ?? "?"}`)
          .join(" | "),
        selectedFibers: selectedChildFibers,
      });

      await tx.segmentFiber.updateMany({
        where: { segmentId: parent.id, fiberNumber: { in: selectedChildFibers } },
        data: {
          // EDIT HERE: Partial-split parent rows are not DUMMY.
          // These ODF ports are still live, but their direct far end has moved to the inserted node.
          // Keep them as ACTIVE with an explicit REHOMED_OUT audit marker so live direct-capacity
          // calculations can exclude them without treating them as dead/dummy inventory.
          status: input.mode === "FULL_SPLIT" ? ResourceStatus.DECOMMISSIONED : ResourceStatus.ACTIVE,
          serviceId: null,
          serviceRouteId: null,
          serviceAllocationId: null,
          serviceCode: null,
          allocationGroup: null,
          pathOrder: null,
          allocatedAt: null,
          remarks: input.mode === "FULL_SPLIT" ? `Retired by full split via ${insertedSite}.` : rehomedOutRemark,
        },
      });
      if (selectedMappingIdsForRetire.length) {
        await tx.segmentEndpointMapping.updateMany({
          where: { id: { in: selectedMappingIdsForRetire } },
          data: {
            // EDIT HERE: Keep borrowed/lent child mappings visible as REHOMED, not DUMMY.
            status: input.mode === "FULL_SPLIT" ? ResourceStatus.DECOMMISSIONED : ResourceStatus.ACTIVE,
            serviceCode: null,
            remarks: input.mode === "FULL_SPLIT" ? `Retired by full split via ${insertedSite}.` : rehomedOutRemark,
          },
        });
      }
      if (input.mode === "FULL_SPLIT") {
        await tx.linkSegment.update({
          where: { id: parent.id },
          data: {
            status: ResourceStatus.DECOMMISSIONED,
            decommissionedAt: new Date(),
            comments: [parent.comments, `Fully split via ${insertedSite}.`].filter(Boolean).join(" "),
          },
        });
      } else {
        await tx.linkSegment.update({
          where: { id: parent.id },
          data: {
            status: ResourceStatus.ACTIVE,
            isPartialTermination: true,
            comments: [parent.comments, `Partial split via ${insertedSite}; fibers ${selectedChildFibers.join(", ")} borrowed.`].filter(Boolean).join(" "),
          },
        });
      }

      await segmentCapacityService.refreshSegmentCapacity(tx, parent.id);
      await segmentCapacityService.refreshSegmentCapacity(tx, ax.id);
      await segmentCapacityService.refreshSegmentCapacity(tx, xb.id);

      return { ax, xb };
    });

    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: segmentId,
      action: "MANUAL_OVERRIDE",
      newValue: {
        mode: input.mode,
        insertedSite,
        selectedFiberNumbers: selectedChildFibers,
        createdSegments: [result.ax.segmentCode, result.xb.segmentCode],
        affectedServices: affectedServices.map((service) => service.serviceCode).filter(Boolean),
      },
      changedById: changedById ?? null,
      reason: input.comments ?? `${input.mode === "FULL_SPLIT" ? "Full" : "Partial"} split from parent segment view`,
    });

    return {
      mode: input.mode,
      parentSegmentId: segmentId,
      parentSegmentCode: parent.segmentCode,
      insertedSite,
      selectedFiberNumbers: selectedChildFibers,
      affectedServices: affectedServices.map((service) => service.serviceCode).filter(Boolean),
      createdRows: [
        await inventoryService.getInventoryRowById(result.ax.id),
        await inventoryService.getInventoryRowById(result.xb.id),
      ].filter(Boolean),
      parentRow: await inventoryService.getInventoryRowById(segmentId),
    };
  },

  async apply(input: IntermediateInput, changedById?: string | null) {
    assertRequired(input);
    const capacity = input.segmentCapacity && input.segmentCapacity > 0 ? Number(input.segmentCapacity) : 96;
    const borrowed = input.borrowedFibers && input.borrowedFibers > 0 ? Number(input.borrowedFibers) : 0;
    const direct = await findActiveDirectSegment(input.nearSite, input.farSite);
    if (!direct) {
      throw new Error(`No active direct segment was found for ${input.nearSite} - ${input.farSite}.`);
    }
    const insertedNearRack = input.insertedNearRack ?? input.insertedRack;
    const insertedNearOdf = input.insertedNearOdf ?? input.insertedOdf;
    const insertedNearPortGroup = input.insertedNearPortGroup ?? input.insertedPortGroup;
    const insertedFarRack = input.insertedFarRack ?? input.insertedRack;
    const insertedFarOdf = input.insertedFarOdf ?? input.insertedOdf;
    const insertedFarPortGroup = input.insertedFarPortGroup ?? input.insertedPortGroup;

    if (input.mode === "FULL_SPLIT") {
      const first = await manualSegmentService.create({
        segmentCapacity: capacity,
        distanceKm: input.distanceKm ?? null,
        status: "ACTIVE",
        comments: input.comments ?? "Full split intermediate insertion",
        overrideReason: `Full split from ${input.nearSite}-${input.farSite}`,
        endpointA: endpoint(input.nearSite, input.nearRack, input.nearOdf, input.nearPortGroup),
        endpointB: endpoint(input.insertedSite, String(insertedNearRack), String(insertedNearOdf), insertedNearPortGroup),
      }, changedById);
      const second = await manualSegmentService.create({
        segmentCapacity: capacity,
        distanceKm: input.distanceKm ?? null,
        status: "ACTIVE",
        comments: input.comments ?? "Full split intermediate insertion",
        overrideReason: `Full split from ${input.nearSite}-${input.farSite}`,
        endpointA: endpoint(input.insertedSite, String(insertedFarRack), String(insertedFarOdf), insertedFarPortGroup),
        endpointB: endpoint(input.farSite, input.farRack, input.farOdf, input.farPortGroup),
      }, changedById);

      if (!first?.segmentId || !second?.segmentId) {
        throw new Error("Full split created an incomplete segment record. No live segment was retired.");
      }

      await prisma.$transaction(async (tx) => {
        for (const allocation of input.carryServices ? direct.serviceAllocations : []) {
          const serviceCode = allocation.service?.serviceCode;
          if (!allocation.serviceId || !serviceCode) continue;
          const fiberNumbers = fiberNumbersForAllocation(allocation);
          if (Math.max(...fiberNumbers) > capacity) {
            throw new Error(`Service ${serviceCode} uses fibers ${fiberNumbers.join("-")}, which exceed the new split capacity of ${capacity}.`);
          }

          await tx.serviceRoute.updateMany({
            where: { serviceId: allocation.serviceId, isActive: true },
            data: { isActive: false, remarks: `Superseded by complete split of ${direct.segmentCode}.` },
          });

          const route = await tx.serviceRoute.create({
            data: {
              serviceId: allocation.serviceId,
              routeName: `Carried forward ${serviceCode} via ${normalizeSiteCode(input.insertedSite)}`,
              routeType: "WORKING",
              isActive: true,
              remarks: `Carried forward after confirmed complete split of ${direct.segmentCode}.`,
            },
          });

          for (const [index, segmentId] of [first.segmentId, second.segmentId].entries()) {
            const segment = await tx.linkSegment.findUnique({
              where: { id: segmentId },
              include: { endpointA: true, endpointB: true },
            });
            if (!segment) throw new Error("Created split segment was not found while carrying service allocations.");
            const pathLabel = index === 0
              ? `${normalizeSiteCode(input.nearSite)} -> ${normalizeSiteCode(input.insertedSite)}`
              : `${normalizeSiteCode(input.insertedSite)} -> ${normalizeSiteCode(input.farSite)}`;
            const allocated = await segmentCapacityService.allocateSpecificFibers(tx, {
              segmentId,
              serviceId: allocation.serviceId,
              serviceRouteId: route.id,
              serviceCode,
              allocationGroup: route.id,
              pathOrder: index + 1,
              fiberNumbers,
              fromSiteId: segment.endpointA.siteId,
              toSiteId: segment.endpointB.siteId,
              endpointAId: segment.endpointAId,
              endpointBId: segment.endpointBId,
              endpointAPortGroupId: segment.endpointA.portGroupId,
              endpointBPortGroupId: segment.endpointB.portGroupId,
              pathLabel,
              remarks: `Carried forward from ${direct.segmentCode}`,
              requestedCapacity: capacity,
            });
            await tx.serviceRouteHop.create({
              data: {
                serviceRouteId: route.id,
                hopOrder: index + 1,
                siteId: segment.endpointA.siteId,
                rackId: segment.endpointA.rackId,
                odfId: segment.endpointA.odfId,
                portGroupId: segment.endpointA.portGroupId,
                segmentId,
                pathLabel,
                distanceKm: segment.distanceKm,
                remarks: `Allocated carried-forward fibers ${allocated.fiberNumbers.join("-")} for ${serviceCode}`,
              },
            });
          }

          await tx.serviceAllocation.update({
            where: { id: allocation.id },
            data: { status: ResourceStatus.DECOMMISSIONED, remarks: `Retired by complete split via ${normalizeSiteCode(input.insertedSite)}.` },
          });
        }

        await tx.segmentFiber.updateMany({
          where: { segmentId: direct.id },
          data: {
            status: ResourceStatus.DECOMMISSIONED,
            serviceId: null,
            serviceRouteId: null,
            serviceAllocationId: null,
            serviceCode: null,
            allocationGroup: null,
            allocatedAt: null,
            remarks: `Retired by complete split via ${normalizeSiteCode(input.insertedSite)}.`,
          },
        });

        await tx.linkSegment.update({
          where: { id: direct.id },
          data: {
            status: ResourceStatus.DECOMMISSIONED,
            decommissionedAt: new Date(),
            comments: [direct.comments, `Full intermediate termination inserted at ${normalizeSiteCode(input.insertedSite)}.`].filter(Boolean).join(" "),
          },
        });
      });

      await writeAuditLog({
        entityType: "LinkSegment",
        entityId: direct.id,
        action: "MANUAL_OVERRIDE",
        newValue: { mode: input.mode, createdSegments: [first?.segmentCode, second?.segmentCode] },
        changedById: changedById ?? null,
        reason: "Full termination / full split intermediate site insertion",
      });

      return { mode: input.mode, decommissionedSegment: direct.segmentCode, createdRows: [first, second], carriedServices: Boolean(input.carryServices) };
    }

    if (input.mode === "STUB_INTERCEPT") {
      // CASE 3 — Dead-end stub / open tail.
      // Insert B intercepting `borrowed` fibers from the A side only. The A-B
      // branch terminates those fibers at B; the matching C-facing fibers become
      // an un-terminated open tail. The main A-C trunk stays active with reduced
      // through-capacity (e.g. 12 - 4 = 8). Unlike Case 2 there is no live B-C
      // return — the B-C stub is created idle so the operator can mark the
      // C-facing ports open/dead by hand.
      const interceptCount = borrowed;
      if (!interceptCount) throw new Error("Intercepted fiber count must be greater than zero for a dead-end stub.");

      const requestedNumbers = parsePortNumbers(input.borrowedPortGroup);
      const spareTrunkFibers = direct.fibers.filter(
        (fiber) => fiber.status === ResourceStatus.AVAILABLE || fiber.status === ResourceStatus.SPARE,
      );
      const toIntercept = requestedNumbers.length
        ? direct.fibers.filter((fiber) => requestedNumbers.includes(fiber.fiberNumber))
        : spareTrunkFibers.slice(0, interceptCount);
      if (toIntercept.length < interceptCount) {
        throw new Error(`Only ${toIntercept.length} spare fiber(s) are available to intercept from ${direct.segmentCode}.`);
      }
      const liveIntercept = toIntercept.filter(
        (fiber) => fiber.serviceCode || fiber.status === ResourceStatus.USED || fiber.status === ResourceStatus.ACTIVE,
      );
      if (liveIntercept.length) {
        throw new Error(`A dead-end stub must intercept spare fibers. These carry live traffic: ${liveIntercept.map((fiber) => fiber.fiberNumber).join(", ")}.`);
      }

      // Trunk: intercepted fibers no longer pass A->C, so mark them DUMMY to drop
      // the direct through-count without deleting physical inventory.
      await prisma.$transaction(async (tx) => {
        await tx.segmentFiber.updateMany({
          where: { id: { in: toIntercept.map((fiber) => fiber.id) } },
          data: {
            status: ResourceStatus.DUMMY,
            serviceId: null,
            serviceRouteId: null,
            serviceAllocationId: null,
            serviceCode: null,
            allocationGroup: null,
            allocatedAt: null,
            remarks: `Intercepted at ${normalizeSiteCode(input.insertedSite)} (dead-end stub); A-side terminated, C-side left open.`,
          },
        });
        await tx.linkSegment.update({
          where: { id: direct.id },
          data: {
            isPartialTermination: true,
            comments: [direct.comments, `${interceptCount} fiber(s) intercepted at ${normalizeSiteCode(input.insertedSite)} as a dead-end stub; C-side left open.`].filter(Boolean).join(" "),
          },
        });
        await segmentCapacityService.refreshSegmentCapacity(tx, direct.id);
      });

      // A-B branch: the intercepted fibers terminate at the inserted node.
      const branch = await manualSegmentService.create({
        segmentCapacity: interceptCount,
        distanceKm: input.distanceKm ?? null,
        status: "ACTIVE",
        comments: input.comments ?? "Dead-end stub: A-side intercept branch",
        overrideReason: `${interceptCount} fiber(s) intercepted from ${input.nearSite}-${input.farSite} (dead-end stub)`,
        endpointA: endpoint(input.nearSite, input.nearRack, input.nearOdf, input.nearPortGroup),
        endpointB: endpoint(input.insertedSite, String(insertedNearRack), String(insertedNearOdf), insertedNearPortGroup),
      }, changedById);

      // B-C open tail: persisted but un-terminated/idle. The operator flips the
      // C-facing ports to open/dead manually from the ODF & Racks view.
      const openTail = await manualSegmentService.create({
        segmentCapacity: interceptCount,
        distanceKm: input.distanceKm ?? null,
        status: "ACTIVE",
        comments: input.comments ?? "Dead-end stub: open tail (un-terminated)",
        overrideReason: `Open tail from ${input.insertedSite} to ${input.farSite} (un-terminated dead-end)`,
        endpointA: endpoint(input.insertedSite, String(insertedFarRack), String(insertedFarOdf), insertedFarPortGroup),
        endpointB: endpoint(input.farSite, input.farRack, input.farOdf, input.farPortGroup),
      }, changedById);

      if (openTail?.segmentId) {
        await prisma.$transaction(async (tx) => {
          await tx.segmentFiber.updateMany({
            where: { segmentId: openTail.segmentId },
            data: {
              status: ResourceStatus.AVAILABLE,
              serviceId: null,
              serviceRouteId: null,
              serviceAllocationId: null,
              serviceCode: null,
              allocationGroup: null,
              allocatedAt: null,
              remarks: `Open tail: un-terminated C-side of dead-end stub at ${normalizeSiteCode(input.insertedSite)}. Mark open/dead manually.`,
            },
          });
          await tx.linkSegment.update({
            where: { id: openTail.segmentId },
            data: {
              isPartialTermination: true,
              comments: `Open tail / dead-end stub — C-side fibers un-terminated and idle; mark open/dead manually.`,
            },
          });
          await segmentCapacityService.refreshSegmentCapacity(tx, openTail.segmentId);
        });
      }

      await writeAuditLog({
        entityType: "LinkSegment",
        entityId: direct.id,
        action: "MANUAL_OVERRIDE",
        newValue: {
          mode: input.mode,
          interceptedFibers: interceptCount,
          branchSegment: branch?.segmentCode,
          openTailSegment: openTail?.segmentCode,
        },
        changedById: changedById ?? null,
        reason: "Dead-end stub / open tail intercept",
      });

      return {
        mode: input.mode,
        trunkSegment: direct.segmentCode,
        interceptedFibers: interceptCount,
        createdRows: [branch, openTail].filter(Boolean),
        openTailSegment: openTail?.segmentCode,
        carriedServices: false,
      };
    }

    if (!borrowed) throw new Error("Borrowed fibers must be greater than zero for a partial branch breakout.");
    const requestedBorrowedNumbers = parsePortNumbers(input.borrowedPortGroup);
    const borrowedNumbers = requestedBorrowedNumbers.length ? requestedBorrowedNumbers : [];
    const serviceAllocationsOnBorrowed = direct.serviceAllocations.filter((allocation) =>
      borrowedNumbers.length ? overlaps(fiberNumbersForAllocation(allocation), borrowedNumbers) : false
    );
    if (serviceAllocationsOnBorrowed.length && !input.carryServices) {
      throw new Error("The borrowed fiber range contains active services. Enable service carry-forward or choose spare fibers.");
    }

    await prisma.$transaction(async (tx) => {
      const available = direct.fibers.filter((fiber) => fiber.status === ResourceStatus.AVAILABLE || fiber.status === ResourceStatus.SPARE || fiber.status === ResourceStatus.ACTIVE);
      const toBorrow = borrowedNumbers.length
        ? direct.fibers.filter((fiber) => borrowedNumbers.includes(fiber.fiberNumber))
        : available.slice(0, borrowed);
      if (toBorrow.length < borrowed) {
        throw new Error(`Only ${toBorrow.length} matching spare fiber(s) are available to borrow from ${direct.segmentCode}.`);
      }
      const unavailable = toBorrow.filter((fiber) => !(
        fiber.status === ResourceStatus.AVAILABLE ||
        fiber.status === ResourceStatus.SPARE ||
        fiber.status === ResourceStatus.ACTIVE ||
        (input.carryServices && fiber.status === ResourceStatus.USED)
      ));
      if (unavailable.length) {
        throw new Error(`Borrowed fibers are not spare: ${unavailable.map((fiber) => fiber.fiberNumber).join(", ")}.`);
      }
      await tx.segmentFiber.updateMany({
        where: { id: { in: toBorrow.map((fiber) => fiber.id) } },
        data: {
          status: ResourceStatus.DUMMY,
          serviceId: null,
          serviceRouteId: null,
          serviceAllocationId: null,
          serviceCode: null,
          allocationGroup: null,
          allocatedAt: null,
          remarks: `Borrowed for branch breakout at ${normalizeSiteCode(input.insertedSite)}`,
        },
      });
      await tx.linkSegment.update({
        where: { id: direct.id },
        data: {
          isPartialTermination: true,
          comments: [direct.comments, `${borrowed} fibers borrowed for branch breakout at ${normalizeSiteCode(input.insertedSite)}.`].filter(Boolean).join(" "),
        },
      });
      await segmentCapacityService.refreshSegmentCapacity(tx, direct.id);
    });

    const branch = await manualSegmentService.create({
      segmentCapacity: borrowed,
      distanceKm: input.distanceKm ?? null,
      status: "ACTIVE",
      comments: input.comments ?? "Partial branch breakout",
      overrideReason: `${borrowed} fibers borrowed from ${input.nearSite}-${input.farSite}`,
      endpointA: endpoint(input.nearSite, input.nearRack, input.nearOdf, input.nearPortGroup),
      endpointB: endpoint(input.insertedSite, String(insertedNearRack), String(insertedNearOdf), insertedNearPortGroup),
    }, changedById);
    const branchReturn = await manualSegmentService.create({
      segmentCapacity: borrowed,
      distanceKm: input.distanceKm ?? null,
      status: "ACTIVE",
      comments: input.comments ?? "Partial branch breakout return path",
      overrideReason: `${borrowed} fibers borrowed from ${input.nearSite}-${input.farSite}`,
      endpointA: endpoint(input.insertedSite, String(insertedFarRack), String(insertedFarOdf), insertedFarPortGroup),
      endpointB: endpoint(input.farSite, input.farRack, input.farOdf, input.farPortGroup),
    }, changedById);

    if (input.carryServices && serviceAllocationsOnBorrowed.length && branch?.segmentId && branchReturn?.segmentId) {
      await prisma.$transaction(async (tx) => {
        for (const allocation of serviceAllocationsOnBorrowed) {
          const serviceCode = allocation.service?.serviceCode;
          if (!allocation.serviceId || !serviceCode) continue;
          const allocationFibers = fiberNumbersForAllocation(allocation);
          const translatedFibers = Array.from({ length: allocationFibers.length }, (_, index) => index + 1);
          await tx.serviceRoute.updateMany({
            where: { serviceId: allocation.serviceId, isActive: true },
            data: { isActive: false, remarks: `Superseded by partial branch breakout of ${direct.segmentCode}.` },
          });
          await tx.serviceAllocation.update({
            where: { id: allocation.id },
            data: { status: ResourceStatus.DECOMMISSIONED, remarks: `Rerouted through ${normalizeSiteCode(input.insertedSite)} partial branch.` },
          });
          const route = await tx.serviceRoute.create({
            data: {
              serviceId: allocation.serviceId,
              routeName: `Partial branch ${serviceCode} via ${normalizeSiteCode(input.insertedSite)}`,
              routeType: "WORKING",
              isActive: true,
              remarks: `Carried forward after confirmed partial branch breakout of ${direct.segmentCode}.`,
            },
          });

          for (const [index, segmentId] of [branch.segmentId, branchReturn.segmentId].entries()) {
            const segment = await tx.linkSegment.findUnique({ where: { id: segmentId }, include: { endpointA: true, endpointB: true } });
            if (!segment) throw new Error("Created branch segment was not found while carrying service allocations.");
            const pathLabel = index === 0
              ? `${normalizeSiteCode(input.nearSite)} -> ${normalizeSiteCode(input.insertedSite)}`
              : `${normalizeSiteCode(input.insertedSite)} -> ${normalizeSiteCode(input.farSite)}`;
            const allocated = await segmentCapacityService.allocateSpecificFibers(tx, {
              segmentId,
              serviceId: allocation.serviceId,
              serviceRouteId: route.id,
              serviceCode,
              allocationGroup: route.id,
              pathOrder: index + 1,
              fiberNumbers: translatedFibers,
              fromSiteId: segment.endpointA.siteId,
              toSiteId: segment.endpointB.siteId,
              endpointAId: segment.endpointAId,
              endpointBId: segment.endpointBId,
              endpointAPortGroupId: segment.endpointA.portGroupId,
              endpointBPortGroupId: segment.endpointB.portGroupId,
              pathLabel,
              remarks: `Carried forward from borrowed fibers ${allocationFibers.join(", ")}`,
              requestedCapacity: borrowed,
            });
            await tx.serviceRouteHop.create({
              data: {
                serviceRouteId: route.id,
                hopOrder: index + 1,
                siteId: segment.endpointA.siteId,
                rackId: segment.endpointA.rackId,
                odfId: segment.endpointA.odfId,
                portGroupId: segment.endpointA.portGroupId,
                segmentId,
                pathLabel,
                distanceKm: segment.distanceKm,
                remarks: `Allocated branch fibers ${allocated.fiberNumbers.join("-")} for ${serviceCode}`,
              },
            });
          }
        }
      });
    }

    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: direct.id,
      action: "MANUAL_OVERRIDE",
      newValue: { mode: input.mode, borrowedFibers: borrowed, branchSegments: [branch?.segmentCode, branchReturn?.segmentCode] },
      changedById: changedById ?? null,
      reason: "Partial termination / branch breakout",
    });

    return { mode: input.mode, trunkSegment: direct.segmentCode, borrowedFibers: borrowed, createdRows: [branch, branchReturn].filter(Boolean), carriedServices: Boolean(input.carryServices) };
  },
};
