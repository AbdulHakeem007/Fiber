export const PAGE_SIZE_OPTIONS = [50, 100, 200, 500, 1000] as const;

export const CORE_SITE_TYPES = ["DWDM", "PE", "Data Center", "Aggregation", "Backbone"] as const;

export const SITE_STATUS_OPTIONS = ["ACTIVE", "PLANNED", "INACTIVE", "DECOMMISSIONED"] as const;

export const ODF_STATUS_OPTIONS = ["ACTIVE", "PLANNED", "INACTIVE", "DECOMMISSIONED"] as const;

export const RESOURCE_STATUS_OPTIONS = [
  "ACTIVE",
  "AVAILABLE",
  "RESERVED",
  "MAINTENANCE",
  "INACTIVE",
  "FAULTY",
  "DUMMY",
  "DECOMMISSIONED",
  "REHOMED",
] as const;

export const BULK_OPERATIONAL_STATUSES = ["ACTIVE", "MAINTENANCE", "INACTIVE", "RESERVED"] as const;

// Hardcoded option lists for the Site master form. Constraining these fields to a
// fixed menu prevents irregular free-text entries in the site database.
export const SITE_TYPE_OPTIONS = ["Indoor", "Outdoor"] as const;

export const SITE_CRITICALITY_OPTIONS = [
  "DWDM",
  "PE",
  "DC",
  "Core",
  "C-BI",
  "A-MPLS",
  "B2B",
  "Equinix",
  "MW Hub",
  "DWDM & PE",
] as const;

export const TOWER_STRUCTURE_OPTIONS = ["GF", "Building"] as const;

export const COLOCATION_TYPE_OPTIONS = ["Not shared", "Host", "Guest"] as const;
