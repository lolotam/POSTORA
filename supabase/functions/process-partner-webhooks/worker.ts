/**
 * The partner webhook delivery worker (deliverables 5.3, 5.4).
 *
 * Design record: docs/decisions/2026-09-02-d5-webhook-substrate.md.
 *
 * Separated from index.ts so the whole tick -- claiming, the budget, the
 * signature, the settle, the backlog check -- is testable against a stubbed
 * Supabase boundary and a stubbed clock, with no HTTP server and no cron
 * secret. index.ts is the door; this is the work.
 */

import {
  backoffSecondsFor,
  deliverWebhook,
  deliveryHeaders,
  MAX_DELIVERY_ATTEMPTS,
  selectSigningSecret,
  signWebhookPayload,
  type WebhookSecretState,
} from "../_shared/partnerWebhookDelivery.ts";

export const WORKER_LIMITS = {
  /** Never more than this in one tick, however much budget is left. */
  claimLimit: 20,
  /** How many deliveries are in flight at once. */
  concurrency: 5,
  /**
   * 45s of a 60s worker ceiling. The remaining 15s is not slack -- it is what
   * settles the last wave and returns a response. A tick that spends its whole
   * budget delivering gets killed before it records what it did, and the rows
   * come back with a charged attempt and no result.
   */
  tickBudgetMs: 45_000,
  /**
   * Longer than a worst-case delivery (10s per hop x 2 hops + settle), short
   * enough that a killed worker's rows recover on the next tick.
   */
  leaseSeconds: 90,
  maxAttempts: MAX_DELIVERY_ATTEMPTS,
  /** Backlog age past which the tick writes a system_logs row. */
  backlogWarnAgeSeconds: 900,
} as const;

export type WorkerLimits = typeof WORKER_LIMITS;

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  workspace_id: string;
  event_type: string;
  event_occurrence_id: string;
  payload: Record<string, unknown>;
  secret_version: number;
  attempts: number;
}

