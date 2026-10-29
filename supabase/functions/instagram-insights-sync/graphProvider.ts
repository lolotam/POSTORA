/**
 * The Meta Graph adapter for the OWNER Instagram collection.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The HTTP shape of one owner capture: the URL grammar, the account
 *   profile, the account day, the media inventory sweep, the usage-header
 *   reading, the bounded retry policy, the body cap and the failure
 *   classification.
 *
 * WHY THE TIMEOUT COVERS THE BODY
 *
 *   A timeout that is cleared when the headers arrive leaves the body read
 *   unbounded, which is the shape of a hung worker. The abort stays armed
 *   until the body has been read, the body itself is size-capped, and the
 *   read is RACED against the abort so a transport that ignores it cannot
 *   outlive the ceiling.
 *
 * WHY A FAILURE NEVER CARRIES THE PROVIDER TEXT
 *
 *   A Graph error message can quote the token, the account id or an internal
 *   URL. The failures below carry a stable message and a stable kind. The
 *   raw text is read, classified and dropped; it never becomes a reason code,
 *   a stored `last_reason_code`, a log line or a client response.
 *
 * WHY A MISSING METRIC IS NULL AND NEVER ZERO
 *
 *   "The provider did not report this metric" and "the provider reported
 *   zero" are different facts, and only one of them is a metric. A missing
 *   count is null, and the accepted SQL stores null as NULL (unavailable),
 *   never as a zero.
 *
 * WHY A MALFORMED RESPONSE IS AN ERROR AND NOT AN EMPTY SUCCESS
 *
 *   A response without a `data` array, a `data` that is not an array, a
 *   count beyond 2^53 and a Graph error envelope delivered with HTTP 200 are
 *   all failures. Reading them as "no data" would turn a broken response
 *   into a successful but empty capture, and the accepted SQL would then
 *   record that emptiness as a fact about the account.
 *
 * WHY THE PAGINATION CURSOR IS REBUILT AND NEVER FOLLOWED
 *
 *   The provider's `paging.next` is a URL that may point anywhere. It is
 *   never requested. The cursor VALUE is validated against a strict
 *   character allow-list and is re-inserted into a request this module
 *   builds itself, on the one host this module trusts.
 *
 * WHY THE ACCOUNT DAY IS A TOTAL AND NOT A BUCKET SUM
 *
 *   The account endpoint documents `metric_type=total_value` for the
 *   interaction metrics, and the answer is `data[].total_value.value`. The
 *   `values[]` shape is the time-series shape of the same endpoint, so
 *   reading it here would store a bucket under the meaning of a total.
 *   There is no fallback: a metric row without a `total_value` leaves that
 *   metric null, and a malformed `total_value` is a failure.
 *
 * WHY THE MEDIA ENDPOINT IS READ DIFFERENTLY
 *
 *   The media endpoint documents its answer in `data[].values[]`, and it
 *   populates `total_value` only for a breakdown, which this adapter never
 *   asks for. The two endpoints are therefore read from the shape each one
 *   documents, and the metric set of a media depends on its own product
 *   type, because Meta documents which metric exists for which type.
 */

/** The one host this module ever talks to. */
const GRAPH_HOST = "https://graph.facebook.com";

/** The default Graph version. */
export const DEFAULT_GRAPH_API_VERSION = "v22.0";

/** The provider ceiling of one attempt: headers AND body. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;

/** The hard cap on the response body of one attempt. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The usage percentage at which the provider work stops. */
export const USAGE_STOP_PERCENT = 80;

/** The page size of the media connection. */
export const MEDIA_PAGE_SIZE = 50;

/** The Graph error codes that mean "the provider is throttling". */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** The Graph error codes that mean "the credential was rejected". */
const TOKEN_ERROR_CODES = new Set([190]);

/** The Graph error codes that mean "the permission was refused". */
const PERMISSION_ERROR_CODES = new Set([10, 200]);

/** The cursor grammar. A cursor is an opaque provider token, never a URL. */
const CURSOR_GRAMMAR = /^[A-Za-z0-9_=-]{1,512}$/;

/** The version grammar. */
const VERSION_GRAMMAR = /^v\d{1,3}\.\d{1,2}$/;

/** The insights scopes a Graph message may name. */
const INSIGHTS_SCOPE_MARKERS = [
  "instagram_manage_insights",
  "instagram_business_manage_insights",
];

/** The account day metrics this adapter collects. */
const ACCOUNT_DAY_METRICS = ["reach", "views", "accounts_engaged", "total_interactions"];

