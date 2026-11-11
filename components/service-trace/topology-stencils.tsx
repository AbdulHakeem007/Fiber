"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Shared SVG stencil primitives for every Service Trace canvas (the per-group
// ring / linear views AND the unified multi-topology canvas). Centralizing these
// here keeps a single source of truth for stencil geometry, the label renderer,
// and — most importantly — the PE / ATN / Jumper SELECTION RULE, so a future
// stencil change is made in exactly one place.
// ─────────────────────────────────────────────────────────────────────────────

export type RingRole = "pe" | "atn" | "jumper" | "site";

export interface Point {
  x: number;
  y: number;
}

export type TopologyRenderNode = { raw: string; clean: string; isCore: boolean; isJumper: boolean };

export const JUMPER_LABEL_RE = /\s*\(\s*jumper\s*\)/i;

// ─────────────────────────────────────────────────────────────────────────────
// SITE-STENCIL DIRECTORY (secondary "service trace search" node paths only).
//
// The site stencil used by the non-A-MPLS service-trace-search renderers
// (indirect trail chains / transport-trail previews) is loaded from a dedicated
// folder: public/network-stencils/site. This is exposed by Next.js at the
// root-relative URL "/network-stencils/site", which is what MUST be referenced —
// NOT an absolute OS path like C:\Users\...\public\network-stencils\site.
//
// PORTABILITY: a root-relative "/network-stencils/site/..." URL is resolved by
// the browser against whatever origin currently serves the app, so it keeps
// mapping correctly after the project is moved to a new device OR a new path on
// the same device (the physical folder simply travels inside public/). An
// absolute filesystem path could not be used as an <image href> at all (browsers
// block file:// from an http(s) origin) and would break on every move. When the
// stencils are relocated OUTSIDE the app bundle after a move (e.g. served from a
// CDN or a shared asset host), point NEXT_PUBLIC_SITE_STENCIL_DIR at the new
// base and the loader re-maps with no code change.
const SITE_STENCIL_DIR = (process.env.NEXT_PUBLIC_SITE_STENCIL_DIR || "/network-stencils/site").replace(/\/+$/, "");

/** Resolve a site-stencil asset path against the configured (portable) base dir. */
export function siteStencilHref(fileName: string): string {
  return `${SITE_STENCIL_DIR}/${fileName.replace(/^\/+/, "")}`;
}

// Dark-mode tower artwork. The default Site.svg is low-contrast on the deep-navy
// canvas, so a dedicated dark variant is hard-wired for dark mode only (callers
// pass this href when the app theme is dark). Env-overridable for portability.
export const SITE_STENCIL_DARK_HREF = process.env.NEXT_PUBLIC_SITE_STENCIL_DARK || "/network-stencils/Site_Dark.svg";

/** The light/dark site (tower) href for the current theme. */
export function siteStencilForTheme(isDark: boolean): string {
  return isDark ? SITE_STENCIL_DARK_HREF : SVG_STENCILS.site.href;
}

export const SVG_STENCILS: Record<RingRole, { href: string; w: number; h: number; text: string; label: "bottom" | "center" | "below"; weight: number }> = {
  pe: { href: "/network-stencils/PE.svg", w: 132, h: 82, text: "#ffffff", label: "bottom", weight: 800 },
  atn: { href: "/network-stencils/ATN.svg", w: 116, h: 72, text: "#000000", label: "bottom", weight: 800 },
  jumper: { href: "/network-stencils/Jumper.svg", w: 96, h: 56, text: "#ff0000", label: "bottom", weight: 800 },
  // Standard network node for non-A-MPLS views (indirect trail chains etc.):
  // pulled from public/network-stencils/site (see SITE_STENCIL_DIR above), name
  // strictly BENEATH the icon in black. Sized within the PE footprint so
  // MAX_STENCIL_* (A-MPLS canvas geometry constants) are unaffected.
  site: { href: siteStencilHref("Site.svg"), w: 116, h: 72, text: "#000000", label: "below", weight: 800 },
};

/** Widest stencil footprint — used by anti-collision spacing as the minimum slot. */
export const MAX_STENCIL_WIDTH = Math.max(...Object.values(SVG_STENCILS).map((s) => s.w));
export const MAX_STENCIL_HEIGHT = Math.max(...Object.values(SVG_STENCILS).map((s) => s.h));

export function cleanNodeLabel(node: string): string {
  return node.replace(JUMPER_LABEL_RE, "").trim();
}

