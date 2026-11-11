import { NextResponse } from "next/server";
import { OdfStatus, Prisma } from "@prisma/client";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { assertIndividualDeleteAllowed, DeletePolicyError } from "@/lib/auth/delete-policy";
import { OdfDeleteBlockedError } from "@/server/services/destructive-delete.service";
import { pendingDeletionService } from "@/server/services/pending-deletion.service";
import { prisma } from "@/lib/db/prisma";
import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { normalizeRackCode } from "@/lib/telecom/connection-identity";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { inventorySyncService } from "@/server/services/inventory-sync.service";

const ODF_STATUSES = new Set(["ACTIVE", "PLANNED", "INACTIVE", "DECOMMISSIONED"]);


function parsePortRanges(value: unknown): number[] {
  const ports = new Set<number>();
  for (const part of String(value ?? "").split(",")) {
    const text = part.trim();
    if (!text) continue;
    const match = text.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    for (let port = Math.min(start, end); port <= Math.max(start, end); port += 1) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function normalizeOptionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ odfId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to update ODF records." }, { status: 403 });
    }

    const { odfId } = await params;
    const body = await request.json();
    const requestedStatus = String(body.status ?? "").toUpperCase();
    if (requestedStatus && !ODF_STATUSES.has(requestedStatus)) {
      return NextResponse.json(
        { error: `Invalid ODF status. Allowed: ${[...ODF_STATUSES].join(", ")}` },
        { status: 400 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.oDF.findUnique({
        where: { id: odfId },
        include: { site: true, rack: true },
      });
      if (!current) throw new Error("ODF record was not found.");

      // EDIT HERE: ODF row edit supports all important properties, not just maxPorts.
      const requestedSite = normalizeOptionalText(body.siteCode ?? body.siteId ?? body.siteName);
      const requestedRack = normalizeOptionalText(body.rackCode);
      const requestedOdf = normalizeOptionalText(body.odfCode);
      const nextSiteCode = (requestedSite ? normalizeAlias(requestedSite) : current.site.code) ?? current.site.code;
      const nextRackCode = (requestedRack ? normalizeRackCode(requestedRack) : current.rack.rackCode) ?? current.rack.rackCode;
      const nextOdfCode = (requestedOdf ? normalizeOdfCode(requestedOdf) : current.odfCode) ?? current.odfCode;

      const site = await tx.site.upsert({
        where: { code: nextSiteCode },
        update: { name: normalizeOptionalText(body.siteName) ?? normalizeOptionalText(body.siteId) ?? undefined, isFiberNode: true },
        create: {
          code: nextSiteCode,
          name: normalizeOptionalText(body.siteName) ?? normalizeOptionalText(body.siteId) ?? nextSiteCode,
          isFiberNode: true,
          status: "ACTIVE",
        },
      });

      const rack = await tx.rack.upsert({
        where: { siteId_rackCode: { siteId: site.id, rackCode: nextRackCode } },
        update: { status: "ACTIVE" },
        create: { siteId: site.id, rackCode: nextRackCode, name: nextRackCode, status: "ACTIVE" },
      });

      const odf = await tx.oDF.update({
        where: { id: odfId },
        data: {
          siteId: site.id,
          rackId: rack.id,
          odfCode: nextOdfCode,
          name: normalizeOptionalText(body.name) ?? nextOdfCode,
          status: requestedStatus ? requestedStatus as OdfStatus : undefined,
          maxPorts: body.maxPorts === "" || body.maxPorts === null || body.maxPorts === undefined ? null : Number(body.maxPorts),
          remarks: typeof body.remarks === "string" ? body.remarks : undefined,
        },
        include: { site: true, rack: true, portGroups: true, ports: true },
      });

      await tx.portGroup.updateMany({
        where: { odfId: odf.id },
        data: { siteId: site.id, rackId: rack.id },
      });

      // EDIT HERE: Individual ODF edit now supports the same range model as New ODF Addition.
      // Available and Dummy ranges update physical ODF ports and matching port groups in one transaction.
      const availablePorts = parsePortRanges(body.availableRanges);
      const dummyPorts = parsePortRanges(body.dummyRanges);
      const updateRange = async (ports: number[], status: "AVAILABLE" | "DUMMY") => {
        if (!ports.length) return;
        await tx.oDFPort.updateMany({
          where: { odfId: odf.id, portNumber: { in: ports } },
          data: { status },
        });
        for (const portNumber of ports) {
          await tx.oDFPort.upsert({
            where: { odfId_portNumber: { odfId: odf.id, portNumber } },
            update: { status },
            create: { odfId: odf.id, portNumber, label: String(portNumber), status },
          });
        }
        await tx.portGroup.updateMany({
          where: {
            odfId: odf.id,
            OR: ports.map((portNumber) => ({ startPortNumber: { lte: portNumber }, endPortNumber: { gte: portNumber } })),
          },
          data: { status },
        });
      };
      await updateRange(availablePorts, "AVAILABLE");
      await updateRange(dummyPorts, "DUMMY");

      if (requestedStatus === "DECOMMISSIONED") {
        await tx.oDFPort.updateMany({
          where: { odfId: odf.id },
          data: { status: "DECOMMISSIONED" },
        });
        await tx.portGroup.updateMany({
          where: { odfId: odf.id },
          data: { status: "DECOMMISSIONED" },
        });
      }

      // Downstream sync inside the same transaction: cascade the (possibly
      // renamed) Site/Rack/ODF identity to every FK-linked segment endpoint and
      // ODF Mapping child row, then re-link any raw-code orphans that this
      // asset registration just made resolvable.
      await inventorySyncService.propagateOdfIdentity(tx, odf.id);
      await inventorySyncService.healSegmentEndpoints(tx);

      return tx.oDF.findUniqueOrThrow({ where: { id: odf.id }, include: { site: true, rack: true, portGroups: true, ports: true } });
    });

    return NextResponse.json({
      row: {
        odfId: result.id,
        siteCode: result.site.code,
        siteName: result.site.name,
        rackCode: result.rack.rackCode,
        odfCode: result.odfCode,
        status: result.status,
        maxPorts: result.maxPorts,
        portGroupCount: result.portGroups.length,
        remarks: result.remarks,
        totalOdfPorts: result.ports.length,
        usedOdfPorts: result.ports.filter((port) => port.status === "USED" || port.status === "ACTIVE").length,
        freeOdfPorts: result.ports.filter((port) => port.status === "AVAILABLE").length,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "An ODF with this Site ID / Rack / ODF combination already exists." }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ODF update failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ odfId: string }> }) {
  try {
    const session = await getSessionUser();
    const { odfId } = await params;

    // RBAC: ADMIN may delete any ODF directly; READ_WRITE may delete an
    // individual ODF only once the ODF record itself is Decommissioned.
    const odf = await prisma.oDF.findUnique({
      where: { id: odfId },
      select: { status: true, odfCode: true, rack: { select: { rackCode: true } }, site: { select: { code: true } } },
    });
    if (!odf) return NextResponse.json({ error: "ODF record was not found." }, { status: 404 });
    assertIndividualDeleteAllowed(session?.roleCode, odf.status, "ODF record");

    // Repair older/stale records: decommissioning an ODF is a retained state,
    // but its physical ports must also be retired before explicit deletion.
    // Some rows were marked DECOMMISSIONED before that cascade existed, so sync
    // those child rows here before the strict live-port check.
    if (odf.status === "DECOMMISSIONED") {
      await prisma.$transaction([
        prisma.oDFPort.updateMany({
          where: { odfId, status: { not: "DECOMMISSIONED" } },
          data: { status: "DECOMMISSIONED" },
        }),
        prisma.portGroup.updateMany({
          where: { odfId, status: { not: "DECOMMISSIONED" } },
          data: { status: "DECOMMISSIONED" },
        }),
      ]);
    }

    // Strict decommission-then-delete workflow (enforced server-side so it
    // cannot be bypassed by calling the API directly): an ODF and its ports may
    // only be deleted once every port has been set to DECOMMISSIONED. Any
    // remaining live port blocks the deletion.
    const livePortCount = await prisma.oDFPort.count({
      where: { odfId, status: { not: "DECOMMISSIONED" } },
    });
    if (livePortCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete this ODF: ${livePortCount} port(s) are still live. Set every port to "Decommissioned" first, then delete the segment and ports.`,
          dependencies: [{
            id: `${odfId}:live-ports`,
            kind: "mapping",
            label: `${livePortCount} live ODF port(s)`,
            detail: "Set every physical ODF port on this row to Decommissioned before deleting.",
            href: `/odf-racks?search=${encodeURIComponent([odf.site.code, odf.rack.rackCode, odf.odfCode].join(" "))}`,
          }],
        },
        { status: 409 },
      );
    }

    // Delayed deletion: a dependency-free ODF is parked on a 24 working-hour
    // hold (GCC calendar — weekends/holidays pause the countdown) instead of
    // being purged immediately. The operator can undo within the window; the
    // pending-deletions sweeper runs the original destructive delete after it.
    const hold = await pendingDeletionService.markOdfForDeletion(odfId, session?.id);
    return NextResponse.json(
      {
        pending: true,
        hold,
        message: `ODF deletion scheduled. You can undo this decision for the next 24 working hours (until ${new Date(hold.scheduledPurgeAt).toLocaleString()}).`,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof DeletePolicyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof OdfDeleteBlockedError) {
      return NextResponse.json({ error: error.message, dependencies: error.dependencies }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ODF delete failed." },
      { status: 500 },
    );
  }
}
