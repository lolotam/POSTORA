/**
 * Normalizes international telephone numbers accepted for AI agent administration.
 * This intentionally differs from contact imports, which store digit-only numbers.
 */
export function normalizeE164Phone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("+")) return null;

  const compact = `+${trimmed.slice(1).replace(/[\s-]/g, "")}`;
  return /^\+[1-9]\d{1,14}$/.test(compact) ? compact : null;
}