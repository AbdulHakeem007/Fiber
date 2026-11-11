import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { attachmentService } from "@/server/services/attachment.service";

// DELETE /api/attachments/:id -> remove the metadata row and purge the file from
// disk. The file delete is best-effort: a missing file still clears metadata.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write access is required to delete attachments." }, { status: 403 });
    }
    const { id } = await params;
    const result = await attachmentService.delete(id);
    if (!result) {
      return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Attachment delete failed." },
      { status: 400 },
    );
  }
}
