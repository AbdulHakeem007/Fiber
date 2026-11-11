import { NextResponse } from "next/server";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { buildSitePairKey } from "@/lib/telecom/site-pair";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { inventoryService } from "@/server/services/inventory.service";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode } from "@/lib/telecom/connection-identity";
import { connectionDuplicateService } from "@/server/services/connection-duplicate.service";
import { normalizeSegmentDefaultTopologyRole } from "@/lib/telecom/topology-role";
import { resolveRegisteredEndpointAssets } from "@/server/services/inventory-asset-validation.service";

const SEGMENT_STATUSES = new Set(["ACTIVE", "SPARE", "RESERVED", "FAULTY", "DUMMY", "PLANNED", "INACTIVE", "UNKNOWN", "DECOMMISSIONED"]);

interface EndpointPatch {
  rawSiteCode?: string | null;
  rawRackCode?: string | null;
  rawOdfCode?: string | null;
  rawPortText?: string | null;
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

function portStatusForSegment(status: string): "ACTIVE" | "USED" | "SPARE" | "RESERVED" | "FAULTY" | "DUMMY" | "PLANNED" | "INACTIVE" | "UNKNOWN" {
  if (status === "ACTIVE" || status === "AVAILABLE") return "ACTIVE";
  if (status === "SPARE" || status === "RESERVED" || status === "FAULTY" || status === "DUMMY" || status === "PLANNED" || status === "INACTIVE" || status === "UNKNOWN") {
    return status;
  }
  return "ACTIVE";
}

async function ensureEndpointAssets(
  tx: any,
  endpoint: EndpointPatch,
  status: string,
  metadata: { tubeNumber?: number | null; tubeColor?: string | null; fiberPortNumber?: number | null; fiberNumber?: number | null },
) {
  const assets = await resolveRegisteredEndpointAssets(tx, {
    siteCode: endpoint.rawSiteCode,
    rackCode: endpoint.rawRackCode,
    odfCode: endpoint.rawOdfCode,
  });
  const { siteId, rackId, odfId } = assets;
  const portLabel = normalizePortLabel(clean(endpoint.rawPortText));

  if (!portLabel) {
    return { siteId, rackId, odfId, portGroupId: null };
  }

  const ports = parsePortNumbers(portLabel);
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

async function findOrCreateCable(cableLabel?: string | null): Promise<string | null> {
  const label = clean(cableLabel);
  if (!label) return null;

  const existing = await prisma.cable.findFirst({
    where: { OR: [{ cableCode: label }, { cableName: label }] },
    select: { id: true },
  });
  if (existing) return existing.id;

  return (await prisma.cable.create({
    data: { cableCode: label, cableName: label, status: "ACTIVE" },
    select: { id: true },
  })).id;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ segmentId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to update mappings." }, { status: 403 });
    }

    const { segmentId } = await params;
    const body = await request.json();
    const status = SEGMENT_STATUSES.has(body.status) ? body.status : "ACTIVE";
    const endpointA = (body.endpointA ?? {}) as EndpointPatch;
    const endpointB = (body.endpointB ?? {}) as EndpointPatch;
    const required = [
      ["Near site", endpointA.rawSiteCode],
      ["Near rack", endpointA.rawRackCode],
      ["Near ODF", endpointA.rawOdfCode],
      ["Far site", endpointB.rawSiteCode],
      ["Far rack", endpointB.rawRackCode],
      ["Far ODF", endpointB.rawOdfCode],
    ];
    const missing = required.filter(([, value]) => !String(value ?? "").trim()).map(([label]) => label);
    if (missing.length) {
      return NextResponse.json({ error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for manual mapping.` }, { status: 400 });
    }
    const cableId = await findOrCreateCable(body.cableLabel);
    const metadata = {
      tubeNumber: body.tubeNumber === null || body.tubeNumber === "" || body.tubeNumber === undefined ? null : Number(body.tubeNumber),
      tubeColor: clean(body.tubeColor),
      fiberPortNumber: body.fiberPortNumber === null || body.fiberPortNumber === "" || body.fiberPortNumber === undefined ? null : Number(body.fiberPortNumber),
      fiberNumber: body.fiberNumber === null || body.fiberNumber === "" || body.fiberNumber === undefined ? null : Number(body.fiberNumber),
    };
    const segmentCapacity = body.segmentCapacity === null || body.segmentCapacity === "" || body.segmentCapacity === undefined ? null : Number(body.segmentCapacity);
    const segmentType = normalizeSegmentDefaultTopologyRole(body.segmentDefaultRole);
    if (!segmentType) {
      return NextResponse.json({ error: "Segment Type must be one of Backbone, Default, Interconnect, Intra-site, GPON segment, or B2B segment." }, { status: 400 });
    }

    const existing = await prisma.linkSegment.findUnique({
      where: { id: segmentId },
      include: { endpointA: true, endpointB: true, serviceAllocations: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Segment not found." }, { status: 404 });
    }

    await prisma.$transaction(async (tx) => {
      const endpointAAssets = await ensureEndpointAssets(tx, endpointA, status, metadata);
      const endpointBAssets = await ensureEndpointAssets(tx, endpointB, status, metadata);
      const duplicate = await connectionDuplicateService.findDuplicateSegment(tx, {
        siteCode: endpointA.rawSiteCode,
        rackCode: endpointA.rawRackCode,
        odfCode: endpointA.rawOdfCode,
        portLabel: endpointA.rawPortText,
      }, {
        siteCode: endpointB.rawSiteCode,
        rackCode: endpointB.rawRackCode,
        odfCode: endpointB.rawOdfCode,
        portLabel: endpointB.rawPortText,
      }, { excludeSegmentId: segmentId });
      if (duplicate) {
        throw new Error(`Duplicate mapping found. Existing segment ${duplicate.segmentCode} already uses the same site/rack/ODF/port identity.`);
      }

      await tx.segmentEndpoint.update({
        where: { id: existing.endpointAId },
        data: {
          siteId: endpointAAssets.siteId,
          rackId: endpointAAssets.rackId,
          odfId: endpointAAssets.odfId,
          portGroupId: endpointAAssets.portGroupId,
          rawSiteCode: normalizeAlias(endpointA.rawSiteCode),
          rawRackCode: normalizeRackCode(endpointA.rawRackCode),
          rawOdfCode: normalizeOdfCode(endpointA.rawOdfCode),
          rawPortText: normalizePortLabel(endpointA.rawPortText),
          displayPortText: normalizePortLabel(endpointA.rawPortText),
          terminationStatus: status,
          remarks: clean(body.comments),
        },
      });

      await tx.segmentEndpoint.update({
        where: { id: existing.endpointBId },
        data: {
          siteId: endpointBAssets.siteId,
          rackId: endpointBAssets.rackId,
          odfId: endpointBAssets.odfId,
          portGroupId: endpointBAssets.portGroupId,
          rawSiteCode: normalizeAlias(endpointB.rawSiteCode),
          rawRackCode: normalizeRackCode(endpointB.rawRackCode),
          rawOdfCode: normalizeOdfCode(endpointB.rawOdfCode),
          rawPortText: normalizePortLabel(endpointB.rawPortText),
          displayPortText: normalizePortLabel(endpointB.rawPortText),
          terminationStatus: status,
          remarks: clean(body.comments),
        },
      });

      await tx.linkSegment.update({
        where: { id: segmentId },
        data: {
          segmentCode: clean(body.segmentCode) ?? existing.segmentCode,
          cableId,
          allocatedServiceCode: null,
          routeLabel: clean(body.routeLabel),
          tubeNumber: metadata.tubeNumber,
          tubeColor: metadata.tubeColor,
          tubeLabel: clean(body.tubeLabel),
          fiberPortNumber: metadata.fiberPortNumber,
          fiberNumber: metadata.fiberNumber,
          fiberLabel: clean(body.fiberLabel),
          distanceKm: body.distanceKm === null || body.distanceKm === "" || body.distanceKm === undefined ? null : Number(body.distanceKm),
          totalFiberCapacity: Number.isFinite(segmentCapacity) && segmentCapacity && segmentCapacity > 0 ? segmentCapacity : undefined,
          status,
          manualOverride: Boolean(body.manualOverride),
          overrideReason: clean(body.overrideReason),
          comments: clean(body.comments),
          segmentDefaultRole: segmentType,
          sitePairKey: buildSitePairKey(normalizeAlias(endpointA.rawSiteCode), normalizeAlias(endpointB.rawSiteCode)),
        },
      });

      // Cascade the parent endpoint identity down to EVERY child mapping row so the
      // children inherit the new Site/Rack/ODF (a segment is strictly one Site-Rack-ODF
      // per end). Per-row port labels are preserved.
      await tx.segmentEndpointMapping.updateMany({
        where: { segmentId },
        data: {
          localSiteCode: normalizeAlias(endpointA.rawSiteCode),
          localRackCode: normalizeRackCode(endpointA.rawRackCode),
          localOdfCode: normalizeOdfCode(endpointA.rawOdfCode),
          farSiteCode: normalizeAlias(endpointB.rawSiteCode),
          farRackCode: normalizeRackCode(endpointB.rawRackCode),
          farOdfCode: normalizeOdfCode(endpointB.rawOdfCode),
          localPortGroupId: endpointAAssets.portGroupId,
          farPortGroupId: endpointBAssets.portGroupId,
        },
      });

      await segmentCapacityService.ensureFiberInventory(tx, segmentId, segmentCapacity);

    });

    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: segmentId,
      action: "UPDATE",
      fieldName: "segment",
      newValue: body,
      changedById: session?.id ?? null,
      reason: clean(body.overrideReason) ?? "Manual segment update",
    });

    const row = await inventoryService.getInventoryRowById(segmentId);
    return NextResponse.json({ row });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Segment update failed." },
      { status: 500 },
    );
  }
}
