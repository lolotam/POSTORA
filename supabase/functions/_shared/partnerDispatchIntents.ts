// Dispatch intents for partner sends (D13, Phase 3 Stage 1).
//
// One durable row per attempted provider dispatch, written and COMMITTED
// before the provider call is made (deliverable 3.2: the ordering is the
// deliverable). The row is the evidence a later takeover needs to refuse to
// re-send: "an intent exists that I do not own" is a hard stop, because the
// previous attempt may have reached the provider.
//
// State machine (enforced again in SQL by the transition trigger):
//   intended -> sent | failed | indeterminate | reconciled_sent
//   sent     -> reconciled_sent
//   indeterminate -> reconciled_sent
//   failed, reconciled_sent: terminal
//
// `indeterminate` is written ONLY by a takeover, never by the attempt that
// issued the call (decision record §2). An attempt that itself observes an
// unknown outcome (timeout, 5xx, unparseable body) leaves its row
// `intended` and marks the IDEMPOTENCY row indeterminate instead -- that is
// the partner-facing "not resendable" record.

export type DispatchIntentState =
  | "intended"
  | "sent"
  | "failed"
  | "indeterminate"
  | "reconciled_sent";

export interface DispatchIntentRow {
  id: string;
  state: DispatchIntentState;
  wamid: string | null;
  http_status: number | null;
  response_body: unknown;
}

export type RecordIntentResult =
  | { status: "recorded"; intentId: string }
  | { status: "existing"; row: DispatchIntentRow };

/** Guard for webhook-echoed correlators: the ids this module mints are UUIDs,
 *  and an `.eq("id", ...)` against a non-UUID string is a Postgres cast
 *  error, not an empty result. Garbage echoes must be ignorable, not fatal. */
export function isDispatchIntentId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
}

/**
 * The pre-call boundary (3.2).
 *
 * INSERT ... ON CONFLICT (key_id, idempotency_key) DO NOTHING, then read.
 * The insert is a standalone statement on the caller's client: when its
 * promise resolves, the row is COMMITTED and visible to any other
 * connection. The caller must await this BEFORE issuing the provider call.
 *
 * The conflict case IS the takeover check (3.3): a row already existing for
 * this (key, idempotency key) means a previous attempt got as far as
 * committing an intent -- so a retry must not dispatch, whatever the row's
 * state. The caller decides what to do with each state; this function only
 * reports.
 *
 * Throws on database errors: a failed intent write must abort the send (an
 * unrecorded dispatch is the duplicate window D13 exists to close), which is
 * the caller's cue to release its quota reservation and fail loudly.
 */
export async function recordDispatchIntent(
  // deno-lint-ignore no-explicit-any
  client: any,
  params: {
    keyId: string;
    workspaceId: string;
    socialAccountId: string;
    idempotencyKey: string;
    summary: Record<string, unknown>;
  },
): Promise<RecordIntentResult> {
  const intentId = crypto.randomUUID();
  const { error } = await client
    .from("partner_dispatch_intents")
    .insert(
      {
        id: intentId,
        workspace_id: params.workspaceId,
        key_id: params.keyId,
        social_account_id: params.socialAccountId,
        idempotency_key: params.idempotencyKey,
        state: "intended",
        request_summary: params.summary,
      },
      // The natural key. DO NOTHING, not DO UPDATE: a conflicting row belongs
      // to a previous attempt and must be READ, never overwritten.
      { onConflict: "key_id,idempotency_key", ignoreDuplicates: true },
    );
  if (error) {
    throw new Error(`Dispatch intent write failed: ${error.message}`);
  }

  // The insert reported nothing about whether it inserted (DO NOTHING
  // swallows the conflict), so the row is read back explicitly.
  const { data: existing, error: readError } = await client
    .from("partner_dispatch_intents")
    .select("id, state, wamid, http_status, response_body")
    .eq("key_id", params.keyId)
    .eq("idempotency_key", params.idempotencyKey)
    .maybeSingle();
  if (readError) {
    throw new Error(`Dispatch intent read-back failed: ${readError.message}`);
  }
  if (!existing) {
    // The row we just inserted cannot vanish (no delete grant exists), so
    // this is not a legitimate state -- failing loudly beats dispatching on
    // the strength of a write we cannot confirm.
    throw new Error("Dispatch intent neither inserted nor found after insert");
  }
  if (existing.id === intentId) return { status: "recorded", intentId };
  return { status: "existing", row: existing as DispatchIntentRow };
}