export function normalizedNodeLabel(node: string): string {
  return cleanNodeLabel(node).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// CENTRALIZED STENCIL SELECTION — single source of truth for which public
// stencil (PE / ATN / Jumper) every canvas node uses.
//
// Rule order (first match wins):
//   1. JUMPER  -> jumper stencil. A passive cross-connect / intermediate
//      connection point (no local drop).
//   2. CORE    -> PE stencil. The node resolved to a Core / DC / PE boundary site.
//   3. DEFAULT -> ATN stencil. Every other access node.
// ─────────────────────────────────────────────────────────────────────────────
export function selectStencil(node: TopologyRenderNode): RingRole {
  if (node.isJumper) return "jumper"; // Rule 1: jumper / intermediate connection point
  if (node.isCore) return "pe"; //        Rule 2: Core / DC / PE boundary site
  return "atn"; //                        Rule 3: default access node (ATN)
}

/** Build a render node from a raw label using pre-normalized core / jumper sets. */
export function toRenderNode(raw: string, coreSet: Set<string>, jumperSet: Set<string>): TopologyRenderNode {
  const clean = cleanNodeLabel(raw);
  const key = normalizedNodeLabel(raw);
  return { raw, clean, isCore: coreSet.has(key), isJumper: jumperSet.has(key) || JUMPER_LABEL_RE.test(raw) };
}

export function labelFontSize(label: string, width: number, role: RingRole): number {
  const max = role === "pe" ? 14 : role === "jumper" ? 12 : 13;
  const min = role === "jumper" ? 8 : 9;
  return Math.max(min, Math.min(max, (width - 20) / Math.max(4, label.length) / 0.6));
}

export function StencilNode({
  node,
  point,
  role,
  clipId,
  busy,
  flagged,
  editable,
  draggable = false,
  labelPlacement,
  labelColor,
  href,
  width,
  height,
  onClick,
  onDoubleClick,
  onPointerDown,
}: {
  node: TopologyRenderNode;
  point: Point;
  role: RingRole;
  clipId: string;
  busy: boolean;
  flagged: boolean;
  editable: boolean;
  draggable?: boolean;
  /** Optional per-canvas override: force the site name below the icon. */
  labelPlacement?: "bottom" | "center" | "below";
  /** Optional per-canvas override for the label color (e.g. solid black). */
  labelColor?: string;
  /** Optional artwork override (e.g. the dark-mode tower). Defaults to the role stencil. */
  href?: string;
  /** Optional footprint overrides (secondary trace-search views enlarge the
   *  tower / shrink the jumper). A-MPLS callers omit these so the MAX_STENCIL_*
   *  geometry constants — and the locked canvas layout — stay untouched. */
  width?: number;
  height?: number;
  onClick: (event: React.MouseEvent<SVGGElement>) => void;
  onDoubleClick: (event: React.MouseEvent<SVGGElement>) => void;
  onPointerDown?: (event: React.PointerEvent<SVGGElement>) => void;
}) {
  const stencil = SVG_STENCILS[role];
  const w = width ?? stencil.w;
  const h = height ?? stencil.h;
  const drawHref = href ?? stencil.href;
  const x = point.x - w / 2;
  const y = point.y - h / 2;
  const placement = labelPlacement ?? stencil.label;
  const isBelow = placement === "below";
  // A below-the-icon label is not confined by the stencil artwork, so it gets a
  // wider text box and a larger, clearly readable font than in-icon labels.
  const textWidth = isBelow ? w + 56 : Math.max(32, w - 24);
  const fontSize = isBelow
    ? Math.max(13, Math.min(17, (textWidth - 8) / Math.max(4, node.clean.length) / 0.6))
    : labelFontSize(node.clean, w, role);
  const textY = isBelow ? y + h + 15 : placement === "bottom" ? y + h - 16 : point.y + 4;
  const textColor = labelColor ?? stencil.text;
  const estimatedWidth = node.clean.length * fontSize * 0.62;
  const textFit = estimatedWidth > textWidth
    ? { textLength: textWidth, lengthAdjust: "spacingAndGlyphs" as const }
    : {};

  return (
    <g
      style={{ cursor: draggable ? "grab" : editable ? "pointer" : "default" }}
      opacity={busy ? 0.5 : 1}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      aria-label={node.clean}
    >
      <title>
        {flagged ? `Ready for Integration: ${node.clean}` : role === "pe" ? `PE / Core / DC: ${node.clean}` : role === "jumper" ? `Jumper: ${node.clean}` : `ATN: ${node.clean}`}
      </title>
      <defs>
        <clipPath id={clipId}>
          <rect x={point.x - textWidth / 2} y={textY - fontSize / 2 - 3} width={textWidth} height={fontSize + 7} />
        </clipPath>
      </defs>
      <rect x={x + 3} y={y + 5} width={w} height={h} rx={14} fill="transparent" />
      {flagged ? <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={14} fill="#FF0000" /> : null}
      <image
        href={drawHref}
        x={x}
        y={y}
        width={w}
        height={h}
        preserveAspectRatio="xMidYMid meet"
        opacity={1}
      />
      <text
        x={point.x}
        y={textY}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight={stencil.weight}
        fill={flagged ? "#0d0303" : textColor}
        clipPath={`url(#${clipId})`}
        {...textFit}
      >
        {node.clean}
      </text>
      {flagged ? (
        <text x={point.x} y={y + h + 14} textAnchor="middle" fontSize={10} fontWeight={800} fill="#FF0000">
          Ready for Integration
        </text>
      ) : null}
    </g>
  );
}
