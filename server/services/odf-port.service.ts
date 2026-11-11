import { ResourceStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizeRackCode } from "@/lib/telecom/connection-identity";
import { displaySiteLabel } from "@/lib/telecom/site-display";
import { applyDarkStubMarker } from "@/lib/telecom/dark-stub";
import { inventorySyncService } from "@/server/services/inventory-sync.service";

const RESOURCE_STATUSES = new Set(Object.values(ResourceStatus));

function parseRanges(value: string): number[] {
  const ports = new Set<number>();

  for (const part of value.split(",")) {
    const text = part.trim();
    if (!text) continue;

    const match = text.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;

    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);

    for (let port = Math.min(start, end); port <= Math.max(start, end); port += 1) {
      ports.add(port);
    }
  }

  return [...ports].sort((a, b) => a - b);
}

function normalizeStatus(status?: string | null): ResourceStatus | undefined {
  if (!status) return undefined;
  const normalized = status.trim().toUpperCase();
  // EDIT HERE: ODF port classifications are normalized to the five agreed UI states.
  // Legacy values are mapped so old imports do not break the clean operational model.
  const aliases: Record<string, ResourceStatus> = {
    ACTIVE: "ACTIVE",
    USED: "ACTIVE",
    INACTIVE: "DECOMMISSIONED",
    PLANNED: "AVAILABLE",
    // RESERVED is a first-class, operator-selectable ODF port type — it must
    // persist as RESERVED (no longer collapsed into AVAILABLE).
    SPARE: "AVAILABLE",
  };
  const mapped = aliases[normalized] ?? normalized;
  return RESOURCE_STATUSES.has(mapped as ResourceStatus) ? mapped as ResourceStatus : undefined;
}

function rangeNumbers(start?: number | null, end?: number | null): number[] {
  if (!start || !end || start <= 0 || end <= 0) return [];
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function pairLabels(maxPort: number): Array<{ label: string; ports: number[] }> {
  const groups: Array<{ label: string; ports: number[] }> = [];
  for (let port = 1; port <= maxPort; port += 2) {
    const ports = port + 1 <= maxPort ? [port, port + 1] : [port];
    groups.push({ label: ports.length === 1 ? String(port) : `${port}-${port + 1}`, ports });
  }
  return groups;
}

function statusForPorts(ports: number[], terminated: Set<number>, dummy: Set<number>): ResourceStatus {
  if (ports.some((port) => dummy.has(port))) return "DUMMY";
  // New ODF provisioning does not make traffic active. Terminated input ranges are physical availability only.
  return "AVAILABLE";
}

function readableSiteName(raw: string): string | null {
  const label = displaySiteLabel(raw);
  const normalized = normalizeAlias(raw);
  if (!label || label === "-" || label === normalized) return null;
  return label;
}


function titleCaseLoose(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (["MSC", "BSC", "MDU", "POP", "DC", "ATN", "ODF", "OLT", "PE", "OSP", "ISP", "NOC", "DWDM"].includes(upper)) return upper;
      if (/^(MU|MUTR|DH|BA|SH|MS|DA|DF)\d+/i.test(word)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function siteDisplayName(siteCode: string, provided?: string | null): string {
  const text = String(provided ?? "").trim();
  if (text && normalizeAlias(text) !== normalizeAlias(siteCode)) return displaySiteLabel(text);
  return displaySiteLabel(siteCode);
}

function rangeFromStartEnd(start?: string | number | null, end?: string | number | null): number[] {
  const a = Number(start);
  const b = Number(end ?? start);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return [];
  const ports: number[] = [];
  for (let port = Math.min(a, b); port <= Math.max(a, b); port += 1) ports.push(port);
  return ports;
}

function pairLabelsFromPorts(ports: number[]): string[] {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const labels: string[] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const first = sorted[i];
    const second = sorted[i + 1];
    labels.push(second && second === first + 1 ? `${first}-${second}` : String(first));
  }
  return labels;
}

async function fallbackUserId() {
  return (await prisma.user.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }))?.id ?? null;
}

