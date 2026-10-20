// MCP clients often send list fields of create_post as text instead of a real
// JSON array: JSON-array text ("[\"uuid\"]") or comma-separated text
// ("facebook, instagram"). The Postora API only accepts string arrays, so these
// values are normalized here before the request is forwarded.

export const LIST_FIELDS = [
  "media_file_ids",
  "media_urls",
  "account_ids",
  "platforms",
  "instagram_collaborators",
  "instagram_user_tags",
  "youtube_tags",
] as const;

/**
 * Normalize a single list value into a string array.
 *
 * - array: strings are trimmed, non-strings are kept as-is, empty strings are dropped
 * - JSON-array text: parsed and normalized like an array; unparsable text is
 *   forwarded unchanged so the API can report the bad input
 * - other text: split on "," and each part is trimmed, empty parts are dropped
 * - anything else (undefined, null, number, object) is returned unchanged
 */
export function toStringList(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : item))
      .filter((item) => !(typeof item === "string" && item === ""));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.startsWith("[")) {
      try {
        // Text that starts with "[" and parses is always a JSON array.
        return toStringList(JSON.parse(trimmed));
      } catch {
        // Not valid JSON - forward the original value so the API reports it.
        return value;
      }
    }

    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  return value;
}

/**
 * Copy the tool arguments and normalize every known list field, so the API is
 * always called with real string arrays. Unknown keys are left untouched.
 */
export function normalizeListFields(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...args };

  for (const field of LIST_FIELDS) {
    const value = normalized[field];
    if (value === undefined) continue;
    normalized[field] = toStringList(value);
  }

  return normalized;
}
