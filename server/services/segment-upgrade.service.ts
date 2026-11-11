import { Prisma, ResourceStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { segmentCapacityService } from "@/server/services/segment-capacity.service";
import { inventoryService } from "@/server/services/inventory.service";
import { inventorySyncService } from "@/server/services/inventory-sync.service";

type Tx = Prisma.TransactionClient;

/**
 * Capacity upgrade = grow a segment's live ODF-port capacity by consuming the
 * DUMMY ports already provisioned on its two endpoint ODFs (from ODF & Racks
 * inventory). Business rule (operator-defined):
 *   • New ports must come ONLY from the dummy-port pool. A port that is already
 *     ACTIVE / USED / AVAILABLE / RESERVED / any non-DUMMY state is rejected with
 *     "already active fibers".
 *   • Near and far counts must match (each near port pairs with one far port).
 * The new ports are flipped DUMMY -> AVAILABLE and added as live child mappings,
 * so the segment's capacity and displayed port range grow automatically (both are
 * derived from child mappings).
 */

function parsePortRange(text?: string | null): number[] {
  const ports = new Set<number>();
  for (const part of String(text ?? "").split(",")) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2] ?? match[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) continue;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p += 1) ports.add(p);
  }
  return [...ports].sort((x, y) => x - y);
}

