import { browserTimeZone, resolveLocalWallClock } from "@/features/scheduled/domain/wallClockMove";

export type ShortcutName = "in_1_hour" | "tomorrow_9";

export type ShortcutInstant =
  | { ok: true; iso: string; resolution: string | null }
  | { ok: false; reason: "invalid" | "nonexistent"; resolution: string | null };

export type ScheduledAtVerdict = "ok" | "past" | "invalid";

const HOUR_MS = 3_600_000;
const OVERLAP_SCAN_MINUTES = 180;

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zoneIsValid(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zoneParts(instant: Date, timeZone: string): CalendarParts | null {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  let hour = Number(bag.hour);
  const minute = Number(bag.minute);
  if (![year, month, day, hour, minute].every((value) => Number.isInteger(value))) return null;
  if (hour === 24) hour = 0;
  return { year, month, day, hour, minute };
}

function nextCalendarDay(parts: CalendarParts): CalendarParts {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: 9,
    minute: 0,
  };
}

function sameClock(parts: CalendarParts, year: number, month: number, day: number, hour: number, minute: number): boolean {
  return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
}

/**
 * 09:00 on the next calendar day in `timeZone`.
 * The browser's own zone goes through `resolveLocalWallClock` so a DST gap is refused
 * the same way the scheduler refuses one, and an overlap keeps the earlier instant.
 */
function tomorrowNine(now: Date, timeZone: string): ShortcutInstant {
  const today = zoneParts(now, timeZone);
  if (!today) return { ok: false, reason: "invalid", resolution: null };
  const target = nextCalendarDay(today);
  if (timeZone === browserTimeZone()) {
    const resolved = resolveLocalWallClock(target.year, target.month - 1, target.day, 9, 0);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: "nonexistent",
        resolution: "09:00 does not exist on that day in this time zone because clocks spring forward.",
      };
    }
    const later = zoneParts(new Date(resolved.when.getTime() + 60 * 60_000), timeZone);
    const overlap = later !== null && sameClock(later, target.year, target.month, target.day, 9, 0);
    return {
      ok: true,
      iso: resolved.when.toISOString(),
      resolution: overlap ? "09:00 happens twice on that day; the earlier instant was used." : null,
    };
  }
  return wallClockInZone(target.year, target.month, target.day, 9, 0, timeZone);
}

function wallClockInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): ShortcutInstant {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = offsetOf(new Date(guessUtc), timeZone);
  if (firstOffset === null) return { ok: false, reason: "invalid", resolution: null };
  let instant = new Date(guessUtc - firstOffset);
  const secondOffset = offsetOf(instant, timeZone);
  if (secondOffset === null) return { ok: false, reason: "invalid", resolution: null };
  if (firstOffset !== secondOffset) instant = new Date(guessUtc - secondOffset);
  const seen = zoneParts(instant, timeZone);
  if (!seen || !sameClock(seen, year, month, day, hour, minute)) {
    return {
      ok: false,
      reason: "nonexistent",
      resolution: "09:00 does not exist on that day in this time zone because clocks spring forward.",
    };
  }
  let earlier = instant;
  for (let delta = 1; delta <= OVERLAP_SCAN_MINUTES; delta += 1) {
    const candidate = new Date(instant.getTime() - delta * 60_000);
    const parts = zoneParts(candidate, timeZone);
    if (parts && sameClock(parts, year, month, day, hour, minute) && candidate.getTime() < earlier.getTime()) {
      earlier = candidate;
    }
  }
  return {
    ok: true,
    iso: earlier.toISOString(),
    resolution: earlier.getTime() === instant.getTime()
      ? null
      : "09:00 happens twice on that day; the earlier instant was used.",
  };
}

function offsetOf(instant: Date, timeZone: string): number | null {
  const parts = zoneParts(instant, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  return asUtc - instant.getTime();
}

export function shortcutInstant(name: ShortcutName, now: Date, timeZone: string): ShortcutInstant {
  if (Number.isNaN(now.getTime()) || !zoneIsValid(timeZone)) {
    return { ok: false, reason: "invalid", resolution: null };
  }
  if (name === "in_1_hour") {
    return { ok: true, iso: new Date(now.getTime() + HOUR_MS).toISOString(), resolution: null };
  }
  return tomorrowNine(now, timeZone);
}

export function validateScheduledAt(iso: string, now: Date): ScheduledAtVerdict {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime()) || Number.isNaN(now.getTime())) return "invalid";
  if (when.getTime() <= now.getTime()) return "past";
  return "ok";
}

export function formatInZone(iso: string, timeZone: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime()) || !zoneIsValid(timeZone)) return "";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(when);
}
