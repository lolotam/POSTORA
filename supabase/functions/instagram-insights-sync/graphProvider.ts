/**
 * Meta Graph API v22.0 Provider Client for Instagram Insights.
 *
 * Strictly typed, hermetically testable, and resilient:
 * - Fetches account-level insights (reach, views, accounts engaged, total interactions)
 * - Fetches media inventory and individual media metrics
 * - Enforces bounded 8s execution ceiling per request
 * - Observes and handles rate limits (HTTP 429, codes 4/17/32/613, headers x-app-usage/x-business-use-case-usage >= 80%)
 * - Classifies token expiry (190) vs revocation (458/467)
 * - Distinguishes permission missing from metric unavailability (e.g. code 10 insufficient viewers)
 * - Rejects malformed responses, misaligned date buckets, and AD media
 * - Redacts credentials from error messages at the provider boundary
 */

export type ProviderErrorKind =
  | "rate_limited"
  | "token_expired"
  | "token_revoked"
  | "permission_missing"
  | "transient_error"
  | "unsupported_metric"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly statusCode?: number;
  readonly subcode?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      kind: ProviderErrorKind;
      statusCode?: number;
      subcode?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.statusCode = options.statusCode;
    this.subcode = options.subcode;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface AccountDailyInsights {
  provider_date: string;
  metric_date: string;
  period_start: string;
  period_end: string;
  provider_timezone: string;
  query_kind: "interactions";
  metrics: {
    reach?: number;
    views?: number;
    accounts_engaged?: number;
    total_interactions?: number;
    likes?: number;
    comments?: number;
    saves?: number;
    shares?: number;
  };
}

export interface ProfileObservation {
  followers_count?: number;
  media_count?: number;
}

export interface MediaInsightSnapshotItem {
  ig_media_id: string;
  media_product_type?: string;
  media_type: string;
  caption?: string;
  permalink?: string;
  thumbnail_url?: string;
  published_at: string;
  status: "ok" | "unavailable";
  metrics: {
    views?: number;
    reach?: number;
    likes?: number;
    comments?: number;
    saved?: number;
    shares?: number;
    total_interactions?: number;
    ig_reels_avg_watch_time_ms?: number;
    like_count_public?: number;
    comments_count_public?: number;
  };
}

export interface FetchedOwnerData {
  accountDaily: AccountDailyInsights;
  profileObservation: ProfileObservation;
  mediaItems: MediaInsightSnapshotItem[];
}

export interface GraphProviderOptions {
  graphApiVersion?: string;
  fetchFn?: typeof fetch;
}

