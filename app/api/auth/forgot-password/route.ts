import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/session";
import { notificationService } from "@/server/services/notification.service";
import { writeAuditLog } from "@/lib/audit/audit-log";

const schema = z.object({
  email: z.string().trim().email("Enter a valid registered email address."),
});

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
      include: { role: true },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: "No active user exists for that registered email." }, { status: 404 });
    }

    const temporaryPassword = generateTemporaryPassword();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.$transaction([
      // Single live temp password per user: retire any earlier unconsumed ones so a
      // previously issued (and possibly leaked) temporary password can no longer be
      // used once a fresh reset is requested.
      prisma.temporaryPassword.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.temporaryPassword.create({
        data: {
          userId: user.id,
          passwordHash: hashPassword(temporaryPassword),
          expiresAt,
          reason: "Forgot password request",
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { forcePasswordChange: true },
      }),
    ]);

    const delivery = await notificationService.sendEmail({
      to: user.email,
      subject: "Fiber Inventory Portal temporary password",
      text: [
        `Hello ${user.name},`,
        "",
        "A temporary password was generated for the Fiber Inventory Management Portal.",
        `Temporary password: ${temporaryPassword}`,
        `Expires: ${expiresAt.toISOString()}`,
        "",
        "You must change this password immediately after login.",
      ].join("\n"),
      userId: user.id,
      metadata: { purpose: "PASSWORD_RESET", expiresAt: expiresAt.toISOString() },
    });

    await writeAuditLog({
      entityType: "User",
      entityId: user.id,
      action: "PASSWORD_RESET",
      changedById: user.id,
      reason: "Temporary password generated from forgot password flow",
      newValue: { expiresAt: expiresAt.toISOString(), delivery: "EMAIL" },
    });

    return NextResponse.json({
      message: delivery.status === "SENT"
        ? "Temporary password generated and sent to the registered email address."
        : "Temporary password generated, but SMTP is not configured. Ask an Admin to configure SMTP before using password reset.",
      expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Password reset request failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
