// Idempotency for partner sends.
//
// The claim is an INSERT that races on the primary key: whoever inserts first
// owns the send, and everyone else reads the existing row and reacts to its
// state. A check-then-insert would let two concurrent retries both send.

export type ClaimResult =
  | { outcome: "claimed"; attemptToken: string }
  | { outcome: "replay"; httpStatus: number; body: unknown }
  | { outcome: "conflict" }
  | { outcome: "in_progress" }
  | { outcome: "indeterminate" };

/**
 * Recursively canonicalize before hashing.
 *
 * The obvious one-liner is WRONG and dangerously so:
 *   JSON.stringify(body, Object.keys(body).sort())
 * The second argument is a replacer ALLOW-LIST, not a sort order. It strips
 * every nested property whose name is absent from the top level, so
 * `[{type:"body",parameters:[{text:"12.500"}]}]` and the same structure with
 * `"99.000"` both collapse to `[{}]` — two genuinely different messages hash
 * identically, and the second silently replays the first's response.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = canonicalize(source[key]);
  }
  return out;
}

/** Stable digest of the request body, so a reused key with different content
 *  is detected rather than silently replayed. Accepts null/undefined. */
export async function hashRequest(body: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalize(body));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function claimIdempotency(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ClaimResult> {
  // All of the atomicity lives in the RPC: insert-or-inspect, stale-lease
  // takeover, and expiry pruning happen in one statement under a row lock.
  const { data, error } = await client.rpc("claim_partner_idempotency", {
    p_key_id: keyId,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    // Must stay above the 75s worst-case send deadline in Task 5. See the
    // comment on claim_partner_idempotency for why a short lease double-sends.
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`Idempotency claim failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  switch (row?.outcome) {
    case "claimed":
      return { outcome: "claimed", attemptToken: row.attempt_token };
    case "replay":
      return { outcome: "replay", httpStatus: row.http_status, body: row.response_body };
    case "conflict":
      return { outcome: "conflict" };
    case "indeterminate":
      return { outcome: "indeterminate" };
    default:
      return { outcome: "in_progress" };
  }
}

export async function completeIdempotency(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
  attemptToken: string,
  httpStatus: number,
  body: unknown,
): Promise<void> {
  const { error } = await client
    .from("partner_api_idempotency")
    .update({
      state: "completed",
      http_status: httpStatus,
      response_body: body,
      completed_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey)
    // Only settle a row still in flight...
    .eq("state", "processing")
    // ...AND only if we still own it. A takeover leaves state = 'processing'
    // but mints a new token, so this is what actually stops a revived stale
    // writer from settling the new owner's attempt with its own result.
    .eq("attempt_token", attemptToken);

  // Swallowing this would leave the row `processing` with no live lease. The
  // stale-lease path in the RPC recovers it, but a silent failure here means
  // a duplicate could re-send, so it must at least be visible.
  if (error) {
    console.error("[partner-api] idempotency settle failed:", error.message);
    throw new Error(`Idempotency settle failed: ${error.message}`);
  }
}

export async function markIndeterminate(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
  attemptToken: string,
): Promise<void> {
  const { error } = await client
    .from("partner_api_idempotency")
    .update({ state: "indeterminate", locked_until: null })
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey)
    // Never downgrade an already-settled success to `indeterminate`: if the
    // completion committed and only the response was lost, the row is correct
    // as it stands. The token check additionally stops a stale writer from
    // poisoning an attempt it no longer owns.
    .eq("state", "processing")
    .eq("attempt_token", attemptToken);

  // If this write is lost the row stays `processing`; once its lease expires
  // a retry would take it over and re-send a message that may already have
  // been delivered. Loud failure is the lesser evil.
  if (error) {
    console.error("[partner-api] indeterminate mark failed:", error.message);
    throw new Error(`Indeterminate mark failed: ${error.message}`);
  }
}
