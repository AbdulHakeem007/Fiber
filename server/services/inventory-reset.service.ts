import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";

export const INVENTORY_RESET_CONFIRMATION = "RESET LIVE INVENTORY";

export const inventoryResetService = {
  async resetLiveInventory(input: { requestedById: string; confirmation: string; reason?: string | null }) {
    if (input.confirmation !== INVENTORY_RESET_CONFIRMATION) {
      throw new Error(`Type ${INVENTORY_RESET_CONFIRMATION} to confirm the live inventory reset.`);
    }

    const before = await prisma.$transaction(async (tx) => ({
      linkSegments: await tx.linkSegment.count(),
      segmentFibers: await tx.segmentFiber.count(),
      serviceAllocations: await tx.serviceAllocation.count(),
      racks: await tx.rack.count(),
      odfs: await tx.oDF.count(),
      portGroups: await tx.portGroup.count(),
      splitters: await tx.splitter.count(),
      stagingRows: await tx.importStagingRow.count(),
    }));

    // Purge sequentially (child -> parent), NOT inside a single interactive
    // transaction. A wrapping $transaction() carries a 30s default timeout, which a
    // large dataset (hundreds of thousands of fibers/ports) blows past mid-purge,
    // expiring the transaction and rolling the whole reset back. Each deleteMany is
    // its own fast single statement with no interactive-transaction timeout, in
    // FK-safe order, so the reset scales to any volume (mirrors scripts/full-flush.ts).
    // The op is idempotent: re-running after an interruption simply clears the rest.
    await prisma.alertEvent.deleteMany({});
    await prisma.utilizationMetric.deleteMany({});

    await prisma.serviceRouteHop.deleteMany({});
    await prisma.segmentEndpointMapping.deleteMany({});
    await prisma.segmentFiber.deleteMany({});
    await prisma.serviceAllocation.deleteMany({});
    await prisma.serviceRoute.deleteMany({});
    await prisma.service.deleteMany({});

    await prisma.splitterOutput.deleteMany({});
    await prisma.splitter.deleteMany({});

    await prisma.linkSegment.deleteMany({});
    await prisma.segmentEndpoint.deleteMany({});
    await prisma.cable.deleteMany({});

    await prisma.portGroupMember.deleteMany({});
    await prisma.oDFPort.deleteMany({});
    await prisma.portGroup.deleteMany({});
    await prisma.oDF.deleteMany({});
    await prisma.rack.deleteMany({});

    await prisma.importIssue.deleteMany({});
    await prisma.importStagingRow.deleteMany({});
    await prisma.auditLog.updateMany({
      where: { importBatchId: { not: null } },
      data: { importBatchId: null },
    });
    await prisma.importBatch.deleteMany({});

    await prisma.site.updateMany({
      data: {
        isFiberNode: false,
        isCoreSite: false,
        coreSiteType: null,
      },
    });

    await writeAuditLog({
      entityType: "Inventory",
      entityId: "LIVE",
      action: "DELETE",
      fieldName: "liveInventoryReset",
      oldValue: before,
      newValue: { resetAt: new Date().toISOString() },
      changedById: input.requestedById,
      reason: input.reason ?? "Admin reset live fiber inventory before normalized CSV rebuild",
    });

    return { reset: true, before };
  },
};
