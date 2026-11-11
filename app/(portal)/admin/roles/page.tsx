export default function AdminRolesPage() {
  return (
    <div className="card p-5">
      <div className="section-title">Role Model & Permissions</div>
      <div className="mt-4 space-y-3 text-sm text-slate-300">
        <div>ADMIN: full access, bulk operations, users, roles, alert policies, SMTP, templates, aliases, suppress/clear alerts.</div>
        <div>READ_WRITE: add/edit inventory, mappings, reserve/release, import/export where allowed, acknowledge alerts when policy permits.</div>
        <div>READ_ONLY: view, search, service trace, topology, reports, and export. No add/edit/delete or admin access.</div>
      </div>
    </div>
  );
}
