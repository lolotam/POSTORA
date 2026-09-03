// Rate limiting, monthly quota, and the usage ledger for partner API keys.
//
// Deliberately NOT built on api_logs: that table is keyed by (user_id,
// endpoint) with no key column, and the existing ecommerce limiter counts
// then inserts, which two concurrent requests can both pass.

import { type PartnerKeyRecord, PartnerAuthError } from "./partnerApiKeys.ts";

export interface UsageInput {
  keyId: string;
  workspaceId: string;
  action: string;
  billable: boolean;
  httpStatus: number;
  errorCode?: string;
  /** The X-Postora-Request-Id the response carried; the operator's only correlation handle. */
  requestId?: string;
  /** Wall-clock ms from request entry to response. Rounded and floored at 0 on write. */
  latencyMs?: number;
}

/**
 * Reserve one unit of monthly quota before sending. Returns false when the
 * reservation would exceed quota — the caller must then settle the pending
 * idempotency claim rather than leaving it in `processing`.
 *
 * Reserve/settle rather than consume-on-entry, because the plan promises a
 * partner is charged only for messages Meta accepted.
 */
export async function reserveQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<boolean> {
  const { data, error } = await client.rpc("reserve_partner_quota", {
    p_key_id: record.id,
  });
  if (error) {
    throw new PartnerAuthError("Quota check failed", "internal_error", 500);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return Boolean(row?.allowed);
}

/** Refund a reservation after Meta DEFINITELY rejected the send. Never call
 *  this for an indeterminate outcome — the message may have been delivered. */
export async function releaseQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("release_partner_quota", { p_key_id: record.id });
  if (error) console.error("[partner-api] quota release failed:", error.message);
}

/** Move a reservation to confirmed after the provider definitely accepted the message. */
export async function confirmQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("confirm_partner_quota", { p_key_id: record.id });
  if (error) console.error("[partner-api] quota confirm failed:", error.message);
}

/** Move a reservation to indeterminate when the provider outcome is unknown — the message may have been delivered. */
export async function indeterminateQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("indeterminate_partner_quota", { p_key_id: record.id });
  if (error) console.error("[partner-api] quota indeterminate failed:", error.message);
}

/**
 * Non-send actions never reserve quota, so they update last_used_at here.
 *
 * Failure is logged, not thrown: a missing last_used_at stamp must never turn a
 * successful read into an error for the caller.
 */
export async function touchKey(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("touch_partner_key", { p_key_id: record.id });
  if (error) console.error("[partner-api] touch key failed:", error.message);
}

/**
 * D7 limiter-failure risk classes (POSTORA-PARTNER-API-SPEC-v1 §D7).
 *
 * A — bounded local read:    fail OPEN, the limiter outage costs nothing.
 * B — external or unbounded: fail CLOSED.
 * C — mutation or amplifier: fail CLOSED.
 *
 * The classes live here so the failure policy stays with the limiter; the
 * action→class assignment lives with the action registry in
 * partner-api/router.ts so no action can be added without choosing a class.
 */
export type LimiterRiskClass = "A" | "B" | "C";

/**
 * The numbers the X-RateLimit-* headers publish, as computed by Postgres from
 * the same minute bucket the counter just consumed.
 */
export interface RateLimitBudget {
  limit: number;
  remaining: number;
  /** Seconds until the consumed window ends (always 1..60), measured by the
   *  same Postgres clock that picked the bucket — never a local clock. */
  resetSeconds: number;
}

/**
 * Whether the limiter answered for this key. "resolved" carries the budget
 * the RPC reported, so callers publish real numbers instead of inventing
 * them; "unavailable" means no budget was resolved, so no budget numbers may
 * appear in any header. The D7 fail-open/fail-closed enforcement happens
 * inside checkRateLimit and cannot be bypassed by ignoring the return value.
 */
export type RateLimitDecision =
  | ({ status: "resolved" } & RateLimitBudget)
  | { status: "unavailable" };

