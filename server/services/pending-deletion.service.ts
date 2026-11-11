import { randomUUID } from "crypto";
import { PendingDeletionEntityType, PendingDeletionStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import {
  addWorkingMillis,
  remainingHoldMillis,
  resolveGccCalendarConfig,
  DELETION_HOLD_MILLIS,
  type GccCalendarConfig,
} from "@/lib/utils/gcc-calendar";
import { destructiveDeleteService, OdfDeleteBlockedError } from "@/server/services/destructive-delete.service";

/**
 * Delayed-deletion (24 working-hour soft-delete hold) workflow shared by the
 * ODF/Rack inventory and ODF Mapping (segment) delete endpoints.
 *
 * Marking an entity for deletion no longer purges it. The entity is parked on
 * a PendingDeletion hold whose countdown only runs on GCC working days
 * (Sun-Thu by default; weekends and configured national holidays pause it).
 * During the hold the operator can undo the decision; once the hold expires,
 * the sweeper executes the original destructive delete path unchanged.
 *
 * Two adjacent segments marked together are purged as a Reverse Split: the
 * shared transit site is removed and the outer endpoints are stitched into one
 * new segment (see destructiveDeleteService.deleteSegments mergeTopology).
 */

export interface PendingDeletionView {
  id: string;
  entityType: PendingDeletionEntityType;
  entityId: string;
  entityLabel: string | null;
  deleteGroupId: string | null;
  mergeTopology: boolean;
  requestedAt: string;
  scheduledPurgeAt: string;
  remainingMs: number;
}

export interface PendingDeletionListResult {
  now: string;
  holdMillis: number;
  calendar: GccCalendarConfig;
  holds: PendingDeletionView[];
}

function holdCalendar(): GccCalendarConfig {
  return resolveGccCalendarConfig();
}

function toView(
  row: {
    id: string;
    entityType: PendingDeletionEntityType;
    entityId: string;
    entityLabel: string | null;
    deleteGroupId: string | null;
    mergeTopology: boolean;
    requestedAt: Date;
    scheduledPurgeAt: Date;
  },
  config: GccCalendarConfig,
  now: Date,
): PendingDeletionView {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    deleteGroupId: row.deleteGroupId,
    mergeTopology: row.mergeTopology,
    requestedAt: row.requestedAt.toISOString(),
    // Effective deadline is re-derived from requestedAt so holidays configured
    // after the hold started still extend the window.
    scheduledPurgeAt: addWorkingMillis(row.requestedAt, DELETION_HOLD_MILLIS, config).toISOString(),
    remainingMs: remainingHoldMillis(row.requestedAt, now, config),
  };
}

async function purgeOdfHold(hold: { id: string; entityId: string; requestedById: string | null }) {
  try {
    // Blockers are re-checked inside deleteOdf: if live services appeared
    // during the hold, the purge is aborted and the hold auto-cancels so the
    // operator gets a visible, reversible state instead of a silent failure.
    await destructiveDeleteService.deleteOdf(hold.entityId, hold.requestedById);
    await prisma.pendingDeletion.update({
      where: { id: hold.id },
      data: { status: PendingDeletionStatus.PURGED, purgedAt: new Date() },
    });
  } catch (error) {
    const message = error instanceof OdfDeleteBlockedError
      ? "Purge blocked: live inventory records now reference this ODF. The scheduled deletion was cancelled."
      : `Purge failed: ${error instanceof Error ? error.message : String(error)}`;
    await prisma.pendingDeletion.update({
      where: { id: hold.id },
      data: { status: PendingDeletionStatus.CANCELLED, cancelledAt: new Date(), purgeError: message },
    });
  }
}

async function purgeSegmentGroup(holds: Array<{ id: string; entityId: string; requestedById: string | null; mergeTopology: boolean }>) {
  const ids = holds.map((hold) => hold.entityId);
  const requestedById = holds[0]?.requestedById ?? null;
  const asReverseSplit = holds.length === 2 && holds.every((hold) => hold.mergeTopology);
  try {
    if (asReverseSplit) {
      // Reverse Split: remove the shared transit site, stitch the outer
      // endpoints into one segment, leave outer ODF/rack/fiber mappings alone.
      await destructiveDeleteService.deleteSegments(ids, requestedById, "Scheduled segment deletion (reverse split)", { mergeTopology: true });
    } else {
      await destructiveDeleteService.hardDeleteSegments(ids, requestedById, "Scheduled segment deletion (hold expired)");
    }
    await prisma.pendingDeletion.updateMany({
      where: { id: { in: holds.map((hold) => hold.id) } },
      data: { status: PendingDeletionStatus.PURGED, purgedAt: new Date() },
    });
  } catch (error) {
    const message = `Purge failed: ${error instanceof Error ? error.message : String(error)}`;
    await prisma.pendingDeletion.updateMany({
      where: { id: { in: holds.map((hold) => hold.id) } },
      data: { status: PendingDeletionStatus.CANCELLED, cancelledAt: new Date(), purgeError: message },
    });
  }
}

