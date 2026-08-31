export function requiredString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = record[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

