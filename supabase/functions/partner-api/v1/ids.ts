// Prefixed opaque resource identifiers (spec §7.1, deliverable 2.6).
//
// WHY THE PREFIX IS THE WHOLE POINT
// ---------------------------------
// §7.1 requires IDs to be "opaque, prefixed, stable", with provider IDs
// carried as clearly named separate fields and never as the primary ID. The
// prefix is not decoration: it makes a client that passes a `conv_` where a
// `msg_` belongs fail at the door with `resource_not_found` instead of
// reaching the database and either erroring or — worse — matching, since
// nothing stops two tables from sharing a UUID.
//
// WHY THE BODY IS THE BARE UUID AND NOT BASE64
// --------------------------------------------
// Encoding adds no privacy over a random UUID: base64 is not a secret, and a
// partner who wants the underlying value gets it in one line. What it does
// add is an unreadable identifier in every support ticket and log line. So
// the body is the UUID verbatim.
//
// The property that actually matters for privacy is WHICH value we prefix.
// `messaging_cache.conversation_id` is the natural conversation key, but it
// is text of the form `wa_<phone_number_id>_<msisdn>` — it embeds the
// customer's phone number. Publishing it as `conv_wa_1555…` would put a
// customer MSISDN in every partner's URL bar, log aggregator and error
// tracker, and base64ing it would only make that leak harder to notice.
// `/v1` therefore publishes `messaging_cache.id`, the surrogate UUID, and the
// text key never leaves the server. See conversations.ts.

/** The prefixes §7.1 fixes. Adding one is a contract change; the OpenAPI
 *  document's `PrefixedId` pattern must be updated in the same commit. */
export const ID_PREFIXES = ["acc", "conv", "msg", "post", "media", "evt", "wh"] as const;

export type IdPrefix = typeof ID_PREFIXES[number];

/** Canonical 8-4-4-4-12 hex form. Deliberately NOT a loose `[0-9a-f-]+`:
 *  the whole reason this function exists is to keep a non-UUID out of a
 *  `.eq()` against a uuid column, and a loose pattern would let
 *  "----------" through. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeId(prefix: IdPrefix, uuid: string): string {
  return `${prefix}_${uuid}`;
}

/**
 * The UUID inside a prefixed id, or null if the id is not a well-formed id of
 * exactly this prefix.
 *
 * Callers MUST treat null as `resource_not_found` and answer without touching
 * the database. Two reasons, and the second is the load-bearing one:
 *
 *   1. PostgREST rejects a non-UUID compared against a uuid column with a
 *      500-class error, so a client typo would read as a Postora fault.
 *   2. That error is an existence ORACLE. A malformed id failing differently
 *      from an unknown-but-well-formed id tells a prober which of their
 *      guesses had the right shape — the same enumeration leak the key-auth
 *      path avoids by answering `invalid_key` for both "no such key" and
 *      "malformed key". Every /v1 route parameter goes through here so the
 *      two cases are indistinguishable.
 */
export function decodeId(prefix: IdPrefix, value: string): string | null {
  const head = `${prefix}_`;
  if (!value.startsWith(head)) return null;
  const body = value.slice(head.length);
  return UUID_RE.test(body) ? body : null;
}
