export const YOUTUBE_PACIFIC_TIME_ZONE = "America/Los_Angeles";

const pacificFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: YOUTUBE_PACIFIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Formats `now` as `YYYY-MM-DD` in the YouTube Data API quota timezone (America/Los_Angeles). */
export function pacificDateString(now: Date): string {
  const parts = pacificFormatter.formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}
