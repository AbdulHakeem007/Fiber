import { ResourceStatus } from "@prisma/client";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { prisma } from "@/lib/db/prisma";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode } from "@/lib/telecom/connection-identity";
import { normalizeSegmentDefaultTopologyRole } from "@/lib/telecom/topology-role";
import { connectionDuplicateService } from "@/server/services/connection-duplicate.service";
import { inventoryService } from "@/server/services/inventory.service";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { resolveRegisteredEndpointAssets } from "@/server/services/inventory-asset-validation.service";

const SEGMENT_STATUSES = new Set(["ACTIVE", "SPARE", "RESERVED", "FAULTY", "DUMMY", "PLANNED", "INACTIVE", "UNKNOWN", "DECOMMISSIONED"]);

interface EndpointInput {
  rawSiteCode?: string | null;
  rawRackCode?: string | null;
  rawOdfCode?: string | null;
  rawPortText?: string | null;
}

interface CreateManualSegmentInput {
  segmentCode?: string | null;
  segmentDefaultRole?: string | null;
  allocatedServiceCode?: string | null;
  segmentCapacity?: number | null;
  cableLabel?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  tubeLabel?: string | null;
  fiberPortNumber?: number | null;
  fiberNumber?: number | null;
  fiberLabel?: string | null;
  distanceKm?: number | null;
  status?: string | null;
  comments?: string | null;
  overrideReason?: string | null;
  endpointA: EndpointInput;
  endpointB: EndpointInput;
  childUnitMode?: "PAIR" | "SINGLE" | null;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePortNumbers(label?: string | null): number[] {
  const match = label?.replace(/\s+/g, "").match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return [];
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) return [];
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  if (end - start > 999) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function labelFromPorts(ports: number[]): string | null {
  const values = [...new Set(ports.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!values.length) return null;
  return values.length === 1 ? String(values[0]) : `${values[0]}-${values[values.length - 1]}`;
}

function labelsFromPorts(ports: number[], mode: "PAIR" | "SINGLE" = "PAIR"): string[] {
  const values = [...new Set(ports.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!values.length) return [];
  if (mode === "SINGLE") return values.map(String);
  const labels: string[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const first = values[index];
    const second = values[index + 1];
    labels.push(second && second === first + 1 ? `${first}-${second}` : String(first));
  }
  return labels;
}

function deriveChildPortLabels(localLabel?: string | null, farLabel?: string | null, capacity?: number | null, mode: "PAIR" | "SINGLE" = "PAIR") {
  const localPorts = parsePortNumbers(localLabel);
  const farPorts = parsePortNumbers(farLabel);
  const countFromCapacity = Number.isFinite(Number(capacity)) && Number(capacity) > 0 ? Number(capacity) : 0;
  const count = Math.max(localPorts.length, farPorts.length, countFromCapacity);
  let localBase = localPorts.length ? localPorts : Array.from({ length: count }, (_, index) => index + 1);
  let farBase = farPorts.length ? farPorts : localBase;
  // Declared fiber capacity is authoritative for row generation: 126 fibers in
  // PAIR mode must yield exactly 63 child rows even when the ODF port label
  // spans a wider physical range (e.g. a 144-port frame).
  if (countFromCapacity > 0) {
    localBase = localBase.slice(0, countFromCapacity);
    farBase = farBase.slice(0, countFromCapacity);
  }
  const localLabels = labelsFromPorts(localBase, mode);
  const farLabels = labelsFromPorts(farBase, mode);
  return localLabels.map((localPort, index) => ({
    localPort,
    farPort: farLabels[index] ?? farLabels[farLabels.length - 1] ?? localPort,
    fiberNumbers: parsePortNumbers(localPort),
  }));
}

function portStatusForSegment(status: string): "ACTIVE" | "USED" | "SPARE" | "RESERVED" | "FAULTY" | "DUMMY" | "PLANNED" | "INACTIVE" | "UNKNOWN" {
  if (status === "ACTIVE" || status === "AVAILABLE") return "ACTIVE";
  if (status === "SPARE" || status === "RESERVED" || status === "FAULTY" || status === "DUMMY" || status === "PLANNED" || status === "INACTIVE" || status === "UNKNOWN") {
    return status;
  }
  return "ACTIVE";
}

function displayNameFromSiteText(siteText?: string | null, code?: string | null): string | null {
  const text = clean(siteText);
  if (!text) return null;
  const normalizedText = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code && normalizedText === code && !/\d/.test(code)) {
    // A user typed a readable site/customer name without a formal site code.
    // Keep the readable name for display instead of only exposing MINISTRYOFHEALTH-style keys.
    return text.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  return text;
}

async function ensureEndpointAssets(
  tx: any,
  endpoint: EndpointInput,
  status: string,
  metadata: { tubeNumber?: number | null; tubeColor?: string | null; fiberPortNumber?: number | null; fiberNumber?: number | null },
) {
  const assets = await resolveRegisteredEndpointAssets(tx, {
    siteCode: endpoint.rawSiteCode,
    rackCode: endpoint.rawRackCode,
    odfCode: endpoint.rawOdfCode,
  });
  const { siteId, rackId, odfId, rackCode, odfCode } = assets;
  const portLabel = normalizePortLabel(clean(endpoint.rawPortText));

  if (!portLabel) {
    return { siteId, rackId, odfId, portGroupId: null };
  }

  const ports = parsePortNumbers(portLabel);

  // DARK_STUB routing guard: a new segment/spur may not consume an ODF port the
  // engineer has manually blocked. This is the read-side of the DARK_STUB state —
  // the routing engine treats blocked ports as occupied/unavailable, preventing
  // accidental reuse or loops through them. Checked per individual port, so a
  // blocked NEAR port never implicates the FAR-end port (a separate ODFPort row),
  // which stays freely routable. Throwing here rolls back the whole create
  // transaction, so nothing is partially written (Zero-Overwrite).
  if (ports.length) {
    const blocked = await tx.oDFPort.findMany({
      where: { odfId, portNumber: { in: ports }, isBlocked: true },
      select: { portNumber: true },
    });
    if (blocked.length) {
      throw new Error(
        `ODF port(s) ${blocked.map((row: { portNumber: number }) => row.portNumber).join(", ")} at ${endpoint.rawSiteCode}/${rackCode}/${odfCode} are marked DARK_STUB (blocked) and cannot carry a new link. Unblock them first or choose different ports.`,
      );
    }
  }

  const portGroup = await tx.portGroup.upsert({
    where: { odfId_displayLabel: { odfId, displayLabel: portLabel } },
    update: {
      status: portStatusForSegment(status),
      tubeNumber: metadata.tubeNumber ?? undefined,
      tubeColor: metadata.tubeColor ?? undefined,
      fiberPortNumber: metadata.fiberPortNumber ?? undefined,
      fiberNumber: metadata.fiberNumber ?? undefined,
    },
    create: {
      siteId,
      rackId,
      odfId,
      groupType: ports.length === 1 ? "SINGLE" : ports.length === 2 ? "PAIR" : "CUSTOM",
      displayLabel: portLabel,
      startPortNumber: ports[0] ?? null,
      endPortNumber: ports[ports.length - 1] ?? null,
      tubeNumber: metadata.tubeNumber ?? null,
      tubeColor: metadata.tubeColor ?? null,
      fiberPortNumber: metadata.fiberPortNumber ?? null,
      fiberNumber: metadata.fiberNumber ?? null,
      status: portStatusForSegment(status),
      source: "MANUAL",
    },
    select: { id: true },
  });

  for (let index = 0; index < ports.length; index += 1) {
    const odfPort = await tx.oDFPort.upsert({
      where: { odfId_portNumber: { odfId, portNumber: ports[index] } },
      update: {
        status: portStatusForSegment(status),
        tubeNumber: metadata.tubeNumber ?? undefined,
        tubeColor: metadata.tubeColor ?? undefined,
        fiberPortNumber: metadata.fiberPortNumber ? metadata.fiberPortNumber + index : undefined,
        fiberNumber: metadata.fiberNumber ? metadata.fiberNumber + index : undefined,
      },
      create: {
        odfId,
        portNumber: ports[index],
        label: String(ports[index]),
        status: portStatusForSegment(status),
        tubeNumber: metadata.tubeNumber ?? null,
        tubeColor: metadata.tubeColor ?? null,
        fiberPortNumber: metadata.fiberPortNumber ? metadata.fiberPortNumber + index : null,
        fiberNumber: metadata.fiberNumber ? metadata.fiberNumber + index : null,
      },
      select: { id: true },
    });
    await tx.portGroupMember.upsert({
      where: { portGroupId_odfPortId: { portGroupId: portGroup.id, odfPortId: odfPort.id } },
      update: { sequence: index + 1 },
      create: { portGroupId: portGroup.id, odfPortId: odfPort.id, sequence: index + 1 },
    });
  }

  return { siteId, rackId, odfId, portGroupId: portGroup.id };
}

async function findOrCreateCable(tx: any, cableLabel?: string | null): Promise<string | null> {
  const label = clean(cableLabel);
  if (!label) return null;
  const existing = await tx.cable.findFirst({
    where: { OR: [{ cableCode: label }, { cableName: label }] },
    select: { id: true },
  });
  if (existing) return existing.id;
  return (await tx.cable.create({ data: { cableCode: label, cableName: label, status: "ACTIVE" }, select: { id: true } })).id;
}

async function nextSegmentCode(tx: any, endpointA?: string | null, endpointB?: string | null, requested?: string | null) {
  const base = clean(requested) ?? `SEG-${normalizeAlias(endpointA) || "A"}-${normalizeAlias(endpointB) || "B"}`;
  let candidate = base;
  let suffix = 1;
  while (await tx.linkSegment.findUnique({ where: { segmentCode: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export const manualSegmentService = {
  async create(input: CreateManualSegmentInput, changedById?: string | null) {
    const status = SEGMENT_STATUSES.has(String(input.status)) ? (String(input.status) as ResourceStatus) : ResourceStatus.ACTIVE;
    const metadata = {
      tubeNumber: input.tubeNumber === null || input.tubeNumber === undefined ? null : Number(input.tubeNumber),
      tubeColor: clean(input.tubeColor),
      fiberPortNumber: input.fiberPortNumber === null || input.fiberPortNumber === undefined ? null : Number(input.fiberPortNumber),
      fiberNumber: input.fiberNumber === null || input.fiberNumber === undefined ? null : Number(input.fiberNumber),
    };
    // Persist the service identity so a manually mapped circuit is visible in
    // Service Trace, Impact Analysis, and utilization (was previously dropped).
    const serviceCode = clean(input.allocatedServiceCode);
    const segmentType = normalizeSegmentDefaultTopologyRole(input.segmentDefaultRole);
    if (!segmentType) {
      throw new Error("Segment Type must be one of Backbone, Default, Interconnect, Intra-site, GPON segment, or B2B segment.");
    }

    const segmentId = await prisma.$transaction(async (tx) => {
      const endpointAAssets = await ensureEndpointAssets(tx, input.endpointA, status, metadata);
      const endpointBAssets = await ensureEndpointAssets(tx, input.endpointB, status, metadata);
      const duplicate = await connectionDuplicateService.findDuplicateSegment(tx, {
        siteCode: input.endpointA.rawSiteCode,
        rackCode: input.endpointA.rawRackCode,
        odfCode: input.endpointA.rawOdfCode,
        portLabel: input.endpointA.rawPortText,
      }, {
        siteCode: input.endpointB.rawSiteCode,
        rackCode: input.endpointB.rawRackCode,
        odfCode: input.endpointB.rawOdfCode,
        portLabel: input.endpointB.rawPortText,
      });
      if (duplicate) {
        throw new Error(`Duplicate mapping found. Existing segment ${duplicate.segmentCode} already uses the same site/rack/ODF/port identity.`);
      }
      const endpointA = await tx.segmentEndpoint.create({
        data: {
          endpointSide: "A",
          ...endpointAAssets,
          rawSiteCode: normalizeAlias(input.endpointA.rawSiteCode),
          rawRackCode: normalizeRackCode(input.endpointA.rawRackCode),
          rawOdfCode: normalizeOdfCode(input.endpointA.rawOdfCode),
          rawPortText: normalizePortLabel(input.endpointA.rawPortText),
          displayPortText: normalizePortLabel(input.endpointA.rawPortText),
          terminationStatus: status,
          remarks: clean(input.comments),
        },
        select: { id: true },
      });
      const endpointB = await tx.segmentEndpoint.create({
        data: {
          endpointSide: "B",
          ...endpointBAssets,
          rawSiteCode: normalizeAlias(input.endpointB.rawSiteCode),
          rawRackCode: normalizeRackCode(input.endpointB.rawRackCode),
          rawOdfCode: normalizeOdfCode(input.endpointB.rawOdfCode),
          rawPortText: normalizePortLabel(input.endpointB.rawPortText),
          displayPortText: normalizePortLabel(input.endpointB.rawPortText),
          terminationStatus: status,
          remarks: clean(input.comments),
        },
        select: { id: true },
      });
      const cableId = await findOrCreateCable(tx, input.cableLabel);
      const segmentCode = await nextSegmentCode(tx, input.endpointA.rawSiteCode, input.endpointB.rawSiteCode, input.segmentCode);
      const segmentCapacity = input.segmentCapacity === null || input.segmentCapacity === undefined ? null : Number(input.segmentCapacity);
      const capacity = Number.isFinite(segmentCapacity) && segmentCapacity && segmentCapacity > 0 ? segmentCapacity : 0;
      const segment = await tx.linkSegment.create({
        data: {
          segmentCode,
          segmentGroupName: segmentCode.split("-C")[0] ?? segmentCode,
          segmentDefaultRole: segmentType,
          segmentCapacityFibers: capacity || null,
          sitePairKey: buildSitePairKey(normalizeAlias(input.endpointA.rawSiteCode), normalizeAlias(input.endpointB.rawSiteCode)),
          endpointAId: endpointA.id,
          endpointBId: endpointB.id,
          cableId,
          totalFiberCapacity: capacity,
          tubeNumber: metadata.tubeNumber,
          tubeColor: metadata.tubeColor,
          tubeLabel: clean(input.tubeLabel),
          fiberPortNumber: metadata.fiberPortNumber,
          fiberNumber: metadata.fiberNumber,
          fiberLabel: clean(input.fiberLabel),
          distanceKm: input.distanceKm === null || input.distanceKm === undefined ? null : Number(input.distanceKm),
          status,
          source: "MANUAL",
          allocatedServiceCode: serviceCode,
          manualOverride: true,
          overrideReason: clean(input.overrideReason) ?? "Manual near/far mapping",
          comments: clean(input.comments),
        },
        select: { id: true },
      });
      const childUnits = deriveChildPortLabels(
        input.endpointA.rawPortText,
        input.endpointB.rawPortText,
        capacity,
        input.childUnitMode === "SINGLE" ? "SINGLE" : "PAIR",
      );
      for (const child of childUnits.length ? childUnits : [{ localPort: normalizePortLabel(input.endpointA.rawPortText), farPort: normalizePortLabel(input.endpointB.rawPortText), fiberNumbers: parsePortNumbers(input.endpointA.rawPortText).length ? parsePortNumbers(input.endpointA.rawPortText) : parsePortNumbers(input.endpointB.rawPortText) }]) {
        await tx.segmentEndpointMapping.create({
          data: {
            segmentId: segment.id,
            localSiteCode: normalizeAlias(input.endpointA.rawSiteCode),
            localRackCode: normalizeRackCode(input.endpointA.rawRackCode),
            localOdfCode: normalizeOdfCode(input.endpointA.rawOdfCode),
            localPortLabel: child.localPort,
            farSiteCode: normalizeAlias(input.endpointB.rawSiteCode),
            farRackCode: normalizeRackCode(input.endpointB.rawRackCode),
            farOdfCode: normalizeOdfCode(input.endpointB.rawOdfCode),
            farPortLabel: child.farPort,
            localPortGroupId: endpointAAssets.portGroupId,
            farPortGroupId: endpointBAssets.portGroupId,
            fiberNumbersJson: JSON.stringify(child.fiberNumbers.length ? child.fiberNumbers : parsePortNumbers(child.localPort)),
            serviceCode,
            status: serviceCode ? ResourceStatus.USED : (status === ResourceStatus.USED ? ResourceStatus.AVAILABLE : status),
            source: "MANUAL",
            remarks: clean(input.comments),
          },
        });
      }
      await segmentCapacityService.ensureFiberInventory(tx, segment.id, capacity || childUnits.reduce((sum, unit) => sum + Math.max(1, unit.fiberNumbers.length || parsePortNumbers(unit.localPort).length), 0));
      return segment.id;
    });

    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: segmentId,
      action: "CREATE",
      newValue: input,
      changedById: changedById ?? null,
      reason: clean(input.overrideReason) ?? "Manual near/far mapping",
    });

    return inventoryService.getInventoryRowById(segmentId);
  },
};