/**
 * Thrown when the limiter ran and refused the call. Carries the
 * database-computed seconds until the window that refused it ends, so the
 * 429's Reset and Retry-After come from the clock that consumed the bucket.
 * Null only when the RPC's shape drifted on the refusal path: a refusal
 * stays a refusal, but a reset nobody actually computed must not be
 * published as one.
 */
export class RateLimitedError extends PartnerAuthError {
  public readonly resetSeconds: number | null;
  constructor(resetSeconds: number | null) {
    super("Rate limit exceeded", "rate_limited", 429);
    this.name = "RateLimitedError";
    this.resetSeconds = resetSeconds;
  }
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * consume_partner_rate_v2 derives reset_seconds from one now() with
 * CEIL(window_end - now()), so it is mathematically 1..60. Anything outside
 * that range — 0, negative, over 60, fractional — is not a value the real
 * function can produce, and must not be published as if it were.
 */
function validResetSeconds(value: unknown): number | null {
  const n = safeInteger(value);
  return n !== null && n >= 1 && n <= 60 ? n : null;
}

/**
 * Per-minute rate limit via an atomic bucket.
 *
 * Counting rows in the usage ledger and inserting afterwards would be the
 * same count-then-insert race the spec rejects — concurrent requests all read
 * the same stale count and all pass. consume_partner_rate_v2 does the
 * increment, the decision, AND the header numbers (remaining, seconds until
 * the window ends) in one statement, so every published number describes the
 * exact bucket that was charged.
 *
 * On RPC error this does NOT silently proceed (D7): a limiter outage plus a
 * partner retry loop is exactly what rate limiting exists to prevent. Only a
 * class-A bounded local read may continue unthrottled; everything else —
 * including an action nobody assigned a class to — fails closed with a
 * retryable 503. A refused request is harmless; an unthrottled send is not.
 */
export async function checkRateLimit(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
  riskClass: LimiterRiskClass | undefined,
): Promise<RateLimitDecision> {
  const { data, error } = await client.rpc("consume_partner_rate_v2", {
    p_key_id: record.id,
    p_limit: record.rateLimitPerMin,
  });
  if (error) {
    if (riskClass === "A") {
      console.error("[partner-api] rate limiter unavailable; class A proceeding unthrottled:", error.message);
      return { status: "unavailable" };
    }
    console.error(`[partner-api] rate limiter unavailable (class ${riskClass ?? "unclassified"}); failing closed:`, error.message);
    throw new PartnerAuthError("Rate limiter is unavailable; retry shortly", "limiter_unavailable", 503);
  }

  // PostgREST returns a bare object for a RETURNS TABLE rpc on the current
  // self-hosted build but has returned a one-element array on others; accept
  // both so the verdict never depends on the gateway version.
  //
  // EXACTLY one element, though. Taking data[0] from an array of any length
  // silently discards the rest, so a two-row result whose first row happens to
  // say allowed:true would be read as an allow. consume_partner_rate_v2
  // returns a single row by construction, so more than one is drift, and drift
  // must be indistinguishable from the limiter being down.
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : undefined) : data;

