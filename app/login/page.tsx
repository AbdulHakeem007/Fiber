import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getSessionUser } from "@/lib/auth/session";

// Authoritative login gate. Unlike middleware (Edge, no DB access), this verifies
// the session resolves to a REAL active user before redirecting to the dashboard.
// A signature-valid-but-orphaned cookie (user no longer exists) resolves to null
// here, so the login form is shown instead of bouncing back to /dashboard — which
// is what previously created the /login <-> /dashboard redirect loop. The stale
// cookie is harmlessly overwritten on the next successful login.
export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) {
    redirect(user.forcePasswordChange ? "/change-password" : "/dashboard");
  }
  return <LoginForm />;
}
