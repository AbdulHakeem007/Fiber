import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { attachmentService } from "@/server/services/attachment.service";

// POST /api/attachments/upload -> multipart file stream upload.
// The service validates the target segment/site exists, streams the file to disk
// first, and only then inserts the metadata row (with file cleanup on failure).
export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write access is required to upload attachments." }, { status: 403 });
    }
    const formData = await request.formData();
    const attachment = await attachmentService.upload(formData, session!);
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Attachment upload failed." },
      { status: 400 },
    );
  }
}
