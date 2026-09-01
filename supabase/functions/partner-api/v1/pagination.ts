// Opaque cursor pagination (spec §7.1, deliverable 2.6).
//
// WHY KEYSET AND NOT OFFSET
// -------------------------
// §7.1 forbids offset pagination outright, and the reason is specific to what
// /v1 paginates: conversation and message lists are written concurrently by
// definition — a webhook can insert a row between a partner's page 1 and page
// 2. Under OFFSET, that insert shifts every later row back by one, so the
// partner silently never sees the row that moved across the boundary. Under a
// keyset cursor the boundary is a VALUE, not a count, so a concurrent insert
// either sorts inside a page already read or is picked up by the next one.
// Nothing is skipped.
//
// THE SORT KEY IS A PAIR, AND THE PAIR IS NOT OPTIONAL
// ---------------------------------------------------
// Timestamps collide: two messages in the same conversation can share a
// `timestamp` to the microsecond, and WhatsApp history sync writes rows in
// batches that make that likely rather than exotic. A cursor on the timestamp
// alone would either re-emit the whole colliding group on every page (with
// `>=`) or drop all but one of it (with `>`). So the cursor carries
// (timestamp, id) and the comparison is lexicographic on the pair, which is
// total because ids are unique.

import { v1ErrorResponse } from "./errors.ts";

/** Page size bounds. MUST equal `components.schemas.LimitParameter`'s
 *  minimum/maximum/default in docs/api/openapi.yaml — a partner reading the
 *  document and a partner reading a response must agree about the page they
 *  get. */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;
export const LIMIT_DEFAULT = 20;

/** The position of one row in a descending (timestamp, id) ordering. */
export interface CursorPosition {
  /** ISO-8601 timestamp of the last row on the page just returned. */
  timestamp: string;
  /** That row's UUID — the tiebreaker that makes the ordering total. */
  id: string;
}

/**
 * Encode a position as the opaque string a partner sends back.
 *
 * base64url, not plain base64: the value travels in a query string, where
 * `+` means space and `/` and `=` need escaping. A cursor that survives one
 * client's URL encoding and not another's is a bug that only shows up in
 * somebody else's HTTP library.
 */
export function encodeCursor(position: CursorPosition): string {
  const json = JSON.stringify({ t: position.timestamp, i: position.id });
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Decode a cursor a partner sent back, or null if it is not one we issued.
 *
 * EVERY failure mode returns null and the caller answers `invalid_request` —
 * not a silent reset to page 1. A tampered or truncated cursor that quietly
 * restarts the listing looks to a partner's sync job like "the feed ended and
 * began again", and it will happily reprocess every row it already handled.
 * Rejecting is loud, recoverable, and cannot corrupt their state.
 *
 * The shape is validated field by field rather than trusted after the base64
 * decodes: the decoded bytes are attacker-controlled, and `t` reaches a
 * PostgREST timestamp comparison. A cursor is not a capability — it grants no
 * access on its own, because the account filter is applied from the KEY's
 * binding on every page, never from the cursor.
 */
export function decodeCursor(value: string): CursorPosition | null {
  let json: string;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const { t, i } = parsed as Record<string, unknown>;
  if (typeof t !== "string" || typeof i !== "string") return null;
  // TWO checks, and the first is the one that matters.
  //
  // `Date.parse` alone is nowhere near strict enough to be a guard: V8 still
  // honours legacy US formats, so `Date.parse("May 8, 2026")` SUCCEEDS. That
  // string contains a comma, and a comma is the disjunct separator in
  // PostgREST's `or=` grammar -- so it would reach keysetFilter and split the
  // filter into extra terms, answering a partner-triggerable 500 rather than
  // a 400. Not a tenancy hole (the or-group is ANDed with the binding and
  // workspace filters, so a mangled group cannot escape them), but it is a
  // response-shape oracle and a needless 500.
  //
  // The shape check is therefore an explicit ISO-8601 pattern, which admits
  // no comma, parenthesis or bare dot. `Date.parse` then rejects what is
  // shaped like an instant but is not one (`2026-13-45T00:00:00Z`).
  if (!ISO_INSTANT_RE.test(t)) return null;
  if (Number.isNaN(Date.parse(t))) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i)) return null;
  return { timestamp: t, id: i };
}

/** ISO-8601 as PostgREST renders a timestamptz: an optional fractional part
 *  and an optional `Z` or `±HH:MM` offset. Deliberately anchored and
 *  character-exact -- its job is to admit nothing that means something in the
 *  `or=` filter grammar. */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export interface PageRequest {
  limit: number;
  cursor: CursorPosition | null;
}

/**
 * Read `?limit=` and `?cursor=` off a request, or return the 400 to send.
 *
 * `limit` is CLAMPED to the documented bounds (the OpenAPI document says
 * "server may clamp") but a non-integer is REJECTED: clamping `?limit=abc` to
 * 20 would answer a page the partner never asked for and give them no way to
 * discover the typo.
 */
export function readPageRequest(
  req: Request,
  requestId: string,
): { ok: true; page: PageRequest } | { ok: false; res: Response } {
  const params = new URL(req.url).searchParams;

  let limit = LIMIT_DEFAULT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    // Number() rather than parseInt(): parseInt("20abc") is 20, which would
    // accept a malformed value as if it were fine.
    const parsed = Number(rawLimit);
    if (rawLimit.trim() === "" || !Number.isInteger(parsed)) {
      return {
        ok: false,
        res: v1ErrorResponse("invalid_request", requestId, {
          message: "limit must be an integer",
        }),
      };
    }
    limit = Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, parsed));
  }

  let cursor: CursorPosition | null = null;
  const rawCursor = params.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    cursor = decodeCursor(rawCursor);
    if (cursor === null) {
      return {
        ok: false,
        res: v1ErrorResponse("invalid_request", requestId, {
          message: "cursor is not a valid pagination cursor",
        }),
      };
    }
  }

  return { ok: true, page: { limit, cursor } };
}

/**
 * The PostgREST filter for "strictly before this position" in a descending
 * (timestamp, id) ordering.
 *
 * Returned as ONE string for ONE `.or()` call, deliberately. supabase-js
 * `.or()` calls do not compose: a second `.or()` on the same builder replaces
 * the first rather than AND-ing with it, which this repo has already shipped
 * once to production (PR #35, WhatsApp chat overhaul). Building the whole
 * disjunction here means a caller cannot make that mistake by adding a
 * condition, because there is nothing to add it to.
 *
 * `column` is a caller-supplied identifier, never partner input — the two
 * call sites pass the literals "last_message_at" and "timestamp".
 */
export function keysetFilter(column: string, position: CursorPosition): string {
  return `${column}.lt.${position.timestamp},` +
    `and(${column}.eq.${position.timestamp},id.lt.${position.id})`;
}

/**
 * Split an over-fetched result into the page and its `next_cursor`.
 *
 * Callers fetch `limit + 1` rows: the existence of that extra row is what
 * proves another page exists. Deriving `next_cursor` from a full page instead
 * would emit a cursor at the end of every exhausted listing, and a partner's
 * sync loop would poll forever on a feed that had ended.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  positionOf: (row: T) => CursorPosition,
): { page: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { page: rows, nextCursor: null };
  const page = rows.slice(0, limit);
  return { page, nextCursor: encodeCursor(positionOf(page[page.length - 1]!)) };
}
