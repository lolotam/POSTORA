/**
 * The shared transport and contract of the OWNER collection providers.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The parts of a Meta collection call that are the SAME for every login
 *   kind: the HTTP shape of one attempt, the body cap, the abort race, the
 *   bounded retry policy, the usage-header reading, the failure
 *   classification, the cursor grammar, the count and text readers, and the
 *   projection shapes the worker consumes.
 *
 *   It owns NO host and NO endpoint. The Facebook-login adapter
 *   (graphProvider.ts) and the Instagram-login adapter
 *   (directGraphProvider.ts) each own their own host, their own field
 *   lists, their own metric sets and their own URL grammar. This module is
 *   the machinery they share, not a base class they inherit a host from.
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
 */

/** The provider ceiling of one attempt: headers AND body. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;

/** The hard cap on the response body of one attempt. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The usage percentage at which the provider work stops. */
export const USAGE_STOP_PERCENT = 80;

/**
 * The ceiling of ONE media insights attempt: headers AND body.
 *
 * The media continuation fetches at most five media per visit, sequentially,
 * inside one forty second run, so a single media call may not spend more
 * than four seconds of it.
 */
export const MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS = 4_000;

/** The version grammar. */
const VERSION_GRAMMAR = /^v\d{1,3}\.\d{1,2}$/;

/** The insights scopes a Graph message may name. */
const INSIGHTS_SCOPE_MARKERS = [
  "instagram_manage_insights",
  "instagram_business_manage_insights",
];

/** The cursor grammar. A cursor is an opaque provider token, never a URL. */
export const CURSOR_GRAMMAR = /^[A-Za-z0-9_=-]{1,512}$/;

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
  /**
   * The Graph error code the provider named, when it named one.
   *
   * The code is a NUMBER, never the provider's text, and it is what tells a
   * refusal of ONE item apart from a refusal of the whole account: Meta
   * answers a single media it will never answer with code 10 or 100, while
   * a credential the provider rejects answers with 190.
   */
  readonly graphCode?: number | null;
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
  /** The Graph error code, when the provider named one. */
  readonly graphCode: number | null;

  constructor(message: string, options: OwnerProviderErrorOptions) {
    super(message);
    this.name = "OwnerProviderError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.usagePercent = options.usagePercent ?? 0;
    this.throttledUntil = options.throttledUntil ?? null;
    this.retryable = options.retryable ?? false;
    this.graphCode = options.graphCode ?? null;
  }
}

/** A provider answer that carries its usage. */
export interface OwnerProviderResult<T> {
  readonly value: T;
  readonly usagePercent: number;
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
 * The metrics are the ones the provider REPORTED. A metric the provider did
 * not report is absent, never zero: "the provider reported zero" and "the
 * provider reported nothing" are different facts, and only one of them is a
 * measurement.
 *
 * A timeout, a transport failure and a malformed response are NOT an empty
 * answer: they are failures, and the media stays in the queue.
 */
export interface OwnerMediaInsights {
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

/**
 * Validates a configured Graph version.
 *
 * A malformed version is a configuration refusal, not a silent default.
 */
export function resolveGraphApiVersion(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim();
  if (!VERSION_GRAMMAR.test(value)) {
    throw new Error("The configured Graph API version is not a valid version.");
  }
  return value;
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

/** The Graph error codes that mean "the provider is throttling". */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** The Graph error codes that mean "the credential was rejected". */
const TOKEN_ERROR_CODES = new Set([190]);

/** The Graph error codes that mean "the permission was refused". */
const PERMISSION_ERROR_CODES = new Set([10, 200]);

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
  const options = {
    usagePercent,
    throttledUntil,
    statusCode: httpStatus,
    graphCode: envelope.code,
  };

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

/**
 * Reads a count.
 *
 *   absent or null -> null (unavailable)
 *   negative       -> null (a hidden count is unavailable, not negative)
 *   not a number   -> the response is malformed and fails
 *   fractional     -> the response is malformed and fails
 *   beyond 2^53    -> the response is malformed and fails
 */
export function readProviderCount(
  record: Record<string, unknown>,
  key: string,
): number | null {
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

/**
 * Reads a bounded text field.
 *
 * An absent field is null. A field that is not a string, or that is longer
 * than the accepted column, is a malformed response and not a truncation.
 */
export function readProviderBoundedText(
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

/** The answer of one attempt. */
export interface OwnerProviderAttempt {
  readonly payload: unknown;
  readonly usagePercent: number;
  readonly throttledUntil: Date | null;
}

export interface OwnerProviderTransportOptions {
  /** The transport. Injectable so a test never reaches the network. */
  readonly fetchFn?: typeof fetch;
  /** The per-attempt ceiling. */
  readonly attemptTimeoutMs?: number;
}

/**
 * The bounded HTTP transport of one provider family.
 *
 * It knows the URL it is given and nothing else: the host, the version and
 * the endpoint grammar belong to the adapter that calls it.
 */
export class OwnerProviderTransport {
  readonly #fetchFn: typeof fetch;
  readonly #attemptTimeoutMs: number;

  constructor(options: OwnerProviderTransportOptions = {}) {
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS;
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
  async attempt(
    url: string,
    signal: AbortSignal,
    options: {
      readonly maxAttempts?: number;
      readonly attemptTimeoutMs?: number;
    } = {},
  ): Promise<OwnerProviderAttempt> {
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
  ): Promise<OwnerProviderAttempt> {
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
 * Reads the `data` array of a provider answer.
 *
 * A missing or non-array `data` is a malformed response. It is never read
 * as "the provider returned nothing".
 */
export function requireProviderDataArray(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new OwnerProviderError(
      "The provider response was not an object.",
      { kind: "provider_error" },
    );
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new OwnerProviderError(
      "The provider response carried no data array.",
      { kind: "provider_error" },
    );
  }
  return data;
}

/**
 * Reads the provider's `paging` object.
 *
 * The provider's `paging.next` URL is never requested and never parsed.
 * Only the PRESENCE of that URL and the opaque cursor value are read, and
 * the cursor is re-inserted into a request the adapter builds itself, on
 * the one host the adapter trusts.
 *
 * A page WITHOUT a `paging.next` is the LAST page: the provider documents
 * that the next-page URL is the signal that another page exists, so a
 * `paging.cursors.after` on its own is not a licence to spend another call.
 */
export function readProviderNextCursor(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new OwnerProviderError(
      "The provider response was not an object.",
      { kind: "provider_error" },
    );
  }

  const paging = (payload as Record<string, unknown>).paging;
  if (paging === undefined || paging === null) return null;
  if (typeof paging !== "object" || Array.isArray(paging)) {
    throw new OwnerProviderError(
      "The provider returned a malformed media connection.",
      { kind: "provider_error" },
    );
  }

  const pagingRecord = paging as Record<string, unknown>;

  // The presence of the next-page URL is the whole signal. It is never
  // requested, never parsed and never logged.
  const next = pagingRecord.next;
  if (next === undefined || next === null) return null;
  if (typeof next !== "string") {
    throw new OwnerProviderError(
      "The provider returned a malformed media connection.",
      { kind: "provider_error" },
    );
  }

  const cursors = pagingRecord.cursors;
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
