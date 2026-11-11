// Strand-level state marker for mid-span-tap "stranded capacity".
//
// When a cable is tapped at a mid-span site, some strands are diverted while the
// far-side tails of those strands are left physically present in the tray/ODF but
// with no outbound continuity. Those tails are STRANDED: not routable, not live
// direct capacity, and not part of any ring — yet they must NOT be dropped
// (Zero-Overwrite Protection). This mirrors lib/telecom/rehome.ts exactly: a
// remark marker + predicate, consumed by isLiveDirectCapacity / impact / trace so
// no DB migration is required and the existing split logic is untouched.
//
// Direction-agnostic by design: the open end can be EITHER cable end (the tap
// site is the only fixed point), so the dead-end site is always a parameter.
export const STUB_STRAND_MARKER = "[STUB_STRAND]";

export function isStrandedStrandRemark(remarks?: string | null): boolean {
  return String(remarks ?? "").includes(STUB_STRAND_MARKER);
}

export function buildStrandedStrandRemark(input: {
  /** The mid-span site where the tap/splice happened (e.g. Site B). */
  tapSite: string;
  /** The site where these strands now dead-end — whichever cable end it is. */
  openEndSite: string;
  cableLabel?: string | null;
  selectedPorts?: string | null;
  selectedFibers?: number[];
}): string {
  const cable = input.cableLabel?.trim() ? ` Cable: ${input.cableLabel.trim()}.` : "";
  const ports = input.selectedPorts?.trim() ? ` Ports: ${input.selectedPorts.trim()}.` : "";
  const fibers = input.selectedFibers?.length ? ` Fibers: ${input.selectedFibers.join(", ")}.` : "";
  return `${STUB_STRAND_MARKER} Open-ended capacity at ${input.openEndSite} due to mid-span tap at ${input.tapSite}.${cable}${ports}${fibers}`;
}

/** Surface a clear display status for stranded rows without overwriting the
 *  stored ResourceStatus (mirrors withRehomedStatusForDisplay). */
export function withStrandedStatusForDisplay<T extends { status?: string | null; remarks?: string | null }>(row: T): T {
  return isStrandedStrandRemark(row.remarks) ? { ...row, status: "STRANDED" } : row;
}
