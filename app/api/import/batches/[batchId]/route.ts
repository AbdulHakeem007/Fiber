import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { importRepository } from "@/server/repositories/import.repository";

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to read upload batches." }, { status: 403 });
    }
    const { batchId } = await params;
    const review = await importRepository.getBatchReviewWindow(batchId);
    if (!review) return NextResponse.json({ error: "Import batch not found." }, { status: 404 });
    return NextResponse.json(review);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import batch lookup failed." },
      { status: 500 },
    );
  }
}

type DeleteResult = {
  deletedIssues: number;
  deletedStagingRows: number;
  deletedBatch: boolean;
  hasApprovedRows?: boolean;
  approvedCount?: number;
  message?: string;
};

function boolParam(url: URL, key: string): boolean {
  return ["1", "true", "yes"].includes(String(url.searchParams.get(key) ?? "").toLowerCase());
}

export async function DELETE(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "importManage")) {
      return NextResponse.json({ error: "Import management access is required to remove upload batches." }, { status: 403 });
    }

    const { batchId } = await params;
    const url = new URL(request.url);
    if (boolParam(url, "rollback")) {
      return NextResponse.json({ error: "Rollback has been removed from the portal." }, { status: 410 });
    }
    const stagingOnly = boolParam(url, "stagingOnly");

    const result = await prisma.$transaction(async (tx): Promise<DeleteResult> => {
      const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
      if (!batch) {
        return {
          deletedIssues: 0,
          deletedStagingRows: 0,
          deletedBatch: false,
          message: "Import batch not found.",
        };
      }

      const stagingRows = await tx.importStagingRow.findMany({
        where: { importBatchId: batchId },
        select: { id: true, status: true },
      });
      const nonApprovedStagingRowIds = stagingRows.filter((row) => row.status !== "APPROVED").map((row) => row.id);

      const deletedIssues = await tx.importIssue.deleteMany({ where: { importBatchId: batchId } });

      if (nonApprovedStagingRowIds.length) {
        await tx.segmentEndpointMapping.updateMany({
          where: { importStagingRowId: { in: nonApprovedStagingRowIds } },
          data: { importStagingRowId: null },
        });
      }

      const deletedNonApproved = await tx.importStagingRow.deleteMany({
        where: { importBatchId: batchId, status: { not: "APPROVED" } },
      });

      const approvedCount = await tx.importStagingRow.count({
        where: { importBatchId: batchId, status: "APPROVED" },
      });

      if (approvedCount === 0) {
        await tx.auditLog.updateMany({ where: { importBatchId: batchId }, data: { importBatchId: null } });
        await tx.linkSegment.updateMany({ where: { importBatchId: batchId }, data: { importBatchId: null } });
        await tx.splitter.updateMany({ where: { importBatchId: batchId }, data: { importBatchId: null } });
        await tx.importBatch.delete({ where: { id: batchId } });
        return {
          deletedIssues: deletedIssues.count,
          deletedStagingRows: deletedNonApproved.count,
          deletedBatch: true,
        };
      }

      return {
        deletedIssues: deletedIssues.count,
        deletedStagingRows: deletedNonApproved.count,
        deletedBatch: false,
        hasApprovedRows: true,
        approvedCount,
        message: stagingOnly ? "Staging review data was removed; approved live inventory remains." : "This upload has approved live inventory.",
      };
    });

    if (result.message === "Import batch not found.") {
      return NextResponse.json({ error: result.message }, { status: 404 });
    }
    if (result.hasApprovedRows && !stagingOnly) {
      return NextResponse.json(
        { hasApprovedRows: true, approvedCount: result.approvedCount, message: "This upload has approved live inventory." },
        { status: 409 },
      );
    }
    return NextResponse.json({
      deletedIssues: result.deletedIssues,
      deletedStagingRows: result.deletedStagingRows,
      deletedBatch: result.deletedBatch,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload batch removal failed." },
      { status: 500 },
    );
  }
}
