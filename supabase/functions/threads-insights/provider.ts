import { z } from "https://esm.sh/zod@3.25.76";
import { classifyMetaError, type ClassifiedReason } from "../_shared/threads-debug.ts";
import { mapAnalyticsReads, MetaAnalyticsTransport, metaAnalyticsFailure, type MetaAnalyticsError, type MetaAnalyticsFailure, type MetaAnalyticsResult } from "../_shared/metaAnalyticsTransport.ts";
export { latestRetryAt } from "../_shared/metaAnalyticsTransport.ts";

const metricRow = z.object({
  name: z.string().min(1).max(100),
  period: z.enum(["day", "week", "days_28", "lifetime"]).optional(),
  total_value: z.object({ value: z.number().finite().nullish() }).optional(),
  values: z.array(z.object({ value: z.number().finite().nullish(), end_time: z.string().optional() })).optional(),
});
const postRow = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/), text: z.string().nullish(), timestamp: z.string().datetime({ offset: true }),
  media_type: z.string().optional(), media_url: z.string().nullish(), permalink: z.string().nullish(),
  shortcode: z.string().nullish(), thumbnail_url: z.string().nullish(),
});
const metricPayload = z.object({ data: z.array(metricRow) });
const postsPayload = z.object({
  data: z.array(postRow).max(25),
  paging: z.object({
    next: z.string().min(1).max(16384).optional(),
    cursors: z.object({ after: z.string().min(1).max(4096).optional() }).optional(),
  }).optional(),
});
const identityPayload = z.object({ id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/), username: z.string().optional() });

export type ThreadsMetricRow = z.infer<typeof metricRow>;
export type ThreadsPost = z.infer<typeof postRow>;
export type ThreadsProviderError = MetaAnalyticsError<ClassifiedReason>;
type ProviderFailure = MetaAnalyticsFailure<ClassifiedReason>;
export type ProviderResult<T> = MetaAnalyticsResult<T, ClassifiedReason>;
const FAILURE_MESSAGE = "Threads insights request could not be completed.";
type RequestQuery = Record<string, string | number>;

function failure(status: number, kind: ThreadsProviderError["kind"], reason: ClassifiedReason = "transient"): ProviderFailure {
  return metaAnalyticsFailure(status, kind, reason, FAILURE_MESSAGE);
}

function providerFailure(status: number, payload: unknown, headers: Headers): ProviderFailure | null {
  const error = z.object({ error: z.object({ code: z.number().int().optional(), error_subcode: z.number().int().optional(), message: z.string().optional() }) }).safeParse(payload);
  if (status !== 429 && typeof payload === "object" && payload !== null && Object.hasOwn(payload, "error") && !error.success) {
    return failure(status, "invalid_response");
  }
  if (status >= 200 && status < 300 && !error.success) return null;
  const code = error.success ? error.data.error.code : undefined;
  const subcode = error.success ? error.data.error.error_subcode : undefined;
  const classified = classifyMetaError({
    code: code === 200 ? 10 : code, error_subcode: subcode,
    message: error.success ? error.data.error.message ?? "" : "",
  });
  const throttled = status === 429 || classified.reason === "rate_limited";
  const retry = headers.get("retry-after");
  const retryTime = retry && /^\d{1,7}$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
  const retryAt = Number.isFinite(retryTime) && retryTime > Date.now() ? retryTime : Date.now() + 60_000;
  return {
    status, data: null,
    error: { kind: "provider", reason: throttled ? "rate_limited" : status >= 500 && classified.reason === "unknown" ? "transient" : classified.reason,
      message: "Threads insights request could not be completed.", code, subcode },
    retryAt: throttled ? new Date(retryAt).toISOString() : null,
  };
}

/** One request-scoped budget is shared by identity, profile, listing and post calls. No retries. */
export class ThreadsInsightsProvider {
  private readonly transport: MetaAnalyticsTransport<ClassifiedReason>;
  constructor(private readonly options: {
    token: string; signal: AbortSignal; startedAt: number; fetch?: typeof fetch;
    requestTimeoutMs?: number; budgetMs?: number; maxCalls?: number; beforeRequest?: () => Promise<void>;
    afterResponse?: (status: number, headers: Headers) => Promise<void>;
  }) {
    this.transport = new MetaAnalyticsTransport({ ...options, origin: "https://graph.threads.net", version: "v1.0",
      fallbackReason: "transient", rateLimitedReason: "rate_limited", failureMessage: FAILURE_MESSAGE, classifyFailure: providerFailure });
  }

  identity() { return this.transport.request(["me"], { fields: "id,username" }, identityPayload); }

  profile(input: { userId: string; metrics: readonly string[]; since: number; until: number; metricType?: "time_series" }) {
    const query: RequestQuery = { metric: input.metrics.join(","), since: input.since, until: input.until, locale: "en_US" };
    if (input.metricType) query.metric_type = input.metricType;
    return this.transport.request([input.userId, "threads_insights"], query, metricPayload);
  }

  async recentPosts(userId: string, page?: { after: string | null; limit: number }) {
    const reply = await this.transport.request([userId, "threads"], {
      fields: "id,text,timestamp,media_type,media_url,permalink,shortcode,thumbnail_url", limit: page?.limit ?? 25,
      ...(page?.after ? { after: page.after } : {}),
    }, postsPayload);
    const after = reply.data?.paging?.cursors?.after;
    return after?.includes(this.options.token) ? failure(reply.status, "invalid_response") : reply;
  }

  postInsights(postId: string) {
    return this.transport.request([postId, "insights"], { metric: "views,likes,replies,reposts,quotes,shares" }, metricPayload);
  }

  async post(postId: string) {
    const reply = await this.transport.request([postId], { fields: "id,text,timestamp,permalink" }, postRow);
    return reply.data && reply.data.id !== postId ? failure(reply.status, "invalid_response") : reply;
  }
}

/** Fixed worker count bounds simultaneous calls while preserving provider listing order. */
export async function loadPostMetrics(provider: ThreadsInsightsProvider, posts: readonly ThreadsPost[]) {
  return await mapAnalyticsReads(posts, async (post) => ({ post, insights: await provider.postInsights(post.id) }));
}
