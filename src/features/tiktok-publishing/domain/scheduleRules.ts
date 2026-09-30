import { resolveLocalWallClock } from "@/features/scheduled";

export type ShortcutName = "in_1_hour" | "tomorrow_9";

export type ShortcutInstant =
  | { ok: true; iso: string; resolution: string | null }
  | { ok: false; reason: "invalid" | "nonexistent"; resolution: string | null };

export type ScheduledAtVerdict = "ok" | "past" | "invalid";

const HOUR_MS = 3_600_000;
export const AMBIGUOUS_TIME_NOTE = "That time happens twice on that day; the earlier instant was used.";

function zoneIsValid(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The workspace schedules in the browser's local zone. */
function tomorrowNine(now: Date): ShortcutInstant {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const resolved = resolveLocalWallClock(target.getFullYear(), target.getMonth(), target.getDate(), 9, 0);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "nonexistent",
      resolution: "09:00 does not exist on that day in this time zone because clocks spring forward.",
    };
  }
  return {
    ok: true,
    iso: resolved.when.toISOString(),
    resolution: resolved.ambiguous ? AMBIGUOUS_TIME_NOTE : null,
  };
}

export function shortcutInstant(name: ShortcutName, now: Date, timeZone: string): ShortcutInstant {
  if (Number.isNaN(now.getTime()) || !zoneIsValid(timeZone)) {
    return { ok: false, reason: "invalid", resolution: null };
  }
  if (name === "in_1_hour") {
    return { ok: true, iso: new Date(now.getTime() + HOUR_MS).toISOString(), resolution: null };
  }
  return tomorrowNine(now);
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
