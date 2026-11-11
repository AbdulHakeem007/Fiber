export function summarizeDirectConnectivity(
  rows: Array<{ remoteSiteCode: string; distanceKm?: number | null; isCoreSite?: boolean; coreSiteType?: string | null }>,
) {
  const grouped = new Map<string, { siteCode: string; segmentCount: number; distanceKm?: number | null; isCoreSite?: boolean; coreSiteType?: string | null }>();

  for (const row of rows) {
    const current = grouped.get(row.remoteSiteCode);
    if (current) {
      current.segmentCount += 1;
      current.distanceKm = current.distanceKm ?? row.distanceKm ?? null;
      current.isCoreSite = current.isCoreSite || row.isCoreSite;
      current.coreSiteType = current.coreSiteType ?? row.coreSiteType ?? null;
    } else {
      grouped.set(row.remoteSiteCode, {
        siteCode: row.remoteSiteCode,
        segmentCount: 1,
        distanceKm: row.distanceKm ?? null,
        isCoreSite: Boolean(row.isCoreSite),
        coreSiteType: row.coreSiteType ?? null,
      });
    }
  }

  return [...grouped.values()].sort((a, b) => b.segmentCount - a.segmentCount || a.siteCode.localeCompare(b.siteCode));
}
