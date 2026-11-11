import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { isChildLinkTag } from "@/lib/config/child-link-tags";
import { updateChildLinkTagCascade } from "@/server/services/child-link-tag.service";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Read/write inventory access is required to tag child links." }, { status: 403 });
    }
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const tag = typeof body.tag === "string" ? body.tag.trim() : "";
    if (!isChildLinkTag(tag)) {
      return NextResponse.json({ error: "Invalid child-link tag." }, { status: 400 });
    }

    const result = await updateChildLinkTagCascade({ id, tag, operatorId: session?.id });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Child-link tag update failed." }, { status: 500 });
  }
}
