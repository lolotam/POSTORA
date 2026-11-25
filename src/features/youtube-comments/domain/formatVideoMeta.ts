export function formatVideoDuration(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;
  const totalHours = (days ? Number(days) * 24 : 0) + (hours ? Number(hours) : 0);
  const mins = minutes ? Number(minutes) : 0;
  const secs = seconds ? Number(seconds) : 0;
  if (totalHours === 0 && mins === 0 && secs === 0) return null;
  const mm = String(mins).padStart(totalHours > 0 ? 2 : 1, "0");
  const ss = String(secs).padStart(2, "0");
  return totalHours > 0 ? `${totalHours}:${mm}:${ss}` : `${mins}:${ss}`;
}

function formatCount(count: number | null | undefined, locale: string, options: Intl.NumberFormatOptions): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return "\u2014";
  try {
    return new Intl.NumberFormat(locale, options).format(count);
  } catch {
    return new Intl.NumberFormat("en", options).format(count);
  }
}

export function formatCompactCount(count: number | null | undefined, locale: string): string {
  return formatCount(count, locale, { notation: "compact", maximumFractionDigits: 1 });
}

export function formatExactCount(count: number | null | undefined, locale: string): string {
  return formatCount(count, locale, {});
}

export function validPublishDate(publishedAt: string | null | undefined): Date | null {
  if (!publishedAt) return null;
  const date = new Date(publishedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}
