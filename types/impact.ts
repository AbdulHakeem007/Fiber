import type { InventoryFilters } from "@/lib/filters/inventory-filters";

export interface ImpactResource {
  siteCode?: string | null;
  rackCode?: string | null;
  odfCode?: string | null;
  portGroup?: string | null;
  fiberPortNumber?: number | null;
  cableLabel?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  fiberNumber?: number | null;
  status?: string | null;
}

export interface ImpactService {
  serviceCode: string;
  serviceName?: string | null;
  routeType?: string | null;
  fullPathLabel?: string | null;
  isProtectionPath?: boolean;
}

export interface ImpactSite {
  siteCode: string;
  siteType?: string | null;
  coreSiteType?: string | null;
  isCoreSite: boolean;
}

export interface ImpactLink {
  segmentId: string;
  segmentCode: string;
  serviceIds?: string | null;
  nearSite: string;
  nearRack?: string | null;
  nearOdf?: string | null;
  nearPortGroup?: string | null;
  farSite?: string | null;
  farRack?: string | null;
  farOdf?: string | null;
  farPortGroup?: string | null;
  cableLabel?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  fiberPortNumber?: number | null;
  fiberNumber?: number | null;
  status: string;
}


export interface ImpactServiceLinkRow {
  section: "Direct" | "Indirect";
  serviceId: string;
  segmentCode: string;
  nearSite?: string | null;
  nearRack?: string | null;
  nearOdf?: string | null;
  nearPort?: string | null;
  farSite?: string | null;
  farRack?: string | null;
  farOdf?: string | null;
  farPort?: string | null;
  status?: string | null;
}



export interface ImpactBoundaryEndpoint {
  siteId: string;
  rackId: string;
  odfId: string;
}

export interface ImpactBoundaryFootprint {
  start: ImpactBoundaryEndpoint;
  end: ImpactBoundaryEndpoint;
}

export interface IndirectImpactPath {
  serviceId: string;
  fullPathLabel?: string | null;
  totalDistanceKm: number;
  reason: string;
  boundary: ImpactBoundaryFootprint;
  segments: Array<{
    segmentId?: string | null;
    segmentCode?: string | null;
    fromSite?: string | null;
    toSite?: string | null;
    distanceKm?: number | null;
  }>;
}

export interface CutoverImpactSummary {
  filters: InventoryFilters;
  selectedResources: ImpactResource[];
  counts: {
    impactedServices: number;
    impactedLinks: number;
    impactedSites: number;
    coreSites: number;
  };
  directLinks: ImpactLink[];
  activeServiceLinks: ImpactServiceLinkRow[];
  indirectPaths: IndirectImpactPath[];
  boundaryFootprint?: ImpactBoundaryFootprint | null;
  riskFactors: Array<{
    segmentId: string;
    segmentCode: string;
    riskType: "SAME_SITE" | "SAME_RACK" | "SAME_ODF" | "SAME_CABLE" | "BOUNDARY_MATCH";
    siteCode?: string | null;
    rackCode?: string | null;
    odfCode?: string | null;
    reason: string;
    status: string;
  }>;
  /** Total indirect rows detected; riskFactors is a bounded preview of these. */
  riskFactorTotal?: number;
  impactedServices: ImpactService[];
  impactedSites: ImpactSite[];
  criticalCoreSites: ImpactSite[];
  facing: "NO_LIVE_IMPACT" | "ACCESS_FACING" | "CUSTOMER_FACING" | "AGGREGATION_FACING" | "CORE_BACKBONE_FACING";
  impactScope: "NONE" | "LIMITED" | "MULTI_SERVICE" | "WIDESPREAD" | "CORE_CRITICAL";
  notes: string[];
  exportRows: Record<string, unknown>[];
}
