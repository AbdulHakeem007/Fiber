export const REHOMED_OUT_MARKER = "[REHOMED_OUT]";

export function isRehomedOutRemark(remarks?: string | null): boolean {
  return String(remarks ?? "").includes(REHOMED_OUT_MARKER);
}

export function buildRehomedOutRemark(input: {
  viaSite: string;
  oldSegmentCode: string;
  newSegmentCodes?: string[];
  selectedPorts?: string;
  selectedFibers?: number[];
}): string {
  const newSegments = input.newSegmentCodes?.filter(Boolean).join(" + ") || "new split segments";
  const ports = input.selectedPorts?.trim() ? ` Ports: ${input.selectedPorts.trim()}.` : "";
  const fibers = input.selectedFibers?.length ? ` Fibers: ${input.selectedFibers.join(", ")}.` : "";
  return `${REHOMED_OUT_MARKER} Re-homed via ${input.viaSite}; original direct neighbor ${input.oldSegmentCode} replaced by ${newSegments}.${ports}${fibers}`;
}

export function withRehomedStatusForDisplay<T extends { status?: string | null; remarks?: string | null }>(row: T): T {
  return isRehomedOutRemark(row.remarks) ? { ...row, status: "REHOMED" } : row;
}
