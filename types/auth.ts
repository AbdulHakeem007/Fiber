export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  loginType: "LOCAL" | "LDAP";
  /** True when the portal stores a hashed password for this user (LOCAL only). */
  passwordInPortal: boolean;
  isActive: boolean;
  /** True when the account is currently locked out after failed sign-ins. */
  isLocked: boolean;
  lastLoginAt?: string | null;
}
