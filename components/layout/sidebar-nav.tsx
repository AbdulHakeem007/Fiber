"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Database,
  FileBarChart,
  Gauge,
  GitBranch,
  Grid3X3,
  MapPinned,
  Paperclip,
  Radar,
  Route,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

/* Icon components must stay inside this client module: server components can
   only pass plain serializable data (strings) across the client boundary. */
const ICONS = {
  gauge: Gauge,
  database: Database,
  "map-pinned": MapPinned,
  grid: Grid3X3,
  "git-branch": GitBranch,
  route: Route,
  radar: Radar,
  upload: Upload,
  bell: Bell,
  "file-bar-chart": FileBarChart,
  paperclip: Paperclip,
  users: Users,
} satisfies Record<string, LucideIcon>;

export type NavIconName = keyof typeof ICONS;

/* Refined corporate palette: every nav item rests in a uniform slate/zinc tone
   so the rail reads as a cohesive infrastructure terminal rather than a vibrant
   colour map. The indigo active/hover accent is applied in CSS (.nav-item-*),
   not per item. Values are raw RGB triples consumed via rgb() in globals.css.
   The keys are kept so existing NavItem `tone` values stay type-valid. */
const SLATE = "148 163 184"; // slate-400
const TONES = {
  sky: SLATE,
  violet: SLATE,
  emerald: SLATE,
  amber: SLATE,
  rose: SLATE,
  teal: SLATE,
  red: SLATE,
  indigo: SLATE,
  orange: SLATE,
  lime: SLATE,
  purple: SLATE,
} satisfies Record<string, string>;

export type NavTone = keyof typeof TONES;

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
  tone: NavTone;
};

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="mt-6 space-y-1" aria-label="Primary">
      {items.map(({ href, label, icon, tone }) => {
        const Icon = ICONS[icon] ?? Database;
        const isActive = pathname === href || pathname.startsWith(`${href}/`);
        const rgb = TONES[tone] ?? TONES.sky;
        return (
          <Link
            key={href}
            href={href as any}
            aria-current={isActive ? "page" : undefined}
            className={`nav-item ${isActive ? "nav-item-active" : ""}`}
            title={label}
            style={{ ["--nav-rgb" as string]: rgb }}
          >
            <span className="nav-icon-chip" aria-hidden="true">
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="nav-label truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
