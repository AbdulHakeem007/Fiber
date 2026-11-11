import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";

/**
 * Rename a site's (legacy) code, or merge it into an existing site when the new
 * code is already taken — "unify accordingly".
 *
 * Why this is more than a column update: `code` is the unique business key but
 * the real ownership is `Site.id` (every ODF/rack/endpoint/etc. FKs to the id).
 * `code` is ALSO denormalized into rawSiteCode / localSiteCode / farSiteCode /
 * splitter*SiteCode columns used by trace + inventory lookups. So a correct
 * rename must (a) move the denormalized strings and (b) keep the OLD code
 * resolvable. We register the old code as a SiteAlias — the app already resolves
 * codes through aliases — which guarantees correctness even if a denormalized
 * string was stored in a non-canonical form.
 */

function normalizeCode(raw: string): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

/** Rewrite every denormalized site-code string from `oldCode` to `newCode`. */
async function rewriteDenormalizedCodes(tx: Prisma.TransactionClient, oldCode: string, newCode: string) {
  await tx.segmentEndpoint.updateMany({ where: { rawSiteCode: oldCode }, data: { rawSiteCode: newCode } });
  await tx.segmentEndpointMapping.updateMany({ where: { localSiteCode: oldCode }, data: { localSiteCode: newCode } });
  await tx.segmentEndpointMapping.updateMany({ where: { farSiteCode: oldCode }, data: { farSiteCode: newCode } });
  await tx.splitter.updateMany({ where: { primaryInputSiteCode: oldCode }, data: { primaryInputSiteCode: newCode } });
  await tx.splitter.updateMany({ where: { secondaryInputSiteCode: oldCode }, data: { secondaryInputSiteCode: newCode } });
  await tx.splitterOutput.updateMany({ where: { localSiteCode: oldCode }, data: { localSiteCode: newCode } });
  await tx.splitterOutput.updateMany({ where: { destinationSiteCode: oldCode }, data: { destinationSiteCode: newCode } });
}

/** Move every id-keyed relation from `fromId` to `toId` (used by merge). */
async function reassignRelations(tx: Prisma.TransactionClient, fromId: string, toId: string) {
  await tx.rack.updateMany({ where: { siteId: fromId }, data: { siteId: toId } });
  await tx.oDF.updateMany({ where: { siteId: fromId }, data: { siteId: toId } });
  await tx.portGroup.updateMany({ where: { siteId: fromId }, data: { siteId: toId } });
  await tx.segmentEndpoint.updateMany({ where: { siteId: fromId }, data: { siteId: toId } });
  await tx.serviceRouteHop.updateMany({ where: { siteId: fromId }, data: { siteId: toId } });
  await tx.serviceAllocation.updateMany({ where: { fromSiteId: fromId }, data: { fromSiteId: toId } });
  await tx.serviceAllocation.updateMany({ where: { toSiteId: fromId }, data: { toSiteId: toId } });
  await tx.cable.updateMany({ where: { siteAId: fromId }, data: { siteAId: toId } });
  await tx.cable.updateMany({ where: { siteBId: fromId }, data: { siteBId: toId } });
  await tx.utilizationMetric.updateMany({ where: { scopeSiteId: fromId }, data: { scopeSiteId: toId } });
  await tx.alertEvent.updateMany({ where: { siteId: fromId }, data: { siteId: toId } });
  await tx.importStagingRow.updateMany({ where: { normalizedSiteAId: fromId }, data: { normalizedSiteAId: toId } });
  await tx.importStagingRow.updateMany({ where: { normalizedSiteBId: fromId }, data: { normalizedSiteBId: toId } });
}

