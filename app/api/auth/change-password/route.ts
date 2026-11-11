import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";

const schema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: z.string().min(10, "Use at least 10 characters."),
  confirmNewPassword: z.string().min(10, "Confirm the new password."),
}).refine((body) => body.newPassword === body.confirmNewPassword, {
  path: ["confirmNewPassword"],
  message: "New password and confirmation must match.",
});

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!session) return NextResponse.json({ error: "Login is required." }, { status: 401 });

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid password change request." }, { status: 400 });
    }
    const body = parsed.data;
    if (body.currentPassword === body.newPassword) {
      return NextResponse.json({ error: "New password must be different from the current password." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.id },
      include: { role: true, temporaryPasswords: { where: { consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } } },
    });
    if (!user || !user.isActive) return NextResponse.json({ error: "User session is no longer active." }, { status: 401 });

    const normalPasswordOk = verifyPassword(body.currentPassword, user.passwordHash, user.role.code);
    const temporaryPasswordOk = user.temporaryPasswords.some((temp) => verifyPassword(body.currentPassword, temp.passwordHash, user.role.code));
    if (!normalPasswordOk && !temporaryPasswordOk) {
      return NextResponse.json({ error: "Current password is incorrect or expired." }, { status: 401 });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: hashPassword(body.newPassword),
          passwordChangedAt: new Date(),
          forcePasswordChange: false,
        },
      }),
      prisma.temporaryPassword.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    await writeAuditLog({
      entityType: "User",
      entityId: user.id,
      action: "PASSWORD_CHANGE",
      changedById: user.id,
      reason: temporaryPasswordOk ? "Forced password change after temporary password login" : "User changed password",
    });

    return NextResponse.json({ message: "Password changed successfully." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Password change failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