/**
 * The ceiling of ONE media insights attempt: headers AND body.
 *
 * The media continuation fetches at most five media per visit, sequentially,
 * inside one forty second run, so a single media call may not spend more
 * than four seconds of it.
 */
export const MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS = 4_000;

/**
 * The media insights metrics, per media product type.
 *
 * Meta documents which metric exists for which media product type
 * (https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights).
 * Only the metrics that the accepted `owner_media` whitelist can store are
 * requested: a metric the whitelist cannot store is never asked for, because
 * a stored metric outside the whitelist is refused by the accepted SQL.
 *
 * The names are the provider's own names and they are also the whitelist
 * keys, so no metric is renamed on the way to the database.
 */
const MEDIA_INSIGHT_METRICS_BY_PRODUCT_TYPE: Readonly<Record<string, readonly string[]>> = {
  FEED: [
    "views",
    "reach",
    "likes",
    "comments",
    "saved",
    "shares",
    "total_interactions",
    "profile_visits",
    "follows",
  ],
  REELS: ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"],
  STORY: [
    "views",
    "reach",
    "shares",
    "total_interactions",
    "profile_visits",
    "follows",
    "replies",
  ],
};

/**
 * The metrics every media product type that has insights supports.
 *
 * It is the intersection of the documented sets. It is the set for a media
 * whose product type the provider did not name, so an unknown type still
 * collects the metrics the provider certainly has.
 */
const UNIVERSAL_MEDIA_INSIGHT_METRICS: readonly string[] = [
  "views",
  "reach",
  "shares",
  "total_interactions",
];

/**
 * The media type whose insights Meta documents as unavailable.
 *
 * "Insights data is not available for any media within an Instagram Media
 * album." A media of that type therefore has no insight metrics at all, and
 * that is a POSITIVE statement about the provider, not a failed request.
 */
const ALBUM_MEDIA_TYPE = "CAROUSEL_ALBUM";

/** The media fields this adapter requests. */
const MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "timestamp",
  "permalink",
  "thumbnail_url",
  "like_count",
  "comments_count",
].join(",");

/** The longest text the accepted snapshot columns accept. */
const MAX_TEXT_LENGTH = 2000;

export type OwnerProviderErrorKind =
  | "rate_limited"
  | "token_invalid"
  | "scope_missing"
  | "provider_error";

export interface OwnerProviderErrorOptions {
  readonly kind: OwnerProviderErrorKind;
  readonly statusCode?: number | null;
  readonly usagePercent?: number;
  readonly throttledUntil?: Date | null;
  readonly retryable?: boolean;
}

/**
 * A provider failure.
 *
 * It carries a stable kind and a stable message. It never carries the
 * provider's text, the request URL or a credential.
 */
export class OwnerProviderError extends Error {
  readonly kind: OwnerProviderErrorKind;
  readonly statusCode: number | null;
  readonly usagePercent: number;
  readonly throttledUntil: Date | null;
  readonly retryable: boolean;