  // The limiter's verdict is real ONLY when it arrives in the exact shape the
  // v2 function produces: an object whose `allowed` is a literal boolean and
  // — when allowed — whose remaining and reset_seconds are present and in
  // range. Anything else (null, undefined, a bare boolean from the v1
  // signature, or a record from a drifted RPC) is treated as the limiter
  // being unavailable, NEVER as allowed.
  //
  // This is the hardening this function already carried for the v1 boolean
  // shape, carried forward: testing `allowed === false` alone and treating
  // everything else as allowed reintroduces the exact fail-open D7 removes,
  // just through a narrower door. In a migration-first self-hosted stack an
  // RPC whose shape has drifted is a realistic failure, not a hypothetical
  // one, and it must be indistinguishable from the limiter being down.
  const unexpected = (): RateLimitDecision => {
    console.error(
      `[partner-api] rate limiter returned an unexpected result (class ${riskClass ?? "unclassified"}); treating as unavailable:`,
      JSON.stringify(data),
    );
    if (riskClass === "A") return { status: "unavailable" };
    throw new PartnerAuthError("Rate limiter is unavailable; retry shortly", "limiter_unavailable", 503);
  };

  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return unexpected();
  }
  const { allowed, remaining, reset_seconds } = row as Record<string, unknown>;

  if (allowed === true) {
    const remainingN = safeInteger(remaining);
    const resetN = validResetSeconds(reset_seconds);
    // An "allowed" verdict without real numbers is not a resolution: the
    // response would have to invent Remaining or Reset, which is precisely
    // what this rework removed the need for.
    //
    // The upper bound is EXCLUSIVE, and that is not a nicety. remaining is
    // GREATEST(limit - count, 0) and the row this call just consumed makes
    // count >= 1, so the largest value the real function can return is
    // limit - 1. `remaining === limit` therefore describes a window nothing
    // was charged to: it is arithmetically impossible from
    // consume_partner_rate_v2 and is evidence the answer came from somewhere
    // else. An earlier version of this check used `> limit` and accepted that
    // exact value -- publishing it hands a partner one request of budget that
    // does not exist.
    if (
      remainingN === null || resetN === null ||
      remainingN < 0 || remainingN >= record.rateLimitPerMin
    ) {
      return unexpected();
    }
    return {
      status: "resolved",
      limit: record.rateLimitPerMin,
      remaining: remainingN,
      resetSeconds: resetN,
    };
  }
  if (allowed === false) {
    // The refusal itself proves no requests remain in the window, so the
    // caller may publish Remaining 0 without an RPC number; Reset and
    // Retry-After are publishable only when the RPC actually provided one.
    throw new RateLimitedError(validResetSeconds(reset_seconds));
  }
  return unexpected();
}

/** The two columns migration 20260902200000 adds. A deploy that reaches
 *  production before that migration is applied must still write the row. */
const LEDGER_TELEMETRY_COLUMNS = ["request_id", "latency_ms"] as const;

/**
 * True when PostgREST refused the insert because it does not know one of the
 * telemetry columns yet (PGRST204). Any other error is a real failure and is
 * reported, not retried — a retry loop over an unknown fault writes nothing
 * and hides the cause.
 */
function isMissingTelemetryColumn(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST204") return true;
  const message = error.message ?? "";
  return message.includes("schema cache") &&
    LEDGER_TELEMETRY_COLUMNS.some((column) => message.includes(`'${column}'`));
}

/**
 * Append to the usage ledger. Swallows its own errors on purpose: losing an
 * audit row must never turn a delivered message into a reported failure.
 *
 * Merging deploys this function while migrations are applied by hand, so this
 * code can reach production before the columns it writes exist. PostgREST
 * rejects the WHOLE insert when it does not know a column, which would drop
 * the billing row entirely rather than just its telemetry — so a refusal for
 * exactly that reason is retried without the two new fields, leaving them
 * NULL, which is what they are for every row written before this change.
 */
export async function recordUsage(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: UsageInput,
): Promise<void> {
  const row: Record<string, unknown> = {
    key_id: input.keyId,
    workspace_id: input.workspaceId,
    action: input.action,
    billable: input.billable,
    http_status: input.httpStatus,
    error_code: input.errorCode ?? null,
    request_id: input.requestId ?? null,
    // The column CHECK refuses a negative; a clock that ran backwards must
    // not cost the row.
    latency_ms: input.latencyMs === undefined ? null : Math.max(0, Math.round(input.latencyMs)),
  };

  try {
    const { error } = await client.from("partner_api_usage").insert(row);
    if (!error) return;

    if (!isMissingTelemetryColumn(error)) {
      console.error("[partner-api] usage ledger write failed:", error.message);
      return;
    }

    console.warn(
      "[partner-api] usage ledger: telemetry columns are missing, writing without them —",
      "apply migration 20260902200000_admin_partner_hub.sql",
    );
    const legacyRow = { ...row };
    for (const column of LEDGER_TELEMETRY_COLUMNS) delete legacyRow[column];
    const retry = await client.from("partner_api_usage").insert(legacyRow);
    if (retry.error) {
      console.error("[partner-api] usage ledger write failed:", retry.error.message);
    }
  } catch (err) {
    console.error("[partner-api] usage ledger threw:", err);
  }
}