/**
 * A takeover's verdict on an `intended` row it does not own (3.3): the
 * outcome is unknown, so the row becomes `indeterminate` and nothing may
 * ever dispatch against this idempotency key again.
 *
 * Atomic compare-and-set (`WHERE state = 'intended'`), then a re-read: if
 * the CAS affected nothing, a concurrent writer (the webhook, or a crash
 * survivor that settled late) moved the row first, and the state NOW held is
 * returned so the caller reacts to reality rather than to its stale read.
 *
 * Throws on database errors, matching markIndeterminate's reasoning: if this
 * verdict is lost, the caller must not soften it into a dispatch.
 */
export async function takeoverIntentToIndeterminate(
  // deno-lint-ignore no-explicit-any
  client: any,
  intentId: string,
): Promise<DispatchIntentState> {
  const { error } = await client
    .from("partner_dispatch_intents")
    .update({ state: "indeterminate", resolved_at: new Date().toISOString() })
    .eq("id", intentId)
    .eq("state", "intended");
  if (error) {
    throw new Error(`Dispatch intent takeover failed: ${error.message}`);
  }

  const { data: row, error: readError } = await client
    .from("partner_dispatch_intents")
    .select("state")
    .eq("id", intentId)
    .maybeSingle();
  if (readError || !row) {
    throw new Error(
      `Dispatch intent state unreadable after takeover: ${readError?.message ?? "row gone"}`,
    );
  }
  return row.state as DispatchIntentState;
}

/**
 * `intended -> sent`: the provider accepted and named the message. Records
 * the wamid AND the normalized response, because a crash between this write
 * and the idempotency settle leaves the takeover of the future holding only
 * this row -- and it must be able to replay the outcome verbatim instead of
 * guessing.
 *
 * Errors are logged, never thrown: the message has been accepted by the
 * provider by the time this runs, and failing the request here would report
 * a delivered message as failed -- the exact inversion the send path's
 * bookkeeping rules forbid. The CAS on `intended` means a webhook that
 * reconciled the row first (proving the same send) wins harmlessly.
 */
export async function markIntentSent(
  // deno-lint-ignore no-explicit-any
  client: any,
  intentId: string,
  wamid: string,
  httpStatus: number,
  body: unknown,
): Promise<void> {
  const { error } = await client
    .from("partner_dispatch_intents")
    .update({
      state: "sent",
      wamid,
      http_status: httpStatus,
      response_body: body,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", intentId)
    .eq("state", "intended");
  if (error) {
    console.error("[partner-dispatch] intent sent-mark failed:", error.message);
  }
}

/**
 * `intended -> failed`: the provider rejected the send with an error that
 * PROVES non-delivery (a typed 4xx rejection). A timeout, 5xx or unparseable
 * body never reaches this function -- those are indeterminate-class and the
 * row deliberately stays `intended` (the request-level record carries the
 * verdict instead).
 *
 * Same log-only error policy as markIntentSent, for the same reason: the
 * provider has already answered.
 */
export async function markIntentFailed(
  // deno-lint-ignore no-explicit-any
  client: any,
  intentId: string,
  httpStatus: number,
  body: unknown,
): Promise<void> {
  const { error } = await client
    .from("partner_dispatch_intents")
    .update({
      state: "failed",
      http_status: httpStatus,
      response_body: body,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", intentId)
    .eq("state", "intended");
  if (error) {
    console.error("[partner-dispatch] intent failed-mark failed:", error.message);
  }
}

/**
 * Reconciliation (3.4): a status webhook carrying this intent's id in
 * `biz_opaque_callback_data`.
 *
 * The EXISTENCE of the status is the positive signal -- it proves Meta
 * accepted and dispatched the message, whatever the delivery outcome it
 * reports (`failed` delivery statuses still prove the send happened, and
 * reconcile dispatch, not delivery). This is the ONLY thing that resolves an
 * `indeterminate` row, and it can never make anything resendable: the
 * transition trigger refuses every path back toward `intended`.
 *
 * Accepts `intended` as a source state deliberately: an attempt that crashed
 * mid-flight (or that observed an unknown outcome, which by design writes no
 * intent state) leaves its row `intended`, and a webhook arriving for it is
 * exactly the positive evidence that row is waiting for.
 *
 * Errors are logged, never thrown: reconciliation is an improvement, not a
 * precondition (decision record §2), and a failure here must not break the
 * webhook's delivery reporting for every other message in the batch.
 */
export async function reconcileDispatchIntentByEcho(
  // deno-lint-ignore no-explicit-any
  client: any,
  intentId: string,
  wamid: string,
): Promise<void> {
  const { error } = await client
    .from("partner_dispatch_intents")
    .update({
      state: "reconciled_sent",
      wamid,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", intentId)
    // `failed` is excluded on purpose: a proven-not-delivered send cannot
    // produce a status, so a "positive" signal for one means something is
    // deeply wrong and must not be papered over.
    .in("state", ["intended", "indeterminate", "sent"]);
  if (error) {
    console.error("[partner-dispatch] intent reconcile failed:", error.message);
  }
}
