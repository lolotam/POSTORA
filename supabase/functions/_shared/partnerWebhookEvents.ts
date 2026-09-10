/**
 * The event vocabulary and the fan-out that turns one occurrence into outbox
 * rows (deliverables 5.2, 5.7).
 *
 * Design record: docs/decisions/2026-09-02-d5-webhook-substrate.md.
 */

/**
 * The events a subscription may name -- a CLOSED allowlist, and the mechanism
 * that stops this phase becoming an implicit promise.
 *
 * D6 originally shipped events only once their transition, stable identifier and
 * TRANSACTIONAL producer were defined. The WhatsApp lifecycle additions below
 * are explicitly best-effort observations after persistence: an outbox failure
 * must not block activation or history completion. `webhook.test` is certifiable
 * precisely because it has no external producer: its transition is "a partner
 * asked", its occurrence id is minted at request time, and its enqueue is the
 * request's own write. There is nothing to crash between.
 *
 * Phase 6 (2026-09-02) certifies six more, each via a SECURITY DEFINER SQL
 * function that performs the state change AND the fan-out in one statement --
 * see migration 20260902130000 and the Phase 6 decision record:
 *
 *   message.received                 partner_upsert_whatsapp_message /
 *                                    partner_import_whatsapp_message_batch
 *   message.accepted                 partner_settle_dispatch_intent_sent /
 *                                    partner_reconcile_dispatch_intent_sent
 *   message.delivered/.read/.failed  partner_apply_whatsapp_message_status
 *                                    (WhatsApp Cloud only -- unavailable in
 *                                    Evolution QR mode)
 *   account.reauthorization_required partner_record_refresh_failure
 *
 * account.connected / account.disconnected are deliberately STILL ABSENT: the
 * activation transition has 24 genuine commit points across 15 files
 * (ledger, resolved inventory) and the correct mechanism is a database
 * trigger, not hand-wired enqueues. Advertising them before that exists
 * would be the implicit promise this list exists to prevent.
 *
 * The database CHECK on partner_webhooks.events enforces the same list, so a
 * widening needs both a migration and this constant -- deliberately two
 * deliberate acts.
 */
export const CERTIFIED_EVENT_TYPES = [
  "webhook.test",
  "message.received",
  "message.accepted",
  "message.delivered",
  "message.read",
  "message.failed",
  "account.reauthorization_required",
  // Phase 8 (2026-09-02): a database trigger on posts is the producer
  // (migration 20260902150000), so EVERY schedule writer -- /v1 and all six
  // browser paths -- emits transactionally. post.published / post.failed have
  // a live producer since Phase 7 (partner_settle_platform_post) but stay
  // uncertified until the seam has settled one real publish in production --
  // the owner's observation gate. Certify them by widening the DB CHECK and
  // this list together, nothing else.
  "post.scheduled",
  // Number lifecycle: syncEvolutionAccountConnection; history: importEvolutionHistory.
  // These cover the shared Evolution QR paths, not generic account.* writers.
  "whatsapp_number.connected",
  "whatsapp_number.disconnected",
  "history_sync.completed",
  // Table trigger covers browser, escalation and /v1; emission failures do not block writers.
  "conversation.assigned",
  "conversation.unassigned",
] as const;

export type CertifiedEventType = typeof CERTIFIED_EVENT_TYPES[number];

export function isCertifiedEventType(value: string): value is CertifiedEventType {
  return (CERTIFIED_EVENT_TYPES as readonly string[]).includes(value);
}

export interface WebhookEventOccurrence {
  workspaceId: string;
  eventType: CertifiedEventType;
  /**
   * Identifies the TRANSITION, not the resource. `<event_type>:<stable key>`,
   * because `message.delivered` and `message.read` for one message share a
   * provider id -- keyed on the resource alone the second silently collides
   * with the first and the outbox drops the event it exists to guarantee.
   */
  occurrenceId: string;
  payload: Record<string, unknown>;
  /** Narrowing filters. null means the occurrence is not platform/account specific. */
  platform: string | null;
  accountId: string | null;
  occurredAt?: string;
  /**
   * Restrict the fan-out to ONE subscription.
   *
   * Fan-out is right for a real event: a transition happened in the world and
   * every subscription that asked about it should hear. It is wrong for
   * `POST /v1/webhooks/{id}/test`, which is a request to exercise ONE
   * endpoint. Without this, testing one subscription posts that test to every
   * other subscription in the workspace whose filters happen to be compatible
   * -- so a partner debugging endpoint A wakes endpoints B and C, and reads
   * the arriving payload as evidence about A.
   */
  restrictToWebhookId?: string;
}

