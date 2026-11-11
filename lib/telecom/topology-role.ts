// EDIT HERE: Service Trace topology roles for ring/subring/spur separation.
// This is intentionally not "Protection Type". Protection/work/protection path logic is separate.
// "INTRA_SITE" and "GPON_SEGMENT" are additive segment-level tags (labels
// "Intra-site" / "GPON segment"). They are intentionally NOT consumed by the
// ring/spur trace classifier or any routing/tracing math — they only mark a
// segment so the dashboard statistics can include/exclude it (Intra-site feeds
// the Core & DC Intra-Site ODF Saturation panel; GPON segment lets the Top
// Utilized Links view drop one-to-many splitter feeds). Adding them here is
// purely additive: no existing role's behaviour changes.
export type TopologyRole = "MAIN_RING" | "SINGLE_HOMED" | "SUBRING" | "SPUR" | "SPUR_CHAIN" | "INTERCONNECT" | "INTRA_SITE" | "GPON_SEGMENT" | "B2B_SEGMENT" | "REVIEW";
export type StoredTopologyRole = Exclude<TopologyRole, "MAIN_RING">;
export type TopologyRoleSource = "DEFAULT_MAIN_RING" | "SEGMENT_DEFAULT" | "CHILD_OVERRIDE" | "AUTO_REVIEW";
export type SegmentType = "BACKBONE" | "DEFAULT" | "INTERCONNECT" | "INTRA_SITE" | "GPON_SEGMENT" | "B2B_SEGMENT";

export const STORED_TOPOLOGY_ROLES: StoredTopologyRole[] = [
  "SINGLE_HOMED",
  "SUBRING",
  "SPUR",
  "SPUR_CHAIN",
  "INTERCONNECT",
  "INTRA_SITE",
  "GPON_SEGMENT",
  "B2B_SEGMENT",
  "REVIEW",
];

export const SEGMENT_TYPES: SegmentType[] = ["BACKBONE", "DEFAULT", "INTERCONNECT", "INTRA_SITE", "GPON_SEGMENT", "B2B_SEGMENT"];

// Backward-compatible export name for callers that still persist the parent
// segment classification in LinkSegment.segmentDefaultRole. Parent segment
// classification is now "Segment Type", not a topology role.
export const SEGMENT_DEFAULT_TOPOLOGY_ROLES: SegmentType[] = SEGMENT_TYPES;

// Dashboard-only, parent-segment-level tags that must never disturb core
// routing/tracing or appear as a child fiber/service classification. B2B_SEGMENT
// is a sibling of GPON_SEGMENT: parent-only, ignored by the trace/topology engine,
// and (like GPON) hidden from the Site Connectivity Canvas by default.
export const STANDALONE_DASHBOARD_ROLES: StoredTopologyRole[] = ["INTRA_SITE", "GPON_SEGMENT", "B2B_SEGMENT"];

// Intra-site / GPON segment are parent-segment-only classifications: they have no
// meaning on an individual child fiber/service row, so the child topology-role
// pickers exclude them. Keeping them out of the child set also keeps the
// service-trace classifier, which only ever reads child-level roles, untouched.
export const CHILD_TOPOLOGY_ROLES: StoredTopologyRole[] = STORED_TOPOLOGY_ROLES.filter(
  (role) => !(STANDALONE_DASHBOARD_ROLES as readonly string[]).includes(role),
);

/** True when a segment's role is a standalone, dashboard-only tag (Intra-site /
 *  GPON segment) that must be excluded from the inter-site "Top Utilized Links"
 *  metric. Splitter feeds carry the GPON-segment tag because their one-to-many
 *  topology sits at critical utilization and skews the site-pair view. */
export function isStandaloneDashboardRole(value?: string | null): boolean {
  const normalized = normalizeTopologyRole(value);
  return Boolean(normalized && (STANDALONE_DASHBOARD_ROLES as readonly string[]).includes(normalized));
}

