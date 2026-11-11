export function portNumbersFromLabel(label?: string | null): number[] {
  // EDIT HERE: ODF port range parser.
  // "1-6" means the sequential ODF ports 1,2,3,4,5,6.
  // "1-2,5-6" is a manual override and means 1,2,5,6.
  // This function intentionally reads ODF port labels, not tube/fiber metadata.
  const cleaned = String(label ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, "").trim();
  if (!cleaned) return [];

  const ports: number[] = [];
  for (const token of cleaned.split(",").filter(Boolean)) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : first;
    if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) continue;
    const start = Math.min(first, second);
    const end = Math.max(first, second);
    if (end - start > 999) continue;
    for (let value = start; value <= end; value += 1) ports.push(value);
  }

  return [...new Set(ports)].sort((a, b) => a - b);
}

export function fiberCountFromUnit(label?: string | null, fiberNumbersJson?: string | null): number {
  // EDIT HERE: Port count must be driven by the ODF port label when present.
  // Imported fiberNumbersJson can contain physical fiber IDs or migrated helper
  // values that do not always equal the number of ODF ports used by a service.
  // Example: local/far port "9" is a 1-port service even if JSON contains [9,10].
  const fromPortLabel = portNumbersFromLabel(label);
  if (fromPortLabel.length) return fromPortLabel.length;

  const fromJson = String(fiberNumbersJson ?? "").match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (fromJson.length) return new Set(fromJson).size;
  return 0;
}

export function unitLabel(numbers: number[]): string | null {
  const sorted = [...new Set(numbers.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted.length === 1 ? String(sorted[0]) : `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

export function jsonFiberNumbersFromUnit(label?: string | null): string | null {
  const numbers = portNumbersFromLabel(label);
  return numbers.length ? JSON.stringify(numbers) : null;
}

export function splitPairSurvivor(oldUnit?: string | null, newUnit?: string | null): string | null {
  const oldNumbers = portNumbersFromLabel(oldUnit);
  const newNumbers = portNumbersFromLabel(newUnit);
  if (oldNumbers.length <= 1 || newNumbers.length !== 1) return null;
  if (!oldNumbers.includes(newNumbers[0])) return null;
  const remaining = oldNumbers.filter((value) => !newNumbers.includes(value));
  return unitLabel(remaining);
}

export function pairedSelectedPeerUnit(oldBaseUnit?: string | null, newBaseUnit?: string | null, oldPeerUnit?: string | null, explicitPeerUnit?: string | null): string | null {
  const oldBase = portNumbersFromLabel(oldBaseUnit);
  const newBase = portNumbersFromLabel(newBaseUnit);
  const oldPeer = portNumbersFromLabel(oldPeerUnit);
  const explicitPeer = String(explicitPeerUnit ?? "").trim();
  const oldPeerText = String(oldPeerUnit ?? "").trim();
  if (explicitPeer && explicitPeer !== oldPeerText) return explicitPeer;
  if (oldBase.length <= 1 || newBase.length !== 1 || oldPeer.length !== oldBase.length) return explicitPeer || oldPeerText || null;
  const selectedIndex = oldBase.findIndex((value) => value === newBase[0]);
  if (selectedIndex < 0) return explicitPeer || oldPeerText || null;
  return unitLabel([oldPeer[selectedIndex]]);
}

export function pairedSurvivorFarUnit(oldLocalUnit?: string | null, newLocalUnit?: string | null, oldFarUnit?: string | null, newFarUnit?: string | null): string | null {
  const oldLocal = portNumbersFromLabel(oldLocalUnit);
  const newLocal = portNumbersFromLabel(newLocalUnit);
  const oldFar = portNumbersFromLabel(oldFarUnit);
  const newFar = portNumbersFromLabel(newFarUnit);
  if (oldLocal.length <= 1 || newLocal.length !== 1) return null;
  const removedLocalIndex = oldLocal.findIndex((value) => value === newLocal[0]);
  if (removedLocalIndex < 0) return null;
  const remainingIndexes = oldLocal.map((_, index) => index).filter((index) => index !== removedLocalIndex);

  if (oldFar.length === oldLocal.length) {
    const remainingFar = remainingIndexes.map((index) => oldFar[index]).filter((value) => Number.isInteger(value) && value > 0);
    return unitLabel(remainingFar);
  }

  const farSurvivor = splitPairSurvivor(oldFarUnit, newFarUnit);
  return farSurvivor;
}

export function isUnavailableFiberStatus(status?: string | null): boolean {
  const normalized = String(status ?? "").toUpperCase();
  return ["USED", "ACTIVE", "RESERVED", "FAULTY", "BLOCKED", "DUMMY", "DECOMMISSIONED", "UNKNOWN", "PLANNED"].includes(normalized);
}