interface SubscriptionRow {
  id: string;
  secret_version: number;
  platform: string | null;
  social_account_id: string | null;
}

export interface EnqueueResult {
  /** Rows the insert created. A repeat of the same occurrence enqueues 0. */
  enqueued: number;
  matched: number;
}

/**
 * Fan one occurrence out to every subscription that matches it.
 *
 * One event matching three subscriptions is THREE rows: deduplication is per
 * subscription because delivery is. Zero rows for non-matching subscriptions
 * is the other half of the same invariant, and the half a "delivered at least
 * once" test never notices is missing.
 */
export async function enqueuePartnerWebhookEvent(
  // deno-lint-ignore no-explicit-any
  admin: any,
  occurrence: WebhookEventOccurrence,
): Promise<EnqueueResult> {
  // Platform and account filters are applied HERE rather than in the query,
  // and that is not laziness. Each is an "is null OR equals" disjunction, and
  // PostgREST's `.or()` does not compose -- a second call REPLACES the first
  // rather than ANDing with it, which shipped as a real bug in PR #35. Two
  // disjunctions would need one hand-built or-string, and a hand-built
  // or-string is where a stray comma becomes a filter that matches everything.
  // The candidate set is one workspace's subscriptions, so filtering in
  // TypeScript costs nothing and cannot be got subtly wrong.
  const { data, error } = await admin
    .from("partner_webhooks")
    .select("id, secret_version, platform, social_account_id")
    .eq("workspace_id", occurrence.workspaceId)
    .eq("is_active", true)
    .contains("events", [occurrence.eventType]);

  if (error) throw new Error(`webhook subscription lookup failed: ${error.message}`);

  const matching = ((data ?? []) as SubscriptionRow[]).filter((row) =>
    // An unset filter means "no narrowing", so it matches. A SET filter that
    // disagrees with the occurrence excludes it -- a filter may only ever
    // remove subscriptions from a match, never add one.
    (row.platform === null || row.platform === occurrence.platform) &&
    (row.social_account_id === null || row.social_account_id === occurrence.accountId) &&
    // ...and the caller's own restriction obeys the same rule: it can only
    // narrow. A restriction naming a subscription that fails the other axes
    // still matches nothing.
    (occurrence.restrictToWebhookId === undefined ||
      row.id === occurrence.restrictToWebhookId)
  );

  if (matching.length === 0) return { enqueued: 0, matched: 0 };

  const rows = matching.map((row) => ({
    webhook_id: row.id,
    workspace_id: occurrence.workspaceId,
    event_type: occurrence.eventType,
    event_occurrence_id: occurrence.occurrenceId,
    payload: occurrence.payload,
    // Captured at ENQUEUE. Reading the secret at send time instead would
    // re-sign a mid-ladder retry under a rotated secret, changing the
    // signature of an event whose id is immutable.
    secret_version: row.secret_version,
    ...(occurrence.occurredAt ? { occurred_at: occurrence.occurredAt } : {}),
  }));

  const { data: inserted, error: insertError } = await admin
    .from("partner_webhook_deliveries")
    // ignoreDuplicates, not an error: re-enqueuing the same occurrence is the
    // NORMAL outcome of a producer retry, and the UNIQUE constraint absorbing
    // it is exactly the dedup the outbox is for.
    .upsert(rows, { onConflict: "webhook_id,event_occurrence_id", ignoreDuplicates: true })
    .select("id");

  if (insertError) {
    throw new Error(`webhook delivery enqueue failed: ${insertError.message}`);
  }

  return { enqueued: (inserted ?? []).length, matched: matching.length };
}
