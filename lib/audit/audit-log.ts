import { prisma } from "@/lib/db/prisma";
import { stringifyValue } from "@/lib/audit/diff";

export interface AuditEntryInput {
  entityType: string;
  entityId: string;
  action:
    | "CREATE"
    | "UPDATE"
    | "DELETE"
    | "IMPORT"
    | "EXPORT"
    | "RESERVE"
    | "RELEASE"
    | "ACKNOWLEDGE"
    | "SUPPRESS"
    | "CLEAR"
    | "PASSWORD_RESET"
    | "PASSWORD_CHANGE"
    | "SMTP_UPDATE"
    | "TEMPLATE_UPDATE"
    | "ROLE_CHANGE"
    | "MANUAL_OVERRIDE"
    | "LOGIN";
  fieldName?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  comment?: string | null;
  changedById?: string | null;
  importBatchId?: string | null;
}

// `entityId` is part of the btree index AuditLog_entityType_entityId_createdAt_idx.
// Postgres rejects an index row larger than ~2704 bytes, so a caller that passes a
// huge value (e.g. a comma-joined list of many segment ids during a bulk delete)
// would crash the whole operation. Defensively cap the indexed value; the full
// identifier set should live in oldValue/newValue (which are not indexed).
const MAX_ENTITY_ID_LENGTH = 200;
function safeEntityId(entityId: string): string {
  if (entityId.length <= MAX_ENTITY_ID_LENGTH) return entityId;
  return `${entityId.slice(0, MAX_ENTITY_ID_LENGTH - 24)}...(+${entityId.length - (MAX_ENTITY_ID_LENGTH - 24)} chars)`;
}

export async function writeAuditLog(input: AuditEntryInput) {
  await prisma.auditLog.create({
    data: {
      entityType: input.entityType,
      entityId: safeEntityId(input.entityId),
      action: input.action,
      fieldName: input.fieldName,
      oldValue: stringifyValue(input.oldValue),
      newValue: stringifyValue(input.newValue),
      reason: input.reason ?? null,
      comment: input.comment ?? null,
      changedById: input.changedById ?? null,
      importBatchId: input.importBatchId ?? null,
    },
  });
}
