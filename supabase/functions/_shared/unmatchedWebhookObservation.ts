// Records inbound webhook events that matched no connected account.
//
// The gap this closes: every "no matching account" branch in the webhook handlers
// currently logs one console.warn and drops the event. On 2026-08-24 that cost an hour of
// `docker logs` archaeology to work out that a user's Instagram DMs were arriving for an
// account they had never connected. See
// docs/investigations/2026-08-24-autoverse-instagram-n8n-trigger-no-events.md
//
// Nothing here may change how an event is routed. These are observations taken alongside
// the existing warns, never in place of them.

export type UnmatchedPlatform = "facebook" | "instagram" | "whatsapp";
export type UnmatchedEventKind = "message" | "comment" | "unknown";
export type UnmatchedReason = "unknown_recipient" | "account_inactive";

export interface UnmatchedObservation {
  recipient_id: string;
  event_kind: UnmatchedEventKind;
  reason: UnmatchedReason;
  summary: Record<string, unknown>;
  social_account_id?: string;
  user_id?: string;
}

interface BuildInput {
  recipientId: string;
  eventKind: UnmatchedEventKind;
  /** The account found by a diagnostic lookup that ignores is_active, if any. */
  inactiveAccount?: { id: string; user_id: string } | null;
  /** The raw Meta `entry`, when the observation came from one. */
  entry?: Record<string, unknown> | null;
  /** The raw `changes[]` element, for comment and WhatsApp field events. */
  change?: Record<string, unknown> | null;
}

/**
 * Envelope shape only — never content.
 *
 * This deliberately records key *names* and event *kinds*, never message text, media
 * URLs, profile names, or sender identifiers. Two reasons: the table is readable by the
 * owning user for account_inactive rows, so anything stored here can reach someone who
 * was not party to the conversation; and the existing "produced no inbound message" log
 * in facebook-instagram-webhook already sets exactly this precedent, explicitly dropping
 * `sender` and `recipient` from the keys it prints.
 */
export function buildObservation(input: BuildInput): UnmatchedObservation {
  const { recipientId, eventKind, inactiveAccount, entry, change } = input;
  const messaging = Array.isArray((entry as { messaging?: unknown[] })?.messaging)
    ? ((entry as { messaging: Record<string, unknown>[] }).messaging)
    : [];
  const changes = Array.isArray((entry as { changes?: unknown[] })?.changes)
    ? ((entry as { changes: Record<string, unknown>[] }).changes)
    : [];

  const summary: Record<string, unknown> = {};
  if (entry) {
    summary.entry_keys = Object.keys(entry);
    if (entry.time !== undefined) summary.entry_time = entry.time;
    if (messaging.length > 0) {
      summary.messaging_kinds = messaging.map((event) =>
        Object.keys(event || {}).filter((key) =>
          key !== "sender" && key !== "recipient" && key !== "timestamp"
        )
      );
    }
    if (changes.length > 0) {
      summary.change_fields = changes.map((entryChange) => entryChange?.field);
    }
  }
  if (change?.field !== undefined) summary.change_field = change.field;

  return {
    recipient_id: recipientId,
    event_kind: eventKind,
    // An inactive row means the recipient IS a Postora account, just a disconnected one.
    // That distinction is the difference between "reconnect this account" and "you
    // connected the wrong account entirely", and the handlers cannot tell them apart on
    // their own because both account resolvers filter is_active = true.
    reason: inactiveAccount ? "account_inactive" : "unknown_recipient",
    summary,
    ...(inactiveAccount
      ? { social_account_id: inactiveAccount.id, user_id: inactiveAccount.user_id }
      : {}),
  };
}

/**
 * Writes a request's observations in one call.
 *
 * Batched on purpose. The caller wraps this in runInBackground, whose degraded path (no
 * EdgeRuntime.waitUntil) awaits up to 2s per invocation — so calling per event would put
 * that cost on Meta's acknowledgement once per event rather than once per request.
 *
 * Best-effort by contract: this must never throw. The handlers it runs inside return 500
 * from their outer catch, and a 500 makes Meta redeliver — turning a diagnostic write
 * into a delivery bug would be a strictly worse outcome than losing the diagnostic.
 */
export async function flushObservations(
  // PromiseLike, not Promise: supabase-js returns a thenable query builder from rpc(),
  // which satisfies `then` but not `catch`/`finally`. Typing the minimum this function
  // actually uses keeps a plain object usable as a fake in tests.
  adminClient: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error?: unknown }> },
  platform: UnmatchedPlatform,
  observations: UnmatchedObservation[],
): Promise<void> {
  if (observations.length === 0) return;
  try {
    const { error } = await adminClient.rpc("record_unmatched_webhook_observations", {
      p_platform: platform,
      p_observations: observations,
    });
    if (error) {
      console.error("[unmatched-observation] write failed:", error);
    }
  } catch (error) {
    console.error("[unmatched-observation] write threw:", error);
  }
}
