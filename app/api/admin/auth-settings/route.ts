import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { authSettingsService } from "@/server/services/auth-settings.service";
import { writeAuditLog } from "@/lib/audit/audit-log";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "adminManage")) {
      return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
    }

    const body = await request.json();
    const saved = await authSettingsService.save(body, session?.id ?? null);

    await writeAuditLog({
      entityType: "AuthSetting",
      entityId: saved.id,
      action: "ROLE_CHANGE",
      changedById: session?.id ?? null,
      reason: "Authentication / LDAP settings updated",
      newValue: {
        loginMode: saved.loginMode,
        ldapEnabled: saved.ldapEnabled,
        ldapHost: saved.ldapHost,
        emergencyAccountEnabled: saved.emergencyAccountEnabled,
        emergencyUsername: saved.emergencyUsername,
      },
    });

    return NextResponse.json({ settings: await authSettingsService.getPublic() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authentication settings update failed." },
      { status: 500 },
    );
  }
}
