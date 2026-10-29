/**
 * The bounded Apify adapter for the competitor fallback.
 *
 * WHY THIS EXISTS AT ALL
 *
 *   Plan decision P5 defers the SCHEDULED paid fallback. The interactive
 *   search path keeps its own admin-controlled fallback, and this adapter
 *   is the internal, bounded gateway a worker would use - never the
 *   user-JWT handler, which would run the paid actor under a browser
 *   identity.
 *
 *   The adapter is complete and tested, but the shipped composition of
 *   `competitor-snapshot-sync` injects a DISABLED policy. Nothing in this
 *   repository turns scheduled paid work on, and this module does not read
 *   a setting that could.
 *
 * WHY THE ACTOR IS STARTED, NOT "RUN SYNCHRONOUSLY"
 *
 *   The existing interactive path uses Apify's `run-sync-get-dataset-items`
 *   endpoint, which starts a run and waits for it in one request. That
 *   shape cannot be retried safely: a request that times out may have
 *   started a run that nobody will ever see, and a retry starts a second
 *   one. That is a duplicated bill.
 *
 *   This adapter therefore uses the ASYNCHRONOUS run start: one POST that
 *   creates a run and returns its id, followed by bounded reads of that
 *   run's dataset. The POST is never retried. If its response is lost, the
 *   outcome is INDETERMINATE - not a failure to retry - and the caller
 *   records that and stops.
 *
 * WHY THE CREDENTIAL IS IN A HEADER
 *
 *   The token is sent as `Authorization: Bearer <token>`. It is never a
 *   query parameter, so it cannot end up in a log line, a proxy log or an
 *   error message that quotes a URL.
 *
 * WHY ONLY ONE HOST
 *
 *   The adapter talks to `api.apify.com` and to nothing else. The actor id
 *   is server configuration and is validated; the target handle is
 *   validated; the results limit is capped.
 */

import {
  CompetitorProviderError,
  type CompetitorCapture,
  type CompetitorMediaItem,
  type CompetitorProfileObservation,
  type CompetitorReasonCode,
  type PaidCaptureOutcome,
  type PaidCaptureProvider,
} from "./types.ts";

/** The one host this module ever talks to. */
const APIFY_HOST = "https://api.apify.com";

/** The default actor, matching the interactive path's configuration. */
export const DEFAULT_APIFY_ACTOR_ID = "apify~instagram-scraper";

/** The hard cap on the rows one paid capture may return. */
export const MAX_PAID_MEDIA_ROWS = 30;

/** The ceiling for one request: headers AND body. */
export const APIFY_ATTEMPT_TIMEOUT_MS = 8_000;

/** The hard cap on a response body. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The actor id grammar: `owner~actor` or `owner/actor`. */
const ACTOR_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}[~/][A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The handle grammar, the same one the database enforces. */
const HANDLE_GRAMMAR = /^[a-z0-9._]{1,30}$/;

export interface ApifyProviderOptions {
  /** The actor id. Server configuration; validated when it is set. */
  readonly actorId?: string;
  /**
   * The API token. It is server configuration and it is sent as a bearer
   * header. It is never a query parameter and never a request payload.
   */
  readonly apiToken?: string;
  /** The transport. Injectable so a test never reaches the network. */
  readonly fetchFn?: typeof fetch;
  /** The per-request ceiling. */
  readonly attemptTimeoutMs?: number;
}

/**
 * Validates the configured actor id.
 *
 * A malformed actor id is a configuration refusal: a typo that silently
 * became the default actor would spend money on the wrong scrape.
 */
export function resolveApifyActorId(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return DEFAULT_APIFY_ACTOR_ID;
  }
  const value = raw.trim();
  if (!ACTOR_ID_GRAMMAR.test(value)) {
    throw new Error("The configured Apify actor id is not a valid actor id.");
  }
  return value;
}

/**
 * Builds the actor input.
 *
 * It is the same contract the interactive path uses, with the results
 * limit capped.
 */
export function buildApifyActorInput(username: string, resultsLimit: number): {
  readonly directUrls: readonly string[];
  readonly resultsType: string;
  readonly resultsLimit: number;
  readonly addParentData: boolean;
} {
  return {
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsType: "posts",
    resultsLimit: Math.min(Math.max(1, resultsLimit), MAX_PAID_MEDIA_ROWS),
    addParentData: true,
  };
}