// Segment roles hidden from the Site Connectivity Canvas by default — GPON and B2B
// access segments that clutter the transport topology view. A "Show all link types"
// toggle on the canvas reveals them. Deliberately a separate set from
// STANDALONE_DASHBOARD_ROLES so canvas visibility stays decoupled from the
// Top-Links / trace logic (e.g. INTRA_SITE is NOT hidden from the canvas).
export const CANVAS_HIDDEN_SEGMENT_ROLES: StoredTopologyRole[] = ["GPON_SEGMENT", "B2B_SEGMENT"];

export function isCanvasHiddenSegmentRole(value?: string | null): boolean {
  const normalized = normalizeTopologyRole(value);
  return Boolean(normalized && (CANVAS_HIDDEN_SEGMENT_ROLES as readonly string[]).includes(normalized));
}

export function normalizeTopologyRole(value?: string | null): StoredTopologyRole | null {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized || normalized === "MAIN_RING" || normalized === "NORMAL") return null;
  return (STORED_TOPOLOGY_ROLES as readonly string[]).includes(normalized)
    ? (normalized as StoredTopologyRole)
    : null;
}

export function normalizeSegmentType(value?: string | null): SegmentType | null {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized || normalized === "MAIN_RING" || normalized === "DEFAULT_MAIN_RING" || normalized === "NORMAL") return "DEFAULT";
  return (SEGMENT_TYPES as readonly string[]).includes(normalized)
    ? (normalized as SegmentType)
    : null;
}

export function normalizeSegmentDefaultTopologyRole(value?: string | null): SegmentType | null {
  return normalizeSegmentType(value);
}

export function effectiveTopologyRole(input: {
  childTopologyRole?: string | null;
  segmentDefaultRole?: string | null;
}): { role: TopologyRole; source: TopologyRoleSource } {
  // GUARDRAIL: Intra-site / GPON-segment are standalone DASHBOARD tags. They are
  // deliberately invisible to the routing/tracing engine — a segment carrying one
  // of them routes exactly like an untagged (MAIN_RING) segment, so it is never
  // dropped from a trace nor mis-grouped in the topology metrics. The tag itself
  // is still persisted on segmentDefaultRole and read directly by the dashboard.
  const child = normalizeTopologyRole(input.childTopologyRole);
  if (child && !isStandaloneDashboardRole(child)) return { role: child, source: "CHILD_OVERRIDE" };

  const segment = normalizeSegmentDefaultTopologyRole(input.segmentDefaultRole);
  if (segment && normalizeTopologyRole(segment) && !isStandaloneDashboardRole(segment)) return { role: normalizeTopologyRole(segment)!, source: "SEGMENT_DEFAULT" };

  return { role: "MAIN_RING", source: "DEFAULT_MAIN_RING" };
}

export function segmentTypeLabel(type?: string | null): string {
  switch (normalizeSegmentType(type)) {
    case "BACKBONE": return "Backbone";
    case "DEFAULT": return "Default";
    case "INTERCONNECT": return "Interconnect";
    case "INTRA_SITE": return "Intra-site";
    case "GPON_SEGMENT": return "GPON segment";
    case "B2B_SEGMENT": return "B2B segment";
    default: return "Default";
  }
}

export function topologyRoleLabel(role?: string | null): string {
  const normalized = role === "MAIN_RING" ? "MAIN_RING" : normalizeTopologyRole(role);
  switch (normalized) {
    case "SINGLE_HOMED": return "Single-homed ring";
    case "SUBRING": return "Subring";
    case "SPUR": return "Spur";
    case "SPUR_CHAIN": return "Spur chain";
    case "INTERCONNECT": return "Interconnect";
    case "INTRA_SITE": return "Intra-site";
    case "GPON_SEGMENT": return "GPON segment";
    case "B2B_SEGMENT": return "B2B segment";
    case "REVIEW": return "Review";
    default: return "Main ring";
  }
}

export function topologyRoleSourceLabel(source?: string | null): string {
  switch (source) {
    case "CHILD_OVERRIDE": return "Overridden at child/service row";
    case "SEGMENT_DEFAULT": return "Inherited from segment";
    case "AUTO_REVIEW": return "Auto review warning";
    default: return "Default MAIN_RING";
  }
}
