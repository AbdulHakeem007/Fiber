import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { assertIndividualDeleteAllowed, DeletePolicyError } from "@/lib/auth/delete-policy";
import { prisma } from "@/lib/db/prisma";
import { destructiveDeleteService } from "@/server/services/destructive-delete.service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionUser();
    const { id } = await params;

    // RBAC: ADMIN may hard-delete any ODF Mapping directly; READ_WRITE may
    // hard-delete an individual mapping only once it is Decommissioned.
    const segment = await prisma.linkSegment.findUnique({ where: { id }, select: { status: true } });
    if (!segment) return NextResponse.json({ error: "ODF mapping not found." }, { status: 404 });
    assertIndividualDeleteAllowed(session?.roleCode, segment.status, "ODF mapping");

    const body = await request.json().catch(() => ({}));
    if (body.confirmation !== "CONFIRM DELETE") {
      return NextResponse.json({ error: "Type CONFIRM DELETE to permanently delete this ODF mapping." }, { status: 400 });
    }

    const result = await destructiveDeleteService.hardDeleteSegments([id], session?.id, "Single ODF Mapping hard delete");
    return NextResponse.json({
      success: true,
      deletedMappingId: result.deletedIds[0] ?? id,
      deletedChildLinks: result.childLinkCount,
      utilizationSnapshot: result.deletedCount > 0,
    });
  } catch (error) {
    if (error instanceof DeletePolicyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "ODF mapping hard-delete failed." }, { status: 500 });
  }
}
