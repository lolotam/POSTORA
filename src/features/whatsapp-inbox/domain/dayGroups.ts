function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayLabel(date: Date, now: Date): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export interface DayGroup<T> {
  day: string;
  label: string;
  rows: T[];
}

/** Consecutive messages on the same local day share one separator, as in WhatsApp Web. */
export function groupByDay<T extends { created_time: string }>(messages: T[], now: Date = new Date()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of messages) {
    const date = new Date(row.created_time);
    const day = localDayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, label: dayLabel(date, now), rows: [row] });
  }
  return groups;
}

/** Chat-list timestamp: the time today, the short date otherwise. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (localDayKey(date) === localDayKey(now)) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${String(date.getFullYear()).slice(-2)}`;
}
