"use client";

import { useState } from "react";
import type { UserRow } from "@/types/auth";
import { useToast } from "@/components/ui/toast";

export function UsersTable({ rows }: { rows: UserRow[] }) {
  const [users, setUsers] = useState(rows);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; email: string; password: string; roleCode: string; loginType: "LOCAL" | "LDAP"; isActive: boolean }>({ name: "", email: "", password: "", roleCode: "READ_ONLY", loginType: "LOCAL", isActive: true });

  function resetForm() {
    setEditingId(null);
    setForm({ name: "", email: "", password: "", roleCode: "READ_ONLY", loginType: "LOCAL", isActive: true });
  }

  function editUser(user: UserRow) {
    setEditingId(user.id);
    setForm({ name: user.name, email: user.email, password: "", roleCode: user.role, loginType: user.loginType, isActive: user.isActive });
  }

  async function saveUser() {
    setMessage(null);
    const url = editingId ? `/api/admin/users/${editingId}` : "/api/admin/users";
    try {
      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok || !payload.row) throw new Error(payload.error ?? "User save failed.");
      setUsers((current) => editingId ? current.map((row) => (row.id === editingId ? payload.row : row)) : [payload.row, ...current]);
      resetForm();
      setMessage(editingId ? "User updated." : "User added.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "User save failed.");
    }
  }

  async function updateUser(user: UserRow, patch: Partial<Pick<UserRow, "isActive" | "role">>) {
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: patch.isActive, roleCode: patch.role }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.row) throw new Error(payload.error ?? "User update failed.");
      setUsers((current) => current.map((row) => (row.id === user.id ? payload.row : row)));
      setMessage("User updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "User update failed.");
    }
  }

  async function unlockUser(user: UserRow) {
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unlock: true }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.row) throw new Error(payload.error ?? "Unlock failed.");
      setUsers((current) => current.map((row) => (row.id === user.id ? payload.row : row)));
      setMessage(`Account ${user.email} unlocked.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unlock failed.");
    }
  }

  async function deleteUser(user: UserRow) {
    if (!window.confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "User deletion failed.");
      setUsers((current) => current.filter((row) => row.id !== user.id));
      setMessage("User deleted.");
      toast.deleted(`User ${user.email}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "User deletion failed.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-5">
        <div className="section-title">{editingId ? "Edit user" : "Add user"}</div>
        <div className="mt-4 grid gap-3 md:grid-cols-6">
          <input className="input-dark" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <input className="input-dark" placeholder="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          <select className="input-dark" value={form.loginType} onChange={(event) => setForm({ ...form, loginType: event.target.value as "LOCAL" | "LDAP" })}>
            <option value="LOCAL">Local</option>
            <option value="LDAP">LDAP</option>
          </select>
          <input
            className="input-dark"
            placeholder={form.loginType === "LDAP" ? "Managed by LDAP" : editingId ? "New password optional" : "Password"}
            type="password"
            value={form.password}
            disabled={form.loginType === "LDAP"}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          <select className="input-dark" value={form.roleCode} onChange={(event) => setForm({ ...form, roleCode: event.target.value })}>
            <option value="ADMIN">ADMIN</option>
            <option value="READ_WRITE">READ_WRITE</option>
            <option value="READ_ONLY">READ_ONLY</option>
          </select>
          <div className="flex gap-2">
            <button className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700" onClick={saveUser}>{editingId ? "Save" : "Add"}</button>
            {editingId ? <button className="btn btn-ghost" onClick={resetForm}>Cancel</button> : null}
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
          Active account
        </label>
      </div>
      {message ? <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div> : null}
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Login Type</th>
              <th>Password in Portal?</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.email}</td>
                <td>
                  <select className="input-dark" value={row.role} onChange={(event) => updateUser(row, { role: event.target.value })}>
                    <option value="ADMIN">ADMIN</option>
                    <option value="READ_WRITE">READ_WRITE</option>
                    <option value="READ_ONLY">READ_ONLY</option>
                  </select>
                </td>
                <td><span className={`badge ${row.loginType === "LDAP" ? "badge-spare" : "badge-active"}`}>{row.loginType}</span></td>
                <td>{row.passwordInPortal ? "Yes (Securely Hashed)" : "No"}</td>
                <td>
                  {row.isActive ? "Active" : "Disabled"}
                  {row.isLocked ? <span className="ml-2 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Locked</span> : null}
                </td>
                <td>{row.lastLoginAt ?? "-"}</td>
                <td>
                  {row.isLocked ? (
                    <button className="mr-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700" onClick={() => unlockUser(row)}>
                      Unlock
                    </button>
                  ) : null}
                  <button className="btn btn-ghost btn-compact" onClick={() => updateUser(row, { isActive: !row.isActive })}>
                    {row.isActive ? "Suspend" : "Activate"}
                  </button>
                  <button className="ml-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs" onClick={() => editUser(row)}>
                    Edit
                  </button>
                  <button className="ml-2 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700" onClick={() => deleteUser(row)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
