// DARK_STUB (manual port blocking) helpers.
//
// A planning engineer can mark individual ODF ports as DARK_STUB to match the
// physical OSP design (dead-ended / intentionally blocked capacity). The source
// of truth is the per-port ODFPort.isBlocked flag — genuinely port-level, NOT
// group/PTP-allocation level — so blocking a near-side port never touches its
// far-end peer (a different ODFPort row). The human-readable reason is kept on
// ODFPort.remarks via the marker below, appended WITHOUT clobbering any existing
// remark text (Zero-Overwrite Protection).
export const DARK_STUB_MARKER = "[DARK_STUB]";

export function isDarkStubRemark(remarks?: string | null): boolean {
  return String(remarks ?? "").includes(DARK_STUB_MARKER);
}

// Strip any prior DARK_STUB note while preserving the rest of the remark, then
// re-append a fresh note when blocking. Returns null only when nothing is left.
export function applyDarkStubMarker(existing: string | null | undefined, blocked: boolean, reason?: string | null): string | null {
  const base = String(existing ?? "")
    .replace(/\[DARK_STUB\][^\n]*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!blocked) return base || null;
  const note = `${DARK_STUB_MARKER} ${reason?.trim() || "Manually blocked (dead-end / OSP design)."}`;
  return base ? `${base} ${note}` : note;
}