  constructor(message: string, options: OwnerProviderErrorOptions) {
    super(message);
    this.name = "OwnerProviderError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.usagePercent = options.usagePercent ?? 0;
    this.throttledUntil = options.throttledUntil ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export interface OwnerGraphProviderOptions {
  /** The Graph version. Defaults to v22.0 and is validated when configured. */
  readonly apiVersion?: string;
  /** The Meta app id. It is used only to build the shared throttle bucket key. */
  readonly appId?: string | null;
  /** The transport. Injectable so a test never reaches the network. */
  readonly fetchFn?: typeof fetch;
  /** The per-attempt ceiling. */
  readonly attemptTimeoutMs?: number;
}

/** The public counts of one profile observation. */
export interface OwnerProfileObservation {
  readonly followers_count: number | null;
  readonly media_count: number | null;
}

/** One account day of interactions. */
export interface OwnerAccountDay {
  readonly provider_date: string;
  readonly metric_date: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly provider_timezone: string;
  readonly query_kind: "interactions";
  readonly metrics: {
    readonly reach?: number;
    readonly views?: number;
    readonly accounts_engaged?: number;
    readonly total_interactions?: number;
  };
}

/** One captured media row. */
export interface OwnerMediaItem {
  readonly ig_media_id: string;
  readonly media_product_type: string | null;
  readonly media_type: string | null;
  readonly thumbnail_url: string | null;
  readonly caption: string | null;
  readonly permalink: string | null;
  readonly published_at: string;
  readonly like_count_public: number | null;
  readonly comments_count_public: number | null;
}

/**
 * The insights of one media object.
 *
 * `supported` is false only when the provider's own documentation says the
 * media type has no insights at all. A timeout, a transport failure and a
 * malformed response are NEVER evidence that a metric is unsupported: they
 * are failures, and the media stays in the queue.
 */
export interface OwnerMediaInsights {
  readonly supported: boolean;
  readonly metrics: Readonly<Record<string, number>>;
}

/** Why the media sweep stopped. */
export type MediaSweepStop =
  | "window_covered"
  | "feed_exhausted"
  | "page_cap"
  | "unusable_cursor"
  | "usage_stop";

/** The result of one media inventory sweep. */
export interface OwnerMediaSweep {
  readonly items: readonly OwnerMediaItem[];
  readonly pagesFetched: number;
  readonly truncated: boolean;
  readonly windowCovered: boolean;
  readonly oldestReturnedAt: string | null;
  readonly nextCursor: string | null;
  readonly stopped: MediaSweepStop;
}

/** A provider answer that carries its usage. */
export interface OwnerProviderResult<T> {
  readonly value: T;
  readonly usagePercent: number;
}

/**
 * Validates the configured Graph version.
 *
 * A malformed version is a configuration refusal, not a silent default.
 */
export function resolveOwnerGraphApiVersion(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return DEFAULT_GRAPH_API_VERSION;
  }
  const value = raw.trim();
  if (!VERSION_GRAMMAR.test(value)) {
    throw new Error("The configured Graph API version is not a valid version.");
  }
  return value;
}

/**
 * The documented media insights metrics of one media.
 *
 * The set depends on the media's own product type, because Meta documents
 * which metric exists for which type. A media whose type has no insights at
 * all gets an EMPTY set: that is a positive statement from the provider's
 * documentation, and it is the only case in which a metric is terminal.
 *
 * An unknown product type gets the intersection of the documented sets, so
 * the request stays inside what the provider certainly has.
 */
export function mediaInsightMetricsFor(
  mediaProductType: string | null,
  mediaType: string | null,
): readonly string[] {
  if (mediaType !== null && mediaType.trim().toUpperCase() === ALBUM_MEDIA_TYPE) {
    return [];
  }

  const key = mediaProductType === null ? "" : mediaProductType.trim().toUpperCase();
  const documented = MEDIA_INSIGHT_METRICS_BY_PRODUCT_TYPE[key];
  if (documented !== undefined) return documented;

  return UNIVERSAL_MEDIA_INSIGHT_METRICS;
}

/**
 * Reads the usage percentage out of the two Meta usage headers.
 *
 * Both headers are read and the highest percentage wins. The parser walks
 * the whole document, so a nested business or use-case object is found
 * wherever it sits.
 */
export function parseOwnerUsagePercent(headers: Headers): number {
  return Math.max(
    readUsageHeader(headers.get("x-app-usage")),
    readUsageHeader(headers.get("x-business-use-case-usage")),
  );
}

function readUsageHeader(raw: string | null): number {
  if (!raw) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A header that is not JSON is not evidence of usage.
    return 0;
  }

  return collectUsagePercentages(parsed, 0);
}

function collectUsagePercentages(value: unknown, into: number): number {
  if (Array.isArray(value)) {
    let highest = into;
    for (const entry of value) {
      highest = collectUsagePercentages(entry, highest);
    }
    return highest;
  }

  if (typeof value !== "object" || value === null) return into;

  const record = value as Record<string, unknown>;
  let highest = into;

  for (const key of ["call_count", "total_time", "total_cputime"]) {
    const candidate = record[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    highest = Math.max(highest, Math.min(100, Math.max(0, candidate)));
  }

  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === "object") {
      highest = collectUsagePercentages(nested, highest);
    }
  }

  return highest;
}

/**
 * A promise that rejects when the signal aborts.
 *
 * It bounds a read that a transport may never settle.
 */
function abortRejection(signal: AbortSignal, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new OwnerProviderError(message, { kind: "provider_error" }));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(new OwnerProviderError(message, { kind: "provider_error" }));
    }, { once: true });
  });
}

