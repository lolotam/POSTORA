export type WallClockRefusal = "invalid" | "nonexistent" | "tooSoon";

export type WallClockMove =
  | { ok: true; iso: string }
  | { ok: false; reason: WallClockRefusal };

const MIN_LEAD_MS = 60_000;
const OVERLAP_SCAN_MINUTES = 180;

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function sameWallClock(when: Date, year: number, month: number, day: number, hours: number, minutes: number): boolean {
  return when.getFullYear() === year
    && when.getMonth() === month
    && when.getDate() === day
    && when.getHours() === hours
    && when.getMinutes() === minutes
    && when.getSeconds() === 0;
}

/** Earlier of two local instants that share a wall clock during a DST overlap. */
function earlierOccurrence(constructed: Date, year: number, month: number, day: number, hours: number, minutes: number): Date {
  let earlier = constructed;
  for (let delta = 1; delta <= OVERLAP_SCAN_MINUTES; delta += 1) {
    const candidate = new Date(constructed.getTime() - delta * 60_000);
    if (sameWallClock(candidate, year, month, day, hours, minutes) && candidate.getTime() < earlier.getTime()) {
      earlier = candidate;
    }
  }
  return earlier;
}

/**
 * Keep the source instant's local hours and minutes on `targetDay`.
 * A spring-forward gap is refused. A fall-back overlap uses the earlier instant.
 * Seconds are cleared. The result must be at least one minute ahead.
 */
export function moveKeepingLocalWallClock(sourceIso: string, targetDay: Date, nowMs = Date.now()): WallClockMove {
  const source = new Date(sourceIso);
  if (Number.isNaN(source.getTime()) || Number.isNaN(targetDay.getTime())) {
    return { ok: false, reason: "invalid" };
  }
  const hours = source.getHours();
  const minutes = source.getMinutes();
  const year = targetDay.getFullYear();
  const month = targetDay.getMonth();
  const day = targetDay.getDate();
  const constructed = new Date(year, month, day, hours, minutes, 0, 0);
  if (!sameWallClock(constructed, year, month, day, hours, minutes)) {
    return { ok: false, reason: "nonexistent" };
  }
  const resolved = earlierOccurrence(constructed, year, month, day, hours, minutes);
  if (resolved.getTime() < nowMs + MIN_LEAD_MS) {
    return { ok: false, reason: "tooSoon" };
  }
  return { ok: true, iso: resolved.toISOString() };
}

/** Post drag: same local hours and minutes, no lead-time or DST refusal. */
export function movePostToDay(scheduledAt: string | null, targetDay: Date): Date {
  const original = scheduledAt ? new Date(scheduledAt) : new Date();
  return new Date(
    targetDay.getFullYear(),
    targetDay.getMonth(),
    targetDay.getDate(),
    original.getHours(),
    original.getMinutes(),
  );
}
