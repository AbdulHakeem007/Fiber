export interface SiteConnectivityNode {
  siteCode: string;
  siteName?: string | null;
  siteType?: string | null;
  isCoreSite: boolean;
  coreSiteType?: string | null;
  segmentCount: number;
  serviceCount: number;
  utilizationPct?: number | null;
  distanceKm?: number | null;
  status: "Critical" | "High" | "Moderate" | "Low" | "No Data";
  hasParallelLinks: boolean;
  rackSummary?: string | null;
  odfSummary?: string | null;
  portSummary?: string | null;
  cableSummary?: string | null;
  /** True when every segment connecting to this site is a GPON / B2B access
   *  segment. Retained for backward-compatible callers; the canvas now uses the
   *  per-type filter (linkTypes) instead of a blanket hide. */
  hiddenByDefault: boolean;
  /** Distinct link/segment types this site connects through — one of
   *  "default" (general-purpose transport), "Backbone", "GPON", or "B2B".
   *  Drives the canvas link-type filter. */
  linkTypes: string[];
}

export interface SiteConnectivityRow {
  segmentId: string;
  segmentCode: string;
  searchedSite: string;
  connectedSite: string;
  directSegmentCount: number;
  rackId?: string | null;
  odfId?: string | null;
  portPair?: string | null;
  farRackId?: string | null;
  farOdfId?: string | null;
  farPortPair?: string | null;
  cableId?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  fiberPortNumber?: number | null;
  fiberNumber?: number | null;
  fiberLabel?: string | null;
  distanceKm?: number | null;
  utilizationPct?: number | null;
  serviceIds?: string | null;
  serviceCount: number;
  status: string;
}

export interface SiteConnectivitySummary {
  site: {
    code: string;
    name?: string | null;
    region?: string | null;
    city?: string | null;
    siteType?: string | null;
    status: string;
    isCoreSite: boolean;
    coreSiteType?: string | null;
  };
  directConnectedSiteCount: number;
  directPhysicalSegmentCount: number;
  nodes: SiteConnectivityNode[];
  rows: SiteConnectivityRow[];
}