/**
 * Reads a response body with a hard byte cap.
 *
 * The abort signal stays armed for the whole read, so a provider that sends
 * headers and then stalls cannot outlive the attempt ceiling. A transport
 * that ignores the abort is still bounded: the read is raced against the
 * signal, not merely cancelled.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const onAbort = () => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      // The reader's cancellation is not the outcome of the read.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (signal.aborted) {
        throw new OwnerProviderError(
          "The provider response did not complete inside its ceiling.",
          { kind: "provider_error" },
        );
      }

      const { done, value } = await Promise.race([
        reader.read(),
        abortRejection(
          signal,
          "The provider response did not complete inside its ceiling.",
        ),
      ]);

      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new OwnerProviderError(
          "The provider response was larger than this adapter accepts.",
          { kind: "provider_error" },
        );
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      // The reader's cancellation is not the outcome of the read.
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/**
 * Reads a count.
 *
 *   absent or null -> null (unavailable)
 *   negative       -> null (a hidden count is unavailable, not negative)
 *   not a number   -> the response is malformed and fails
 *   fractional     -> the response is malformed and fails
 *   beyond 2^53    -> the response is malformed and fails
 */
function readCount(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new OwnerProviderError(
      "The provider returned a malformed count.",
      { kind: "provider_error" },
    );
  }
  if (raw < 0) return null;
  if (!Number.isInteger(raw)) {
    throw new OwnerProviderError(
      "The provider returned a fractional count.",
      { kind: "provider_error" },
    );
  }
  if (!Number.isSafeInteger(raw)) {
    throw new OwnerProviderError(
      "The provider returned a count that cannot be represented exactly.",
      { kind: "provider_error" },
    );
  }
  return raw;
}

function readBoundedText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const raw = record[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new OwnerProviderError(
      "The provider returned a malformed text field.",
      { kind: "provider_error" },
    );
  }
  if (raw.length > maxLength) {
    throw new OwnerProviderError(
      "The provider returned an oversized text field.",
      { kind: "provider_error" },
    );
  }
  return raw;
}

/**
 * Reads the Graph error envelope, as far as this adapter reads it.
 *
 * Only the code, the subcode and whether the message names an insights
 * scope are read. The message itself is never copied.
 */
export function readOwnerGraphErrorEnvelope(
  payload: unknown,
): { readonly code: number | null; readonly subcode: number | null; readonly mentionsScope: boolean } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return null;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "number" && Number.isFinite(record.code)
    ? record.code
    : null;
  const subcode = typeof record.error_subcode === "number" &&
      Number.isFinite(record.error_subcode)
    ? record.error_subcode
    : null;

  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  const mentionsScope = INSIGHTS_SCOPE_MARKERS.some((marker) => message.includes(marker));

  return { code, subcode, mentionsScope };
}

/**
 * Classifies a Graph error envelope.
 *
 * The classification is by code first and by message only where the code is
 * silent. Nothing here reads an account id or a token out of the message.
 */
export function classifyOwnerGraphError(
  envelope: { readonly code: number | null; readonly mentionsScope: boolean },
  httpStatus: number,
  usagePercent: number,
  throttledUntil: Date | null,
): OwnerProviderError {
  const options = { usagePercent, throttledUntil, statusCode: httpStatus };

  if (httpStatus === 429) {
    return new OwnerProviderError(
      "The provider is throttling this application.",
      { ...options, kind: "rate_limited" },
    );
  }

  const { code, mentionsScope } = envelope;

  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    return new OwnerProviderError(
      "The provider is throttling this application.",
      { ...options, kind: "rate_limited" },
    );
  }

  if (code !== null && TOKEN_ERROR_CODES.has(code)) {
    return new OwnerProviderError(
      "The provider rejected the credential.",
      { ...options, kind: "token_invalid" },
    );
  }

  if (code !== null && PERMISSION_ERROR_CODES.has(code)) {
    // A permission refusal is the provider's own signal that this
    // credential cannot read this data. It is not a transport failure and it
    // is not the account's fault.
    return new OwnerProviderError(
      "The provider refused the permission for this collection.",
      { ...options, kind: "scope_missing" },
    );
  }

  if (usagePercent >= USAGE_STOP_PERCENT) {
    return new OwnerProviderError(
      "The provider usage budget is nearly spent.",
      { ...options, kind: "rate_limited" },
    );
  }

  if (mentionsScope) {
    return new OwnerProviderError(
      "The provider refused the permission for this collection.",
      { ...options, kind: "scope_missing" },
    );
  }

  return new OwnerProviderError(
    "The provider request failed.",
    { ...options, kind: "provider_error", retryable: httpStatus >= 500 },
  );
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: unknown }).name === "AbortError";
}

/** A bounded, abort-aware pause between retries. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A SHA-256 digest, as lower-case hex.
 *
 * The platform's own Web Crypto implementation is used, so no third-party
 * hash is added to this repository.
 */
export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("The runtime does not provide a SHA-256 implementation.");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The Graph adapter for the owner collection.
 */
export class InstagramGraphProvider {
  readonly #apiVersion: string;
  readonly #appId: string | null;
  readonly #fetchFn: typeof fetch;
  readonly #attemptTimeoutMs: number;

