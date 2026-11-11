/**
 * GCC business-day calendar for the delayed-deletion (24h soft-delete hold)
 * workflow.
 *
 * The hold countdown only runs during GCC working days (Sunday-Thursday by
 * default; Friday/Saturday are the weekend). Official national holidays pause
 * the countdown for their full duration, exactly like a weekend day. All
 * functions are pure so both server routes and client countdown timers share
 * the same arithmetic.
 *
 * Working days and holidays are configurable:
 *  - `GCC_WORKING_DAYS` env: comma-separated JS weekday numbers (0=Sunday).
 *    Default "0,1,2,3,4" (Sun-Thu).
 *  - `GCC_HOLIDAYS` env: comma-separated ISO dates (YYYY-MM-DD) treated as
 *    non-working days regardless of weekday.
 */

export interface GccCalendarConfig {
  /** JS weekday numbers (0=Sunday .. 6=Saturday) that count as working days. */
  workingDays: number[];
  /** ISO dates (YYYY-MM-DD, local time) that are official holidays. */
  holidays: string[];
}

/** Sunday-Thursday: the standard GCC working week. */
export const DEFAULT_GCC_WORKING_DAYS = [0, 1, 2, 3, 4];

/** 24 hours of *working* time — the reversal window for soft deletes. */
export const DELETION_HOLD_MILLIS = 24 * 60 * 60 * 1000;

const DAY_MILLIS = 24 * 60 * 60 * 1000;
// Hard iteration guard: a 24h hold can never span more than a few days of
// weekends/holidays; 3,660 days (~10y) protects against config mistakes
// (e.g. an empty workingDays list) without ever looping forever.
const MAX_DAY_STEPS = 3660;

export function defaultGccCalendarConfig(): GccCalendarConfig {
  return { workingDays: [...DEFAULT_GCC_WORKING_DAYS], holidays: [] };
}

/** Parse the env-configurable calendar (server side). Invalid entries are dropped. */
export function resolveGccCalendarConfig(env?: { GCC_WORKING_DAYS?: string; GCC_HOLIDAYS?: string }): GccCalendarConfig {
  const source = env ?? (typeof process !== "undefined" ? process.env : {});
  const workingDays = String(source.GCC_WORKING_DAYS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  const holidays = String(source.GCC_HOLIDAYS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => /^\d{4}-\d{2}-\d{2}$/.test(token));
  return {
    workingDays: workingDays.length ? [...new Set(workingDays)].sort() : [...DEFAULT_GCC_WORKING_DAYS],
    holidays,
  };
}

function isoDateOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True when the given moment falls on a working day (and not on a holiday). */
export function isWorkingDay(date: Date, config: GccCalendarConfig): boolean {
  if (!config.workingDays.includes(date.getDay())) return false;
  return !config.holidays.includes(isoDateOf(date));
}

function startOfNextDay(date: Date): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Deadline that lies `workingMillis` of working time after `start`.
 * Non-working days (weekends + holidays) extend the deadline by their full
 * duration, i.e. the countdown pauses over them.
 */
export function addWorkingMillis(start: Date, workingMillis: number, config: GccCalendarConfig): Date {
  let cursor = new Date(start.getTime());
  let remaining = Math.max(0, workingMillis);
  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    const dayEnd = startOfNextDay(cursor);
    if (isWorkingDay(cursor, config)) {
      const available = dayEnd.getTime() - cursor.getTime();
      if (remaining <= available) return new Date(cursor.getTime() + remaining);
      remaining -= available;
    }
    cursor = dayEnd;
  }
  // Guard fallback: behave like a plain (non-paused) deadline.
  return new Date(start.getTime() + workingMillis);
}

/** Working-time milliseconds elapsed between two moments (order-safe). */
export function workingMillisBetween(from: Date, to: Date, config: GccCalendarConfig): number {
  if (to.getTime() <= from.getTime()) return 0;
  let cursor = new Date(from.getTime());
  let elapsed = 0;
  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    if (cursor.getTime() >= to.getTime()) break;
    const dayEnd = startOfNextDay(cursor);
    const sliceEnd = Math.min(dayEnd.getTime(), to.getTime());
    if (isWorkingDay(cursor, config)) elapsed += sliceEnd - cursor.getTime();
    cursor = new Date(dayEnd.getTime());
  }
  return elapsed;
}

/**
 * Working-time milliseconds still left on a hold that started at `markedAt`.
 * Zero (never negative) once the hold has fully elapsed.
 */
export function remainingHoldMillis(
  markedAt: Date,
  now: Date,
  config: GccCalendarConfig,
  holdMillis: number = DELETION_HOLD_MILLIS,
): number {
  return Math.max(0, holdMillis - workingMillisBetween(markedAt, now, config));
}

/** "22h 14m" style label for the Undo countdown button. */
export function formatRemainingHold(millis: number): string {
  const totalMinutes = Math.max(0, Math.ceil(millis / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
