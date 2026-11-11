import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";

export async function PATCH(request: Request, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "alertAcknowledge")) {
      return NextResponse.json({ error: "Write access is required to acknowledge, suppress, or clear alerts." }, { status: 403 });
    }

    const { alertId } = await params;
    const body = (await request.json()) as { action?: string };

    const data =
      body.action === "acknowledge"
        ? { state: "ACKNOWLEDGED" as const, acknowledgedById: session?.id ?? null, acknowledgedAt: new Date() }
        : body.action === "suppress"
          ? { state: "SUPPRESSED" as const }
          : body.action === "clear"
            ? { state: "CLEARED" as const, clearedAt: new Date() }
            : null;

    if (!data) {
      return NextResponse.json({ error: "Unknown alert action." }, { status: 400 });
    }

    const alert = await prisma.alertEvent.update({
      where: { id: alertId },
      data,
    });

    return NextResponse.json({
      row: {
        id: alert.id,
        title: alert.title,
        severity: alert.severity,
        state: alert.state,
        scopeLabel: alert.sitePairKey ?? alert.siteId ?? alert.linkSegmentId ?? "GLOBAL",
        lastSeenAt: alert.lastSeenAt.toISOString(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Alert update failed." },
      { status: 500 },
    );
  }
}
