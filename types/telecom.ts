export type TopologyRole = "MAIN_RING" | "SINGLE_HOMED" | "SUBRING" | "SPUR" | "SPUR_CHAIN" | "INTERCONNECT" | "REVIEW";
export type StoredTopologyRole = Exclude<TopologyRole, "MAIN_RING">;
export type TopologyRoleSource = "DEFAULT_MAIN_RING" | "SEGMENT_DEFAULT" | "CHILD_OVERRIDE" | "AUTO_REVIEW";
export type SegmentType = "BACKBONE" | "DEFAULT" | "INTERCONNECT" | "INTRA_SITE" | "GPON_SEGMENT" | "B2B_SEGMENT";

export type SegmentStatus = "ACTIVE" | "AVAILABLE" | "USED" | "SPARE" | "RESERVED" | "FAULTY" | "DUMMY" | "PLANNED" | "INACTIVE" | "UNKNOWN" | "DECOMMISSIONED" | "REHOMED";

export interface InventorySegmentRow {
  segmentId: string;
  segmentCode: string;
  segmentGroupName?: string | null;
  segmentSequence?: string | null;
  segmentCapacityFibers?: number | null;
  segmentDefaultRole?: SegmentType | StoredTopologyRole | string | null;

  /** Combined service IDs found in child fiber links. Segment itself is not a service. */
  serviceIds?: string | null;

  nearSite: string;
  nearSiteCode?: string | null;
  nearSiteType?: string | null;
  nearCoreSiteType?: string | null;
  nearRack?: string | null;
  nearOdf?: string | null;

  /** Segment-level ODF port range, e.g. 1-24. Not an individual service port pair. */
  nearPortGroup?: string | null;
  nearPortRangeStart?: number | null;
  nearPortRangeEnd?: number | null;

  farSite?: string | null;
  farSiteCode?: string | null;
  farSiteType?: string | null;
  farCoreSiteType?: string | null;
  farRack?: string | null;
  farOdf?: string | null;

  /** Segment-level ODF port range, e.g. 25-48. Not an individual service port pair. */
  farPortGroup?: string | null;
  farPortRangeStart?: number | null;
  farPortRangeEnd?: number | null;

  cableLabel?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  tubeLabel?: string | null;
  fiberPortNumber?: number | null;
  fiberNumber?: number | null;
  fiberLabel?: string | null;

  /** Existing names kept for backward compatibility with UI. */
  totalFibers?: number | null;
  usedFibers?: number | null;
  reservedFibers?: number | null;
  faultyFibers?: number | null;
  blockedFibers?: number | null;
  dummyFibers?: number | null;
  rehomedFibers?: number | null;
  availableFibers?: number | null;

  /** Preferred wording for UI: ODF port capacity/count at segment/ODF level. */
  totalOdfPorts?: number | null;
  usedOdfPorts?: number | null;
  reservedOdfPorts?: number | null;
  faultyOdfPorts?: number | null;
  blockedOdfPorts?: number | null;
  dummyOdfPorts?: number | null;
  rehomedOdfPorts?: number | null;
  availableOdfPorts?: number | null;

  utilizationPct?: number | null;
  distanceKm?: number | null;
  status: SegmentStatus;
  updatedAt?: string | null;
  createdAt?: string | null;

  /** Child rows: individual fiber links / port pairs. No nested segment table should be rendered from these. */
  mappings?: InventoryMappingRow[];
  childLinkCount?: number | null;
}

export interface InventoryMappingRow {
  id: string;
  fiberId?: string | null;
  fiberNumber?: number | null;
  serviceId?: string | null;
  tag?: string | null;
  childTopologyRole?: StoredTopologyRole | string | null;
  effectiveTopologyRole?: TopologyRole | string | null;
  topologyRoleSource?: TopologyRoleSource | string | null;
  localSite?: string | null;
  localRack?: string | null;
  localOdf?: string | null;
  localPort?: string | null;
  farSite?: string | null;
  farSiteCode?: string | null;
  farEndpoint?: string | null;
  farRack?: string | null;
  farOdf?: string | null;
  farPort?: string | null;
  cableId?: string | null;
  fiberNumbers?: string | null;
  fiberCount?: number | null;
  status: SegmentStatus;
  remarks?: string | null;
}

export interface DirectConnectionNode {
  siteCode: string;
  distanceKm?: number | null;
  segmentCount: number;
  isCoreSite?: boolean;
  coreSiteType?: string | null;
}

export interface ServiceEndpointView {
  siteCode?: string | null;
  rackCode?: string | null;
  odfCode?: string | null;
  portGroupLabel?: string | null;
  segmentCode?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  tubeLabel?: string | null;
  fiberPortNumber?: number | null;
  fiberNumber?: number | null;
  fiberNumbers?: number[];
  fiberRangeLabel?: string | null;
  fiberLabel?: string | null;
  totalFibers?: number | null;
  usedFibers?: number | null;
  reservedFibers?: number | null;
  faultyFibers?: number | null;
  availableFibers?: number | null;
  utilizationPct?: number | null;
  distanceKm?: number | null;
}

export interface ServiceTraceLinkView {
  id: string;
  serviceId?: string | null;
  segmentId?: string | null;
  segmentCode?: string | null;
  local?: ServiceEndpointView | null;
  far?: ServiceEndpointView | null;
  localSite?: string | null;
  farSite?: string | null;
  localPort?: string | null;
  farPort?: string | null;
  fiberNumbers?: string | null;
  status?: SegmentStatus | string | null;
  remarks?: string | null;
  topologyRole?: TopologyRole | string | null;
  topologyRoleSource?: TopologyRoleSource | string | null;
  childTopologyRole?: StoredTopologyRole | string | null;
  segmentDefaultRole?: SegmentType | StoredTopologyRole | string | null;
  tag?: string | null;
}

