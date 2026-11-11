export function buildSitePairKey(siteA?: string | null, siteB?: string | null): string {
  const values = [siteA?.trim() || "UNKNOWN_A", siteB?.trim() || "UNKNOWN_B"].sort();
  return `${values[0]}__${values[1]}`;
}