  constructor(options: OwnerGraphProviderOptions = {}) {
    this.#apiVersion = resolveOwnerGraphApiVersion(options.apiVersion ?? null);
    this.#appId = options.appId ?? null;
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS;
  }

  /**
   * The shared throttle bucket key.
   *
   * It is a digest of the APP and the protected CREDENTIAL id (never the
   * token): Meta meters a User token per app, and every account bound to
   * that grant shares the meter. Neither input is a secret, so the digest is
   * not one either, and the database never receives a credential.
   */
  async bucketKey(credentialId: string): Promise<string> {
    return await sha256Hex(
      `instagram_owner:${this.#appId ?? "unknown-app"}:${credentialId}`,
    );
  }

  /** The account profile observation. */
  async fetchAccountProfile(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerProfileObservation>> {
    const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igUserId)}` +
      `?fields=followers_count,media_count` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#attempt(url, input.signal);

    const payload = this.#requireObject(response.payload);
    const followers = readCount(payload, "followers_count");
    const media = readCount(payload, "media_count");

    if (followers === null && media === null) {
      throw new OwnerProviderError(
        "The provider returned a profile without a usable count.",
        { kind: "provider_error", usagePercent: response.usagePercent },
      );
    }

    return {
      value: { followers_count: followers, media_count: media },
      usagePercent: response.usagePercent,
    };
  }

  /**
   * The account day of interactions.
   *
   * The request is the documented one for Graph v22: the metrics are
   * requested with `metric_type=total_value`, `period=day` and an explicit
   * `since`/`until` range, and the answer is read from
   * `data[].total_value.value`.
   *
   * There is deliberately NO fallback to `values[]`: on this endpoint
   * `values` is the time-series shape, and reading it as a total would
   * store a bucket sum under the wrong meaning. A metric row without a
   * `total_value` leaves that metric null; a malformed `total_value` or a
   * value that is not an exactly representable non-negative integer is a
   * provider error.
   */
  async fetchAccountDay(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly date: string;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerAccountDay>> {
    const since = Date.parse(`${input.date}T00:00:00+03:00`);
    const until = since + 86_400_000 - 1;

    const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igUserId)}` +
      `/insights?metric=${encodeURIComponent(ACCOUNT_DAY_METRICS.join(","))}` +
      `&period=day&metric_type=total_value` +
      `&since=${Math.floor(since / 1000)}&until=${Math.floor(until / 1000)}` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#attempt(url, input.signal);
    const rows = this.#requireDataArray(response.payload);

    const metrics: {
      reach?: number;
      views?: number;
      accounts_engaged?: number;
      total_interactions?: number;
    } = {};

    for (const row of rows) {
      const record = this.#requireObject(row);
      const name = record.name;
      if (typeof name !== "string") {
        throw new OwnerProviderError(
          "The provider returned a metric without a name.",
          { kind: "provider_error", usagePercent: response.usagePercent },
        );
      }
      if (!ACCOUNT_DAY_METRICS.includes(name)) continue;

      const period = record.period;
      if (period !== undefined && period !== null) {
        if (typeof period !== "string" || period !== "day") {
          throw new OwnerProviderError(
            "The provider returned a metric for another period.",
            { kind: "provider_error", usagePercent: response.usagePercent },
          );
        }
      }

      const total = record.total_value;
      if (total === undefined || total === null) {
        // The provider did not report this metric. It stays null: it is not
        // a zero, and it is not a number borrowed from another shape.
        continue;
      }

      const totalRecord = this.#requireObject(total);
      const raw = totalRecord.value;
      if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isSafeInteger(raw) ||
        raw < 0) {
        throw new OwnerProviderError(
          "The provider returned a malformed metric value.",
          { kind: "provider_error", usagePercent: response.usagePercent },
        );
      }

