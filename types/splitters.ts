export interface SplitterOutputRow {
  id: string;
  outputLabel?: string | null;
  outputPort?: string | null;
  localSiteCode?: string | null;
  localRackCode?: string | null;
  localOdfCode?: string | null;
  localPortLabel?: string | null;
  destinationSiteCode?: string | null;
  destinationLabel?: string | null;
  destinationRackCode?: string | null;
  destinationOdfCode?: string | null;
  destinationPortLabel?: string | null;
  serviceCode?: string | null;
  sharingCustomerServiceId?: string | null;
  sharingCustomerServiceCode?: string | null;
  capacityFibers: number;
  usedFibers: number;
  availableFibers: number;
  status: string;
  remarks?: string | null;
}

export interface SplitterInventoryRow {
  id: string;
  splitterCode: string;
  splitterName?: string | null;
  splitterType?: "OSP_SPL" | "ISP_SPL" | string | null;
  scope: string;
  sourceSite?: string | null;
  location?: string | null;
  locationContext?: string | null;
  protectionMode: string;
  primaryInputSiteCode?: string | null;
  primaryInputRackCode?: string | null;
  primaryInputOdfCode?: string | null;
  primaryInputPortLabel?: string | null;
  secondaryInputSiteCode?: string | null;
  secondaryInputRackCode?: string | null;
  secondaryInputOdfCode?: string | null;
  secondaryInputPortLabel?: string | null;
  outputPortCapacity?: number | null;
  configuredOutputPorts?: number | null;
  totalHardwareCapacity?: number | null;
  utilizationPct?: number | null;
  status: string;
  outputCount: number;
  usedFibers: number;
  availableFibers: number;
  source: string;
  remarks?: string | null;
  outputs: SplitterOutputRow[];
}

export interface SplitterListFilters {
  search?: string;
  splitterType?: string;
  status?: string;
  site?: string;
}

export interface SplitterListPage {
  rows: SplitterInventoryRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SplitterSummary {
  totalSplitters: number;
  ospSplitters: number;
  ispSplitters: number;
  totalOutputs: number;
  configuredPorts: number;
  availablePorts: number;
}
