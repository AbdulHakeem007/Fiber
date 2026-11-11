import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { attachmentService } from "@/server/services/attachment.service";

// GET /api/attachments/site-segments?site=<id|code|name|alias>
// Returns every live fiber segment connected to the resolved site, each with its
// FDD / ODF photo / OTDR document presence. Powers the Attachment-page segment
// autocomplete (issue #4) and the documentation status overview (issue #5).
export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryRead")) {
      return NextResponse.json({ error: "A valid portal session is required to view attachments." }, { status: 403 });
    }
    const { searchParams } = new URL(request.url);
    const result = await attachmentService.siteSegmentsWithDocStatus(searchParams.get("site"));
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Site segment lookup failed." },
      { status: 400 },
    );
  }
}
