"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ToastProvider } from "@/components/ui/toast";

/**
 * Pure-presentation shell: holds the contract/expand state of the primary
 * sidebar so deep mapping tables get the full viewport width on demand.
 * Server-rendered content (session, nav permissions) flows in as children,
 * so no telecom/fiber data structure is touched by this layout state.
 */
export function SidebarShell({
  sidebar,
  header,
  children,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Restore the operator's last layout choice after mount. Reading inside an
  // effect (not the initializer) keeps server and first client render in sync.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("fiber-sidebar") === "collapsed");
    } catch {
      // Storage unavailable — default to expanded.
    }
  }, []);

  function toggle() {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("fiber-sidebar", next ? "collapsed" : "expanded");
      } catch {
        // Storage unavailable — state still toggles for this session.
      }
      return next;
    });
  }

  return (
    <ToastProvider>
    <div className={`min-h-screen ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="glass-chrome app-sidebar fixed inset-y-0 left-0 z-40 hidden p-4 lg:flex lg:flex-col">
        {sidebar}
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar for a wider workspace"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /> : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}
          <span className="sidebar-label">Collapse</span>
        </button>
      </aside>

      <div className="app-content-shell">
        <header className="glass-chrome app-topbar sticky top-0 z-30 px-4 py-3 xl:px-6">
          {header}
        </header>
        <main className="w-full max-w-none space-y-6 p-4 xl:p-6 2xl:p-8">
          {children}
        </main>
      </div>
    </div>
    </ToastProvider>
  );
}
