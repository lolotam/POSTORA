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
 * Per-minute rate limit via an atomic bucket.
 *
 * Counting rows in the usage ledger and inserting afterwards would be the
 * same count-then-insert race the spec rejects — concurrent requests all read
 * the same stale count and all pass. consume_partner_rate does the increment
 * and the read in one statement.
 */
export async function checkRateLimit(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { data, error } = await client.rpc("consume_partner_rate", {
    p_key_id: record.id,
    p_limit: record.rateLimitPerMin,
  });
  if (error) return; // Never fail a send because the limiter is unavailable.
  if (data === false) {
    throw new PartnerAuthError("Rate limit exceeded", "rate_limited", 429);
  }
}

/**
 * Append to the usage ledger. Swallows its own errors on purpose: losing an
 * audit row must never turn a delivered message into a reported failure.
 */
export async function recordUsage(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: UsageInput,
): Promise<void> {
  try {
    const { error } = await client.from("partner_api_usage").insert({
      key_id: input.keyId,
      workspace_id: input.workspaceId,
      action: input.action,
      billable: input.billable,
      http_status: input.httpStatus,
      error_code: input.errorCode ?? null,
    });
    if (error) console.error("[partner-api] usage ledger write failed:", error.message);
  } catch (err) {
    console.error("[partner-api] usage ledger threw:", err);
  }
}
