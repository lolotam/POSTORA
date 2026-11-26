// PT4M13S -> "4:13"; PT1H2M3S -> "1:02:03"; null or unparseable -> null.
// Pure domain formatting: no React and no browser state.
function isoDurationParts(value: string | null): [number, number, number, number] | null {
  if (value === null) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => part ? Number(part) : 0);
  return match.slice(1).every((part) => part === undefined) ? null : [days, hours, minutes, seconds];
}

export function isoDurationSeconds(value: string | null): number | null {
  const parts = isoDurationParts(value);
  if (!parts) return null;
  const [days, hours, minutes, seconds] = parts;
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

export function formatIsoDuration(value: string | null): string | null {
  const parts = isoDurationParts(value);
  if (!parts) return null;
  const [days, hours, minutes, seconds] = parts;
  const totalHours = days * 24 + hours;
  const mm = String(minutes).padStart(totalHours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return totalHours > 0 ? `${totalHours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
