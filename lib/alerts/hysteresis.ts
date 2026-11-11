export function isClearedByHysteresis(currentPct: number, warningThresholdPct: number, hysteresisPct: number) {
  return currentPct <= warningThresholdPct - hysteresisPct;
}
