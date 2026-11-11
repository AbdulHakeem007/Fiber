"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { Mail, Send } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Password reset failed.");
      setMessage(payload.message ?? "Temporary password sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password reset failed.");
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
          "radial-gradient(900px 500px at 0% 0%, rgba(244, 63, 94, 0.10), transparent 60%)," +
          "radial-gradient(800px 480px at 100% 100%, rgba(14, 165, 233, 0.12), transparent 55%)," +
          "linear-gradient(180deg, #fafcff 0%, #f6f8fc 100%)",
      }}
    >
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,.10)] backdrop-blur">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-red-600 text-white">
          <Mail className="h-6 w-6" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold">Forgot Password</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Enter your registered email address. The portal will generate an expiring temporary password and send it by SMTP.
        </p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-semibold text-slate-800">
            Registered email
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-950 shadow-sm outline-none transition placeholder:text-slate-500 focus:border-red-600 focus:ring-4 focus:ring-red-100"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="name@example.com"
              required
            />
          </label>
          {message ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
          {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
          <button className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white" disabled={isSubmitting}>
            <Send className="h-4 w-4" />
            {isSubmitting ? "Sending..." : "Send Temporary Password"}
          </button>
        </form>
        <Link href="/login" className="mt-5 inline-block text-sm font-semibold text-red-700 hover:text-red-900">
          Back to login
        </Link>
      </section>
    </main>
  );
}