/** Add `code` as an alias of `siteId` (idempotent — aliasNormalized is unique). */
async function ensureAlias(tx: Prisma.TransactionClient, siteId: string, code: string) {
  const normalized = normalizeCode(code);
  if (!normalized) return;
  const existing = await tx.siteAlias.findUnique({ where: { aliasNormalized: normalized }, select: { siteId: true } });
  if (existing) {
    if (existing.siteId !== siteId) await tx.siteAlias.update({ where: { aliasNormalized: normalized }, data: { siteId } });
    return;
  }
  await tx.siteAlias.create({ data: { siteId, alias: code, aliasNormalized: normalized } });
}

export type SiteCodeChangeResult =
  | { action: "UNCHANGED"; code: string }
  | { action: "RENAMED"; code: string }
  | { action: "MERGED"; code: string; mergedFromCode: string };

export const siteCodeService = {
  async changeSiteCode(currentCode: string, newCodeRaw: string, changedById?: string | null): Promise<SiteCodeChangeResult> {
    const oldCode = normalizeCode(currentCode);
    const newCode = normalizeCode(newCodeRaw);
    if (!newCode) throw new Error("Legacy site code cannot be empty.");

    const source = await prisma.site.findUnique({ where: { code: oldCode }, select: { id: true, code: true, name: true } });
    if (!source) throw new Error("Site not found.");
    if (newCode === oldCode) return { action: "UNCHANGED", code: oldCode };

    const target = await prisma.site.findUnique({ where: { code: newCode }, select: { id: true, code: true, name: true } });

    // ── MERGE: the new code already belongs to another site → unify into it ──
    if (target && target.id !== source.id) {
      await prisma.$transaction(async (tx) => {
        // Criticality assignments: skip tags the target already has (unique siteId+tagId).
        const targetTagIds = new Set(
          (await tx.siteCriticalityAssignment.findMany({ where: { siteId: target.id }, select: { tagId: true } })).map((a) => a.tagId),
        );
        const sourceAsg = await tx.siteCriticalityAssignment.findMany({ where: { siteId: source.id }, select: { id: true, tagId: true } });
        const dupAsgIds = sourceAsg.filter((a) => targetTagIds.has(a.tagId)).map((a) => a.id);
        if (dupAsgIds.length) await tx.siteCriticalityAssignment.deleteMany({ where: { id: { in: dupAsgIds } } });
        await tx.siteCriticalityAssignment.updateMany({ where: { siteId: source.id }, data: { siteId: target.id } });

        await reassignRelations(tx, source.id, target.id);
        // Source's references used the OLD code → point them at the target code.
        await rewriteDenormalizedCodes(tx, oldCode, target.code);
        // Move source's aliases to the target (aliasNormalized is globally unique → no clash).
        await tx.siteAlias.updateMany({ where: { siteId: source.id }, data: { siteId: target.id } });

        await tx.site.delete({ where: { id: source.id } });
        // Old code (and the source's name) still resolve to the surviving site.
        await ensureAlias(tx, target.id, oldCode);
        if (source.name) await ensureAlias(tx, target.id, source.name);
      });

      await writeAuditLog({
        entityType: "Site",
        entityId: target.code,
        action: "UPDATE",
        fieldName: "code",
        oldValue: { code: source.code, name: source.name },
        newValue: { mergedInto: target.code },
        changedById: changedById ?? null,
        reason: `Legacy code edit merged ${source.code} into existing site ${target.code}`,
      });
      return { action: "MERGED", code: target.code, mergedFromCode: source.code };
    }

    // ── RENAME: the new code is free → rename in place + keep old code resolvable ──
    await prisma.$transaction(async (tx) => {
      await rewriteDenormalizedCodes(tx, oldCode, newCode);
      await tx.site.update({ where: { id: source.id }, data: { code: newCode } });
      await ensureAlias(tx, source.id, oldCode);
    });

    await writeAuditLog({
      entityType: "Site",
      entityId: newCode,
      action: "UPDATE",
      fieldName: "code",
      oldValue: { code: oldCode },
      newValue: { code: newCode },
      changedById: changedById ?? null,
      reason: "Legacy site code renamed",
    });
    return { action: "RENAMED", code: newCode };
  },
};
