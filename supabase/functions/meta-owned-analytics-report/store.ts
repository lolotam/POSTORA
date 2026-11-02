import { z } from "https://esm.sh/zod@3.25.76";
import { ANALYTICS_METRIC_KEYS, UNAVAILABLE_REASONS } from "../_shared/analyticsContract.ts";
import { awaitWithAbort } from "../_shared/abort.ts";

const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const cell = z.object({ metric_key: z.enum(ANALYTICS_METRIC_KEYS), status: z.enum(["available", "unavailable"]), value: count.nullable(),
  reason: z.enum(UNAVAILABLE_REASONS).nullable(), provider_metric: z.string().nullable(), api_version: z.string(),
  window_kind: z.enum(["day", "lifetime", "point_in_time", "period_total"]), provider_timezone: z.string().nullable(),
  window_since: instant.nullable(), window_until: instant.nullable(), source_ref: z.string(), observed_at: instant, collected_at: instant });
const bucket = z.object({ metric_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), period_start: instant, period_end: instant, provider_timezone: z.string() });
const post = z.object({ platform_post_id: z.string().min(1).max(200), published_at: instant, post_text: z.string().max(10000),
  permalink: z.string().nullable(), captured_on: z.string() });
const latest = z.object({ state: z.enum(["pending", "running", "partial", "success", "failed", "retry"]),
  reason_code: z.string().nullable(), retry_at: instant.nullable(), due_at: instant, next_due_at: instant, completed_at: instant.nullable() });
const snapshot = z.object({ ok: z.literal(true), account_id: z.string().uuid(), platform: z.enum(["facebook", "threads"]),
  revision: z.number().int().positive().safe().nullable(), retention_floor: instant.nullable(), as_of: instant, since: instant, until: instant,
  previous_since: instant, timezone: z.string(), health: z.object({ active: z.boolean(), needs_reauth: z.boolean(), token_expired: z.boolean() }).strict(),
  inventory: z.object({ complete: z.boolean(), truncated: z.boolean() }).strict(),
  daily: z.array(z.object({ bucket, metrics: z.array(cell).max(15) })).max(180),
  posts: z.array(z.object({ post, metrics: z.array(cell).max(15) })).max(26),
  profile_boundaries: z.array(cell.extend({ boundary: instant })).max(45),
  profile_current: z.array(cell).max(15),
  period_totals: z.array(cell.extend({ window_kind: z.literal("period_total").default("period_total"), level: z.enum(["account", "post"]), subject_id: z.string() })).max(30),
  collection: z.object({ last_success_at: instant.nullable(), last_partial_at: instant.nullable(), latest: latest.nullable(), syncing: z.boolean() }) }).strict();
const refusal = z.object({ ok: z.literal(false), reason: z.enum(["history_revision_changed", "history_expired"]) }).strict();
export type StoredAnalyticsCell = z.infer<typeof cell>;
export type StoredAnalyticsSnapshot = z.infer<typeof snapshot>;
export type StoredAnalyticsRpc = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<unknown>;

export class PersistedReportRefused extends Error {
  constructor(readonly reason: "storage_unavailable" | "invalid_contract" | "account_not_found" | "history_revision_changed" | "history_expired" | "invalid_cursor", readonly status: number) {
    super(`Persisted analytics report refused: ${reason}`);
    this.name = "PersistedReportRefused";
  }
}

export async function readStoredAnalytics(input: { rpc: StoredAnalyticsRpc; platform: "facebook" | "threads"; ownerId: string;
  accountId: string; request: Record<string, unknown>; signal: AbortSignal }): Promise<StoredAnalyticsSnapshot> {
  let envelope: unknown;
  try { envelope = await awaitWithAbort(() => input.rpc("read_meta_owned_analytics_history", { p_platform: input.platform,
    p_user_id: input.ownerId, p_account_id: input.accountId, p_request: input.request }, input.signal), input.signal); }
  catch { throw new PersistedReportRefused("storage_unavailable", 503); }
  const decoded = z.object({ data: z.unknown(), error: z.unknown() }).safeParse(envelope);
  if (!decoded.success || !Object.hasOwn(decoded.data, "data") || !Object.hasOwn(decoded.data, "error")) throw new PersistedReportRefused("invalid_contract", 503);
  if (decoded.data.error !== null) {
    const error = z.object({ code: z.string() }).safeParse(decoded.data.error);
    throw new PersistedReportRefused(error.success && error.data.code === "MAH02" ? "account_not_found" : "storage_unavailable", error.success && error.data.code === "MAH02" ? 404 : 503);
  }
  const refused = refusal.safeParse(decoded.data.data);
  if (refused.success) throw new PersistedReportRefused(refused.data.reason, refused.data.reason === "history_expired" ? 410 : 409);
  const stored = snapshot.safeParse(decoded.data.data);
  if (!stored.success || stored.data.account_id !== input.accountId.toLowerCase() || stored.data.platform !== input.platform) throw new PersistedReportRefused("invalid_contract", 503);
  return stored.data;
}
