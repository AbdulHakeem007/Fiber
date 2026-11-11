export function sumDistanceKm(items: Array<{ distanceKm?: number | null }>): number {
  return Number(items.reduce((acc, item) => acc + (item.distanceKm ?? 0), 0).toFixed(2));
}
