/**
 * Parsing for the reference images attached to an image generation.
 *
 * This lives apart from `generate-image/index.ts` so it can be unit tested —
 * that file calls `serve()` and imports remote modules at load time, so it
 * cannot run under the app's test runner.
 */

export interface ReferenceInput {
  url: string;
  type: string;
  priority: number;
}

/**
 * Collapse the two reference fields the dialogs send into one list.
 *
 * `referenceImages` carries the per-image type and order; `referenceImage` is
 * the older single-image field, consulted only when the array is absent because
 * the dialog sets it to a copy of the array's first entry.
 */
export function collectReferences(
  single: string | undefined,
  many: { url: string; type?: string; priority?: number }[] | undefined,
): ReferenceInput[] {
  const source = many?.length ? many : single ? [{ url: single }] : [];
  return source.map((ref, index) => ({
    url: ref.url,
    type: ref.type || "style",
    priority: ref.priority ?? index + 1,
  }));
}

/** Split a base64 data URL into its parts, or null when it is not one. */
export function parseDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

/** Host forms that must never be fetched on a caller's behalf. */
const PRIVATE_HOST = /^(localhost$|\[?::1\]?$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/**
 * True when a reference URL is safe to fetch server-side.
 *
 * Reference URLs arrive in the request body, so an unchecked fetch would let a
 * caller aim this function at the internal network and read the response back
 * through the model.
 */
export function isPublicHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && !PRIVATE_HOST.test(parsed.hostname);
}
