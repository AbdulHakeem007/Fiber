export interface ImportStagingReviewRow {
  rowNumber: number;
  normalizedSiteA?: string | null;
  normalizedSiteB?: string | null;
  proposedSegmentCode?: string | null;
  status: string;
  reviewerComment?: string | null;
}

export interface ImportReviewIssue {
  id: string;
  stagingRowId?: string | null;
  severity: string;
  issueCode: string;
  message: string;
  blocking: boolean;
}

export interface ImportReviewRow {
  id: string;
  rowNumber: number;
  status: string;
  reviewerComment?: string | null;
  duplicateOfSegmentId?: string | null;
  sourceSheet?: string | null;
  sourceSiteRaw?: string | null;
  sourceSiteCanonical?: string | null;
  farSiteRaw?: string | null;
  farSiteCanonical?: string | null;
  rackCode?: string | null;
  odfCode?: string | null;
  portGroupLabel?: string | null;
  farRackCode?: string | null;
  farOdfCode?: string | null;
  farPortGroupLabel?: string | null;
  serviceIdResolved?: string | null;
  statusHint?: string | null;
  matchStatus?: string | null;
  directionText?: string | null;
  definitionText?: string | null;
  proposedSegmentCode?: string | null;
  rawJson?: Record<string, unknown>;
  normalizedJson?: Record<string, unknown>;
  issues: ImportReviewIssue[];
}

export interface ImportReviewBatch {
  id: string;
  batchCode: string;
  fileName: string;
  status: string;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  committedRows: number;
  rows: ImportReviewRow[];
  issues: ImportReviewIssue[];
}
