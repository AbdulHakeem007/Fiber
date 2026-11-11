import { AppShell } from "@/components/layout/app-shell";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
