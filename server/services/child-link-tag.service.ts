import { prisma } from "@/lib/db/prisma";
import { logChange } from "@/server/services/audit.service";

export async function updateChildLinkTagCascade(input: {
  id: string;
  tag: string;
  operatorId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.segmentEndpointMapping.findUnique({ where: { id: input.id } });
    if (!before) throw new Error("Child link was not found.");

    const serviceCode = before.serviceCode?.trim() || null;
    const matchingRows = serviceCode
      ? await tx.segmentEndpointMapping.findMany({
          where: { serviceCode, status: { not: "DECOMMISSIONED" } },
          select: { id: true, tag: true },
        })
      : await tx.segmentEndpointMapping.findMany({ where: { id: input.id }, select: { id: true, tag: true } });
    const matchingIds = matchingRows.map((row) => row.id);

    await tx.segmentEndpointMapping.updateMany({
      where: { id: { in: matchingIds } },
      data: { tag: input.tag },
    });

    await logChange(tx, {
      operatorId: input.operatorId,
      actionType: "UPDATE",
      targetTable: "SegmentEndpointMapping",
      targetId: input.id,
      originalState: { clickedRow: before, inheritedRows: matchingRows },
      newState: { tag: input.tag, inheritedRowIds: matchingIds, serviceCode },
    });

    return { id: input.id, tag: input.tag, serviceCode, updatedIds: matchingIds, updatedCount: matchingIds.length };
  });
}
