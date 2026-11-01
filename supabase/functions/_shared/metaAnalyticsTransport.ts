import type { z } from "https://esm.sh/zod@3.25.76";

export type MetaAnalyticsError<Reason extends string> = {
  reason: Reason; message: string; code?: number; subcode?: number;
  kind: "provider" | "transport" | "invalid_response" | "budget" | "aborted";
};
export type MetaAnalyticsFailure<Reason extends string> = {
  status: number; data: null; error: MetaAnalyticsError<Reason>; retryAt: string | null;
};
export type MetaAnalyticsResult<T, Reason extends string> =
  | { status: number; data: T; error: null; retryAt: null }
  | MetaAnalyticsFailure<Reason>;

export function metaAnalyticsFailure<Reason extends string>(status: number, kind: MetaAnalyticsError<Reason>["kind"], reason: Reason, message: string): MetaAnalyticsFailure<Reason> {
  return { status, data: null, error: { kind, reason, message }, retryAt: null };
}

/** Concurrent refusals must never shorten a provider's authoritative backoff. */
export function latestRetryAt(deadlines: readonly (string | null)[]): string | null {
  return deadlines.reduce<string | null>((latest, candidate) =>
    candidate !== null && (latest === null || Date.parse(candidate) > Date.parse(latest)) ? candidate : latest, null);
}

/** Resolve even when a replaced transport ignores AbortSignal; cancel native fetch as well. */
async function beforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException("Meta analytics provider deadline reached", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([pending, refused]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new SyntaxError("Meta analytics response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await beforeAbort(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1_048_576) throw new RangeError("Meta analytics response exceeds limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    // Cleanup cannot extend the request ceiling when a stream ignores cancellation.
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  reader.releaseLock();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export type MetaAnalyticsTransportOptions<Reason extends string> = {
  origin: "https://graph.threads.net" | "https://graph.facebook.com"; version: string;
  token: string; signal: AbortSignal; startedAt: number;
  fallbackReason: Reason; rateLimitedReason: Reason; failureMessage: string;
  classifyFailure: (status: number, payload: unknown, headers: Headers) => MetaAnalyticsFailure<Reason> | null;
  fetch?: typeof fetch; requestTimeoutMs?: number; budgetMs?: number; maxCalls?: number;
};

/** One fixed-origin, request-wide budget for identity, metrics and bounded listing pages. No retries. */
export class MetaAnalyticsTransport<Reason extends string> {
  private calls = 0;
  private readonly deadline: number;
  private retryAt: string | null = null;
  private throttled = false;
  constructor(private readonly options: MetaAnalyticsTransportOptions<Reason>) {
    this.deadline = options.startedAt + (options.budgetMs ?? 30_000);
  }

  private failure(status: number, kind: MetaAnalyticsError<Reason>["kind"], reason = this.options.fallbackReason) {
    return metaAnalyticsFailure(status, kind, reason, this.options.failureMessage);
  }

  private rememberRefusal(refused: MetaAnalyticsFailure<Reason>): MetaAnalyticsFailure<Reason> {
    if (refused.error.reason === this.options.rateLimitedReason) this.throttled = true;
    this.retryAt = latestRetryAt([this.retryAt, refused.retryAt]);
    return { ...refused, retryAt: this.retryAt };
  }

  async request<T>(path: readonly string[], query: Record<string, string | number>, schema: z.ZodType<T>): Promise<MetaAnalyticsResult<T, Reason>> {
    const remaining = this.deadline - Date.now();
    if (this.options.signal.aborted) return this.failure(0, "aborted");
    if (remaining <= 0 || this.calls >= (this.options.maxCalls ?? 32)) return this.failure(0, "budget");
    if (this.throttled) return { ...this.failure(429, "provider", this.options.rateLimitedReason), retryAt: this.retryAt };
    const url = new URL(`${this.options.origin}/${this.options.version}/${path.map(encodeURIComponent).join("/")}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(remaining, this.options.requestTimeoutMs ?? 4_000)));
    const signal = AbortSignal.any([this.options.signal, timeout]);
    this.calls++;
    try {
      const response = await beforeAbort((this.options.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${this.options.token}` }, signal, redirect: "error",
      }), signal);
      if (response.status === 429) this.rememberRefusal(this.options.classifyFailure(429, null, response.headers)!);
      let payload: unknown;
      try { payload = await boundedJson(response, signal); }
      catch (error) {
        if (response.status === 429) return this.rememberRefusal(this.options.classifyFailure(429, null, response.headers)!);
        if (signal.aborted) return this.failure(response.status, this.options.signal.aborted ? "aborted" : "transport");
        if (error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError) return this.failure(response.status, "invalid_response");
        throw error;
      }
      const refused = this.options.classifyFailure(response.status, payload, response.headers);
      if (refused) return this.rememberRefusal(refused);
      const parsed = schema.safeParse(payload);
      return parsed.success ? { status: response.status, data: parsed.data, error: null, retryAt: null } : this.failure(response.status, "invalid_response");
    } catch (error) {
      if (signal.aborted || error instanceof TypeError || error instanceof DOMException) {
        return this.failure(0, this.options.signal.aborted ? "aborted" : "transport");
      }
      // Transport implementations can reject with arbitrary values. Return an explicit sanitized failed read.
      return this.failure(0, "transport");
    }
  }
}

/** Fixed worker count bounds provider concurrency and preserves request/listing order. */
export async function mapAnalyticsReads<T, R>(subjects: readonly T[], read: (subject: T) => Promise<R>): Promise<R[]> {
  const replies: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, subjects.length) }, async () => {
    while (next < subjects.length) {
      const index = next++;
      replies[index] = await read(subjects[index]);
    }
  }));
  return replies;
}