function compactRanges(ports: number[]): string {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

function safeFiberNumbers(json?: string | null): number[] {
  try {
    const value = JSON.parse(json ?? "[]");
    return Array.isArray(value) ? value.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

async function loadSegment(segmentId: string) {
  return prisma.linkSegment.findUnique({
    where: { id: segmentId },
    include: {
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
    },
  });
}

type LoadedSegment = NonNullable<Awaited<ReturnType<typeof loadSegment>>>;
type LoadedEndpoint = LoadedSegment["endpointA"];

// Relation-lookup repair, not business logic: endpoints created from imports or
// seeds may hold only raw Site/Rack/ODF codes with null FK ids even though the
// assets are registered. Re-link them from the raw codes before any FK-based
// guard runs, so a registered inventory is never reported as missing.
async function loadSegmentHealed(segmentId: string) {
  let seg = await loadSegment(segmentId);
  if (seg && (!seg.endpointA?.odfId || !seg.endpointB?.odfId)) {
    await inventorySyncService.healSegmentEndpoints(prisma, { segmentId });
    seg = await loadSegment(segmentId);
  }
  return seg;
}

async function endpointSummary(endpoint: LoadedEndpoint) {
  const odfId = endpoint?.odfId ?? null;
  let dummyPorts: number[] = [];
  if (odfId) {
    const ports = await prisma.oDFPort.findMany({
      where: { odfId, status: ResourceStatus.DUMMY },
      select: { portNumber: true },
      orderBy: { portNumber: "asc" },
    });
    dummyPorts = ports.map((p) => p.portNumber);
  }
  return {
    site: endpoint?.rawSiteCode ?? endpoint?.site?.code ?? null,
    rack: endpoint?.rawRackCode ?? endpoint?.rack?.rackCode ?? null,
    odf: endpoint?.rawOdfCode ?? endpoint?.odf?.odfCode ?? null,
    odfId,
    configuredRange: endpoint?.portGroup?.displayLabel ?? endpoint?.rawPortText ?? null,
    dummyPorts,
    dummyRanges: compactRanges(dummyPorts),
  };
}

async function assertDummyPorts(odfId: string, ports: number[], side: "near" | "far", endpoint: LoadedEndpoint) {
  const rows = await prisma.oDFPort.findMany({ where: { odfId, portNumber: { in: ports } }, select: { portNumber: true, status: true } });
  const byPort = new Map(rows.map((r) => [r.portNumber, r.status]));
  const odfLabel = `${endpoint?.rawSiteCode ?? "?"}/${endpoint?.rawRackCode ?? "?"}/${endpoint?.rawOdfCode ?? "?"}`;
  const notDummy: number[] = [];
  const missing: number[] = [];
  for (const port of ports) {
    if (!byPort.has(port)) missing.push(port);
    else if (byPort.get(port) !== ResourceStatus.DUMMY) notDummy.push(port);
  }
  // Operator rule: only dummy ports may be consumed. Active/available/reserved/etc.
  // are off-limits — surface the exact "already active fibers" warning.
  if (notDummy.length) {
    throw new Error(
      `${side === "near" ? "Near" : "Far"}-end port(s) ${compactRanges(notDummy)} on ODF ${odfLabel} are already active fibers — begin the upgrade from a sequence that is still in the dummy-port pool.`,
    );
  }
  if (missing.length) {
    throw new Error(
      `${side === "near" ? "Near" : "Far"}-end port(s) ${compactRanges(missing)} are not configured as dummy ports on ODF ${odfLabel}. Only dummy ports (from ODF & Racks inventory) can be used to upgrade capacity.`,
    );
  }
}

async function activateDummyPorts(tx: Tx, odfId: string, ports: number[]) {
  await tx.oDFPort.updateMany({
    where: { odfId, portNumber: { in: ports }, status: ResourceStatus.DUMMY },
    data: { status: ResourceStatus.AVAILABLE },
  });
  // Flip the dummy PortGroups that cover these ports to AVAILABLE so the ODF
  // explorer no longer shows them as dummy spare capacity.
  await tx.portGroup.updateMany({
    where: { odfId, status: ResourceStatus.DUMMY, OR: ports.map((p) => ({ startPortNumber: { lte: p }, endPortNumber: { gte: p } })) },
    data: { status: ResourceStatus.AVAILABLE },
  });
}

export const segmentUpgradeService = {
  async getContext(segmentId: string) {
    const seg = await loadSegmentHealed(segmentId);
    if (!seg) throw new Error("Segment not found.");
    return {
      segmentId: seg.id,
      segmentCode: seg.segmentCode,
      totalFiberCapacity: seg.totalFiberCapacity,
      near: await endpointSummary(seg.endpointA),
      far: await endpointSummary(seg.endpointB),
    };
  },

  async upgradeCapacity(segmentId: string, input: { nearPorts?: string | null; farPorts?: string | null }, changedById?: string | null) {
    const seg = await loadSegmentHealed(segmentId);
    if (!seg) throw new Error("Segment not found.");
    if (seg.status === ResourceStatus.DECOMMISSIONED) throw new Error("A decommissioned segment cannot be upgraded.");

    const nearOdfId = seg.endpointA?.odfId;
    const farOdfId = seg.endpointB?.odfId;
    if (!nearOdfId || !farOdfId) {
      throw new Error("Both segment endpoints must have a registered ODF before upgrading capacity. Add the ODF/Rack inventory first.");
    }

    const nearPorts = parsePortRange(input.nearPorts);
    const farPorts = parsePortRange(input.farPorts);
    if (!nearPorts.length || !farPorts.length) {
      throw new Error("Enter the near-end and far-end dummy port range to add.");
    }
    if (nearPorts.length !== farPorts.length) {
      throw new Error(`Near-end (${nearPorts.length}) and far-end (${farPorts.length}) port counts must match — each near port pairs with one far port.`);
    }

    await assertDummyPorts(nearOdfId, nearPorts, "near", seg.endpointA);
    await assertDummyPorts(farOdfId, farPorts, "far", seg.endpointB);

    const result = await prisma.$transaction(
      async (tx) => {
        await activateDummyPorts(tx, nearOdfId, nearPorts);
        await activateDummyPorts(tx, farOdfId, farPorts);

        const maxLedger = (await tx.segmentFiber.aggregate({ where: { segmentId }, _max: { fiberNumber: true } }))._max.fiberNumber ?? 0;
        const existingMappings = await tx.segmentEndpointMapping.findMany({ where: { segmentId }, select: { fiberNumbersJson: true } });
        const maxMapping = existingMappings.flatMap((m) => safeFiberNumbers(m.fiberNumbersJson)).reduce((a, b) => Math.max(a, b), 0);
        // Seed the new-fiber counter from the highest fiber ACTUALLY in use (ledger
        // or child mappings) — never from totalFiberCapacity. The capacity counter
        // can sit above the real max fiber (e.g. capacity 2 while only fiber 1 is
        // mapped); including it here skipped the next contiguous fiber and overran
        // past the ledger (added fibers 3..13 instead of 2..12), desyncing the
        // mapping fiber-domain from the ODF ports. Contiguity is what keeps port N
        // aligned to fiber N.
        let nextFiber = Math.max(maxLedger, maxMapping);

        for (let i = 0; i < nearPorts.length; i += 1) {
          nextFiber += 1;
          await tx.segmentEndpointMapping.create({
            data: {
              segmentId,
              localSiteCode: seg.endpointA.rawSiteCode,
              localRackCode: seg.endpointA.rawRackCode,
              localOdfCode: seg.endpointA.rawOdfCode,
              localPortLabel: String(nearPorts[i]),
              farSiteCode: seg.endpointB.rawSiteCode,
              farEndpointLabel: seg.endpointB.rawSiteCode,
              farRackCode: seg.endpointB.rawRackCode,
              farOdfCode: seg.endpointB.rawOdfCode,
              farPortLabel: String(farPorts[i]),
              localPortGroupId: seg.endpointA.portGroupId ?? null,
              farPortGroupId: seg.endpointB.portGroupId ?? null,
              fiberNumbersJson: JSON.stringify([nextFiber]),
              status: ResourceStatus.AVAILABLE,
              source: "MANUAL",
              remarks: `[CAPACITY-UPGRADE] Added from dummy ports near ${nearPorts[i]} / far ${farPorts[i]}.`,
            },
          });
        }

        // Size the ledger to the true highest fiber now in use (nextFiber after the
        // loop = maxUsedFiber + added ports), NOT totalFiberCapacity + added. The
        // capacity counter can sit above the real fiber count, which previously
        // overran the ledger by one (created fiber 13 for a 12-fiber segment).
        await segmentCapacityService.ensureFiberInventory(tx, segmentId, nextFiber);
        return segmentCapacityService.refreshSegmentCapacity(tx, segmentId);
      },
      { maxWait: 20000, timeout: 60000 },
    );

    await writeAuditLog({
      entityType: "LinkSegment",
      entityId: segmentId,
      action: "UPDATE",
      fieldName: "capacityUpgrade",
      newValue: { nearPorts, farPorts, addedFibers: nearPorts.length, newTotalCapacity: result.totalFiberCapacity },
      changedById: changedById ?? null,
      reason: "Capacity upgrade from dummy ODF ports",
    });

    return {
      row: await inventoryService.getInventoryRowById(segmentId),
      addedFibers: nearPorts.length,
      newTotalCapacity: result.totalFiberCapacity,
    };
  },
};
