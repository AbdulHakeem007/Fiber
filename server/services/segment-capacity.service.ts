import { Prisma, ResourceStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { fiberCountFromUnit, portNumbersFromLabel } from "@/lib/telecom/fiber-unit";
import { isRehomedOutRemark } from "@/lib/telecom/rehome";
import { isStrandedStrandRemark } from "@/lib/telecom/stranded";
import { canonicalSegmentCodeForCapacity, canonicalSegmentSequence } from "@/lib/telecom/segment-naming";

const DEFAULT_SEGMENT_FIBER_CAPACITY = 48;

/** Remark prefix marking an ODF mapping row auto-consumed by service allocation. */
const AUTO_ALLOC_MARKER = "[AUTO-ALLOC]";

type Tx = Prisma.TransactionClient;

type SegmentWithCapacity = NonNullable<Awaited<ReturnType<typeof loadSegmentForCapacity>>>;

async function loadSegmentForCapacity(tx: Tx, segmentId: string) {
  return tx.linkSegment.findUnique({
    where: { id: segmentId },
    include: {
      cable: true,
      endpointA: { include: { odf: true, portGroup: true } },
      endpointB: { include: { odf: true, portGroup: true } },
    },
  });
}

function positiveInt(value?: number | null): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function highestEndpointPort(segment: SegmentWithCapacity): number | null {
  const values = [
    segment.endpointA.portGroup?.endPortNumber,
    segment.endpointA.portGroup?.startPortNumber,
    segment.endpointB.portGroup?.endPortNumber,
    segment.endpointB.portGroup?.startPortNumber,
  ].map(positiveInt).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

export function inferSegmentFiberCapacity(segment: SegmentWithCapacity, requestedCapacity?: number | null): number {
  return (
    positiveInt(requestedCapacity) ??
    positiveInt(segment.totalFiberCapacity) ??
    positiveInt(segment.usableFiberCapacity) ??
    positiveInt(segment.fiberCount) ??
    positiveInt(segment.cable?.totalFibers) ??
    positiveInt(highestEndpointPort(segment)) ??
    DEFAULT_SEGMENT_FIBER_CAPACITY
  );
}

function inferAlignedUsableCapacity(segment: SegmentWithCapacity, total: number): number {
  const constraints = [
    positiveInt(segment.cable?.totalFibers),
    positiveInt(segment.endpointA.odf?.maxPorts),
    positiveInt(segment.endpointB.odf?.maxPorts),
  ].filter((value): value is number => value !== null);
  return Math.max(0, Math.min(total, ...(constraints.length ? constraints : [total])));
}

function isAllocatable(status: ResourceStatus): boolean {
  return status === ResourceStatus.AVAILABLE || status === ResourceStatus.SPARE || status === ResourceStatus.ACTIVE;
}

// EDIT HERE: Live direct-capacity calculation.
// REHOMED_OUT rows are still live ports, but no longer live direct capacity of this parent segment.
// They are excluded from the parent X-Z capacity while remaining traceable/auditable.
// STUB_STRAND tails (mid-span-tap stranded capacity) are likewise physically present but have no
// outbound continuity, so they are excluded from live direct capacity while staying on the row.
function isLiveDirectCapacity(status: ResourceStatus, remarks?: string | null): boolean {
  return (
    status !== ResourceStatus.DUMMY &&
    status !== ResourceStatus.DECOMMISSIONED &&
    !isRehomedOutRemark(remarks) &&
    !isStrandedStrandRemark(remarks)
  );
}

function findConsecutiveRun(fibers: Array<{ id: string; fiberNumber: number; status: ResourceStatus; serviceId: string | null }>, size: number) {
  const sorted = fibers.filter((fiber) => isAllocatable(fiber.status) && !fiber.serviceId).sort((a, b) => a.fiberNumber - b.fiberNumber);
  for (let index = 0; index <= sorted.length - size; index += 1) {
    const run = sorted.slice(index, index + size);
    const startsAt = run[0]?.fiberNumber ?? 0;
    if (run.every((fiber, offset) => fiber.fiberNumber === startsAt + offset)) return run;
  }
  return null;
}

export const segmentCapacityService = {
  async ensureFiberInventory(tx: Tx, segmentId: string, requestedCapacity?: number | null) {
    const segment = await loadSegmentForCapacity(tx, segmentId);
    if (!segment) throw new Error("Segment not found while creating fiber inventory.");

    const capacity = inferSegmentFiberCapacity(segment, requestedCapacity);
    const existing = await tx.segmentFiber.findMany({
      where: { segmentId },
      select: { fiberNumber: true },
      orderBy: { fiberNumber: "asc" },
    });
    const existingNumbers = new Set(existing.map((fiber) => fiber.fiberNumber));

    for (let fiberNumber = 1; fiberNumber <= capacity; fiberNumber += 1) {
      if (existingNumbers.has(fiberNumber)) continue;
      await tx.segmentFiber.create({
        data: {
          segmentId,
          fiberNumber,
          status: ResourceStatus.AVAILABLE,
          tubeNumber: segment.tubeNumber,
          tubeColor: segment.tubeColor,
          tubeLabel: segment.tubeLabel,
          fiberPortNumber: segment.fiberPortNumber ? segment.fiberPortNumber + fiberNumber - 1 : null,
          fiberLabel: segment.fiberLabel,
        },
      });
    }

    await tx.linkSegment.update({
      where: { id: segmentId },
      data: {
        totalFiberCapacity: capacity,
        availableFiberCount: Math.max(0, capacity - existing.length),
      },
    });

    return this.refreshSegmentCapacity(tx, segmentId);
  },

  async refreshSegmentCapacity(tx: Tx, segmentId: string) {
    const mappings = await tx.segmentEndpointMapping.findMany({
      where: { segmentId },
      select: { localPortLabel: true, farPortLabel: true, fiberNumbersJson: true, status: true, serviceCode: true, remarks: true },
    });

    let total = 0;
    let used = 0;
    let reserved = 0;
    let faulty = 0;
    let dummy = 0;
    // "Inactive" = ports that physically exist but are not usable until OSP work
    // is done (UNKNOWN/PLANNED/INACTIVE/MAINTENANCE). Renamed from "blocked".
    let inactive = 0;

    if (mappings.length) {
      for (const mapping of mappings) {
        const count = fiberCountFromUnit(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson) || 1;
        const status = mapping.status;

        // EDIT HERE: Parent partial-split capacity.
        // Re-homed child ODF port links are still live under the new split segments.
        // They must not count as direct parent capacity, but they must also not be treated as DUMMY.
        if (!isLiveDirectCapacity(status, mapping.remarks)) {
          if (status === ResourceStatus.DUMMY || status === ResourceStatus.DECOMMISSIONED) dummy += count;
          continue;
        }

        total += count;
        // ACTIVE counts as Used (a bare-ACTIVE row used to fall through to Available).
        if (mapping.serviceCode?.trim() || status === ResourceStatus.USED || status === ResourceStatus.ACTIVE) used += count;
        else if (status === ResourceStatus.RESERVED) reserved += count;
        else if (status === ResourceStatus.FAULTY) faulty += count;
        else if (status === ResourceStatus.UNKNOWN || status === ResourceStatus.PLANNED || status === ResourceStatus.INACTIVE || status === ResourceStatus.MAINTENANCE) inactive += count;
      }
    } else {
      const fibers = await tx.segmentFiber.findMany({
        where: { segmentId },
        select: { status: true, serviceCode: true, serviceId: true, remarks: true },
      });

      for (const fiber of fibers) {
        if (!isLiveDirectCapacity(fiber.status, fiber.remarks)) {
          if (fiber.status === ResourceStatus.DUMMY || fiber.status === ResourceStatus.DECOMMISSIONED) dummy += 1;
          continue;
        }
        total += 1;
        if (fiber.serviceCode || fiber.serviceId || fiber.status === ResourceStatus.USED || fiber.status === ResourceStatus.ACTIVE) used += 1;
        else if (fiber.status === ResourceStatus.RESERVED) reserved += 1;
        else if (fiber.status === ResourceStatus.FAULTY) faulty += 1;
        else if (fiber.status === ResourceStatus.UNKNOWN || fiber.status === ResourceStatus.PLANNED || fiber.status === ResourceStatus.INACTIVE || fiber.status === ResourceStatus.MAINTENANCE) inactive += 1;
      }
    }

    const usable = Math.max(0, total);
    const available = Math.max(0, usable - used - reserved - faulty - inactive);
    // Utilization = Used / Total only. Reserved/Faulty/Inactive are their own
    // buckets and are NOT counted as utilized ("Available" is the only free state).
    const utilizationPct = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

    const existing = await tx.linkSegment.findUnique({
      where: { id: segmentId },
      select: { status: true, segmentCode: true, segmentSequence: true },
    });
    const mayAutoStatus = existing?.status === ResourceStatus.ACTIVE || existing?.status === ResourceStatus.AVAILABLE || existing?.status === ResourceStatus.SPARE || existing?.status === ResourceStatus.USED;

    const nextSegmentCode = existing?.segmentCode ? canonicalSegmentCodeForCapacity(existing.segmentCode, total) : undefined;
    const nextSegmentSequence = existing?.segmentCode ? canonicalSegmentSequence(existing.segmentCode, existing.segmentSequence) : undefined;
    const segmentCodeConflict = nextSegmentCode && existing?.segmentCode && nextSegmentCode !== existing.segmentCode
      ? await tx.linkSegment.findUnique({ where: { segmentCode: nextSegmentCode }, select: { id: true } })
      : null;

    return tx.linkSegment.update({
      where: { id: segmentId },
      data: {
        // EDIT HERE: Segment naming/capacity normalization.
        // Keep the live capacity field synced and safely rewrite old suffixes
        // like -C01-24F to -C01-18F when partial rehome reduces direct capacity.
        segmentCode: nextSegmentCode && !segmentCodeConflict ? nextSegmentCode : undefined,
        segmentSequence: nextSegmentSequence ?? undefined,
        segmentCapacityFibers: total,
        totalFiberCapacity: total,
        usableFiberCapacity: usable,
        usedFiberCount: used,
        reservedFiberCount: reserved,
        faultyFiberCount: faulty,
        inactiveFiberCount: inactive,
        dummyFiberCount: dummy,
        availableFiberCount: available,
        utilizationPct,
        status: mayAutoStatus ? ResourceStatus.ACTIVE : undefined,
      },
    });
  },

  /**
   * Public, self-contained recompute for ONE segment — the "dynamic
   * recalculation" trigger fired after a port group is formed or split. Runs in
   * its own short transaction so API routes / background jobs can call it
   * without already holding a tx. Reads the authoritative child ODF-mapping rows
   * and rewrites the cached LinkSegment capacity counters cleanly.
   */
  async recalculateSegment(segmentId: string) {
    return prisma.$transaction((tx) => this.refreshSegmentCapacity(tx, segmentId), {
      maxWait: 15000,
      timeout: 30000,
    });
  },

  /**
   * One-shot drift correction: recompute the cached capacity counters for every
   * live segment straight from its child rows, WITHOUT materializing any fiber
   * ledger (unlike refreshAllSegmentCapacity, which calls ensureFiberInventory).
   * Fixes historical segments whose stored total fell 1-2 below the live
   * child-row truth. Chunked to respect SQLite transaction timeouts at scale.
   */
  async backfillAllSegmentCapacity(options?: { includeDecommissioned?: boolean }) {
    const segments = await prisma.linkSegment.findMany({
      where: options?.includeDecommissioned ? {} : { status: { not: ResourceStatus.DECOMMISSIONED } },
      select: { id: true },
    });
    const CHUNK = 100;
    let updated = 0;
    for (let index = 0; index < segments.length; index += CHUNK) {
      const chunk = segments.slice(index, index + CHUNK);
      await prisma.$transaction(
        async (tx) => {
          for (const { id } of chunk) await this.refreshSegmentCapacity(tx, id);
        },
        { maxWait: 20000, timeout: 120000 },
      );
      updated += chunk.length;
    }
    return { scanned: segments.length, updated };
  },

  /**
   * Stamp imported ODF mapping rows (SegmentEndpointMapping) as consumed for an
   * allocated service. For segments that carry imported child mappings,
   * refreshSegmentCapacity derives utilization from these rows — not the fiber
   * ledger — so without this stamp an auto-allocation never shows up in the ODF
   * Mappings tables or the segment utilization. Best-effort: consumes the first
   * available mapping rows covering the allocated fiber count.
   */
  async stampMappingsForAllocation(
    tx: Tx,
    input: { segmentId: string; serviceCode: string; fibersNeeded: number; isJumper?: boolean; pathLabel?: string | null },
  ) {
    const mappingRows = await tx.segmentEndpointMapping.findMany({
      where: {
        segmentId: input.segmentId,
        serviceCode: null,
        status: { in: [ResourceStatus.AVAILABLE, ResourceStatus.SPARE] },
      },
      select: { id: true, localPortLabel: true, farPortLabel: true, fiberNumbersJson: true },
    });
    if (!mappingRows.length) return { stampedIds: [] as string[], covered: 0 };
    // Ascending allocation: consume the lowest-numbered ODF ports first (Port 1,
    // 2, 3 …). Order by the parsed first port number — NOT the raw label string,
    // which would sort "10" before "2" and consume high ports out of order.
    const firstPortOf = (row: { localPortLabel: string | null; farPortLabel: string | null }) =>
      portNumbersFromLabel(row.localPortLabel ?? row.farPortLabel)[0] ?? Number.MAX_SAFE_INTEGER;
    const mappings = mappingRows.sort((a, b) => firstPortOf(a) - firstPortOf(b));

    const stampedIds: string[] = [];
    let covered = 0;
    for (const mapping of mappings) {
      if (covered >= input.fibersNeeded) break;
      stampedIds.push(mapping.id);
      covered += fiberCountFromUnit(mapping.localPortLabel ?? mapping.farPortLabel, mapping.fiberNumbersJson) || 1;
    }

    if (stampedIds.length) {
      const detail = input.isJumper ? `${input.serviceCode} (Jumper)` : (input.pathLabel ?? input.serviceCode);
      await tx.segmentEndpointMapping.updateMany({
        where: { id: { in: stampedIds } },
        data: {
          status: ResourceStatus.USED,
          serviceCode: input.serviceCode,
          // The [AUTO-ALLOC] marker lets a later re-allocation release exactly
          // the rows we auto-consumed, without ever touching imported mappings.
          remarks: `${AUTO_ALLOC_MARKER} ${detail}`,
        },
      });
    }
    return { stampedIds, covered };
  },

  /**
   * Release ODF mapping rows previously auto-stamped for a service (identified by
   * the [AUTO-ALLOC] remark marker) back to AVAILABLE. Imported/manually edited
   * mappings carrying the same serviceCode are left untouched.
   */
  async releaseAutoStampedMappings(tx: Tx, serviceCode: string) {
    const released = await tx.segmentEndpointMapping.findMany({
      where: { serviceCode, remarks: { startsWith: AUTO_ALLOC_MARKER } },
      select: { id: true, segmentId: true },
    });
    if (!released.length) return;
    await tx.segmentEndpointMapping.updateMany({
      where: { id: { in: released.map((mapping) => mapping.id) } },
      data: { status: ResourceStatus.AVAILABLE, serviceCode: null, remarks: null },
    });
    for (const segmentId of [...new Set(released.map((mapping) => mapping.segmentId))]) {
      await this.refreshSegmentCapacity(tx, segmentId);
    }
  },

  async releaseActiveServiceAllocations(tx: Tx, serviceId: string) {
    const activeRoutes = await tx.serviceRoute.findMany({
      where: { serviceId, isActive: true },
      select: { id: true },
    });
    const activeRouteIds = activeRoutes.map((route) => route.id);
    if (!activeRouteIds.length) return;

    const allocations = await tx.serviceAllocation.findMany({
      where: { serviceRouteId: { in: activeRouteIds }, status: ResourceStatus.ACTIVE },
      select: { id: true, segmentId: true },
    });
    const allocationIds = allocations.map((allocation) => allocation.id);
    const segmentIds = [...new Set(allocations.map((allocation) => allocation.segmentId))];

    if (allocationIds.length) {
      await tx.segmentFiber.updateMany({
        where: { serviceAllocationId: { in: allocationIds } },
        data: {
          status: ResourceStatus.AVAILABLE,
          serviceId: null,
          serviceRouteId: null,
          serviceAllocationId: null,
          serviceCode: null,
          allocationGroup: null,
          pathOrder: null,
          isJumper: false,
          allocatedAt: null,
          remarks: null,
        },
      });
      await tx.serviceAllocation.updateMany({
        where: { id: { in: allocationIds } },
        data: { status: ResourceStatus.SPARE, remarks: "Released by a newer active allocation for the same service." },
      });
    }

    for (const segmentId of segmentIds) {
      await this.refreshSegmentCapacity(tx, segmentId);
    }
  },

  async allocateFiberRun(
    tx: Tx,
    input: {
      segmentId: string;
      serviceId: string;
      serviceRouteId: string;
      serviceCode: string;
      allocationGroup: string;
      pathOrder: number;
      fromSiteId?: string | null;
      toSiteId?: string | null;
      endpointAId?: string | null;
      endpointBId?: string | null;
      endpointAPortGroupId?: string | null;
      endpointBPortGroupId?: string | null;
      pairSize?: number;
      isJumper?: boolean;
      pathLabel?: string | null;
      remarks?: string | null;
      requestedCapacity?: number | null;
    },
  ) {
    const pairSize = Math.max(1, input.pairSize ?? 2);
    await this.ensureFiberInventory(tx, input.segmentId, input.requestedCapacity);
    const fibers = await tx.segmentFiber.findMany({
      where: { segmentId: input.segmentId },
      select: { id: true, fiberNumber: true, status: true, serviceId: true },
      orderBy: { fiberNumber: "asc" },
    });
    const run = findConsecutiveRun(fibers, pairSize);
    if (!run) {
      const refreshed = await this.refreshSegmentCapacity(tx, input.segmentId);
      throw new Error(
        `Segment ${refreshed.segmentCode} has no ${pairSize === 1 ? "available fiber" : `available ${pairSize}-fiber run`}. ` +
          `${refreshed.availableFiberCount} of ${refreshed.totalFiberCapacity} fibers remain available.`,
      );
    }

    const fiberNumbers = run.map((fiber) => fiber.fiberNumber);
    const allocation = await tx.serviceAllocation.create({
      data: {
        serviceId: input.serviceId,
        serviceRouteId: input.serviceRouteId,
        segmentId: input.segmentId,
        allocationGroup: input.allocationGroup,
        pathOrder: input.pathOrder,
        fromSiteId: input.fromSiteId ?? null,
        toSiteId: input.toSiteId ?? null,
        endpointAId: input.endpointAId ?? null,
        endpointBId: input.endpointBId ?? null,
        endpointAPortGroupId: input.endpointAPortGroupId ?? null,
        endpointBPortGroupId: input.endpointBPortGroupId ?? null,
        fiberStart: Math.min(...fiberNumbers),
        fiberEnd: Math.max(...fiberNumbers),
        fiberNumbersJson: JSON.stringify(fiberNumbers),
        status: ResourceStatus.ACTIVE,
        isJumper: Boolean(input.isJumper),
        pathLabel: input.pathLabel ?? null,
        remarks: input.remarks ?? null,
      },
    });

    await tx.segmentFiber.updateMany({
      where: { id: { in: run.map((fiber) => fiber.id) } },
      data: {
        status: ResourceStatus.ACTIVE,
        serviceId: input.serviceId,
        serviceRouteId: input.serviceRouteId,
        serviceAllocationId: allocation.id,
        serviceCode: input.serviceCode,
        allocationGroup: input.allocationGroup,
        pathOrder: input.pathOrder,
        isJumper: Boolean(input.isJumper),
        allocatedAt: new Date(),
        remarks: input.pathLabel ?? null,
      },
    });

    const refreshed = await this.refreshSegmentCapacity(tx, input.segmentId);
    return { allocation, fiberNumbers, segment: refreshed };
  },

  async allocateSpecificFibers(
    tx: Tx,
    input: {
      segmentId: string;
      serviceId: string;
      serviceRouteId: string;
      serviceCode: string;
      allocationGroup: string;
      pathOrder: number;
      fiberNumbers: number[];
      fromSiteId?: string | null;
      toSiteId?: string | null;
      endpointAId?: string | null;
      endpointBId?: string | null;
      endpointAPortGroupId?: string | null;
      endpointBPortGroupId?: string | null;
      isJumper?: boolean;
      pathLabel?: string | null;
      remarks?: string | null;
      requestedCapacity?: number | null;
    },
  ) {
    const fiberNumbers = [...new Set(input.fiberNumbers.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
    if (!fiberNumbers.length) throw new Error("No valid fiber numbers were provided for service allocation.");
    await this.ensureFiberInventory(tx, input.segmentId, Math.max(input.requestedCapacity ?? 0, ...fiberNumbers));

    const fibers = await tx.segmentFiber.findMany({
      where: { segmentId: input.segmentId, fiberNumber: { in: fiberNumbers } },
      select: { id: true, fiberNumber: true, status: true, serviceId: true },
      orderBy: { fiberNumber: "asc" },
    });
    if (fibers.length !== fiberNumbers.length) {
      throw new Error(`Segment is missing one or more requested fibers: ${fiberNumbers.join(", ")}.`);
    }
    const unavailable = fibers.filter((fiber) => !isAllocatable(fiber.status) || fiber.serviceId);
    if (unavailable.length) {
      throw new Error(`Requested fibers are not available: ${unavailable.map((fiber) => fiber.fiberNumber).join(", ")}.`);
    }

    const allocation = await tx.serviceAllocation.create({
      data: {
        serviceId: input.serviceId,
        serviceRouteId: input.serviceRouteId,
        segmentId: input.segmentId,
        allocationGroup: input.allocationGroup,
        pathOrder: input.pathOrder,
        fromSiteId: input.fromSiteId ?? null,
        toSiteId: input.toSiteId ?? null,
        endpointAId: input.endpointAId ?? null,
        endpointBId: input.endpointBId ?? null,
        endpointAPortGroupId: input.endpointAPortGroupId ?? null,
        endpointBPortGroupId: input.endpointBPortGroupId ?? null,
        fiberStart: Math.min(...fiberNumbers),
        fiberEnd: Math.max(...fiberNumbers),
        fiberNumbersJson: JSON.stringify(fiberNumbers),
        status: ResourceStatus.ACTIVE,
        isJumper: Boolean(input.isJumper),
        pathLabel: input.pathLabel ?? null,
        remarks: input.remarks ?? null,
      },
    });

    await tx.segmentFiber.updateMany({
      where: { id: { in: fibers.map((fiber) => fiber.id) } },
      data: {
        status: ResourceStatus.ACTIVE,
        serviceId: input.serviceId,
        serviceRouteId: input.serviceRouteId,
        serviceAllocationId: allocation.id,
        serviceCode: input.serviceCode,
        allocationGroup: input.allocationGroup,
        pathOrder: input.pathOrder,
        isJumper: Boolean(input.isJumper),
        allocatedAt: new Date(),
        remarks: input.pathLabel ?? null,
      },
    });

    const refreshed = await this.refreshSegmentCapacity(tx, input.segmentId);
    return { allocation, fiberNumbers, segment: refreshed };
  },
};

export async function refreshAllSegmentCapacity() {
  const segments = await prisma.linkSegment.findMany({ select: { id: true } });
  for (const segment of segments) {
    await prisma.$transaction((tx) => segmentCapacityService.ensureFiberInventory(tx, segment.id));
  }
}