/**
 * Reads a response body with a hard byte cap, under an armed abort.
 *
 * The read is RACED against the abort, not merely cancelled, so a
 * transport that ignores the abort cannot keep the worker waiting.
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
        throw new CompetitorProviderError(
          "provider_error",
          "The paid provider response did not complete inside its ceiling.",
        );
      }

      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new CompetitorProviderError(
              "provider_error",
              "The paid provider response did not complete inside its ceiling.",
            ));
          }, { once: true });
        }),
      ]);

      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new CompetitorProviderError(
          "provider_error",
          "The paid provider response was larger than this adapter accepts.",
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

function readCount(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The paid provider returned a malformed count.",
    );
  }
  if (raw < 0) return null;
  if (!Number.isInteger(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The paid provider returned a fractional count.",
    );
  }
  return raw;
}

function readOptionalText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const raw = record[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  if (raw.length > maxLength) {
    throw new CompetitorProviderError(
      "provider_error",
      "The paid provider returned an oversized text field.",
    );
  }
  return raw;
}

/**
 * Maps one paid dataset row onto a media row.
 *
 * A row without a usable id or without a usable publication instant is a
 * malformed capture. It is not dropped, because a dropped row turns a
 * broken response into a successful but empty capture.
 */
export function parseApifyMedia(raw: unknown): CompetitorMediaItem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The paid provider returned a malformed media row.",
    );
  }
  const record = raw as Record<string, unknown>;

  const id = typeof record.id === "string" && record.id.trim() !== ""
    ? record.id
    : typeof record.shortCode === "string" && record.shortCode.trim() !== ""
    ? record.shortCode
    : null;

  if (id === null || id.length > 255) {
    throw new CompetitorProviderError(
      "provider_error",
      "The paid provider returned a media row without a usable id.",
    );
  }

  const publishedAt = readPublishedAt(record.timestamp);
  if (publishedAt === null) {
    throw new CompetitorProviderError(
      "provider_error",
      "The paid provider returned a media row without a usable publication time.",
    );
  }

  const mediaType = mapApifyMediaType(record.type);

  return {
    ig_media_id: id,
    media_product_type: null,
    media_type: mediaType,
    thumbnail_url: readOptionalText(record, "displayUrl", 2000),
    caption: readOptionalText(record, "caption", 2000),
    permalink: typeof record.shortCode === "string" && record.shortCode !== ""
      ? `https://www.instagram.com/p/${record.shortCode}/`
      : null,
    published_at: publishedAt,
    like_count: readCount(record, "likesCount"),
    comments_count: readCount(record, "commentsCount"),
    view_count: readCount(record, "videoViewCount"),
  };
}

/**
 * The paid provider does not report Meta's product type, so the product
 * type stays unknown. The media type is the one the actor reports.
 */
function mapApifyMediaType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw === "Video") return "VIDEO";
  if (raw === "Sidecar") return "CAROUSEL_ALBUM";
  if (raw === "Image") return "IMAGE";
  return null;
}

/**
 * Reads a publication instant.
 *
 * The actor reports an ISO string. Some versions report seconds since the
 * epoch as a number. Both are accepted; anything else is unusable and is
 * never replaced with "now".
 */