export interface ServiceTraceTopologyGroup {
  topologyRole: TopologyRole | string;
  topologyLabel: string;
  fullPathLabel: string;
  totalDistanceKm: number;
  nodes: string[];
  segments: Array<{
    segmentId?: string | null;
    segmentCode?: string | null;
    fromSite?: string | null;
    toSite?: string | null;
    distanceKm?: number | null;
  }>;
  links: ServiceTraceLinkView[];
  /** Detected shape of this group: RING / PATH / COMPLEX / SINGLE. */
  shape?: "SINGLE" | "PATH" | "RING" | "COMPLEX" | string;
  /** True when the chain closes back on itself (a real ring). */
  isClosedRing?: boolean;
  /** When closed, the site the ring returns to. */
  ringClosesAt?: string | null;
  /** Sites where degree >= 3 (subring / spur attachment points). */
  junctions?: string[];
  /** Node labels in this group that are ring-boundary sites — Core/DC or Provider
   *  Edge (PE). Drawn at the top of the ring layout and highlighted. */
  coreNodes?: string[];
  /** Subset of nodes tagged as Provider Edge (PE) sites — these aggregate A-MPLS
   *  rings and may be standalone or inside a Core/DC; rendered in a distinct tone. */
  peNodes?: string[];
  /** True when this group should render as a circular ring instead of a line:
   *  an actual closed-ring cycle, or an A-MPLS path between two core/DC sites
   *  (the existing "two core endpoints" case — Rule C). */
  renderAsRing?: boolean;
  /** True when this group is an A-MPLS chain that is NOT a full two-core ring but
   *  should still render on the SVG canvas as a STRAIGHT LINEAR chain (with PE/
   *  ATN/jumper stencils) instead of falling back to the plain text chain.
   *  Covers the degraded A-MPLS cases: zero core endpoints (Case A) or exactly
   *  one core/DC/PE endpoint (Case B). Mutually exclusive with renderAsRing. */
  renderAsLinearChain?: boolean;
  /** Passive jumper sites (straight cross-connect, no local drop). */
  jumpers?: string[];
  /** Branch links not on the main walk, shown separately. */
  branches?: Array<{ fromSite: string; toSite: string; segmentCode?: string | null; distanceKm?: number | null }>;
}

export interface ServiceTraceHopView {
  siteCode?: string | null;
  siteLabel?: string | null;
  isJumper?: boolean;
  incoming?: ServiceEndpointView | null;
  outgoing?: ServiceEndpointView | null;
  segmentCode?: string | null;
  pathLabel?: string | null;
  distanceKm?: number | null;
}

export interface RouteHop {
  siteId: string;
  siteName: string;
  availablePortsCount: number;
  segmentDistance: number;
  isJumper: boolean;
}

export interface IndirectRouteSummary {
  path: RouteHop[];
  totalJumpersInvolved: number;
  cumulativeDistance: number;
}

export interface SplitterTraceFeed {
  siteCode?: string | null;
  rackCode?: string | null;
  odfCode?: string | null;
  portLabel?: string | null;
}

export interface SplitterTraceGroup {
  /** MAIN_TRUNK renders as Group 1; each SPUR renders in its own dashboard panel. */
  role: "MAIN_TRUNK" | "SPUR" | string;
  label: string;
  pathLabel: string;
  outputPort?: string | null;
  serviceCode?: string | null;
  sharingCustomerServiceId?: string | null;
  destinationSite?: string | null;
  destinationLabel?: string | null;
  localRackCode?: string | null;
  localOdfCode?: string | null;
  localPortLabel?: string | null;
  status?: string | null;
}

export interface SplitterTraceFork {
  splitterId: string;
  splitterCode: string;
  splitterType: string;
  locationContext?: string | null;
  protectionMode?: string | null;
  feederSite?: string | null;
  inputFeed: SplitterTraceFeed;
  protectionFeed?: SplitterTraceFeed | null;
  groups: SplitterTraceGroup[];
}

export interface ServiceTraceResult {
  serviceCode: string;
  serviceName: string;
  routeType: string;
  /** The Service record's type (e.g. "A-MPLS", "MPLS Core", "Backbone") — drives
   *  per-type chain iconography (MPLS-core chains draw PE artwork). */
  serviceType?: string | null;
  fullPathLabel: string;
  totalDistanceKm: number;
  hops: ServiceTraceHopView[];
  serviceLinks?: ServiceTraceLinkView[];
  mainRingPath?: ServiceTraceTopologyGroup | null;
  /** When a service is SINGLE_HOMED and MAIN_RING is the primary, shows the single-homed attachment groups. */
  attachedSingleHomed?: ServiceTraceTopologyGroup[];
  attachedSubrings?: ServiceTraceTopologyGroup[];
  attachedSpurs?: ServiceTraceTopologyGroup[];
  attachedSpurChains?: ServiceTraceTopologyGroup[];
  attachedInterconnects?: ServiceTraceTopologyGroup[];
  reviewItems?: ServiceTraceTopologyGroup[];
  suppressReviewDashboard?: boolean;
  topologyWarnings?: string[];
  /**
   * Context A — single Service ID query. Each entry routes the trace linearly
   * through the one allocated splitter output port (other ports are ignored):
   * Site A -> Splitter Node -> Customer Site.
   */
  splitterPath?: SplitterTraceFork[];
}