      metrics[name as keyof typeof metrics] = raw;
    }

    return {
      value: {
        provider_date: input.date,
        metric_date: input.date,
        period_start: new Date(since).toISOString(),
        period_end: new Date(until).toISOString(),
        provider_timezone: "Asia/Kuwait",
        query_kind: "interactions",
        metrics,
      },
      usagePercent: response.usagePercent,
    };
  }

  /**
   * The insights of ONE media object.
   *
   * The metric set is the documented set for the media's own product type,
   * and the request never asks for a metric the accepted whitelist cannot
   * store. The media endpoint documents its answer in `data[].values[]`
   * (`total_value` is only populated for a breakdown, and this adapter asks
   * for none), so the value is read from there.
   *
   * The attempt is bounded to four seconds and it is NEVER retried
   * automatically: the media continuation is a bounded sweep, and a retry
   * would spend the run's budget twice for the same media.
   */
  async fetchMediaInsights(input: {
    readonly igMediaId: string;
    readonly token: string;
    readonly mediaProductType: string | null;
    readonly mediaType: string | null;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerMediaInsights>> {
    const metrics = mediaInsightMetricsFor(input.mediaProductType, input.mediaType);
    if (metrics.length === 0) {
      // The provider's own documentation says this media has no insights.
      // That is a positive statement about the media, not a failure.
      return { value: { supported: false, metrics: {} }, usagePercent: 0 };
    }

    const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igMediaId)}` +
      `/insights?metric=${encodeURIComponent(metrics.join(","))}` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#attempt(url, input.signal, {
      maxAttempts: 1,
      attemptTimeoutMs: MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
    });
    const rows = this.#requireDataArray(response.payload);

    const reported: Record<string, number> = {};

    for (const row of rows) {
      const record = this.#requireObject(row);
      const name = record.name;
      if (typeof name !== "string") {
        throw new OwnerProviderError(
          "The provider returned a metric without a name.",
          { kind: "provider_error", usagePercent: response.usagePercent },
        );
      }
      // A metric that was not requested, or that the accepted whitelist
      // cannot store, is never written.
      if (!metrics.includes(name)) continue;

      const values = record.values;
      if (values === undefined || values === null) continue;
      if (!Array.isArray(values)) {
        throw new OwnerProviderError(
          "The provider returned a malformed metric bucket.",
          { kind: "provider_error", usagePercent: response.usagePercent },
        );
      }
      if (values.length === 0) continue;

      const first = this.#requireObject(values[0]);
      const raw = first.value;
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isSafeInteger(raw) ||
        raw < 0) {
        throw new OwnerProviderError(
          "The provider returned a malformed metric value.",
          { kind: "provider_error", usagePercent: response.usagePercent },
        );
      }

      reported[name] = raw;
    }

    return { value: { supported: true, metrics: reported }, usagePercent: response.usagePercent };
  }

  /**
   * The media inventory sweep.
   *
   * The sweep walks the provider's media connection newest-first and stops
   * when it has proved the window: either an item older than the window
   * start was seen, or the feed ended. A sweep that stopped at the page cap
   * is TRUNCATED and the window is not covered, and the caller resumes it
   * from the returned cursor.
   */
  async fetchMediaWindow(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly cursor: string | null;
    readonly maxPages: number;
    readonly pageSize?: number;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerMediaSweep>> {
    const windowStart = Date.parse(`${input.windowStart}T00:00:00Z`);
    const pageSize = input.pageSize ?? MEDIA_PAGE_SIZE;

    const items: OwnerMediaItem[] = [];
    let pagesFetched = 0;
    let usagePercent = 0;
    let cursor = input.cursor;
    let oldestReturnedAt: string | null = null;
    let truncated = false;
    let windowCovered = false;
    let stopped: MediaSweepStop = "feed_exhausted";

    while (pagesFetched < input.maxPages) {
      const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igUserId)}` +
        `/media?fields=${encodeURIComponent(MEDIA_FIELDS)}&limit=${pageSize}` +
        (cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`) +
        `&access_token=${encodeURIComponent(input.token)}`;

      const response = await this.#attempt(url, input.signal);
      usagePercent = Math.max(usagePercent, response.usagePercent);
      pagesFetched += 1;

      const rows = this.#requireDataArray(response.payload);

      for (const row of rows) {
        const record = this.#requireObject(row);
        const published = this.#readPublishedAt(record);
        const publishedMs = Date.parse(published);

        if (publishedMs < windowStart) {
          // The window boundary was reached. Nothing older belongs to the
          // window, so the sweep is complete.
          windowCovered = true;
          stopped = "window_covered";
          break;
        }

        if (oldestReturnedAt === null || published < oldestReturnedAt) {
          oldestReturnedAt = published;
        }

        const productType = record.media_product_type;
        if (typeof productType === "string" && productType.trim().toUpperCase() === "AD") {
          // An advertisement has no insights. It is not stored, but it still
          // counts towards the window boundary.
          continue;
        }

        items.push(this.#readMediaItem(record, published));
      }

      if (windowCovered) break;

      if (usagePercent >= USAGE_STOP_PERCENT) {
        // The usage budget is nearly spent. No further page is requested
        // for this sweep, and the inventory stays visibly incomplete.
        truncated = true;
        stopped = "usage_stop";
        break;
      }

      const next = this.#readNextCursor(response.payload);
      if (next === null) {
        // The feed ended inside the window: there is nothing older to fetch.
        windowCovered = true;
        stopped = "feed_exhausted";
        break;
      }

      if (!CURSOR_GRAMMAR.test(next)) {
        // The provider offered a page this adapter cannot follow safely.
        truncated = true;
        stopped = "unusable_cursor";
        break;
      }

      cursor = next;

      if (pagesFetched >= input.maxPages) {
        truncated = true;
        stopped = "page_cap";
      }
    }

    return {
      value: {
        items,
        pagesFetched,
        truncated,
        windowCovered,
        oldestReturnedAt,
        nextCursor: truncated ? cursor : null,
        stopped,
      },
      usagePercent,
    };
  }

  // -------------------------------------------------------------------------
  // The private helpers
  // -------------------------------------------------------------------------

  #requireObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new OwnerProviderError(
        "The provider response was not an object.",
        { kind: "provider_error" },
      );
    }
    return value as Record<string, unknown>;
  }

  #requireDataArray(payload: unknown): unknown[] {
    const record = this.#requireObject(payload);
    const data = record.data;
    if (!Array.isArray(data)) {
      // A missing or non-array `data` is a malformed response. It is never
      // read as "the provider returned nothing".
      throw new OwnerProviderError(
        "The provider response carried no data array.",
        { kind: "provider_error" },
      );
    }
    return data;
  }

  #readPublishedAt(record: Record<string, unknown>): string {
    const timestamp = record.timestamp;
    if (typeof timestamp !== "string" || timestamp.trim() === "") {
      throw new OwnerProviderError(
        "The provider returned a media row without a publication time.",
        { kind: "provider_error" },
      );
    }
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
      throw new OwnerProviderError(
        "The provider returned a media row with an unusable publication time.",
        { kind: "provider_error" },
      );
    }
    return parsed.toISOString();
  }

  #readMediaItem(record: Record<string, unknown>, publishedAt: string): OwnerMediaItem {
    const id = record.id;
    if (typeof id !== "string" || id.trim() === "" || id.length > 255) {
      throw new OwnerProviderError(
        "The provider returned a media row without a usable id.",
        { kind: "provider_error" },
      );
    }

    const productType = record.media_product_type;
    if (productType !== undefined && productType !== null && typeof productType !== "string") {
      throw new OwnerProviderError(
        "The provider returned a malformed media product type.",
        { kind: "provider_error" },
      );
    }

    const mediaType = record.media_type;
    if (mediaType !== undefined && mediaType !== null && typeof mediaType !== "string") {
      throw new OwnerProviderError(
        "The provider returned a malformed media type.",
        { kind: "provider_error" },
      );
    }

    return {
      ig_media_id: id,
      media_product_type: typeof productType === "string" && productType.trim() !== ""
        ? productType.trim().toUpperCase().slice(0, 32)
        : null,
      media_type: typeof mediaType === "string" && mediaType.trim() !== ""
        ? mediaType.trim().toUpperCase().slice(0, 32)
        : null,
      thumbnail_url: readBoundedText(record, "thumbnail_url", MAX_TEXT_LENGTH),
      caption: readBoundedText(record, "caption", MAX_TEXT_LENGTH),
      permalink: readBoundedText(record, "permalink", MAX_TEXT_LENGTH),
      published_at: publishedAt,
      like_count_public: readCount(record, "like_count"),
      comments_count_public: readCount(record, "comments_count"),
    };
  }

  /**
   * Reads the next page cursor.
   *
   * The provider's `paging.next` URL is never requested and never parsed.
   * Only the opaque cursor value is read.
   */
  #readNextCursor(payload: unknown): string | null {
    const record = this.#requireObject(payload);
    const paging = record.paging;
    if (paging === undefined || paging === null) return null;
    if (typeof paging !== "object" || Array.isArray(paging)) {
      throw new OwnerProviderError(
        "The provider returned a malformed media connection.",
        { kind: "provider_error" },
      );
    }
    const cursors = (paging as Record<string, unknown>).cursors;
    if (cursors === undefined || cursors === null) return null;
    if (typeof cursors !== "object" || Array.isArray(cursors)) {
      throw new OwnerProviderError(
        "The provider returned a malformed media connection.",
        { kind: "provider_error" },
      );
    }
    const after = (cursors as Record<string, unknown>).after;
    if (after === undefined || after === null) return null;
    if (typeof after !== "string" || after.trim() === "") return null;
    return after;
  }

  /**
   * One attempt, with the bounded retry policy applied around it.
   *
   * Only a transport failure and a 5xx are retried, at most twice, and only
   * while the caller's deadline allows it. A rejected credential, a refused
   * permission, a malformed response and a successful response are never
   * retried.
   *
   * The media insights calls ask for ONE attempt: the media continuation is
   * a bounded sweep inside one run, and a retry would spend the run's
   * budget twice for the same media.
   */
  async #attempt(
    url: string,
    signal: AbortSignal,
    options: {
      readonly maxAttempts?: number;
      readonly attemptTimeoutMs?: number;
    } = {},
  ): Promise<{
    readonly payload: unknown;
    readonly usagePercent: number;
    readonly throttledUntil: Date | null;
  }> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const attemptTimeoutMs = options.attemptTimeoutMs ?? this.#attemptTimeoutMs;
    let lastError: OwnerProviderError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal.aborted) {
        throw new OwnerProviderError(
          "The collection attempt was cancelled before the provider call.",
          { kind: "provider_error" },
        );
      }

      try {
        return await this.#fetchOnce(url, signal, attemptTimeoutMs);
      } catch (error) {
        if (error instanceof OwnerProviderError) {
          if (!error.retryable || attempt === maxAttempts - 1) throw error;
          lastError = error;
          await delay(250, signal);
          continue;
        }
        throw new OwnerProviderError(
          "The provider request failed.",
          { kind: "provider_error", retryable: true },
        );
      }
    }

    throw lastError ??
      new OwnerProviderError("The provider request failed.", { kind: "provider_error" });
  }

  async #fetchOnce(
    url: string,
    signal: AbortSignal,
    attemptTimeoutMs: number,
  ): Promise<{
    readonly payload: unknown;
    readonly usagePercent: number;
    readonly throttledUntil: Date | null;
  }> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);

    try {
      // Raced, not merely signalled: a transport that ignores the abort must
      // not keep the attempt waiting past its ceiling.
      const pending = this.#fetchFn(url, { signal: controller.signal });
      pending.catch(() => undefined);
      const response = await Promise.race([
        pending,
        abortRejection(
          controller.signal,
          "The provider request did not complete inside its ceiling.",
        ),
      ]);

      // The usage headers are read for EVERY response, including the
      // failures, and before the body is consumed.
      const usagePercent = parseOwnerUsagePercent(response.headers);
      const throttledUntil = readRetryAfter(response.headers);

      let bodyText: string;
      try {
        bodyText = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal);
      } catch (error) {
        if (error instanceof OwnerProviderError) throw error;
        throw new OwnerProviderError(
          "The provider response could not be read.",
          { kind: "provider_error", usagePercent },
        );
      }

      let payload: unknown = null;
      if (bodyText.trim() !== "") {
        try {
          payload = JSON.parse(bodyText);
        } catch {
          throw new OwnerProviderError(
            "The provider response was not valid JSON.",
            { kind: "provider_error", usagePercent },
          );
        }
      }

      // A Graph error can arrive with HTTP 200. It is an error, not an
      // empty success.
      const errorEnvelope = readOwnerGraphErrorEnvelope(payload);
      if (errorEnvelope !== null) {
        throw classifyOwnerGraphError(
          errorEnvelope,
          response.status,
          usagePercent,
          throttledUntil,
        );
      }

      if (!response.ok) {
        if (response.status >= 500) {
          throw new OwnerProviderError(
            "The provider request failed.",
            { kind: "provider_error", usagePercent, retryable: true, statusCode: response.status },
          );
        }
        throw classifyOwnerGraphError(
          { code: null, mentionsScope: false },
          response.status,
          usagePercent,
          throttledUntil,
        );
      }

      return { payload, usagePercent, throttledUntil };
    } catch (error) {
      if (error instanceof OwnerProviderError) throw error;
      if (isAbortError(error)) {
        throw new OwnerProviderError(
          "The provider request did not complete inside its ceiling.",
          { kind: "provider_error", retryable: !signal.aborted, statusCode: null },
        );
      }
      throw new OwnerProviderError(
        "The provider request failed.",
        { kind: "provider_error", retryable: true },
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }
  }
}

/**
 * Reads the provider's own throttle deadline.
 *
 * A `Retry-After` header in seconds becomes an instant. A malformed header
 * is not a deadline: the caller then uses the shared window.
 */
export function readRetryAfter(headers: Headers, now: number = Date.now()): Date | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(now + Math.ceil(seconds) * 1000);
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed) && parsed > now) {
    return new Date(parsed);
  }

  return null;
}