export const pendingDeletionService = {
  holdMillis: DELETION_HOLD_MILLIS,

  /**
   * Purge every hold whose 24 working-hour window has fully elapsed on the
   * GCC calendar. Runs lazily from the pending-deletions API (every page that
   * shows countdowns polls it) and from each mark/undo call.
   */
  async sweepExpired(): Promise<{ purgedOdfs: number; purgedSegments: number }> {
    const config = holdCalendar();
    const now = new Date();
    const candidates = await prisma.pendingDeletion.findMany({
      where: { status: PendingDeletionStatus.PENDING, scheduledPurgeAt: { lte: now } },
      orderBy: { requestedAt: "asc" },
    });

    let purgedOdfs = 0;
    let purgedSegments = 0;
    const segmentGroups = new Map<string, typeof candidates>();

    for (const hold of candidates) {
      const remaining = remainingHoldMillis(hold.requestedAt, now, config);
      if (remaining > 0) {
        // A holiday/weekend added after scheduling extended the window: push
        // the cached deadline forward instead of purging.
        await prisma.pendingDeletion.update({
          where: { id: hold.id },
          data: { scheduledPurgeAt: addWorkingMillis(hold.requestedAt, DELETION_HOLD_MILLIS, config) },
        });
        continue;
      }
      if (hold.entityType === PendingDeletionEntityType.ODF) {
        await purgeOdfHold(hold);
        purgedOdfs += 1;
      } else {
        const groupKey = hold.deleteGroupId ?? hold.id;
        segmentGroups.set(groupKey, [...(segmentGroups.get(groupKey) ?? []), hold]);
      }
    }

    for (const [groupKey, holds] of segmentGroups) {
      // A group only purges when EVERY member has expired; members share
      // requestedAt, so a partially expired group means some rows were undone.
      const groupRows = await prisma.pendingDeletion.findMany({
        where: {
          status: PendingDeletionStatus.PENDING,
          OR: [{ deleteGroupId: groupKey }, { id: groupKey }],
        },
      });
      const expired = groupRows.filter((row) => remainingHoldMillis(row.requestedAt, now, config) <= 0);
      if (!expired.length) continue;
      await purgeSegmentGroup(expired);
      purgedSegments += expired.length;
    }

    return { purgedOdfs, purgedSegments };
  },

  /** Current PENDING holds (optionally scoped to one entity type). */
  async listPending(entityType?: PendingDeletionEntityType): Promise<PendingDeletionListResult> {
    await this.sweepExpired();
    const config = holdCalendar();
    const now = new Date();
    const rows = await prisma.pendingDeletion.findMany({
      where: { status: PendingDeletionStatus.PENDING, ...(entityType ? { entityType } : {}) },
      orderBy: { requestedAt: "asc" },
    });
    return {
      now: now.toISOString(),
      holdMillis: DELETION_HOLD_MILLIS,
      calendar: config,
      holds: rows.map((row) => toView(row, config, now)),
    };
  },

  /**
   * Place a dependency-free ODF on the 24 working-hour deletion hold.
   * Throws the consolidated OdfDeleteBlockedError when live records exist.
   * Idempotent: re-marking an already-held ODF returns the existing hold.
   */
  async markOdfForDeletion(odfId: string, requestedById?: string | null): Promise<PendingDeletionView> {
    await this.sweepExpired();
    const config = holdCalendar();
    const now = new Date();

    const existing = await prisma.pendingDeletion.findFirst({
      where: { entityType: PendingDeletionEntityType.ODF, entityId: odfId, status: PendingDeletionStatus.PENDING },
    });
    if (existing) return toView(existing, config, now);

    const odf = await destructiveDeleteService.assertOdfDeletable(odfId);
    const entityLabel = `${odf.site.code} / ${odf.rack.rackCode} / ${odf.odfCode}`;
    const hold = await prisma.pendingDeletion.create({
      data: {
        entityType: PendingDeletionEntityType.ODF,
        entityId: odfId,
        entityLabel,
        requestedById: requestedById ?? null,
        requestedAt: now,
        scheduledPurgeAt: addWorkingMillis(now, DELETION_HOLD_MILLIS, config),
        reason: "ODF delete scheduled with 24 working-hour reversal window (GCC calendar).",
      },
    });
    await writeAuditLog({
      entityType: "ODF",
      entityId: odfId,
      action: "DELETE",
      oldValue: { label: entityLabel },
      newValue: { pendingDeletionId: hold.id, scheduledPurgeAt: hold.scheduledPurgeAt.toISOString() },
      changedById: requestedById ?? null,
      reason: "ODF deletion scheduled (24 working-hour hold; reversible via Undo Delete).",
    });
    return toView(hold, config, now);
  },

  /**
   * Place segments on the deletion hold as one group. When exactly two
   * adjacent segments (sharing a single transit site) are marked together,
   * the group is tagged mergeTopology so the purge runs as a Reverse Split.
   */
  async markSegmentsForDeletion(segmentIds: string[], requestedById?: string | null): Promise<{
    holds: PendingDeletionView[];
    alreadyHeld: PendingDeletionView[];
    mergeTopology: boolean;
    sharedSiteCode: string | null;
  }> {
    await this.sweepExpired();
    const config = holdCalendar();
    const now = new Date();
    const ids = Array.from(new Set(segmentIds.filter(Boolean)));
    if (!ids.length) throw new Error("No segments selected for deletion.");

    const existingHolds = await prisma.pendingDeletion.findMany({
      where: { entityType: PendingDeletionEntityType.SEGMENT, entityId: { in: ids }, status: PendingDeletionStatus.PENDING },
    });
    const alreadyHeldIds = new Set(existingHolds.map((row) => row.entityId));
    const newIds = ids.filter((id) => !alreadyHeldIds.has(id));

    const segments = newIds.length
      ? await prisma.linkSegment.findMany({
          where: { id: { in: newIds } },
          include: {
            endpointA: { include: { site: { select: { code: true } } } },
            endpointB: { include: { site: { select: { code: true } } } },
          },
        })
      : [];
    if (newIds.length && segments.length !== newIds.length) {
      throw new Error("One or more selected segments no longer exist. Refresh the view and retry.");
    }

    // Reverse Split detection: exactly two segments sharing exactly ONE site
    // (the transit boundary between them, e.g. A-B + B-C share B).
    const siteCodesOf = (segment: (typeof segments)[number]) => [
      String(segment.endpointA.site?.code ?? segment.endpointA.rawSiteCode ?? "").trim().toUpperCase(),
      String(segment.endpointB.site?.code ?? segment.endpointB.rawSiteCode ?? "").trim().toUpperCase(),
    ].filter(Boolean);
    let sharedSiteCode: string | null = null;
    if (segments.length === 2) {
      const [first, second] = segments.map(siteCodesOf);
      const shared = first.filter((code) => second.includes(code));
      if (shared.length === 1) sharedSiteCode = shared[0];
    }
    const mergeTopology = Boolean(sharedSiteCode);
    const deleteGroupId = segments.length ? randomUUID() : null;

    const created = [];
    for (const segment of segments) {
      created.push(await prisma.pendingDeletion.create({
        data: {
          entityType: PendingDeletionEntityType.SEGMENT,
          entityId: segment.id,
          entityLabel: segment.segmentCode,
          deleteGroupId,
          mergeTopology,
          requestedById: requestedById ?? null,
          requestedAt: now,
          scheduledPurgeAt: addWorkingMillis(now, DELETION_HOLD_MILLIS, config),
          reason: mergeTopology
            ? `Segment deletion scheduled as Reverse Split across shared site ${sharedSiteCode}.`
            : "Segment deletion scheduled with 24 working-hour reversal window (GCC calendar).",
        },
      }));
    }
    if (created.length) {
      await writeAuditLog({
        entityType: "LinkSegment",
        entityId: `HOLD:${created.length}`,
        action: "DELETE",
        oldValue: { ids: created.map((row) => row.entityId) },
        newValue: { deleteGroupId, mergeTopology, sharedSiteCode, scheduledPurgeAt: created[0].scheduledPurgeAt.toISOString() },
        changedById: requestedById ?? null,
        reason: "Segment deletion scheduled (24 working-hour hold; reversible via Undo Delete).",
      });
    }

    return {
      holds: created.map((row) => toView(row, config, now)),
      alreadyHeld: existingHolds.map((row) => toView(row, config, now)),
      mergeTopology,
      sharedSiteCode,
    };
  },

  /** Reverse a scheduled deletion while it is still PENDING. */
  async undoPendingDeletion(pendingId: string, requestedById?: string | null): Promise<{ undone: boolean; entityLabel: string | null }> {
    const hold = await prisma.pendingDeletion.findUnique({ where: { id: pendingId } });
    if (!hold) throw new Error("Scheduled deletion was not found.");

    // Atomic claim: only a still-PENDING hold can be cancelled, so an undo that
    // races the purge sweeper never reports success on an already-purged row.
    const claimed = await prisma.pendingDeletion.updateMany({
      where: { id: pendingId, status: PendingDeletionStatus.PENDING },
      data: { status: PendingDeletionStatus.CANCELLED, cancelledAt: new Date() },
    });
    if (!claimed.count) {
      throw new Error("This scheduled deletion can no longer be undone (it was already purged or cancelled).");
    }

    // Undoing one half of a Reverse Split pair breaks the adjacency: the
    // remaining hold falls back to a plain single-segment delete.
    if (hold.deleteGroupId && hold.mergeTopology) {
      await prisma.pendingDeletion.updateMany({
        where: { deleteGroupId: hold.deleteGroupId, status: PendingDeletionStatus.PENDING },
        data: { mergeTopology: false },
      });
    }

    await writeAuditLog({
      entityType: hold.entityType === PendingDeletionEntityType.ODF ? "ODF" : "LinkSegment",
      entityId: hold.entityId,
      action: "UPDATE",
      fieldName: "pendingDeletion",
      oldValue: { pendingDeletionId: hold.id, scheduledPurgeAt: hold.scheduledPurgeAt.toISOString() },
      newValue: { status: "CANCELLED" },
      changedById: requestedById ?? null,
      reason: "Scheduled deletion was undone inside the 24 working-hour reversal window.",
    });
    return { undone: true, entityLabel: hold.entityLabel };
  },
};
