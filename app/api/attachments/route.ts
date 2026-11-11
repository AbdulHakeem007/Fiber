import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { attachmentService } from "@/server/services/attachment.service";

// GET /api/attachments?segmentId=&siteId= -> attachment metadata for one scope.
// The UI only calls this after the operator searches a specific Segment/Site ID,
// so nothing is loaded into memory on page mount.
export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryRead")) {
      return NextResponse.json({ error: "A valid portal session is required to view attachments." }, { status: 403 });
    }
    const { searchParams } = new URL(request.url);
    const result = await attachmentService.list({
      segmentId: searchParams.get("segmentId"),
      siteId: searchParams.get("siteId"),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Attachment search failed." },
      { status: 400 },
    );
  }
}
