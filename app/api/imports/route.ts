import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";

export async function GET() {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "importManage")) {
    return NextResponse.json({ error: "Import management access is required to view upload history." }, { status: 403 });
  }

  const rows = await prisma.importMetadata.findMany({
    orderBy: { uploadedAt: "desc" },
    take: 100,
  });

  // Legacy rows stored the uploader's user id (a cuid) in `uploadedBy`, which the
  // Report Upload Summary then rendered as a raw "cmqomxzul0…" string. Resolve any
  // id-shaped value back to a human-readable name/email so historical rows read
  // correctly too. New rows already store a readable name (see import.service).
  const candidateIds = [...new Set(rows.map((row) => row.uploadedBy).filter((value): value is string => Boolean(value)))];
  const users = candidateIds.length
    ? await prisma.user.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true, email: true } })
    : [];
  const nameById = new Map(users.map((user) => [user.id, user.name?.trim() || user.email?.trim() || user.id]));
  const resolvedRows = rows.map((row) => ({
    ...row,
    uploadedBy: (row.uploadedBy && nameById.get(row.uploadedBy)) || row.uploadedBy,
  }));

  return NextResponse.json({ rows: resolvedRows });
}
