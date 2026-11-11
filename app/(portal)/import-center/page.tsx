import { ImportCenterWorkbench } from "@/components/import/import-center-workbench";
import { prisma } from "@/lib/db/prisma";
import type { ImportReviewBatch, ImportReviewIssue } from "@/types/import";

function parseJson(value?: string | null): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export default async function ImportCenterPage() {
  // Validation and commit always process the ENTIRE batch server-side.
  // Only the review-table hydration is windowed: shipping 200k staged rows
  // into one SSR payload would freeze the browser, so the page hydrates the
  // first window while batch.totalRows keeps the summary counters exact.
  const REVIEW_HYDRATION_WINDOW = 2000;
  const batch = await prisma.importBatch.findFirst({
    include: {
      stagingRows: {
        orderBy: { rowNumber: "asc" },
        take: REVIEW_HYDRATION_WINDOW,
      },
      issues: {
        orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
      },
    },
    orderBy: { uploadedAt: "desc" },
  });

  let reviewBatch: ImportReviewBatch | null = null;

  if (batch) {
    const issues: ImportReviewIssue[] = batch.issues.map((issue) => ({
      id: issue.id,
      stagingRowId: issue.stagingRowId,
      severity: issue.severity,
      issueCode: issue.issueCode,
      message: issue.message,
      blocking: issue.blocking,
    }));
    const issuesByRow = new Map<string, ImportReviewIssue[]>();
    for (const issue of issues) {
      if (!issue.stagingRowId) continue;
      issuesByRow.set(issue.stagingRowId, [...(issuesByRow.get(issue.stagingRowId) ?? []), issue]);
    }

    reviewBatch = {
      id: batch.id,
      batchCode: batch.batchCode,
      fileName: batch.fileName,
      status: batch.status,
      totalRows: batch.totalRows,
      validRows: batch.validRows,
      warningRows: batch.warningRows,
      errorRows: batch.errorRows,
      committedRows: batch.committedRows,
      issues,
      rows: batch.stagingRows.map((row) => {
        const normalized = parseJson(row.normalizedJson);
        return {
          id: row.id,
          rowNumber: row.rowNumber,
          status: row.status,
          reviewerComment: row.reviewerComment,
          duplicateOfSegmentId: row.duplicateOfSegmentId,
          sourceSheet: normalized.sourceSheet ?? null,
          sourceSiteRaw: normalized.sourceSiteRaw ?? null,
          sourceSiteCanonical: normalized.sourceSiteCanonical ?? null,
          farSiteRaw: normalized.farSiteRaw ?? null,
          farSiteCanonical: normalized.farSiteCanonical ?? null,
          rackCode: normalized.rackCode ?? null,
          odfCode: normalized.odfCode ?? null,
          portGroupLabel: normalized.portGroupLabel ?? null,
          farRackCode: normalized.farRackCode ?? null,
          farOdfCode: normalized.farOdfCode ?? null,
          farPortGroupLabel: normalized.farPortGroupLabel ?? null,
          serviceIdResolved: normalized.serviceIdResolved ?? null,
          statusHint: normalized.statusHint ?? null,
          matchStatus: normalized.matchStatus ?? null,
          directionText: normalized.directionText ?? null,
          definitionText: normalized.definitionText ?? null,
          proposedSegmentCode: row.proposedSegmentCode,
          issues: issuesByRow.get(row.id) ?? [],
        };
      }),
    };
  }

  return <ImportCenterWorkbench initialBatch={reviewBatch} />;
}
