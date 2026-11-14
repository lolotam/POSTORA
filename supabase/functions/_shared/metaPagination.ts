/** Validate the provider continuation but follow only its bounded opaque cursor. */
export function metaNextCursor(body: Record<string, unknown>, origin: string, path: string, seen: Set<string>): string | null {
  const paging = body.paging;
  if (paging === undefined || paging === null) return null;
  if (typeof paging !== "object" || Array.isArray(paging)) throw new Error("Invalid Meta pagination");
  const continuation = paging as Record<string, unknown>;
  if (continuation.next === undefined || continuation.next === null) return null;
  if (typeof continuation.next !== "string" || !continuation.next) throw new Error("Invalid Meta pagination");
  const next = new URL(continuation.next);
  const cursors = continuation.cursors;
  const after = cursors !== null && typeof cursors === "object" && !Array.isArray(cursors)
    ? (cursors as Record<string, unknown>).after : null;
  // Graph may resolve /me to its numeric subject. Requests still use the original
  // trusted /me edge; neither that subject nor any continuation URL is followed.
  const alias = /^\/(v\d+\.\d+)\/me\/(accounts|permissions)$/.exec(path);
  const resolved = alias ? new RegExp(`^/${alias[1].replace(".", "\\.")}/[0-9]{1,128}/${alias[2]}$`) : null;
  if (next.origin !== origin || (next.pathname !== path && !resolved?.test(next.pathname)) || next.username || next.password || next.hash
    || typeof after !== "string" || !/^[A-Za-z0-9_=-]{1,2048}$/.test(after) || seen.has(after)) {
    throw new Error("Invalid Meta pagination");
  }
  seen.add(after);
  return after;
}
