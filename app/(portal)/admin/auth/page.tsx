import { AuthSettingsPanel } from "@/components/admin/auth-settings";
import { adminService } from "@/server/services/admin.service";
import { authSettingsService } from "@/server/services/auth-settings.service";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  READ_WRITE: "Read and Write",
  READ_ONLY: "Read Only",
};

function usernameFromEmail(email: string): string {
  return email.includes("@") ? email.split("@")[0] : email;
}

export default async function AdminAuthPage() {
  const [settings, users] = await Promise.all([authSettingsService.getPublic(), adminService.listUsers()]);

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">Authentication &amp; LDAP</div>
        <div className="subtle mt-1">Configure the global login mode, the LDAP/Domain Controller connection, and the emergency local fail-safe account.</div>
      </div>

      <AuthSettingsPanel initial={settings} />

      <div className="card p-5">
        <div className="section-title">User record mapping</div>
        <div className="subtle mt-1">Each user is tracked with a Login Type. Local users keep a securely hashed portal password; LDAP users authenticate against the domain and store no portal password.</div>
        <div className="table-shell mt-4">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Full Name</th>
                <th>Role</th>
                <th>Login Type</th>
                <th>Password in Portal?</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{usernameFromEmail(user.email)}</td>
                  <td>{user.name}</td>
                  <td>{ROLE_LABEL[user.role.code] ?? user.role.code}</td>
                  <td>
                    <span className={`badge ${user.loginType === "LDAP" ? "badge-spare" : "badge-active"}`}>{user.loginType}</span>
                  </td>
                  <td>{user.loginType === "LOCAL" && user.passwordHash ? "Yes (Securely Hashed)" : "No"}</td>
                </tr>
              ))}
              {!users.length ? <tr><td colSpan={5}>No users found.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
