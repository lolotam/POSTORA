import type { MetricDefinition, UnavailableReason } from "../_shared/analyticsContract.ts";
import { unavailableMetric } from "../_shared/analyticsContract.ts";
import { alignedDailySeries, countMetric, type CompleteAnalyticsMetric, type DailyAnalyticsRow } from "../_shared/analyticsProjection.ts";
import type { MetaAnalyticsResult } from "../_shared/metaAnalyticsTransport.ts";
import type { AnalyticsCapture } from "./store.ts";
import { threadsSnapshotMetric } from "../threads-insights/analyticsProjection.ts";

export class CollectionProviderRefused extends Error {
  constructor(readonly reason: UnavailableReason | "rate_limited", readonly retryAt: string | null = null) {
    super(`Owned analytics provider refused: ${reason}`);
    this.name = "CollectionProviderRefused";
  }
}
export class CollectionVisitPaused extends Error {
  constructor() { super("Owned analytics visit budget reached"); this.name = "CollectionVisitPaused"; }
}
export type CollectionPage = { ids: string[]; next: string | null; hasMore: boolean };
export type CollectionPost = { published_at: string; text: string; permalink: string | null };
export type CollectionCells = Record<string, CompleteAnalyticsMetric>;
export type CollectionProvider = {
  page: (cursor: string | null) => Promise<CollectionPage>;
  post: (id: string) => Promise<CollectionPost>;
  metrics: (capture: AnalyticsCapture, definitions: MetricDefinition[]) => Promise<CollectionCells>;
};

export function providerReason(reason: string): UnavailableReason | "rate_limited" {
  if (reason === "rate_limited") return reason;
  if (["reauth_required", "expired_token", "invalid_token"].includes(reason)) return "reauth_required";
  if (["permission_missing", "missing_scope", "permission_not_approved"].includes(reason)) return "permission_missing";
  if (["window_mismatch", "capability_unverified"].includes(reason)) return reason as UnavailableReason;
  return "provider_error";
}

export function requiredReply<T>(reply: MetaAnalyticsResult<T, string>): T {
  if (reply.error?.kind === "budget") throw new CollectionVisitPaused();
  if (reply.error) throw new CollectionProviderRefused(providerReason(reply.error.reason), reply.retryAt);
  return reply.data;
}

type CollectionMetricRow = DailyAnalyticsRow & { name: string; total_value?: { value?: number | null } };
export function captureCell(reply: MetaAnalyticsResult<{ data: CollectionMetricRow[] }, string>, definition: MetricDefinition, capture: AnalyticsCapture): CompleteAnalyticsMetric {
  if (reply.error?.kind === "budget") throw new CollectionVisitPaused();
  if (reply.error) {
    const reason = providerReason(reply.error.reason);
    if (["rate_limited", "reauth_required", "permission_missing"].includes(reason)) throw new CollectionProviderRefused(reason, reply.retryAt);
    return unavailableMetric(reason as UnavailableReason);
  }
  const rows = reply.data.data.filter((row) => row.name === definition.providerMetric);
  if (rows.length !== 1) return unavailableMetric("provider_error");
  const row = rows[0];
  if (capture.kind === "account_day") {
    if (!capture.since || !capture.until || !capture.metric_date) return unavailableMetric("window_mismatch");
    return alignedDailySeries(row, { period: { since: capture.since, until: capture.until },
      buckets: [{ date: capture.metric_date, since: capture.since, until: capture.until }] })[0];
  }
  if (definition.platform === "threads") return threadsSnapshotMetric(row, capture.kind === "profile" ? "point_in_time" : "lifetime");
  if (capture.kind === "profile") return row.period === "day" ? countMetric(row.total_value?.value) : unavailableMetric("window_mismatch");
  if (row.period !== "lifetime") return unavailableMetric("window_mismatch");
  return row.values?.length === 1 ? countMetric(row.values[0].value) : unavailableMetric("provider_error");
}

export function collectionPage(ids: string[], paging?: { next?: string; cursors?: { after?: string } }): CollectionPage {
  const hasMore = paging?.next !== undefined;
  const next = hasMore ? paging?.cursors?.after ?? null : null;
  if (hasMore && !next) throw new CollectionProviderRefused("provider_error");
  return { ids, next, hasMore };
}

export function collectionPost(post: CollectionPost): CollectionPost {
  if (post.permalink !== null && (!/^https:\/\/[^\s]+$/.test(post.permalink) || post.permalink.length > 2048)) {
    throw new CollectionProviderRefused("provider_error");
  }
  return { ...post, text: post.text.slice(0, 10000) };
}
