import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { clearLockStateData, findUserByLogin, isLockableRole, MAX_UNLOCK_CODE_ATTEMPTS } from "@/lib/auth/account-lock";

const schema = z.object({
  username: z.string().trim().min(1, "Username is required."),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit unlock code."),
});

// POST /api/auth/unlock — clear an account lock by entering the emailed code.
export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const user = await findUserByLogin(body.username);

    // Generic responses for non-matching / not-locked accounts avoid leaking which
    // usernames exist or are currently locked.
    if (!user || !isLockableRole(user.role.code) || !user.lockedAt) {
      return NextResponse.json({ error: "Invalid unlock request." }, { status: 400 });
    }

    if (!user.unlockCodeHash || !user.unlockCodeExpiresAt || user.unlockCodeExpiresAt.getTime() < Date.now()) {
      return NextResponse.json(
        { error: "The unlock code has expired. Request a new code.", expired: true },
        { status: 400 },
      );
    }

    // Bound brute-force of the 6-digit code: after too many wrong guesses the code
    // is invalidated and the user must request a fresh one.
    if (user.unlockCodeAttempts >= MAX_UNLOCK_CODE_ATTEMPTS) {
      await prisma.user.update({
        where: { id: user.id },
        data: { unlockCodeHash: null, unlockCodeExpiresAt: null, unlockCodeAttempts: 0 },
      });
      return NextResponse.json(
        { error: "Too many incorrect codes. Request a new unlock code.", expired: true },
        { status: 429 },
      );
    }

    if (!verifyPassword(body.code, user.unlockCodeHash)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { unlockCodeAttempts: { increment: 1 } },
      });
      const remaining = Math.max(0, MAX_UNLOCK_CODE_ATTEMPTS - (user.unlockCodeAttempts + 1));
      return NextResponse.json(
        { error: `Incorrect unlock code.${remaining ? ` ${remaining} attempt(s) left.` : " Request a new code."}` },
        { status: 401 },
      );
    }

    await prisma.user.update({ where: { id: user.id }, data: clearLockStateData() });
    await writeAuditLog({
      entityType: "User",
      entityId: user.id,
      action: "MANUAL_OVERRIDE",
      changedById: user.id,
      reason: "Account unlocked via emailed unlock code.",
      newValue: { event: "ACCOUNT_UNLOCKED" },
    });

    return NextResponse.json({ message: "Account unlocked. You can sign in now." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unlock failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
