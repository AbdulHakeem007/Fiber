import { NextResponse } from "next/server";
import { z } from "zod";
import { findUserByLogin, isLockableRole, issueUnlockCode } from "@/lib/auth/account-lock";

const schema = z.object({
  username: z.string().trim().min(1, "Username is required."),
});

// POST /api/auth/unlock/resend — email a fresh unlock code for a locked account.
// Always returns the same generic message so it cannot be used to probe which
// usernames exist or are locked.
export async function POST(request: Request) {
  const generic = NextResponse.json({
    message: "If that account is locked, a new unlock code has been emailed to its registered address.",
  });
  try {
    const body = schema.parse(await request.json());
    const user = await findUserByLogin(body.username);
    if (user && isLockableRole(user.role.code) && user.lockedAt) {
      await issueUnlockCode(user, "Unlock code re-sent on request.");
    }
    return generic;
  } catch {
    // Validation failures still return the generic message (no enumeration signal).
    return generic;
  }
}
