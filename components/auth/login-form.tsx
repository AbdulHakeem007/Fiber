"use client";

import Link from "next/link";
import { Eye, EyeOff, KeyRound, LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { FiberNetworkBackground } from "@/components/auth/login-fiber-art";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Lockout flow: a 423 from /login flips the card to an unlock-code panel.
  const [locked, setLocked] = useState(false);
  const [unlockCode, setUnlockCode] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const loginInputStyle = {
    color: "#020617",
    WebkitTextFillColor: "#020617",
    caretColor: "#dc2626",
    backgroundColor: "#ffffff",
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Idempotent guard: ignore re-entry while a request is in flight so rapid or
    // repeated clicks can never fire a second login or fight the redirect.
    if (isSubmitting) return;
    setMessage(null);
    setInfo(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, rememberMe }),
      });
      const payload = await response.json();
      if (response.status === 423 && payload.locked) {
        // Account locked — switch to the unlock-code panel.
        setLocked(true);
        setMessage(payload.error ?? "This account is locked.");
        setIsSubmitting(false);
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "Login failed.");
      const nextPath = new URLSearchParams(window.location.search).get("next");
      const target = payload.requiresPasswordChange ? "/change-password" : nextPath || "/dashboard";
      // Hard navigation instead of router.push()+router.refresh(): the session
      // cookie was just set on this response, so a full document load lets the
      // middleware re-validate it and render the target in a single shot. The
      // previous push()+refresh() raced the RSC re-render of /login, so the first
      // click often appeared to do nothing and the operator had to click again.
      // isSubmitting stays true so the button is disabled until this page unloads.
      window.location.assign(target);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed.");
      // Re-enable the button only on failure; a successful login keeps it disabled
      // through the hard redirect that unloads this page.
      setIsSubmitting(false);
    }
  }

  async function submitUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unlockBusy) return;
    setMessage(null);
    setInfo(null);
    setUnlockBusy(true);
    try {
      const response = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, code: unlockCode }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unlock failed.");
      // Unlocked: drop back to the sign-in form with a success note.
      setLocked(false);
      setUnlockCode("");
      setPassword("");
      setInfo(payload.message ?? "Account unlocked. You can sign in now.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unlock failed.");
    } finally {
      setUnlockBusy(false);
    }
  }

  async function resendCode() {
    setMessage(null);
    setInfo(null);
    try {
      const response = await fetch("/api/auth/unlock/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const payload = await response.json();
      setInfo(payload.message ?? "If that account is locked, a new code has been emailed.");
    } catch {
      setInfo("If that account is locked, a new code has been emailed.");
    }
  }

  return (
    // LIGHT-MODE only, aligned to the global light palette: soft off-white canvas,
    // deep-slate text, and the app's crimson accent — never forced dark mode.
    <main
      className="fixed inset-0 overflow-y-auto text-slate-900"
      style={{
        colorScheme: "light",
        background:
          "radial-gradient(1100px 540px at 50% -8%, rgba(255,255,255,0.42), transparent 60%)," +
          "radial-gradient(840px 480px at 100% 0%, rgba(140,170,252,0.08), transparent 55%)," +
          "linear-gradient(180deg, #edf1ee 0%, #e5eae5 100%)",
      }}
    >
      <FiberNetworkBackground />

      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-6xl items-center px-6 py-10 sm:px-8">
        <div className="grid w-full items-center gap-10 lg:grid-cols-[1.05fr_.95fr]">
          {/* Hero */}
          <section>
            <h1 className="lp-rise text-4xl font-bold leading-[1.08] tracking-tight text-slate-900 sm:text-5xl lg:text-6xl" style={{ animationDelay: ".06s" }}>
              Interactive Fiber Infrastructure &amp;{" "}
              <span className="lp-sheen bg-gradient-to-r from-red-600 via-rose-500 to-red-700 bg-clip-text text-transparent">
                Provisioning
              </span>{" "}
              Portal
            </h1>

            <p className="lp-rise mt-5 max-w-xl text-lg leading-8 text-slate-600 sm:text-xl" style={{ animationDelay: ".16s" }}>
              Network capacity management, intelligent network segmentation, automated routing, end-to-end circuit tracing, and comprehensive reporting at scale
            </p>
          </section>

          {/* Sign-in form */}
          <section className="lp-rise rounded-2xl border border-slate-200/90 bg-white/90 p-8 shadow-[0_24px_60px_-28px_rgba(15,23,42,0.25)] backdrop-blur" style={{ animationDelay: ".18s" }}>
            <div className="mb-7">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-red-600/25">
                <LockKeyhole className="h-6 w-6" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold text-slate-950">{locked ? "Unlock account" : "Sign in"}</h2>
              <p className="mt-2 flex items-center gap-2 text-sm text-slate-500">
                <ShieldCheck className="h-4 w-4 text-red-600" />
                {locked ? "Enter the unlock code we emailed you" : "Enterprise role-based operations access"}
              </p>
            </div>

            {info ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{info}</div> : null}

            {locked ? (
              <form className="space-y-4" onSubmit={submitUnlock}>
                <p className="text-sm text-slate-600">
                  Account <span className="font-semibold text-slate-800">{username || "—"}</span> is locked. Enter the 6-digit code emailed to its registered address.
                </p>
                <label className="block text-sm font-medium text-slate-700">
                  Unlock code
                  <input
                    className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-center text-lg tracking-[0.5em] text-slate-950 outline-none transition focus:border-red-500 focus:ring-4 focus:ring-red-100"
                    style={loginInputStyle}
                    value={unlockCode}
                    onChange={(event) => setUnlockCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="••••••"
                  />
                </label>
                {message ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div> : null}
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={unlockBusy || unlockCode.length !== 6}
                >
                  <KeyRound className="h-4 w-4" />
                  {unlockBusy ? "Unlocking..." : "Unlock account"}
                </button>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <button type="button" onClick={() => { setLocked(false); setMessage(null); }} className="font-semibold text-slate-600 transition hover:text-slate-900">
                    Back to sign in
                  </button>
                  <button type="button" onClick={resendCode} className="font-semibold text-red-700 transition hover:text-red-900">
                    Resend code
                  </button>
                </div>
              </form>
            ) : (
            <form className="space-y-4" onSubmit={submit}>
              <label className="block text-sm font-medium text-slate-700">
                Username
                <input
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-red-500 focus:ring-4 focus:ring-red-100"
                  style={loginInputStyle}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Password
                <span className="relative mt-2 block">
                  <input
                    className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 pr-12 text-sm text-slate-950 outline-none transition focus:border-red-500 focus:ring-4 focus:ring-red-100"
                    style={loginInputStyle}
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 transition hover:bg-red-50 hover:text-red-700"
                    onClick={() => setShowPassword((value) => !value)}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </span>
              </label>
              <div className="flex items-center justify-between gap-3 text-sm">
                <label className="flex items-center gap-2 text-slate-600">
                  <input type="checkbox" className="accent-red-600" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
                  Remember me
                </label>
                <Link href="/forgot-password" className="font-semibold text-red-700 transition hover:text-red-900">
                  Forgot Password
                </Link>
              </div>
              {message ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div> : null}
              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSubmitting}
              >
                <LogIn className="h-4 w-4" />
                {isSubmitting ? "Signing in..." : "Login"}
              </button>
            </form>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