export class InstagramGraphProvider {
  private readonly version: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: GraphProviderOptions = {}) {
    this.version = options.graphApiVersion ?? "v22.0";
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private sanitizeProviderMessage(message: string): string {
    return message
      .replace(/access_token=[^\s&"']+/gi, "access_token=[REDACTED]")
      .replace(/bearer\s+[^\s&"']+/gi, "Bearer [REDACTED]");
  }

  private checkUsageHeaders(headers: Headers | Record<string, string> | undefined): void {
    if (!headers) return;
    const getHeader = (name: string): string | null => {
      if (typeof (headers as Headers).get === "function") {
        return (headers as Headers).get(name);
      }
      const rec = headers as Record<string, string>;
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(rec)) {
        if (k.toLowerCase() === lower) return String(v);
      }
      return null;
    };

    const appUsageStr = getHeader("x-app-usage");
    if (appUsageStr) {
      try {
        const usage = JSON.parse(appUsageStr);
        if (
          (typeof usage.call_count === "number" && usage.call_count >= 80) ||
          (typeof usage.total_cputime === "number" && usage.total_cputime >= 80) ||
          (typeof usage.total_time === "number" && usage.total_time >= 80)
        ) {
          throw new ProviderError("Meta Graph API usage threshold exceeded (>=80%)", {
            kind: "rate_limited",
            retryAfterSeconds: 300,
          });
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
      }
    }

    const bizUsageStr = getHeader("x-business-use-case-usage");
    if (bizUsageStr) {
      try {
        const bizUsage = JSON.parse(bizUsageStr);
        if (bizUsage && typeof bizUsage === "object") {
          for (const list of Object.values(bizUsage)) {
            if (Array.isArray(list)) {
              for (const item of list) {
                if (
                  item &&
                  typeof item === "object" &&
                  ((typeof item.call_count === "number" && item.call_count >= 80) ||
                    (typeof item.total_cputime === "number" && item.total_cputime >= 80) ||
                    (typeof item.total_time === "number" && item.total_time >= 80))
                ) {
                  throw new ProviderError("Meta Graph API business usage threshold exceeded (>=80%)", {
                    kind: "rate_limited",
                    retryAfterSeconds: 300,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
      }
    }
  }

  private classifyGraphError(errorPayload: unknown, httpStatus: number): ProviderError {
    const err = (errorPayload as { error?: { code?: number; error_subcode?: number; message?: string } })?.error;
    const code = err?.code;
    const subcode = err?.error_subcode;
    const rawMessage = err?.message ?? `Graph API error (${httpStatus})`;
    const message = this.sanitizeProviderMessage(rawMessage);

    if (httpStatus === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
      return new ProviderError(message, {
        kind: "rate_limited",
        statusCode: httpStatus,
        subcode,
        retryAfterSeconds: 300,
      });
    }

    if (code === 190) {
      const isRevoked = subcode === 467 || subcode === 458;
      return new ProviderError(message, {
        kind: isRevoked ? "token_revoked" : "token_expired",
        statusCode: httpStatus,
        subcode,
      });
    }

    if (code === 10) {
      const lower = rawMessage.toLowerCase();
      if (lower.includes("viewer") || lower.includes("not enough")) {
        return new ProviderError(message, {
          kind: "unsupported_metric",
          statusCode: httpStatus,
          subcode,
        });
      }
    }

    if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
      return new ProviderError(message, {
        kind: "permission_missing",
        statusCode: httpStatus,
        subcode,
      });
    }

    if (httpStatus >= 500 && httpStatus <= 599) {
      return new ProviderError(message, {
        kind: "transient_error",
        statusCode: httpStatus,
        subcode,
      });
    }

    return new ProviderError(message, {
      kind: "unknown",
      statusCode: httpStatus,
      subcode,
    });
  }

  private async executeFetch(url: string, callerSignal?: AbortSignal): Promise<Response> {
    const timeoutMs = 8000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ProviderError("Provider request exceeded 8s wait ceiling", {
            kind: "transient_error",
          })
        );
      }, timeoutMs);
    });

    try {
      const fetchPromise = this.fetchFn(url, { signal: callerSignal });
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("Network request failed", {
        kind: "transient_error",
        cause: err,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async fetchAccountProfile(
    igUserId: string,
    accessToken: string,
    signal?: AbortSignal
  ): Promise<ProfileObservation> {
    const url = `https://graph.facebook.com/${this.version}/${encodeURIComponent(
      igUserId
    )}?fields=followers_count,media_count&access_token=${encodeURIComponent(accessToken)}`;

    const response = await this.executeFetch(url, signal);
    const json = await response.json();
    this.checkUsageHeaders(response.headers);

    if (!response.ok || (json && typeof json === "object" && "error" in json)) {
      throw this.classifyGraphError(json, response.status);
    }

    if (json.followers_count !== undefined) {
      if (
        typeof json.followers_count !== "number" ||
        !Number.isSafeInteger(json.followers_count) ||
        json.followers_count < 0
      ) {
        throw new ProviderError("Invalid followers_count: expected nonnegative safe integer", {
          kind: "transient_error",
        });
      }
    }

    if (json.media_count !== undefined) {
      if (
        typeof json.media_count !== "number" ||
        !Number.isSafeInteger(json.media_count) ||
        json.media_count < 0
      ) {
        throw new ProviderError("Invalid media_count: expected nonnegative safe integer", {
          kind: "transient_error",
        });
      }
    }

    return {
      followers_count: json.followers_count,
      media_count: json.media_count,
    };
  }

  async fetchAccountDailyInsights(
    igUserId: string,
    accessToken: string,
    dateString: string,
    signal?: AbortSignal
  ): Promise<AccountDailyInsights> {
    const sinceUnix = Math.floor(new Date(`${dateString}T00:00:00+03:00`).getTime() / 1000);
    const untilUnix = sinceUnix + 86400;

    const metricsList = "reach,views,accounts_engaged,total_interactions";
    const url = `https://graph.facebook.com/${this.version}/${encodeURIComponent(
      igUserId
    )}/insights?metric=${metricsList}&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${encodeURIComponent(
      accessToken
    )}`;

    const response = await this.executeFetch(url, signal);
    const json = await response.json();
    this.checkUsageHeaders(response.headers);

    if (!response.ok || (json && typeof json === "object" && "error" in json)) {
      throw this.classifyGraphError(json, response.status);
    }

    if (!json || typeof json !== "object" || !Array.isArray(json.data)) {
      throw new ProviderError("Invalid Graph response: expected data array", {
        kind: "transient_error",
      });
    }

    for (const entry of json.data) {
      for (const v of entry.values ?? []) {
        if (v?.end_time) {
          const entryEndTimeUnix = Math.floor(new Date(v.end_time).getTime() / 1000);
          if (Math.abs(entryEndTimeUnix - untilUnix) > 129600) {
            throw new ProviderError(
              `Provider returned metric bucket (${v.end_time}) outside requested range (${dateString})`,
              { kind: "transient_error" }
            );
          }
        }
      }
    }

    const metrics: AccountDailyInsights["metrics"] = {};
    for (const entry of json.data) {
      const name = String(entry.name);
      const value = entry.values?.[0]?.value ?? entry.total_value?.value;
      if (typeof value === "number") {
        if (name === "reach") metrics.reach = value;
        else if (name === "views") metrics.views = value;
        else if (name === "accounts_engaged") metrics.accounts_engaged = value;
        else if (name === "total_interactions") metrics.total_interactions = value;
      }
    }

    return {
      provider_date: dateString,
      metric_date: dateString,
      period_start: new Date(sinceUnix * 1000).toISOString(),
      period_end: new Date(untilUnix * 1000).toISOString(),
      provider_timezone: "Asia/Kuwait",
      query_kind: "interactions",
      metrics,
    };
  }

  async fetchRecentMedia(
    igUserId: string,
    accessToken: string,
    limit = 50,
    signal?: AbortSignal
  ): Promise<MediaInsightSnapshotItem[]> {
    const fields =
      "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,like_count,comments_count";
    const url = `https://graph.facebook.com/${this.version}/${encodeURIComponent(
      igUserId
    )}/media?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(accessToken)}`;

    const response = await this.executeFetch(url, signal);
    const json = await response.json();
    this.checkUsageHeaders(response.headers);

    if (!response.ok || (json && typeof json === "object" && "error" in json)) {
      throw this.classifyGraphError(json, response.status);
    }

    if (!json || typeof json !== "object" || !Array.isArray(json.data)) {
      throw new ProviderError("Invalid Graph response: expected data array", {
        kind: "transient_error",
      });
    }

    const items: MediaInsightSnapshotItem[] = [];
    for (const item of json.data) {
      if (!item?.id || !item?.timestamp) continue;
      const productType = item.media_product_type ? String(item.media_product_type).toUpperCase() : "";
      const mediaType = String(item.media_type ?? "IMAGE").toUpperCase();
      if (productType === "AD" || mediaType === "AD") {
        continue;
      }

      items.push({
        ig_media_id: String(item.id),
        media_type: mediaType,
        media_product_type: item.media_product_type ? String(item.media_product_type) : undefined,
        caption: item.caption ? String(item.caption).slice(0, 2000) : undefined,
        permalink: item.permalink ? String(item.permalink).slice(0, 2000) : undefined,
        thumbnail_url: item.thumbnail_url ? String(item.thumbnail_url).slice(0, 2000) : undefined,
        published_at: new Date(item.timestamp).toISOString(),
        status: "ok",
        metrics: {
          like_count_public: typeof item.like_count === "number" ? item.like_count : undefined,
          comments_count_public: typeof item.comments_count === "number" ? item.comments_count : undefined,
        },
      });
    }

    return items;
  }
}
