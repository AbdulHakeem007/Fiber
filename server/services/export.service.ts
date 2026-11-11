import { inventoryService } from "@/server/services/inventory.service";
import { matchesInventoryFilters, type InventoryFilters } from "@/lib/filters/inventory-filters";
import type { InventorySegmentRow } from "@/types/telecom";

function toInventoryExportRow(row: InventorySegmentRow) {
  return {
    segmentCode: row.segmentCode,
    segmentGroupName: row.segmentGroupName,
    segmentSequence: row.segmentSequence,
    segmentCapacityFibers: row.segmentCapacityFibers,
    serviceIds: row.serviceIds,
    nearSite: row.nearSite,
    nearSiteType: row.nearSiteType,
    nearCoreSiteType: row.nearCoreSiteType,
    nearRack: row.nearRack,
    nearOdf: row.nearOdf,
    nearPortGroup: row.nearPortGroup,
    farSite: row.farSite,
    farSiteType: row.farSiteType,
    farCoreSiteType: row.farCoreSiteType,
    farRack: row.farRack,
    farOdf: row.farOdf,
    farPortGroup: row.farPortGroup,
    cableLabel: row.cableLabel,
    tubeNumber: row.tubeNumber,
    tubeColor: row.tubeColor,
    tubeLabel: row.tubeLabel,
    fiberPortNumber: row.fiberPortNumber,
    fiberNumber: row.fiberNumber,
    fiberLabel: row.fiberLabel,
    totalFibers: row.totalFibers,
    usedFibers: row.usedFibers,
    reservedFibers: row.reservedFibers,
    faultyFibers: row.faultyFibers,
    availableFibers: row.availableFibers,
    utilizationPct: row.utilizationPct,
    distanceKm: row.distanceKm,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const exportService = {
  async buildInventoryExportRows(contextSiteCode?: string, filters: InventoryFilters = {}) {
    const rows = await inventoryService.listInventory(contextSiteCode);
    return rows.filter((row) => matchesInventoryFilters(row, filters)).map(toInventoryExportRow);
  },
};
