/**
 * Single source of truth for how a staged import row's lifecycle status is
 * presented. The portal exposes EXPLICIT, non-composite statuses so operators
 * always know why a row did not commit — no silent drops, no ambiguous
 * "Rejected / Skipped" blend.
 *
 *   COMMITTED  — persisted to live ODF Mappings.
 *   SKIPPED    — an exact duplicate of another row already processing in this
 *                same batch (or an existing live segment); kept for review.
 *   REJECTED   — a catastrophic schema / foreign-key failure (missing critical
 *                site IDs, type mismatch); blocked from commit.
 *   ERROR      — blocking validation issue that must be resolved before commit.
 *   VALID / WARNING / STAGED — eligible for commit (clean / with warnings / not
 *                yet validated).
 */
export type ImportRowDecisionTone = "committed" | "skipped" | "rejected" | "blocked" | "ready" | "warning" | "neutral" | "info";

export interface ImportRowDecision {
  label: string;
  tone: ImportRowDecisionTone;
  /** Human reason shown beside the status so nothing is dropped silently. */
  reason: string | null;
}

interface RowStatusInput {
  status: string;
  statusHint?: string | null;
  reviewerComment?: string | null;
  duplicateOfSegmentId?: string | null;
  issues?: Array<{ issueCode: string; message: string; severity: string; blocking: boolean }>;
}

const DUPLICATE_ISSUE_CODES = new Set(["MIRROR_DUPLICATE", "LIVE_DUPLICATE", "TEMPLATE_DUPLICATE_ROW"]);

function firstBlockingIssue(issues: RowStatusInput["issues"]) {
  return issues?.find((issue) => issue.blocking || issue.severity === "ERROR" || issue.severity === "CRITICAL") ?? null;
}

export function importRowDecision(row: RowStatusInput): ImportRowDecision {
  const status = String(row.status ?? "").toUpperCase();
  const hint = String(row.statusHint ?? "").toUpperCase();
  const dupIssue = row.issues?.find((issue) => DUPLICATE_ISSUE_CODES.has(issue.issueCode)) ?? null;

  if (status === "COMMITTED") {
    return { label: "Committed", tone: "committed", reason: row.reviewerComment ?? "Persisted to live ODF Mappings." };
  }

  if (status === "SKIPPED") {
    const reason =
      row.reviewerComment ??
      dupIssue?.message ??
      (row.duplicateOfSegmentId ? "Duplicate of an existing live segment." : "Exact duplicate of another row in this batch.");
    return { label: "Skipped", tone: "skipped", reason };
  }

  if (status === "REJECTED") {
    return {
      label: "Rejected",
      tone: "rejected",
      reason: row.reviewerComment ?? firstBlockingIssue(row.issues)?.message ?? "Schema or foreign-key validation failure.",
    };
  }

  if (status === "ERROR") {
    return { label: "Blocked", tone: "blocked", reason: firstBlockingIssue(row.issues)?.message ?? "Resolve blocking issues before commit." };
  }

  // A clean row that nonetheless still carries a blocking issue is surfaced as
  // blocked rather than ready, so it is never silently committed.
  const blocking = firstBlockingIssue(row.issues);
  if (blocking) return { label: "Blocked", tone: "blocked", reason: blocking.message };

  if (hint === "DUMMY") return { label: "ODF inventory only", tone: "info", reason: "Staged as dummy ODF inventory (no transport segment)." };
  if (hint === "SPLITTER") return { label: "Splitter inventory", tone: "info", reason: "Use the Splitters Inventory import for this row." };

  if (status === "VALID") return { label: "Ready to commit", tone: "ready", reason: null };
  if (status === "WARNING") {
    return { label: "Commit with warnings", tone: "warning", reason: row.issues?.find((issue) => issue.severity === "WARNING")?.message ?? null };
  }
  return { label: "Staged for validation", tone: "neutral", reason: null };
}

export function importDecisionBadgeClass(tone: ImportRowDecisionTone): string {
  switch (tone) {
    case "committed":
      return "import-decision import-decision-committed";
    case "skipped":
      return "import-decision import-decision-skipped";
    case "rejected":
      return "import-decision import-decision-rejected";
    case "blocked":
      return "import-decision import-decision-blocked";
    case "ready":
      return "import-decision import-decision-ready";
    case "warning":
      return "import-decision import-decision-warning";
    case "info":
      return "import-decision import-decision-info";
    default:
      return "import-decision import-decision-neutral";
  }
}
