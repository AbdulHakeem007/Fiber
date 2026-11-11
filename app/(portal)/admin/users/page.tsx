import { UsersTable } from "@/components/admin/users-table";
import { adminService } from "@/server/services/admin.service";

export default async function AdminUsersPage() {
  const users = await adminService.listUsers();

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">User management</div>
      </div>
      <UsersTable
        rows={users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role.code,
          loginType: user.loginType,
          passwordInPortal: user.loginType === "LOCAL" && Boolean(user.passwordHash),
          isActive: user.isActive,
          isLocked: Boolean(user.lockedAt),
          lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
