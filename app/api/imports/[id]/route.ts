import { unlink } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to permanently delete upload metadata." }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.confirmation !== "CONFIRM DELETE") {
      return NextResponse.json({ error: "Type CONFIRM DELETE to permanently remove this upload." }, { status: 400 });
    }

    const rollbackOperationalRecords = Boolean(body.rollbackOperationalRecords);
    if (rollbackOperationalRecords) {
      return NextResponse.json({ error: "Rollback has been removed from the portal." }, { status: 410 });
    }
    const metadata = await prisma.importMetadata.findUnique({ where: { id } })
      ?? await prisma.importMetadata.findFirst({ where: { batchId: id } });
    if (!metadata) return NextResponse.json({ error: "Import metadata row was not found." }, { status: 404 });

    if (metadata.storedPath) {
      await unlink(metadata.storedPath).catch(() => undefined);
    }

    const cleanup = metadata.batchId
      ? await prisma.$transaction(async (tx) => {
          const batchId = metadata.batchId as string;
          const deletedIssues = await tx.importIssue.deleteMany({ where: { importBatchId: batchId } });
          const stagingRows = await tx.importStagingRow.findMany({ where: { importBatchId: batchId }, select: { id: true } });
          if (stagingRows.length) {
            await tx.segmentEndpointMapping.updateMany({
              where: { importStagingRowId: { in: stagingRows.map((row) => row.id) } },
              data: { importStagingRowId: null },
            });
          }
          const deletedStagingRows = await tx.importStagingRow.deleteMany({ where: { importBatchId: batchId } });
          await tx.importMetadata.delete({ where: { id: metadata.id } });
          return { deletedIssues: deletedIssues.count, deletedStagingRows: deletedStagingRows.count };
        })
      : await prisma.$transaction(async (tx) => {
          await tx.importMetadata.delete({ where: { id: metadata.id } });
          return { deletedIssues: 0, deletedStagingRows: 0 };
        });

    return NextResponse.json({ success: true, ...cleanup });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import upload deletion failed." }, { status: 500 });
  }
}
