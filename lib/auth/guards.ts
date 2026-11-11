import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";

export interface SessionUser {
  id: string;
  email: string;
  roleCode: string;
  name: string;
  forcePasswordChange?: boolean;
}

export function requirePermission(user: SessionUser | null, permission: PermissionKey) {
  if (!user || !hasPermission(user.roleCode, permission)) {
    throw new Error(`Unauthorized for permission ${permission}`);
  }
}
