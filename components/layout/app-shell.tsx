import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { LogOut, Network, ShieldCheck } from "lucide-react";
import { TopbarControls } from "@/components/layout/topbar-controls";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { SidebarNav, type NavItem } from "@/components/layout/sidebar-nav";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { hasPermission } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";

// Icons are referenced by serializable name; SidebarNav (client) resolves them.
// Each item owns a distinct tone so the rail is a colour-coded portal map.
const items: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "gauge", tone: "sky" },
  { href: "/inventory", label: "ODF Mappings", icon: "database", tone: "violet" },
  { href: "/sites", label: "Sites Database", icon: "map-pinned", tone: "emerald" },
  { href: "/odf-racks", label: "ODF and Racks Inventory", icon: "grid", tone: "amber" },
  { href: "/splitters", label: "Splitters Inventory", icon: "git-branch", tone: "rose" },
  { href: "/service-trace", label: "Trace and Provision", icon: "route", tone: "teal" },
  { href: "/impact", label: "Impact Analysis", icon: "radar", tone: "red" },
  { href: "/import-center", label: "Import / Export Center", icon: "upload", tone: "indigo" },
  { href: "/alerts", label: "Alerts", icon: "bell", tone: "orange" },
  { href: "/reports", label: "Reports", icon: "file-bar-chart", tone: "lime" },
  { href: "/admin", label: "Admin", icon: "users", tone: "purple" },
];

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.forcePasswordChange) redirect("/change-password");
  const visibleItems = items.filter((item) => item.href !== "/admin" || hasPermission(user.roleCode, "adminManage"));

  const sidebar = (
    <>
      <Link href="/dashboard" className="flex items-center gap-3 rounded-xl px-2 py-3">
        <div className="flex h-18 w-18 flex-none items-center justify-center -ml-8"> 
          <Image
            src="/brand/optical-fiber.png"
            alt="Fiber Inventory logo"
            width={65}
            height={65}
            className="h-full w-full object-contain p-1.5"
            priority
          />
        </div>
        <div className="sidebar-label min-w-0">
          <div className="truncate text-base font-semibold leading-tight tracking-tight" style={{ color: "var(--text-strong)" }}>
            Fiber Inventory
          </div>
          <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--accent-text)" }}>
            Management Portal
          </div>
        </div>
      </Link>

      <div className="flex-1 overflow-y-auto pr-1">
        <SidebarNav items={visibleItems} />
      </div>

      <div className="sidebar-label mt-4 rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 flex-none" style={{ color: "var(--accent-text)" }} aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>Operational controls</div>
            <div className="mt-1 text-xs leading-5" style={{ color: "var(--muted-text)" }}>
              Imports, deletes, suppressions, SMTP, and roles are audited.
            </div>
          </div>
        </div>
      </div>
    </>
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="lg:hidden">
        <div className="text-base font-semibold" style={{ color: "var(--text-strong)" }}>Fiber Inventory Portal</div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--accent-text)" }}>Telecom operations</div>
      </div>
      <div className="min-w-0 flex-1">
        <TopbarControls />
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <div className="hidden text-right md:block">
          <div className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>{user.name}</div>
          <div className="text-xs" style={{ color: "var(--muted-text)" }}>{user.roleCode}</div>
        </div>
        <form action="/api/auth/logout" method="post">
          <button className="btn btn-ghost inline-flex h-10 w-10 !min-h-0 items-center justify-center !p-0" title="Logout" aria-label="Logout">
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <SidebarShell sidebar={sidebar} header={header}>
      {children}
    </SidebarShell>
  );
}
