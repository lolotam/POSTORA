import { z } from "https://esm.sh/zod@3.25.76";
import { parseMetaError, isPermanentMetaError } from "../_shared/metaErrors.ts";
import { MetaAnalyticsTransport, metaAnalyticsFailure, type MetaAnalyticsFailure, type MetaAnalyticsResult } from "../_shared/metaAnalyticsTransport.ts";
import type { UnavailableReason } from "../_shared/analyticsContract.ts";

export const FACEBOOK_INSIGHTS_VERSION = "v25.0";
export type FacebookReadReason = UnavailableReason | "rate_limited";
export type FacebookRead<T> = MetaAnalyticsResult<T, FacebookReadReason>;
const MESSAGE = "Facebook insights request could not be completed.";
const metricRow = z.object({ name: z.string().min(1).max(100), period: z.enum(["day", "week", "days_28", "lifetime"]),
  values: z.array(z.object({ value: z.number().finite().nullish(), end_time: z.string().optional() })).optional() });
const metricPayload = z.object({ data: z.array(metricRow) });
function safePermalink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["facebook.com", "www.facebook.com"].includes(url.hostname) && !url.username && !url.password
      && !Array.from(url.searchParams.keys()).some((key) => ["access_token", "refresh_token", "apikey", "api_key", "token", "authorization", "secret"].includes(key.toLowerCase()));
  } catch (error) { if (error instanceof TypeError) return false; throw error; }
}
const postRow = z.object({ id: z.string().regex(/^\d{1,40}_\d{1,40}$/), created_time: z.string().datetime({ offset: true }),
  message: z.string().nullish(), permalink_url: z.string().refine(safePermalink).nullish() });
const postsPayload = z.object({ data: z.array(postRow).max(5), paging: z.object({
  next: z.string().min(1).max(16384).optional(), cursors: z.object({ after: z.string().min(1).max(4096).optional() }).optional(),
}).optional() });
export type FacebookMetricRow = z.infer<typeof metricRow>;
export type FacebookPost = z.infer<typeof postRow>;

function providerFailure(status: number, payload: unknown, headers: Headers): MetaAnalyticsFailure<FacebookReadReason> | null {
  const parsed = z.object({ error: z.object({ code: z.number().int().optional(), error_subcode: z.number().int().optional(),
    type: z.string().optional(), message: z.string().optional(), is_transient: z.boolean().optional() }) }).safeParse(payload);
  if (status !== 429 && typeof payload === "object" && payload !== null && Object.hasOwn(payload, "error") && !parsed.success) {
    return metaAnalyticsFailure(status, "invalid_response", "provider_error", MESSAGE);
  }
  if (status >= 200 && status < 300 && !parsed.success) {
    // Facebook silently upgrades obsolete requested versions; only the observed pinned version has capability evidence.
    return headers.get("facebook-api-version") === FACEBOOK_INSIGHTS_VERSION ? null
      : metaAnalyticsFailure(status, "invalid_response", "capability_unverified", MESSAGE);
  }
  const meta = parseMetaError(status, payload);
  const throttled = status === 429 || [4, 17, 32, 613].includes(meta.code ?? -1);
  const reason: FacebookReadReason = meta.code === 190 || isPermanentMetaError(meta) ? "reauth_required" : throttled ? "rate_limited"
    : meta.code === 10 || meta.code === 200 ? "permission_missing" : "provider_error";
  const retry = headers.get("retry-after");
  const deadline = retry && /^\d{1,7}$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
  const retryAt = throttled ? new Date(Number.isFinite(deadline) && deadline > Date.now() ? deadline : Date.now() + 60_000).toISOString() : null;
  return { status, data: null, retryAt, error: { reason, kind: "provider", message: MESSAGE, code: meta.code, subcode: meta.error_subcode } };
}

export class FacebookInsightsProvider {
  private readonly transport: MetaAnalyticsTransport<FacebookReadReason>;
  constructor(private readonly options: {
    token: string; signal: AbortSignal; startedAt: number; fetch?: typeof fetch;
    requestTimeoutMs?: number; budgetMs?: number; maxCalls?: number;
  }) {
    this.transport = new MetaAnalyticsTransport({ ...options, origin: "https://graph.facebook.com", version: FACEBOOK_INSIGHTS_VERSION,
      fallbackReason: "provider_error", rateLimitedReason: "rate_limited", failureMessage: MESSAGE, classifyFailure: providerFailure });
  }

  identity() { return this.transport.request(["me"], { fields: "id" }, z.object({ id: z.string().regex(/^\d{1,40}$/) })); }

  metric(input: { pageId: string; metric: string; since: string; until: string }) {
    return this.transport.request([input.pageId, "insights"], { metric: input.metric, period: "day", locale: "en_US",
      since: Date.parse(input.since) / 1000, until: Date.parse(input.until) / 1000 }, metricPayload);
  }

  async posts(pageId: string, after: string | null) {
    const reply = await this.transport.request([pageId, "posts"], { fields: "id,created_time,message,permalink_url", limit: 5, ...(after ? { after } : {}) }, postsPayload);
    if (reply.data?.data.some((post) => !post.id.startsWith(`${pageId}_`)) || reply.data?.paging?.cursors?.after?.includes(this.options.token)) {
      return metaAnalyticsFailure(reply.status, "invalid_response", "provider_error" as const, MESSAGE);
    }
    return reply;
  }

  postMetric(postId: string, metric: string) { return this.transport.request([postId, "insights"], { metric, locale: "en_US" }, metricPayload); }
}
