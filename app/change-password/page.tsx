"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { KeyRound, Save } from "lucide-react";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const passwordsMismatch = confirmNewPassword.length > 0 && newPassword !== confirmNewPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 10 &&
    confirmNewPassword.length >= 10 &&
    newPassword === confirmNewPassword &&
    !isSubmitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (!canSubmit) {
      setError(
        newPassword !== confirmNewPassword
          ? "New password and confirmation must match."
          : "Enter your current password and a new password of at least 10 characters.",
      );
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmNewPassword }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Password change failed.");
      setMessage(payload.message ?? "Password changed.");
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    // Theme-independent neutral canvas: matches the welcome page, never forced dark.
    <main
      className="fixed inset-0 flex items-center justify-center overflow-auto p-6 text-slate-900"
      style={{
        colorScheme: "light",
        background:
          "radial-gradient(900px 500px at 0% 0%, rgba(168, 85, 247, 0.10), transparent 60%)," +
          "radial-gradient(800px 480px at 100% 100%, rgba(245, 158, 11, 0.10), transparent 55%)," +
          "linear-gradient(180deg, #fafcff 0%, #f6f8fc 100%)",
      }}
    >
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,.10)] backdrop-blur">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-red-600 text-white">
          <KeyRound className="h-6 w-6" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold">Change Password</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Temporary passwords expire and must be replaced before opening operational modules.
        </p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-semibold text-slate-800">
            Current or temporary password
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-950 shadow-sm outline-none transition placeholder:text-slate-500 focus:border-red-600 focus:ring-4 focus:ring-red-100"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Enter current or temporary password"
              required
            />
          </label>
          <label className="block text-sm font-semibold text-slate-800">
            New password
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-950 shadow-sm outline-none transition placeholder:text-slate-500 focus:border-red-600 focus:ring-4 focus:ring-red-100"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="Enter at least 10 characters"
              minLength={10}
              required
            />
          </label>
          <label className="block text-sm font-semibold text-slate-800">
            Confirm new password
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-950 shadow-sm outline-none transition placeholder:text-slate-500 focus:border-red-600 focus:ring-4 focus:ring-red-100"
              type="password"
              value={confirmNewPassword}
              onChange={(event) => setConfirmNewPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="Re-enter new password"
              minLength={10}
              aria-invalid={passwordsMismatch}
              aria-describedby={passwordsMismatch ? "password-match-error" : undefined}
              required
            />
          </label>
          {passwordsMismatch ? (
            <div id="password-match-error" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              New password and confirmation must match.
            </div>
          ) : null}
          {message ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
          {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
          <button className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400" disabled={!canSubmit}>
            <Save className="h-4 w-4" />
            {isSubmitting ? "Saving..." : "Save Password"}
          </button>
        </form>
      </section>
    </main>
  );
}
