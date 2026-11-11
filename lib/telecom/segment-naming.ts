// EDIT HERE: Segment naming/capacity normalization.
// Keep physical segment identity separate from live capacity so the UI never
// renders duplicated capacity text such as "MU0052-MU1023-C01-24F C01 - 24F".

export type SegmentNameParts = {
  baseName: string;
  sequence: string | null;
  capacity: number | null;
};

const CAPACITY_SUFFIX_RE = /^(?<base>.+?)(?:-)?(?<sequence>C\d{1,3})\s*-?\s*(?<capacity>\d+)\s*F$/i;

export function parseSegmentNameParts(segmentCode?: string | null): SegmentNameParts {
  const raw = String(segmentCode ?? "").trim();
  if (!raw) return { baseName: "", sequence: null, capacity: null };
  const match = raw.match(CAPACITY_SUFFIX_RE);
  if (!match?.groups) return { baseName: raw, sequence: null, capacity: null };
  const capacity = Number(match.groups.capacity);
  return {
    baseName: match.groups.base.replace(/-+$/, ""),
    sequence: match.groups.sequence.toUpperCase(),
    capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null,
  };
}

export function segmentDisplayTitle(segmentCode?: string | null): string {
  return parseSegmentNameParts(segmentCode).baseName || String(segmentCode ?? "-");
}

export function segmentDisplaySubtitle(segmentCode?: string | null, segmentSequence?: string | null, liveCapacity?: number | null): string {
  const parsed = parseSegmentNameParts(segmentCode);
  const sequence = String(segmentSequence ?? parsed.sequence ?? "").replace(/\s*-\s*\d+\s*F$/i, "").trim();
  const capacity = Number.isFinite(Number(liveCapacity)) && Number(liveCapacity) > 0 ? Number(liveCapacity) : parsed.capacity;
  if (sequence && capacity) return `${sequence} - ${capacity}F`;
  if (sequence) return sequence;
  return capacity ? `${capacity}F` : "";
}

export function canonicalSegmentCodeForCapacity(segmentCode: string, liveCapacity?: number | null): string {
  const parsed = parseSegmentNameParts(segmentCode);
  const capacity = Number.isFinite(Number(liveCapacity)) && Number(liveCapacity) > 0 ? Number(liveCapacity) : parsed.capacity;
  if (!parsed.sequence || !capacity) return segmentCode;
  return `${parsed.baseName}-${parsed.sequence}-${capacity}F`;
}

export function canonicalSegmentSequence(segmentCode?: string | null, segmentSequence?: string | null): string | null {
  const parsed = parseSegmentNameParts(segmentCode);
  const clean = String(segmentSequence ?? parsed.sequence ?? "").replace(/\s*-\s*\d+\s*F$/i, "").trim();
  return clean || null;
}
