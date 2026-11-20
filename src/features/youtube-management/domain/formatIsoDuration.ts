// PT4M13S -> "4:13"; PT1H2M3S -> "1:02:03"; null or unparseable -> null.
// Pure domain formatting: no React, no browser state, exported alone so the
// component file keeps exporting only components (react-refresh rule).
export function formatIsoDuration(value: string | null): string | null {
  if (value === null) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;
  const totalHours = (days ? Number(days) * 24 : 0) + (hours ? Number(hours) : 0);
  const mins = minutes ? Number(minutes) : 0;
  const secs = seconds ? Number(seconds) : 0;
  const mm = String(mins).padStart(totalHours > 0 ? 2 : 1, "0");
  const ss = String(secs).padStart(2, "0");
  return totalHours > 0 ? `${totalHours}:${mm}:${ss}` : `${mins}:${ss}`;
}
