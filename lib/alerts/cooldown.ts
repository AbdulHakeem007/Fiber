export function isCooldownActive(lastSeenAt: Date, cooldownMinutes: number, now = new Date()): boolean {
  return now.getTime() - lastSeenAt.getTime() < cooldownMinutes * 60 * 1000;
}