function readPublishedAt(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const millis = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  if (typeof raw === "string" && raw.trim() !== "") {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  return null;
}

/**
 * The bounded paid adapter.
 */
export class ApifyCompetitorProvider implements PaidCaptureProvider {
  readonly source = "apify" as const;

  readonly #actorId: string;
  readonly #apiToken: string;
  readonly #fetchFn: typeof fetch;
  readonly #attemptTimeoutMs: number;

  constructor(options: ApifyProviderOptions = {}) {
    this.#actorId = resolveApifyActorId(options.actorId ?? null);
    this.#apiToken = options.apiToken ?? "";
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? APIFY_ATTEMPT_TIMEOUT_MS;
  }

  /**
   * One paid capture.
   *
   * The run start is NOT retried. A lost response is INDETERMINATE.
   */
  async capture(request: {
    readonly username: string;
    readonly signal: AbortSignal;
  }): Promise<PaidCaptureOutcome> {
    if (this.#apiToken === "") {
      // A paid adapter without a credential cannot start a run. It refuses
      // instead of sending an unauthenticated request.
      return { status: "failed", reason: "apify_disabled" };
    }

    const username = request.username.trim().replace(/^@+/, "").toLowerCase();
    if (!HANDLE_GRAMMAR.test(username) || username.includes("..")) {
      return { status: "failed", reason: "provider_error" };
    }

    const start = await this.#startRun(request, username);
    if (start.kind === "refused") {
      // The provider answered and refused. Nothing was started, so nothing
      // is billed and the outcome is a plain failure.
      return { status: "failed", reason: "provider_error" };
    }
    if (start.kind === "unknown") {
      // The request may have reached the provider. The submission is
      // unknown and must never be repeated.
      return { status: "indeterminate", reason: "provider_error" };
    }

    let items: unknown[];
    try {
      items = await this.#readDataset(request, start.runId);
    } catch {
      return { status: "failed", reason: "provider_error" };
    }

    try {
      const capture = this.#mapCapture(items, username);
      return { status: "completed", capture };
    } catch {
      return { status: "failed", reason: "provider_error" };
    }
  }

  /**
   * Starts the actor run.
   *
   * The response is read once. A refusal is a definite failure: nothing
   * was started. A failure AFTER the request was sent is an unknown
   * submission: the run may exist and may be billed, so it is never
   * repeated.
   */
  async #startRun(
    request: { readonly username: string; readonly signal: AbortSignal },
    username: string,
  ): Promise<
    | { readonly kind: "started"; readonly runId: string }
    | { readonly kind: "refused" }
    | { readonly kind: "unknown" }
  > {
    const url = `${APIFY_HOST}/v2/acts/${encodeURIComponent(this.#actorId)}/runs`;

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    request.signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#attemptTimeoutMs);

    try {
      const response = await this.#fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiToken}`,
        },
        body: JSON.stringify(buildApifyActorInput(username, MAX_PAID_MEDIA_ROWS)),
        signal: controller.signal,
      });

      const bodyText = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal);

      if (!response.ok) {
        // The run was refused. Nothing was started, so nothing is billed.
        return { kind: "refused" };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        // The provider accepted the request but the answer is unreadable.
        // The run may exist.
        return { kind: "unknown" };
      }

      const runId = readRunId(payload);
      if (runId === null) {
        // The run was created but its id could not be read. The run may
        // exist and may be billed.
        return { kind: "unknown" };
      }

      return { kind: "started", runId };
    } catch {
      // The request may have reached the provider. The submission is
      // unknown and must never be repeated.
      return { kind: "unknown" };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * Reads the run's dataset items.
   *
   * This is a read, so it is retried within the bounded policy.
   */
  async #readDataset(
    request: { readonly username: string; readonly signal: AbortSignal },
    runId: string,
  ): Promise<unknown[]> {
    const url =
      `${APIFY_HOST}/v2/acts/${encodeURIComponent(this.#actorId)}/runs/` +
      `${encodeURIComponent(runId)}/dataset/items?limit=${MAX_PAID_MEDIA_ROWS}`;

    let lastError: CompetitorProviderError | null = null;

    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (request.signal.aborted) {
        throw new CompetitorProviderError(
          "provider_error",
          "The paid capture was cancelled before the dataset read.",
        );
      }

      try {
        const { response, bodyText } = await this.#fetchWithCeiling(url, request);

        if (!response.ok) {
          if (response.status >= 500) {
            throw new CompetitorProviderError(
              "provider_error",
              "The paid provider request failed.",
              { retryable: true },
            );
          }
          throw new CompetitorProviderError(
            "provider_error",
            "The paid provider request failed.",
          );
        }

        const parsed = JSON.parse(bodyText);
        if (!Array.isArray(parsed)) {
          throw new CompetitorProviderError(
            "provider_error",
            "The paid provider returned a malformed dataset.",
          );
        }
        return parsed;
      } catch (error) {
        if (error instanceof CompetitorProviderError) {
          if (!error.retryable || attempt === 2) throw error;
          lastError = error;
          continue;
        }
        lastError = new CompetitorProviderError(
          "provider_error",
          "The paid provider request failed.",
          { retryable: true },
        );
        if (attempt === 2) throw lastError;
      }
    }

    throw lastError ??
      new CompetitorProviderError("provider_error", "The paid provider request failed.");
  }

  async #fetchWithCeiling(
    url: string,
    request: { readonly username: string; readonly signal: AbortSignal },
  ): Promise<{ readonly response: Response; readonly bodyText: string }> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    request.signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#attemptTimeoutMs);

    try {
      const response = await this.#fetchFn(url, {
        headers: { Authorization: `Bearer ${this.#apiToken}` },
        signal: controller.signal,
      });

      const bodyText = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal);
      return { response, bodyText };
    } catch (error) {
      if (error instanceof CompetitorProviderError) throw error;
      if (isAbortError(error)) {
        throw new CompetitorProviderError(
          "provider_error",
          "The paid provider request did not complete inside its ceiling.",
          { retryable: !request.signal.aborted },
        );
      }
      throw new CompetitorProviderError(
        "provider_error",
        "The paid provider request failed.",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onOuterAbort);
    }
  }

  #mapCapture(items: readonly unknown[], username: string): CompetitorCapture {
    const rows = items.slice(0, MAX_PAID_MEDIA_ROWS);
    const media: CompetitorMediaItem[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const item = parseApifyMedia(row);
      if (seen.has(item.ig_media_id)) continue;
      seen.add(item.ig_media_id);
      media.push(item);
    }

    const first = rows.length > 0 && typeof rows[0] === "object" && rows[0] !== null
      ? (rows[0] as Record<string, unknown>)
      : {};

    const profile: CompetitorProfileObservation = {
      followers_count: readCount(first, "followersCount"),
      media_count: readCount(first, "postsCount"),
    };

    return {
      source: "apify",
      profile,
      media,
      truncated: items.length > MAX_PAID_MEDIA_ROWS,
    };
  }
}

function readRunId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).id;
  if (typeof id !== "string" || id.trim() === "") return null;
  return id;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: unknown }).name === "AbortError";
}

/**
 * The reason recorded when a paid capture could not be attempted.
 *
 * It is a stable code, never provider text.
 */
export const PAID_FALLBACK_REFUSAL_REASON: CompetitorReasonCode = "apify_disabled";
