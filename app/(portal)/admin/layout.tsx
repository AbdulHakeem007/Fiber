import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!hasPermission(user?.roleCode, "adminManage")) {
    redirect("/dashboard");
  }

  return children;
}
