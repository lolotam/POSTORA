export type CalendarView = "month" | "week" | "day";

/** Local calendar day "YYYY-MM-DD" for a Date. */
export function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses `?date=YYYY-MM-DD` as a local date; anything else falls back to today. */
export function parseDayKey(value: string | null, today: Date): Date {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return startOfDay(today);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) || dayKey(date) !== value ? startOfDay(today) : date;
}

export function parseCalendarView(value: string | null): CalendarView {
  return value === "week" || value === "day" ? value : "month";
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -date.getDay());
}

/** The days a view shows: six Sunday-first weeks for a month, seven days for a week, one day. */
export function visibleDays(anchor: Date, view: CalendarView): Date[] {
  if (view === "day") return [startOfDay(anchor)];
  if (view === "week") {
    const first = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(first, index));
  }
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

/** Moves the anchor one period back (-1) or forward (+1). */
export function shiftAnchor(anchor: Date, view: CalendarView, direction: -1 | 1): Date {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** "October 2026", "Oct 11 – 17, 2026" or "Monday, October 12, 2026". */
export function periodTitle(anchor: Date, view: CalendarView): string {
  if (view === "month") {
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(anchor);
  }
  if (view === "day") {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(anchor);
  }
  const days = visibleDays(anchor, "week");
  const first = days[0] ?? anchor;
  const last = days[6] ?? anchor;
  const month = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
  const sameMonth = first.getMonth() === last.getMonth();
  const end = sameMonth ? String(last.getDate()) : `${month(last)} ${last.getDate()}`;
  return `${month(first)} ${first.getDate()} – ${end}, ${last.getFullYear()}`;
}
