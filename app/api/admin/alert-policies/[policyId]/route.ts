import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ policyId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required to update alert policies." }, { status: 403 });
    }

    const { policyId } = await params;
    const body = await request.json();
    if (body.action === "pause") {
      const minutes = Math.max(1, Number(body.pauseMinutes ?? 60));
      await prisma.alertSuppression.create({
        data: {
          alertPolicyId: policyId,
          targetType: "POLICY",
          reason: String(body.reason ?? `Paused for ${minutes} minutes`),
          startsAt: new Date(),
          endsAt: new Date(Date.now() + minutes * 60_000),
          createdById: session!.id,
        },
      });
      const policy = await prisma.alertPolicy.update({ where: { id: policyId }, data: { notes: `Paused for ${minutes} minutes` } });
      return NextResponse.json({ policy, message: `Policy paused for ${minutes} minutes.` });
    }
    if (body.action === "clearSuppressions") {
      await prisma.alertSuppression.deleteMany({ where: { alertPolicyId: policyId, endsAt: { gt: new Date() } } });
      const policy = await prisma.alertPolicy.update({ where: { id: policyId }, data: { notes: "Active suppressions cleared." } });
      return NextResponse.json({ policy, message: "Active suppressions cleared." });
    }
    if (body.action === "delete") {
      const linkedEvents = await prisma.alertEvent.count({ where: { alertPolicyId: policyId } });
      if (linkedEvents > 0) {
        const policy = await prisma.alertPolicy.update({ where: { id: policyId }, data: { enabled: false, notes: "Disabled instead of deleted because alert history exists." } });
        return NextResponse.json({ policy, message: "This policy has alert history, so it was disabled instead of deleted." });
      }
      await prisma.alertSuppression.deleteMany({ where: { alertPolicyId: policyId } });
      await prisma.alertPolicy.delete({ where: { id: policyId } });
      return NextResponse.json({ deletedId: policyId });
    }
    const policy = await prisma.alertPolicy.update({
      where: { id: policyId },
      data: {
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        warningThresholdPct: optionalNumber(body.warningThresholdPct),
        criticalThresholdPct: optionalNumber(body.criticalThresholdPct),
        cooldownMinutes: optionalNumber(body.cooldownMinutes) ?? undefined,
        consecutiveHits: optionalNumber(body.consecutiveHits) ?? undefined,
        notifyEmails: typeof body.notifyEmails === "string" ? body.notifyEmails : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      },
    });

    return NextResponse.json({ policy });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Alert policy update failed." },
      { status: 500 },
    );
  }
}
