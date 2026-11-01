import { z } from "https://esm.sh/zod@3.25.76";
import { classifyMetaError, type ClassifiedReason } from "../_shared/threads-debug.ts";

const metricRow = z.object({
  name: z.string().min(1).max(100),
  total_value: z.object({ value: z.number().finite().nullish() }).optional(),
  values: z.array(z.object({ value: z.number().finite().nullish(), end_time: z.string().optional() })).optional(),
});
const postRow = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/), text: z.string().nullish(), timestamp: z.string().optional(),
  media_type: z.string().optional(), media_url: z.string().nullish(), permalink: z.string().nullish(),
  shortcode: z.string().nullish(), thumbnail_url: z.string().nullish(),
});
const metricPayload = z.object({ data: z.array(metricRow) });
const postsPayload = z.object({ data: z.array(postRow).max(25) });
const identityPayload = z.object({ id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/), username: z.string().optional() });

export type ThreadsMetricRow = z.infer<typeof metricRow>;
export type ThreadsPost = z.infer<typeof postRow>;
export type ThreadsProviderError = {
  reason: ClassifiedReason;
  message: string;
  code?: number;
  subcode?: number;
  kind: "provider" | "transport" | "invalid_response" | "budget" | "aborted";
};
type ProviderFailure = { status: number; data: null; error: ThreadsProviderError; retryAt: string | null };
export type ProviderResult<T> =
  | { status: number; data: T; error: null; retryAt: null }
  | ProviderFailure;
type RequestQuery = Record<string, string | number>;

function failure(status: number, kind: ThreadsProviderError["kind"], reason: ClassifiedReason = "transient"): ProviderFailure {
  return { status, data: null, error: { kind, reason, message: "Threads insights request could not be completed." }, retryAt: null };
}

/** Resolves even if a replaced/non-native transport ignores AbortSignal. Native fetch is cancelled too. */
async function beforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException("Threads provider deadline reached", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([pending, refused]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new SyntaxError("Threads response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await beforeAbort(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1_048_576) throw new RangeError("Threads response exceeds limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    // Cancellation is best-effort cleanup; the caller's deadline must not wait for an uncooperative stream.
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  reader.releaseLock();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
    error: { kind: "provider", reason: throttled ? "rate_limited" : status >= 500 ? "transient" : classified.reason,
      message: "Threads insights request could not be completed.", code, subcode },
    retryAt: throttled ? new Date(retryAt).toISOString() : null,
  };
}

/** One request-scoped budget is shared by identity, profile, listing and post calls. No retries. */
export class ThreadsInsightsProvider {
  private calls = 0;
  private readonly deadline: number;
  private retryAt: string | null = null;
  constructor(private readonly options: {
    token: string;
    signal: AbortSignal;
    startedAt: number;
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    budgetMs?: number;
    maxCalls?: number;
  }) {
    this.deadline = options.startedAt + (options.budgetMs ?? 30_000);
  }

  private rememberRefusal(refused: ProviderFailure): ProviderFailure {
    if (refused.retryAt) this.retryAt = refused.retryAt;
    return refused;
  }

  private async request<T>(path: readonly string[], query: RequestQuery, schema: z.ZodType<T>): Promise<ProviderResult<T>> {
    const remaining = this.deadline - Date.now();
    if (this.options.signal.aborted) return failure(0, "aborted");
    if (remaining <= 0 || this.calls >= (this.options.maxCalls ?? 32)) return failure(0, "budget");
    if (this.retryAt && Date.parse(this.retryAt) > Date.now()) {
      return { ...failure(429, "provider", "rate_limited"), retryAt: this.retryAt };
    }
    const url = new URL(`https://graph.threads.net/v1.0/${path.map(encodeURIComponent).join("/")}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(remaining, this.options.requestTimeoutMs ?? 4_000)));
    const signal = AbortSignal.any([this.options.signal, timeout]);
    this.calls++;
    try {
      const response = await beforeAbort((this.options.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${this.options.token}` }, signal, redirect: "error",
      }), signal);
      if (response.status === 429) this.rememberRefusal(providerFailure(429, null, response.headers)!);
      let payload: unknown;
      try { payload = await boundedJson(response, signal); }
      catch (error) {
        if (response.status === 429) return this.rememberRefusal(providerFailure(429, null, response.headers)!);
        if (signal.aborted) return failure(response.status, this.options.signal.aborted ? "aborted" : "transport");
        if (error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError) return failure(response.status, "invalid_response");
        throw error;
      }
      const refused = providerFailure(response.status, payload, response.headers);
      if (refused) {
        return this.rememberRefusal(refused);
      }
      const parsed = schema.safeParse(payload);
      return parsed.success ? { status: response.status, data: parsed.data, error: null, retryAt: null }
        : failure(response.status, "invalid_response");
    } catch (error) {
      if (signal.aborted || error instanceof TypeError || error instanceof DOMException) {
        return failure(0, this.options.signal.aborted ? "aborted" : "transport");
      }
      // Fetch and body streams can reject with arbitrary values; this is an explicit failed read, never empty data.
      return failure(0, "transport");
    }
  }

  identity() { return this.request(["me"], { fields: "id,username" }, identityPayload); }

  profile(input: { userId: string; metrics: readonly string[]; since: number; until: number; metricType?: "time_series" }) {
    const query: RequestQuery = { metric: input.metrics.join(","), since: input.since, until: input.until, locale: "en_US" };
    if (input.metricType) query.metric_type = input.metricType;
    return this.request([input.userId, "threads_insights"], query, metricPayload);
  }

  recentPosts(userId: string) {
    return this.request([userId, "threads"], {
      fields: "id,text,timestamp,media_type,media_url,permalink,shortcode,thumbnail_url", limit: 25,
    }, postsPayload);
  }

  postInsights(postId: string) {
    return this.request([postId, "insights"], { metric: "views,likes,replies,reposts,quotes,shares" }, metricPayload);
  }
}

/** Fixed worker count bounds simultaneous calls while preserving provider listing order. */
export async function loadPostMetrics(provider: ThreadsInsightsProvider, posts: readonly ThreadsPost[]) {
  const results: { post: ThreadsPost; insights: Awaited<ReturnType<ThreadsInsightsProvider["postInsights"]>> }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, posts.length) }, async () => {
    while (next < posts.length) {
      const index = next++;
      results[index] = { post: posts[index], insights: await provider.postInsights(posts[index].id) };
    }
  }));
  return results;
}
