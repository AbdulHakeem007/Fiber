import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getTopologyDefinitions, upsertTopologyDefinition } from "@/lib/telecom/alert-definitions-db";
import { writeAuditLog } from "@/lib/audit/audit-log";

export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  return NextResponse.json({ definitions: await getTopologyDefinitions() });
}

export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "adminManage")) {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const body = await request.json();
    const saved = await upsertTopologyDefinition(String(body.key ?? ""), String(body.label ?? ""), String(body.definition ?? ""));
    await writeAuditLog({
      entityType: "AlertDefinition",
      entityId: saved.key,
      action: "UPDATE",
      changedById: session?.id,
      reason: "Topology alert definition updated",
      newValue: { label: saved.label, definition: saved.definition },
    });
    return NextResponse.json({ definition: saved });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save definition." }, { status: 400 });
  }
}