export const odfPortService = {
  async configureInventory(input: {
    siteCode: string;
    siteName?: string | null;
    rackCode: string;
    odfCode: string;
    totalPorts?: string | number | null;
    terminatedStartPort?: string | number | null;
    terminatedEndPort?: string | number | null;
    dummyStartPort?: string | number | null;
    dummyEndPort?: string | number | null;
    remarks?: string | null;
  }, changedById?: string | null) {
    const siteCode = normalizeAlias(input.siteCode);
    const rackCode = normalizeRackCode(input.rackCode);
    const odfCode = normalizeOdfCode(input.odfCode);
    const terminatedPorts = rangeFromStartEnd(input.terminatedStartPort, input.terminatedEndPort);
    const dummyPorts = rangeFromStartEnd(input.dummyStartPort, input.dummyEndPort);
    const maxFromRanges = Math.max(0, ...terminatedPorts, ...dummyPorts);
    const requestedTotal = Number(input.totalPorts ?? 0);
    const maxPort = Number.isFinite(requestedTotal) && requestedTotal > 0 ? requestedTotal : maxFromRanges;
    const allPorts = maxPort ? Array.from({ length: maxPort }, (_, index) => index + 1) : [];

    if (!siteCode || !rackCode || !odfCode || !allPorts.length) {
      throw new Error("Site ID, rack ID, ODF ID, and either total ODF ports or a terminated/dummy port range are required.");
    }

    const dummySet = new Set(dummyPorts);
    const terminatedSet = new Set(terminatedPorts);
    const displayName = siteDisplayName(siteCode, input.siteName);

    let odfId = "";
    let createdPorts = 0;
    let createdGroups = 0;

    await prisma.$transaction(async (tx) => {
      const site = await tx.site.upsert({
        where: { code: siteCode },
        update: { name: displayName || undefined, isFiberNode: true },
        create: { code: siteCode, name: displayName, isFiberNode: true, status: "ACTIVE" },
      });

      await tx.siteAlias.upsert({
        where: { aliasNormalized: siteCode },
        update: { siteId: site.id },
        create: { siteId: site.id, alias: siteCode, aliasNormalized: siteCode, isPrimary: true, source: "MANUAL" },
      });

      const rack = await tx.rack.upsert({
        where: { siteId_rackCode: { siteId: site.id, rackCode } },
        update: { status: "ACTIVE" },
        create: { siteId: site.id, rackCode, name: rackCode, status: "ACTIVE" },
      });

      const odf = await tx.oDF.upsert({
        where: { siteId_rackId_odfCode: { siteId: site.id, rackId: rack.id, odfCode } },
        update: { maxPorts: maxPort, remarks: input.remarks ?? undefined, status: "ACTIVE" },
        create: { siteId: site.id, rackId: rack.id, odfCode, name: odfCode, maxPorts: maxPort, remarks: input.remarks ?? null, status: "ACTIVE" },
      });
      odfId = odf.id;

      for (const portNumber of allPorts) {
        const status: ResourceStatus = dummySet.has(portNumber) ? "DUMMY" : "AVAILABLE";
        await tx.oDFPort.upsert({
          where: { odfId_portNumber: { odfId: odf.id, portNumber } },
          update: { status, remarks: input.remarks ?? undefined },
          create: { odfId: odf.id, portNumber, label: String(portNumber), status, remarks: input.remarks ?? null },
        });
        createdPorts += 1;
      }

      const labels = pairLabelsFromPorts(allPorts);
      for (const label of labels) {
        const ports = parseRanges(label);
        const groupStatus: ResourceStatus = ports.every((port) => dummySet.has(port)) ? "DUMMY" : "AVAILABLE";
        const group = await tx.portGroup.upsert({
          where: { odfId_displayLabel: { odfId: odf.id, displayLabel: label } },
          update: {
            status: groupStatus,
            startPortNumber: ports[0] ?? null,
            endPortNumber: ports[ports.length - 1] ?? null,
            remarks: input.remarks ?? undefined,
          },
          create: {
            siteId: site.id,
            rackId: rack.id,
            odfId: odf.id,
            groupType: ports.length === 1 ? "SINGLE" : ports.length === 2 ? "PAIR" : "CUSTOM",
            displayLabel: label,
            startPortNumber: ports[0] ?? null,
            endPortNumber: ports[ports.length - 1] ?? null,
            status: groupStatus,
            remarks: input.remarks ?? null,
            source: "MANUAL",
          },
        });
        createdGroups += 1;

        for (let sequence = 0; sequence < ports.length; sequence += 1) {
          const odfPort = await tx.oDFPort.findUnique({ where: { odfId_portNumber: { odfId: odf.id, portNumber: ports[sequence] } }, select: { id: true } });
          if (!odfPort) continue;
          await tx.portGroupMember.upsert({
            where: { portGroupId_odfPortId: { portGroupId: group.id, odfPortId: odfPort.id } },
            update: { sequence },
            create: { portGroupId: group.id, odfPortId: odfPort.id, sequence },
          });
        }
      }
    });

    // Real-time downstream sync: segment endpoints referencing this
    // Site/Rack/ODF by raw code (imports, seeds, staged records) get their
    // relational FKs linked now that the assets are registered.
    await inventorySyncService.healSegmentEndpoints(prisma);

    await writeAuditLog({
      entityType: "ODF",
      entityId: odfId,
      action: "CREATE",
      fieldName: "bulkOdfInventoryAdd",
      newValue: input,
      changedById: changedById ?? await fallbackUserId(),
      reason: "Bulk ODF inventory add/update",
    });

    return {
      odfId,
      siteCode,
      siteName: displayName,
      rackCode,
      odfCode,
      odfPortCount: createdPorts,
      portGroupCount: createdGroups,
      terminatedPortCount: 0,
      dummyPortCount: dummyPorts.length,
      message: `Configured ${createdPorts} ODF port(s), ${createdGroups} port group(s), ${0} active port(s), and ${dummyPorts.length} dummy port(s) for ${displayName}/${rackCode}/${odfCode}.`,
    };
  },

  async bulkUpdate(input: {
    siteCode: string;
    rackCode: string;
    odfCode: string;
    ranges: string;
    status?: string;
    remarks?: string | null;
    tubeNumber?: number | null;
    tubeColor?: string | null;
    fiberPortStart?: number | null;
  }, changedById?: string | null) {
    const siteCode = normalizeAlias(input.siteCode);
    const rackCode = normalizeRackCode(input.rackCode);
    const odfCode = normalizeOdfCode(input.odfCode);
    const ports = parseRanges(input.ranges);
    const status = normalizeStatus(input.status);

    if (!siteCode || !rackCode || !odfCode || !ports.length) {
      throw new Error("Site, rack, ODF, and ODF port ranges are required.");
    }

    const odf = await prisma.oDF.findFirst({
      where: { odfCode, site: { code: siteCode }, rack: { rackCode } },
      select: { id: true },
    });

    if (!odf) throw new Error(`ODF ${siteCode}/${rackCode}/${odfCode} was not found.`);

    let affectedPortGroups = 0;

    await prisma.$transaction(async (tx) => {
      const versionBefore = await tx.oDF.findUnique({
        where: { id: odf.id },
        select: { updatedAt: true },
      });
      if (!versionBefore) throw new Error(`ODF ${siteCode}/${rackCode}/${odfCode} was not found.`);

      for (let index = 0; index < ports.length; index += 1) {
        const portNumber = ports[index];
        await tx.oDFPort.upsert({
          where: { odfId_portNumber: { odfId: odf.id, portNumber } },
          update: {
            status,
            remarks: input.remarks ?? undefined,
            tubeNumber: input.tubeNumber ?? undefined,
            tubeColor: input.tubeColor ?? undefined,
            fiberPortNumber: input.fiberPortStart ? input.fiberPortStart + index : undefined,
          },
          create: {
            odfId: odf.id,
            portNumber,
            label: String(portNumber),
            status: status ?? "AVAILABLE",
            remarks: input.remarks ?? null,
            tubeNumber: input.tubeNumber ?? null,
            tubeColor: input.tubeColor ?? null,
            fiberPortNumber: input.fiberPortStart ? input.fiberPortStart + index : null,
          },
        });
      }

      const updatedGroups = await tx.portGroup.updateMany({
        where: {
          odfId: odf.id,
          OR: ports.map((portNumber) => ({
            startPortNumber: { lte: portNumber },
            endPortNumber: { gte: portNumber },
          })),
        },
        data: {
          status,
          remarks: input.remarks ?? undefined,
          tubeNumber: input.tubeNumber ?? undefined,
          tubeColor: input.tubeColor ?? undefined,
        },
      });

      affectedPortGroups = updatedGroups.count;

      const versionClaim = await tx.oDF.updateMany({
        where: { id: odf.id, updatedAt: versionBefore.updatedAt },
        data: { updatedAt: new Date() },
      });
      if (versionClaim.count !== 1) {
        throw new Error("ODF was modified by another user. Refresh and retry.");
      }
    });

    await writeAuditLog({
      entityType: "ODF",
      entityId: odf.id,
      action: "UPDATE",
      fieldName: "odfPortRangeUpdate",
      newValue: {
        ...input,
        odfPortCount: ports.length,
        affectedPortGroups,
      },
      changedById: changedById ?? await fallbackUserId(),
      reason: "Range-based ODF port update",
    });

    return {
      odfId: odf.id,
      odfPortCount: ports.length,
      updatedPorts: ports.length,
      affectedPortGroups,
      ports,
      message: `Updated ${ports.length} ODF port(s).`,
    };
  },

  // Manual DARK_STUB blocking, strictly at the individual-ODF-port level (NOT the
  // PortGroup / PTP-allocation level). Only the exact ports passed in are toggled:
  // no group cascade, and no far-end peer is touched (a far-end port is a different
  // ODFPort row at another ODF, so it stays independently routable). Validates the
  // whole selection before writing anything (Zero-Overwrite: a conflict halts with
  // a descriptive error and leaves the DB unchanged).
  async setPortBlock(input: {
    siteCode: string;
    rackCode: string;
    odfCode: string;
    ports: number[];
    blocked: boolean;
    reason?: string | null;
  }, changedById?: string | null) {
    const siteCode = normalizeAlias(input.siteCode);
    const rackCode = normalizeRackCode(input.rackCode);
    const odfCode = normalizeOdfCode(input.odfCode);
    const ports = [...new Set((input.ports ?? []).filter((port) => Number.isInteger(port) && port > 0))].sort((a, b) => a - b);

    if (!siteCode || !rackCode || !odfCode || !ports.length) {
      throw new Error("Site ID, rack ID, ODF ID, and at least one ODF port are required.");
    }

    const odf = await prisma.oDF.findFirst({
      where: { odfCode, site: { code: siteCode }, rack: { rackCode } },
      select: { id: true },
    });
    if (!odf) throw new Error(`ODF ${siteCode}/${rackCode}/${odfCode} was not found.`);

    const rows = await prisma.oDFPort.findMany({
      where: { odfId: odf.id, portNumber: { in: ports } },
      select: { portNumber: true, status: true, remarks: true },
    });
    const byPort = new Map(rows.map((row) => [row.portNumber, row]));

    const missing = ports.filter((port) => !byPort.has(port));
    if (missing.length) {
      throw new Error(`These ODF ports do not exist at ${siteCode}/${rackCode}/${odfCode}: ${missing.join(", ")}.`);
    }

    // Guardrail: never block a port that is carrying live service. Halt the whole
    // operation with a clear message rather than partially applying it.
    if (input.blocked) {
      const live = rows.filter((row) => ["ACTIVE", "USED"].includes(String(row.status).toUpperCase()));
      if (live.length) {
        throw new Error(
          `Cannot mark DARK_STUB: port(s) ${live.map((row) => row.portNumber).join(", ")} at ${siteCode}/${rackCode}/${odfCode} carry live service. Release the allocation first.`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const port of ports) {
        const existing = byPort.get(port)!;
        await tx.oDFPort.update({
          where: { odfId_portNumber: { odfId: odf.id, portNumber: port } },
          data: {
            isBlocked: input.blocked,
            remarks: applyDarkStubMarker(existing.remarks, input.blocked, input.reason),
          },
        });
      }
    });

    await writeAuditLog({
      entityType: "ODF",
      entityId: odf.id,
      action: "UPDATE",
      fieldName: input.blocked ? "odfPortDarkStubBlock" : "odfPortDarkStubClear",
      newValue: { siteCode, rackCode, odfCode, ports, blocked: input.blocked, reason: input.reason ?? null },
      changedById: changedById ?? await fallbackUserId(),
      reason: input.blocked ? "Marked individual ODF ports as DARK_STUB" : "Cleared DARK_STUB on individual ODF ports",
    });

    return {
      odfId: odf.id,
      ports,
      blocked: input.blocked,
      message: `${input.blocked ? "Blocked" : "Unblocked"} ${ports.length} ODF port(s) at ${siteCode}/${rackCode}/${odfCode} as DARK_STUB.`,
    };
  },
};
