import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { prisma } from "@/lib/db/prisma";

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required for bulk splitter deletion." }, { status: 403 });
    }

    const body = await request.json();
    const splitterIds = stringList(body.splitterIds ?? body.ids);
    const outputIds = stringList(body.outputIds);
    if (!splitterIds.length && !outputIds.length) {
      return NextResponse.json({ error: "Select at least one splitter or splitter output to delete." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const outputDelete = outputIds.length
        ? await tx.splitterOutput.deleteMany({ where: { id: { in: outputIds } } })
        : { count: 0 };
      const childOutputDelete = splitterIds.length
        ? await tx.splitterOutput.deleteMany({ where: { splitterId: { in: splitterIds } } })
        : { count: 0 };
      const splitterDelete = splitterIds.length
        ? await tx.splitter.deleteMany({ where: { id: { in: splitterIds } } })
        : { count: 0 };
      return {
        splittersDeleted: splitterDelete.count,
        outputsDeleted: outputDelete.count + childOutputDelete.count,
      };
    });

    await writeAuditLog({
      entityType: "Splitter",
      entityId: splitterIds.join(",") || outputIds.join(","),
      action: "DELETE",
      changedById: session?.id ?? null,
      reason: "Bulk splitter inventory deletion",
      newValue: result,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bulk splitter delete failed." }, { status: 500 });
  }
}
