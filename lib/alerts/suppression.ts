export function isSuppressed(startsAt: Date, endsAt: Date, now = new Date()) {
  return now >= startsAt && now <= endsAt;
}