interface WebhookTarget extends WebhookSecretState {
  id: string;
  url: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface WorkerOptions {
  // deno-lint-ignore no-explicit-any
  admin: any;
  fetcher?: Fetcher;
  now?: () => number;
  limits?: WorkerLimits;
}

export interface WorkerSummary {
  claimed: number;
  delivered: number;
  retried: number;
  exhausted: number;
  errors: number;
  elapsedMs: number;
}

/**
 * Whether a whole wave still fits in what is left of the tick.
 *
 * Asked BEFORE claiming, not after, and that ordering is the point: a claim
 * charges an attempt. Claiming rows the deadline then cuts off spends attempts
 * on deliveries that never happened, and after six such ticks the row is
 * exhausted and the endpoint auto-disabled without a single request having
 * been made.
 */
export function canStartAnotherWave(elapsedMs: number, limits: WorkerLimits): boolean {
  // One wave is at most one delivery's wall clock: 2 hops x 10s, plus a
  // settle. Rounded to 25s rather than measured, because the check must be
  // conservative in the direction that leaves the tick able to finish.
  const WAVE_WORST_CASE_MS = 25_000;
  return elapsedMs + WAVE_WORST_CASE_MS <= limits.tickBudgetMs;
}

async function loadTargets(
  // deno-lint-ignore no-explicit-any
  admin: any,
  webhookIds: string[],
): Promise<Map<string, WebhookTarget>> {
  const { data, error } = await admin
    .from("partner_webhooks")
    .select(
      "id, url, secret, secret_version, previous_secret, previous_secret_version, " +
        "previous_secret_expires_at",
    )
    .in("id", webhookIds);

  if (error) throw new Error(`webhook target lookup failed: ${error.message}`);
  return new Map(((data ?? []) as WebhookTarget[]).map((row) => [row.id, row]));
}

/**
 * Deliver one claimed row and settle it.
 *
 * Every exit path settles. A row that returns without settling keeps its lease
 * until it lapses, which turns a code path nobody thought about into a 90s
 * delay for that partner -- silent, and invisible except as backlog age.
 */
async function deliverOne(
  // deno-lint-ignore no-explicit-any
  admin: any,
  row: DeliveryRow,
  target: WebhookTarget | undefined,
  fetcher: Fetcher,
  now: () => number,
  limits: WorkerLimits,
): Promise<"delivered" | "pending" | "exhausted"> {
  if (!target) {
    // The subscription went away between the claim and here. Nothing to
    // deliver to and nothing to retry into, so spend the row rather than
    // leaving it to be re-claimed forever.
    return await settle(admin, row, false, null, "subscription no longer exists", limits, true);
  }

  const selected = selectSigningSecret(target, row.secret_version, new Date(now()));
  if (selected.reVersioned) {
    // The captured version is past its overlap and cannot be honoured. The row
    // records the version it was ACTUALLY signed with -- an unrecorded
    // re-signing is a receiver seeing one event id under two signatures with
    // nothing to explain it.
    await admin
      .from("partner_webhook_deliveries")
      .update({ secret_version: selected.version })
      .eq("id", row.id);
  }

  const body = JSON.stringify({
    id: `evt_${row.id}`,
    type: row.event_type,
    occurrence_id: row.event_occurrence_id,
    data: row.payload,
  });
  const timestampSeconds = Math.floor(now() / 1000);
  const signature = await signWebhookPayload(selected.secret, timestampSeconds, body);

  const outcome = await deliverWebhook(
    target.url,
    deliveryHeaders({
      eventType: row.event_type,
      // The DELIVERY ROW's id, immutable across every retry of this row. One
      // row per (subscription, occurrence), so a partner deduplicating on this
      // is deduplicating on the occurrence -- which is the guarantee D5
      // publishes.
      eventId: `evt_${row.id}`,
      timestampSeconds,
      signature,
    }),
    body,
    fetcher,
  );

  return await settle(admin, row, outcome.ok, outcome.statusCode, outcome.error, limits, false);
}

async function settle(
  // deno-lint-ignore no-explicit-any
  admin: any,
  row: DeliveryRow,
  ok: boolean,
  statusCode: number | null,
  error: string | null,
  limits: WorkerLimits,
  forceExhaust: boolean,
): Promise<"delivered" | "pending" | "exhausted"> {
  const backoff = forceExhaust ? null : backoffSecondsFor(row.attempts);
  const { data, error: rpcError } = await admin.rpc("settle_partner_webhook_delivery", {
    p_id: row.id,
    p_ok: ok,
    p_status_code: statusCode,
    p_error: error,
    p_backoff_seconds: backoff ?? 0,
    // Forcing exhaustion is expressed as "the ladder is one attempt shorter
    // than what has been spent", so there is ONE place that decides what
    // exhausted means -- the SQL -- rather than two that must agree.
    p_max_attempts: forceExhaust ? 0 : limits.maxAttempts,
  });
  if (rpcError) throw new Error(`settle failed: ${rpcError.message}`);
  return (data as "delivered" | "pending" | "exhausted") ?? "pending";
}

/**
 * A correct outbox accumulates undelivered rows in perfect silence, so the
 * tick reads its own backlog and says something when it is old.
 *
 * This is a log line, not an alert: Postora has no alerting stack, and
 * inventing one inside a Partner API phase would be scope theft. The metric
 * exists and is written where a human can find it; routing it to a pager is
 * ops work.
 */
async function reportBacklog(
  // deno-lint-ignore no-explicit-any
  admin: any,
  limits: WorkerLimits,
): Promise<void> {
  const { data, error } = await admin.rpc("partner_webhook_backlog");
  if (error) {
    console.error(`[partner-webhooks] backlog probe failed: ${error.message}`);
    return;
  }
  // A set-returning function reaches supabase-js as an ARRAY even when it
  // returns exactly one row; casting it straight to an object yields undefined
  // for every field and a probe that can never fire.
  const stats = Array.isArray(data) ? data[0] : data;
  if (!stats) return;

  const oldest = Number(stats.oldest_pending_age_secs ?? 0);
  const stuck = Number(stats.stuck_lease_count ?? 0);
  if (oldest < limits.backlogWarnAgeSeconds && stuck === 0) return;

  const { error: logError } = await admin.from("system_logs").insert({
    source: "process-partner-webhooks",
    category: "api",
    level: "warn",
    message: `Partner webhook backlog: oldest due delivery ${Math.round(oldest)}s old, ` +
      `${stuck} stuck lease(s)`,
    metadata: {
      pending: stats.pending_count ?? 0,
      delivering: stats.delivering_count ?? 0,
      exhausted: stats.exhausted_count ?? 0,
      stuck_leases: stuck,
      oldest_pending_age_secs: oldest,
      disabled_webhooks: stats.disabled_webhook_count ?? 0,
    },
  });
  if (logError) console.error(`[partner-webhooks] backlog log write failed: ${logError.message}`);
}

/** One tick. */
export async function runWebhookWorker(options: WorkerOptions): Promise<WorkerSummary> {
  const { admin } = options;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const limits = options.limits ?? WORKER_LIMITS;

  const startedAt = now();
  const summary: WorkerSummary = {
    claimed: 0,
    delivered: 0,
    retried: 0,
    exhausted: 0,
    errors: 0,
    elapsedMs: 0,
  };

  while (
    summary.claimed < limits.claimLimit &&
    canStartAnotherWave(now() - startedAt, limits)
  ) {
    const waveSize = Math.min(limits.concurrency, limits.claimLimit - summary.claimed);
    const { data, error } = await admin.rpc("claim_partner_webhook_deliveries", {
      p_limit: waveSize,
      p_lease_seconds: limits.leaseSeconds,
      p_max_attempts: limits.maxAttempts,
    });
    if (error) {
      console.error(`[partner-webhooks] claim failed: ${error.message}`);
      summary.errors++;
      break;
    }
    const rows = (data ?? []) as DeliveryRow[];
    if (rows.length === 0) break;
    summary.claimed += rows.length;

    const targets = await loadTargets(admin, [...new Set(rows.map((row) => row.webhook_id))]);

    const results = await Promise.all(rows.map(async (row) => {
      try {
        return await deliverOne(admin, row, targets.get(row.webhook_id), fetcher, now, limits);
      } catch (err) {
        // One row's failure must not abandon the rest of the wave. The row
        // keeps its lease and the next tick reclaims it.
        console.error(`[partner-webhooks] ${row.id} threw:`, err);
        return "error" as const;
      }
    }));

    for (const result of results) {
      if (result === "delivered") summary.delivered++;
      else if (result === "pending") summary.retried++;
      else if (result === "exhausted") summary.exhausted++;
      else summary.errors++;
    }
  }

  await reportBacklog(admin, limits);
  summary.elapsedMs = now() - startedAt;
  return summary;
}
