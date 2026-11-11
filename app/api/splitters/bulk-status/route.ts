import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { prisma } from "@/lib/db/prisma";

const BULK_STATUSES = new Set(["ACTIVE", "MAINTENANCE", "INACTIVE", "RESERVED", "AVAILABLE", "FAULTY", "DECOMMISSIONED"]);

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Inventory write access is required for bulk splitter status changes." }, { status: 403 });
    }

    const body = await request.json();
    const splitterIds = stringList(body.splitterIds ?? body.ids);
    const status = String(body.status ?? "").trim().toUpperCase();
    const cascadeOutputs = body.cascadeOutputs !== false;
    if (!splitterIds.length) {
      return NextResponse.json({ error: "Select at least one splitter first." }, { status: 400 });
    }
    if (!BULK_STATUSES.has(status)) {
      return NextResponse.json({ error: "Status must be Active, Maintenance, Inactive, Reserved, Available, Faulty, or Decommissioned." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const splitterUpdate = await tx.splitter.updateMany({
        where: { id: { in: splitterIds } },
        data: { status: status as never },
      });
      const outputUpdate = cascadeOutputs
        ? await tx.splitterOutput.updateMany({
            where: { splitterId: { in: splitterIds } },
            data: { status: status as never },
          })
        : { count: 0 };
      return { splittersUpdated: splitterUpdate.count, outputsUpdated: outputUpdate.count };
    });

    await writeAuditLog({
      entityType: "Splitter",
      entityId: splitterIds.join(","),
      action: "UPDATE",
      newValue: { status, ...result },
      changedById: session?.id ?? null,
      reason: "Bulk splitter status change",
    });

    return NextResponse.json({ ...result, status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bulk splitter status change failed." }, { status: 500 });
  }
}
