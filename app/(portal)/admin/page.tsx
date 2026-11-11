import Link from "next/link";
import { ActivityLogPanel } from "@/components/admin/activity-log-panel";

export default function AdminPage() {
  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="section-title">Admin panel</div>
        <div className="subtle mt-1">Alert policies, notification templates, SMTP, aliases, role management, permissions, audit actions, and future mobile readiness.</div>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <Link className="rounded-lg border border-border bg-white/5 p-5 text-sm" href="/admin/users">Users</Link>
          <Link className="rounded-lg border border-border bg-white/5 p-5 text-sm" href="/admin/roles">Roles</Link>
          <Link className="rounded-lg border border-border bg-white/5 p-5 text-sm" href="/admin/auth">Authentication &amp; LDAP</Link>
          <Link className="rounded-lg border border-border bg-white/5 p-5 text-sm" href="/admin/import-rules">Import Rules</Link>
          <Link className="rounded-lg border border-border bg-white/5 p-5 text-sm" href="/admin/alert-policies">Alert Policies</Link>
          <Link className="rounded-lg border border-border bg-white/5 p-5 text-sm" href="/admin/notifications">SMTP &amp; Templates</Link>
        </div>
      </div>
      <ActivityLogPanel />
    </div>
  );
}
