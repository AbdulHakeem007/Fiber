import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import {
  normalizeTopologyRole,
  normalizeSegmentDefaultTopologyRole,
} from "@/lib/telecom/topology-role";

// EDIT HERE: Bulk topology-role / segment-type editor.
// Lets an operator mark many child fiber rows (SegmentEndpointMapping) or many
// segments (LinkSegment) in one action, instead of opening each row. Child rows
// still use topology roles; parent segments now use Segment Type.

type Target = "child" | "segment";

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json(
        { error: "Read/write inventory access is required to bulk-edit topology roles." },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const target = (String(body.target ?? "child").toLowerCase() as Target);
    const ids = asIdList(body.ids);
    if (!ids.length) {
      return NextResponse.json({ error: "Select at least one row to bulk-edit." }, { status: 400 });
    }

    // For child rows we use the full child-role set (SUBRING/SPUR/SPUR_CHAIN/...);
    // for segments only parent Segment Type values are allowed.
    const rawRole = body.topologyRole ?? body.role ?? body.childTopologyRole ?? body.segmentDefaultRole;
    const role =
      target === "segment"
        ? normalizeSegmentDefaultTopologyRole(rawRole)
        : normalizeTopologyRole(rawRole);

    // For child rows a blank/MAIN_RING request is a valid "clear" operation.
    // For parent segments, blank normalizes to DEFAULT.
    const requestedText = String(rawRole ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    const isClear = target === "child" && (!requestedText || requestedText === "MAIN_RING" || requestedText === "NORMAL");
    if (!role && !isClear) {
      return NextResponse.json(
        {
          error:
            target === "segment"
              ? "Segment Type must be one of Backbone, Default, Interconnect, Intra-site, GPON segment, or B2B segment."
              : "Child topology role must be one of SUBRING, SPUR, SPUR_CHAIN, INTERCONNECT, REVIEW, or blank (MAIN_RING).",
        },
        { status: 400 },
      );
    }

    let updated = 0;
    if (target === "segment") {
      const result = await prisma.linkSegment.updateMany({
        where: { id: { in: ids } },
        data: { segmentDefaultRole: role ?? "DEFAULT" },
      });
      updated = result.count;
    } else {
      const result = await prisma.segmentEndpointMapping.updateMany({
        where: { id: { in: ids } },
        data: { childTopologyRole: role },
      });
      updated = result.count;
    }

    await writeAuditLog({
      entityType: target === "segment" ? "LinkSegment" : "SegmentEndpointMapping",
      entityId: ids.join(","),
      action: "UPDATE",
      fieldName: target === "segment" ? "segmentType" : "childTopologyRole",
      newValue: { role: role ?? "MAIN_RING", count: updated },
      changedById: session?.id ?? null,
      reason: target === "segment"
        ? `Bulk segment type set to ${role ?? "DEFAULT"} on ${updated} segment row(s)`
        : `Bulk topology role set to ${role ?? "MAIN_RING"} on ${updated} child row(s)`,
    });

    return NextResponse.json({
      message: target === "segment"
        ? `Updated segment type on ${updated} segment row(s).`
        : `Updated topology role on ${updated} child row(s).`,
      updated,
      role: role ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk topology role update failed." },
      { status: 400 },
    );
  }
}
