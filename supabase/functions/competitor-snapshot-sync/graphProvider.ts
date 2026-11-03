/**
 * The Meta Graph adapter for Instagram Business Discovery.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The HTTP shape of one Business Discovery capture: the URL grammar, the
 *   pagination, the response validation, the usage-header reading, the
 *   bounded retry policy and the failure classification.
 *
 * THE DOCUMENTED FIELD EXPANSION
 *
 *   Business Discovery is read with the documented expansion
 *
 *     business_discovery.username(<handle>){ <profile fields>,
 *       media.limit(<page size>){ <media fields> } }
 *
 *   `username(<handle>)` is request grammar only: the response carries the
 *   target's fields DIRECTLY on `business_discovery` (a requested `username`
 *   field there is a plain string). The older `business_discovery.fields(...)`
 *   shape with a separate `username` query parameter is a DIFFERENT request
 *   and is not used here.
 *
 * WHY THE HANDLE IS VALIDATED BEFORE IT IS INTERPOLATED
 *
 *   The handle goes into a FIELD EXPRESSION. A handle that carried a brace,
 *   a parenthesis or a comma could change the meaning of the request. The
 *   grammar below is the same one the database enforces, so a handle that
 *   reaches this module is already normalised; it is validated again here
 *   because this module must be safe on its own.
 *
 * WHY THE CURSOR IS REBUILT AND NEVER FOLLOWED
 *
 *   The provider's `paging.next` is a URL that may point anywhere. It is
 *   never requested. The cursor VALUE is validated against a strict
 *   character allow-list and is re-inserted into a request this module
 *   builds itself, on the one host this module trusts. A cursor that does
 *   not match the allow-list stops the pagination instead of being sent.
 *
 * WHY THE TIMEOUT COVERS THE BODY
 *
 *   A timeout that is cleared when the headers arrive leaves the body read
 *   unbounded, which is the shape of a hung worker. The abort stays armed
 *   until the body has been read, and the body itself is size-capped.
 *
 * WHY A FAILURE NEVER CARRIES THE PROVIDER TEXT
 *
 *   A Graph error message can quote the token, the account id or an
 *   internal URL. The failures below carry a stable message and a stable
 *   kind. The raw text is read, classified and dropped.
 *
 * WHY 100/33 IS NOT "THE TARGET IS UNAVAILABLE"
 *
 *   Meta's own message for code 100 subcode 33 is "Unsupported get
 *   request. Object with ID does not exist, cannot be loaded due to
 *   missing permissions, or does not support this operation". It names
 *   three different causes, one of which is a permission problem of the
 *   VIEWER. Treating it as "the target does not exist" would park a
 *   competitor for a week because the viewer's permissions were wrong.
 *
 *   Meta's published Instagram error table documents no code or subcode
 *   that unambiguously means "this Business Discovery target does not
 *   exist", and a missing or empty expansion is a malformed response, not
 *   a verdict. This adapter therefore NEVER reports `target_unavailable`:
 *   every error envelope - including 100/33 - is retryable. Mapping a
 *   provider signal onto the weekly gate needs a verified live fixture
 *   first (release-readiness gate).
 */

import {
  CompetitorProviderError,
  CompetitorProviderPermitError,
  oldestPublishedAt,
  type CompetitorCoverageGapReason,
  type CompetitorMediaItem,
  type CompetitorProfileObservation,
  type CompetitorProvider,
  type CompetitorProviderPermit,
  type CompetitorProviderRequest,
  type CompetitorProviderResult,
  type CompetitorSource,
} from "./types.ts";

/**
 * Asks the permit for one request.
 *
 * A refusal leaves here unchanged, so the caller can tell a refused target
 * from a failed credential. A permit that fails in any other way is
 * UNAVAILABLE: the outcome of the admission decision is unknown, and an
 * unknown outcome is never permission.
 */
async function askPermit(
  permit: CompetitorProviderPermit,
  signal: AbortSignal,
): Promise<void> {
  try {
    await permit(signal);
  } catch (error) {
    if (error instanceof CompetitorProviderPermitError) throw error;
    throw new CompetitorProviderPermitError("unavailable", "permit_failed");
  }
}

/** The one host this module ever talks to. */
const GRAPH_HOST = "https://graph.facebook.com";

/** The default Graph version. Configurable, and validated when configured. */
export const DEFAULT_GRAPH_API_VERSION = "v22.0";

/** The page size of the media connection. */
export const MEDIA_PAGE_SIZE = 25;

/** The hard cap on the media rows of one capture. */
export const MAX_MEDIA_ROWS = 30;

/** The hard cap on the pages of one capture. */
export const MAX_MEDIA_PAGES = 2;

/** The provider ceiling for one attempt: headers AND body. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;

/** The hard cap on the response body of one attempt. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The usage percentage at which the provider work stops. */
export const USAGE_STOP_PERCENT = 80;

/** The Graph error codes that mean "the provider is throttling". */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** The Graph error codes that mean "the credential was rejected". */
const TOKEN_ERROR_CODES = new Set([190]);

/** The Graph error codes that mean "the permission was refused". */
const PERMISSION_ERROR_CODES = new Set([10, 200]);

/**
 * The profile fields of the target.
 *
 * `profile_picture_url` is part of the documented request. The snapshot
 * tables have no column for it, so it is not stored; it is requested
 * because the documented field set is the contract.
 */
const TARGET_FIELDS = [
  "id",
  "username",
  "name",
  "followers_count",
  "media_count",
  "profile_picture_url",
  "biography",
  "website",
].join(",");

/** The media fields of the target. */
const MEDIA_FIELDS = [
  "id",
  "media_type",
  "media_product_type",
  "timestamp",
  "permalink",
  "caption",
  "like_count",
  "comments_count",
  "view_count",
  "thumbnail_url",
  "media_url",
].join(",");

const HANDLE_GRAMMAR = /^[a-z0-9._]{1,30}$/;
const CURSOR_GRAMMAR = /^[A-Za-z0-9_=-]{1,512}$/;
const VERSION_GRAMMAR = /^v\d{1,3}\.\d{1,2}$/;

const KNOWN_PRODUCT_TYPES = new Set(["FEED", "REELS", "STORY", "AD"]);
const KNOWN_MEDIA_TYPES = new Set(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]);

export interface GraphProviderOptions {
  /** The Graph version. Defaults to v22.0 and is validated. */
  readonly apiVersion?: string;
  /** The Meta app id, used only to build the shared throttle bucket key. */
  readonly appId?: string | null;
  /** The transport. Injectable so a test never reaches the network. */
  readonly fetchFn?: typeof fetch;
  /** The per-attempt ceiling. */
  readonly attemptTimeoutMs?: number;
}

/**
 * The result of one capture.
 *
 * The usage percentage is reported even when the capture failed, because
 * the caller has to persist the shared bucket state after EVERY provider
 * response.
 */
export type GraphCaptureResult = CompetitorProviderResult;

/**
 * Normalises and validates a tracked handle.
 *
 * The database normalises it the same way. Both are applied so this module
 * never interpolates something the field grammar could not carry.
 */
export function normalizeCompetitorHandle(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!HANDLE_GRAMMAR.test(trimmed)) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

/**
 * Validates the configured Graph version.
 *
 * A malformed version is a configuration refusal, not a silent default: a
 * typo that fell back to v22.0 would hide the fact that the deployment is
 * not configured the way the operator believes.
 */
export function resolveGraphApiVersion(raw: string | null | undefined): string {
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
 * Reads the usage percentage out of the two Meta usage headers.
 *
 * Both headers are read and the highest percentage wins. Reading only the
 * first header, or only the first nested object, would under-report a
 * nearly spent budget.
 *
 * The parser walks the whole document, so a nested business or use-case
 * object is found wherever it sits.
 */
export function parseUsagePercent(headers: Headers): number {
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
    // Meta reports percentages. A value outside the range is clamped rather
    // than dropped: an over-reported budget is spent, and stopping early is
    // the safe direction.
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
 * Builds the Business Discovery URL.
 *
 * The handle and the cursor are the only interpolated values and both are
 * validated against a strict grammar first. The token is a query
 * parameter, which is the pattern Meta documents for Graph API; the URL is
 * never logged and never returned to a caller.
 */
export function buildBusinessDiscoveryUrl(input: {
  readonly apiVersion: string;
  readonly viewerIgUserId: string;
  readonly handle: string;
  readonly token: string;
  readonly cursor?: string | null;
}): string {
  const mediaConnection = input.cursor
    ? `media.limit(${MEDIA_PAGE_SIZE}).after(${input.cursor}){${MEDIA_FIELDS}}`
    : `media.limit(${MEDIA_PAGE_SIZE}){${MEDIA_FIELDS}}`;

  const fields =
    `business_discovery.username(${input.handle}){${TARGET_FIELDS},${mediaConnection}}`;

  return `${GRAPH_HOST}/${input.apiVersion}/${encodeURIComponent(input.viewerIgUserId)}` +
    `?fields=${encodeURIComponent(fields)}` +
    `&access_token=${encodeURIComponent(input.token)}`;
}

/**
 * Reads a response body with a hard byte cap.
 *
 * The abort signal stays armed for the whole read, so a provider that
 * sends headers and then stalls cannot outlive the attempt ceiling. A
 * transport that ignores the abort is still bounded: the read is raced
 * against the signal, not merely cancelled.
 */
export async function readBoundedBody(
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
          "The provider response did not complete inside its ceiling.",
        );
      }

      const { done, value } = await Promise.race([
        reader.read(),
        abortRejection(signal),
      ]);

      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new CompetitorProviderError(
          "provider_error",
          "The provider response was larger than this adapter accepts.",
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
 * A promise that rejects when the signal aborts.
 *
 * It is used to bound a read that a transport may never settle.
 */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new CompetitorProviderError(
        "provider_error",
        "The provider response did not complete inside its ceiling.",
      ));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(new CompetitorProviderError(
        "provider_error",
        "The provider response did not complete inside its ceiling.",
      ));
    }, { once: true });
  });
}

/** The Graph error envelope, as far as this adapter reads it. */
export interface GraphErrorEnvelope {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly hasPermissionSignal: boolean;
  /** The message names one of the insights scopes by name. */
  readonly mentionsInsightsScope: boolean;
}

export function readGraphErrorEnvelope(payload: unknown): GraphErrorEnvelope | null {
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
  const hasPermissionSignal = message.includes("permission") ||
    message.includes("not authorized") ||
    message.includes("access denied");
  const mentionsInsightsScope = message.includes("instagram_manage_insights") ||
    message.includes("instagram_business_manage_insights");

  return { code, subcode, hasPermissionSignal, mentionsInsightsScope };
}

/**
 * Classifies a Graph error envelope.
 *
 * The classification is by code first and by message only where the code
 * is silent. Nothing here reads the target handle out of the message.
 */
export function classifyGraphError(
  envelope: GraphErrorEnvelope,
  httpStatus: number,
  usagePercent: number,
): CompetitorProviderError {
  const options = { usagePercent };

  if (httpStatus === 429) {
    return new CompetitorProviderError(
      "rate_limited",
      "The provider is throttling this application.",
      options,
    );
  }

  const { code, hasPermissionSignal, mentionsInsightsScope } = envelope;

  if (code !== null && TOKEN_ERROR_CODES.has(code)) {
    return new CompetitorProviderError(
      "token_invalid",
      "The provider rejected the credential.",
      options,
    );
  }

  if (code !== null && PERMISSION_ERROR_CODES.has(code)) {
    // Code 10 also means "insufficient viewers" on some endpoints. On a
    // Business Discovery read it is a permission refusal, and a permission
    // refusal is retryable: it is never the weekly "the target is gone"
    // verdict.
    return new CompetitorProviderError(
      "scope_missing",
      "The provider refused the permission for this discovery.",
      options,
    );
  }

  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    return new CompetitorProviderError(
      "rate_limited",
      "The provider is throttling this application.",
      options,
    );
  }

  if (usagePercent >= USAGE_STOP_PERCENT) {
    return new CompetitorProviderError(
      "rate_limited",
      "The provider usage budget is nearly spent.",
      options,
    );
  }

  if (code === 100) {
    // The generic code. Its message names several possible causes, one of
    // which is the VIEWER's permissions, so it is only a permission
    // failure when it names the scope. Anything else stays a retryable
    // provider failure: it is never the weekly "the target is gone"
    // verdict.
    if (mentionsInsightsScope) {
      return new CompetitorProviderError(
        "scope_missing",
        "The provider refused the permission for this discovery.",
        options,
      );
    }
    return new CompetitorProviderError(
      "provider_error",
      "The provider request failed.",
      { usagePercent, retryable: httpStatus >= 500 },
    );
  }

  if (hasPermissionSignal && code !== null && code >= 200) {
    return new CompetitorProviderError(
      "scope_missing",
      "The provider refused the permission for this discovery.",
      options,
    );
  }

  return new CompetitorProviderError(
    "provider_error",
    "The provider request failed.",
    { usagePercent, retryable: httpStatus >= 500 },
  );
}

/**
 * Reads a public count.
 *
 *   absent or null -> null (unavailable)
 *   negative       -> null (a hidden count is unavailable, not negative)
 *   not a number   -> the capture is malformed and fails
 *   fractional     -> the capture is malformed and fails
 */
function readCount(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a malformed count.",
    );
  }
  if (raw < 0) return null;
  if (!Number.isInteger(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a fractional count.",
    );
  }
  if (!Number.isSafeInteger(raw)) {
    // Beyond 2^53 the parsed number is no longer the value Meta sent.
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a count that cannot be represented exactly.",
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
  if (typeof raw !== "string") {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a malformed text field.",
    );
  }
  if (raw.length > maxLength) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned an oversized text field.",
    );
  }
  return raw;
}

/**
 * Reads one media row.
 *
 * A row without an id, without a valid publication instant, or with an
 * unknown format is a MALFORMED capture. It is not dropped: dropping it
 * would turn a broken response into a successful but empty capture.
 */
export function parseBusinessDiscoveryMedia(raw: unknown): CompetitorMediaItem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a malformed media row.",
    );
  }
  const record = raw as Record<string, unknown>;

  const id = record.id;
  if (typeof id !== "string" || id.trim() === "" || id.length > 255) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a media row without a usable id.",
    );
  }

  const timestamp = record.timestamp;
  if (typeof timestamp !== "string" || timestamp.trim() === "") {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a media row without a publication time.",
    );
  }
  const publishedAt = new Date(timestamp);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a media row with an unusable publication time.",
    );
  }

  const productType = record.media_product_type;
  if (productType !== undefined && productType !== null) {
    if (typeof productType !== "string" || !KNOWN_PRODUCT_TYPES.has(productType)) {
      throw new CompetitorProviderError(
        "provider_error",
        "The provider returned an unknown media product type.",
      );
    }
  }

  const mediaType = record.media_type;
  if (mediaType !== undefined && mediaType !== null) {
    if (typeof mediaType !== "string" || !KNOWN_MEDIA_TYPES.has(mediaType)) {
      throw new CompetitorProviderError(
        "provider_error",
        "The provider returned an unknown media type.",
      );
    }
  }

  return {
    ig_media_id: id,
    media_product_type: typeof productType === "string" ? productType : null,
    media_type: typeof mediaType === "string" ? mediaType : null,
    thumbnail_url: readOptionalText(record, "thumbnail_url", 2000),
    caption: readOptionalText(record, "caption", 2000),
    permalink: readOptionalText(record, "permalink", 2000),
    published_at: publishedAt.toISOString(),
    like_count: readCount(record, "like_count"),
    comments_count: readCount(record, "comments_count"),
    view_count: readCount(record, "view_count"),
  };
}

/**
 * Reads the profile observation.
 *
 * The counts are optional. A missing count is unavailable, not zero.
 */
export function parseBusinessDiscoveryProfile(raw: unknown): CompetitorProfileObservation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a malformed profile.",
    );
  }
  const record = raw as Record<string, unknown>;
  return {
    followers_count: readCount(record, "followers_count"),
    media_count: readCount(record, "media_count"),
  };
}

/**
 * Reads the target out of the documented expansion.
 *
 * The target sits under `business_discovery.username`. An expansion that is
 * present but empty is the unambiguous "there is no target to analyse"
 * signal: Meta resolved the request and there is no business object.
 */
export function readBusinessDiscoveryTarget(
  payload: unknown,
): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider response was not an object.",
    );
  }

  // `username(<handle>)` is REQUEST grammar only. The documented response
  // carries the target's fields directly on `business_discovery`, and a
  // requested `username` field there is a plain string. A missing or
  // malformed object is a broken response, never proof that the target is
  // gone: the unambiguous "target unavailable" verdict comes only from the
  // provider's typed error (see classifyGraphError).
  const discovery = (payload as Record<string, unknown>).business_discovery;
  if (typeof discovery !== "object" || discovery === null || Array.isArray(discovery)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider response carried no business discovery.",
    );
  }

  const record = discovery as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a target without an id.",
    );
  }

  return record;
}

/**
 * Reads the media connection of the target.
 *
 * The connection is an object with `data` and `paging`, never a bare
 * array.
 */
function readMediaConnection(
  target: Record<string, unknown>,
  profile: CompetitorProfileObservation,
): {
  readonly rows: readonly unknown[];
  readonly nextCursor: MediaCursor;
} {
  const media = target.media;
  if (media === undefined && profile.media_count === 0) {
    // Graph omits the connection of an account that has never posted. Only
    // the provider's own zero count proves that emptiness.
    return { rows: [], nextCursor: { present: false, usable: false, cursor: null } };
  }
  if (typeof media !== "object" || media === null || Array.isArray(media)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a malformed media connection.",
    );
  }

  const data = (media as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new CompetitorProviderError(
      "provider_error",
      "The provider returned a malformed media connection.",
    );
  }
  return { rows: data, nextCursor: readMediaCursor(target) };
}

/**
 * The media cursor of the nested media connection.
 *
 * `present` says whether the provider offered a next page at all.
 * `usable` says whether the cursor may be sent. The two are different: an
 * unusable cursor stops the pagination and makes the capture visibly
 * partial, while a missing cursor ends the feed cleanly.
 */
export interface MediaCursor {
  readonly present: boolean;
  readonly usable: boolean;
  readonly cursor: string | null;
}

export function readMediaCursor(target: Record<string, unknown>): MediaCursor {
  const media = target.media;
  if (typeof media !== "object" || media === null || Array.isArray(media)) {
    return { present: false, usable: false, cursor: null };
  }

  const paging = (media as Record<string, unknown>).paging;
  if (typeof paging !== "object" || paging === null || Array.isArray(paging)) {
    return { present: false, usable: false, cursor: null };
  }

  const cursors = (paging as Record<string, unknown>).cursors;
  if (typeof cursors !== "object" || cursors === null || Array.isArray(cursors)) {
    return { present: false, usable: false, cursor: null };
  }

  const after = (cursors as Record<string, unknown>).after;
  if (typeof after !== "string" || after.trim() === "") {
    return { present: false, usable: false, cursor: null };
  }
  if (!CURSOR_GRAMMAR.test(after)) {
    return { present: true, usable: false, cursor: null };
  }

  return { present: true, usable: true, cursor: after };
}

/**
 * The Graph adapter.
 */
export class GraphCompetitorProvider implements CompetitorProvider {
  readonly source: CompetitorSource = "official";

  readonly #apiVersion: string;
  readonly #appId: string | null;
  readonly #fetchFn: typeof fetch;
  readonly #attemptTimeoutMs: number;

  constructor(options: GraphProviderOptions = {}) {
    this.#apiVersion = resolveGraphApiVersion(options.apiVersion ?? null);
    this.#appId = options.appId ?? null;
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS;
  }

  /**
   * The shared throttle bucket key.
   *
   * It is a digest of the APP and the protected CREDENTIAL id (never the
   * token): Meta meters a User token per app, and every Page of that grant
   * shares the meter. Neither input is a secret, so the digest is not one
   * either, and the database never receives a credential.
   */
  async bucketKey(credentialId: string): Promise<string> {
    return await sha256Hex(
      `instagram_discovery:${this.#appId ?? "unknown-app"}:${credentialId}`,
    );
  }

  async fetch(request: CompetitorProviderRequest): Promise<GraphCaptureResult> {
    const handle = normalizeCompetitorHandle(request.username);
    if (handle === null) {
      throw new CompetitorProviderError(
        "provider_error",
        "The tracked handle is not a usable Instagram handle.",
      );
    }

    if (!request.viewerIgUserId || request.viewerIgUserId.length > 255) {
      throw new CompetitorProviderError(
        "provider_error",
        "The viewer identity is not usable for a discovery request.",
      );
    }

    // The start of the capture window. The coverage carries it so the
    // database can tell a capture window from an instant.
    const captureStartedAt = new Date().toISOString();

    const seenCursors = new Set<string>();
    const seenMediaIds = new Set<string>();
    const media: CompetitorMediaItem[] = [];
    let usagePercent = 0;
    let throttledUntil: Date | null = null;
    let truncated = false;
    let cursor: string | null = null;
    let profile: CompetitorProfileObservation | null = null;

    // The coverage evidence.
    //
    // Only this adapter knows what it observed while walking the feed, so
    // only this adapter may fill these in. The ORDER is deliberately NOT
    // verified: no tested, version-compatible ordering contract for this
    // provider exists, and sorting the rows we received would not prove one.
    let cursorPresent = false;
    let exhausted = false;
    let gapReason: CompetitorCoverageGapReason | null = null;

    // The FIRST reason the walk was compromised is the informative one: a
    // later cap does not explain an earlier duplicate.
    const noteGap = (reason: CompetitorCoverageGapReason): void => {
      truncated = true;
      if (gapReason === null) gapReason = reason;
    };

    for (let page = 0; page < MAX_MEDIA_PAGES; page += 1) {
      const attempt = await this.#attempt(request, handle, cursor);

      usagePercent = Math.max(usagePercent, attempt.usagePercent);
      throttledUntil = attempt.throttledUntil;

      if (profile === null) {
        profile = parseBusinessDiscoveryProfile(attempt.target);
      }

      const connection = readMediaConnection(attempt.target, profile);
      const nextCursor = connection.nextCursor;

      // Whether there is MORE to fetch is a property of the LAST response
      // the provider gave. It is read before the media loop can stop the
      // walk, because a capture that hit the row cap still knows whether
      // the feed continued past it.
      cursorPresent = nextCursor.present;

      for (const entry of connection.rows) {
        if (media.length >= MAX_MEDIA_ROWS) {
          noteGap("media_cap_reached");
          break;
        }
        const item = parseBusinessDiscoveryMedia(entry);
        if (seenMediaIds.has(item.ig_media_id)) {
          // A repeated media id means the feed window is not clean. The
          // repeat is skipped and the capture is marked as compromised.
          noteGap("duplicate_media");
          break;
        }
        seenMediaIds.add(item.ig_media_id);
        media.push(item);
      }

      if (usagePercent >= USAGE_STOP_PERCENT) {
        // The usage budget is nearly spent. No further request is made for
        // this capture.
        noteGap("usage_budget_stop");
        break;
      }

      if (!nextCursor.present) {
        // The feed ended. The walk is complete - unless something already
        // compromised the feed window.
        exhausted = gapReason === null;
        break;
      }

      if (!nextCursor.usable || nextCursor.cursor === null) {
        // The provider offered a next page but the cursor cannot be sent
        // safely. The pagination stops and the capture stays visibly
        // partial.
        noteGap("cursor_unusable");
        break;
      }

      if (seenCursors.has(nextCursor.cursor)) {
        // A repeated cursor stops the pagination. It is never requested
        // twice and never guessed around.
        noteGap("cursor_loop");
        break;
      }

      if (media.length >= MAX_MEDIA_ROWS) {
        // The media window is full and the provider still offers a page:
        // the feed continues past what this capture could hold.
        noteGap("media_cap_reached");
        break;
      }

      seenCursors.add(nextCursor.cursor);
      cursor = nextCursor.cursor;
    }

    if (gapReason === null && !exhausted) {
      // The page budget of one capture was reached while the provider was
      // still offering pages. The feed was NOT exhausted and the window
      // this capture saw may be a small part of the target's feed.
      noteGap("page_cap_reached");
    }

    if (profile === null) {
      // Unreachable in practice: the first page always yields a target.
      throw new CompetitorProviderError(
        "provider_error",
        "The provider returned no target for this discovery.",
      );
    }

    const captureEndedAt = new Date().toISOString();

    return {
      capture: {
        source: "official",
        profile,
        media,
        truncated,
        coverage: {
          captureStartedAt,
          // The window cannot end before it started, even if the wall clock
          // moved backwards underneath the capture.
          captureEndedAt: captureEndedAt < captureStartedAt ? captureStartedAt : captureEndedAt,
          oldestReturnedAt: oldestPublishedAt(media),
          orderingVerified: false,
          cursorPresent,
          exhausted,
          truncated,
          gapReason,
        },
      },
      usagePercent,
      throttledUntil,
    };
  }

  /**
   * One capture attempt, with the bounded retry policy applied around it.
   *
   * Only a transport failure and a 5xx are retried, at most twice, and only
   * while the caller's deadline allows it. A rejected credential, a refused
   * permission, a malformed response and a successful response are never
   * retried.
   *
   * The PERMIT is asked before EVERY attempt, never once per call: a retry
   * is a new request and it needs a new authorization. Because the page
   * walk asks this method once per page, the cursor request of the second
   * page is guarded as well. A refused or failed permit is NOT retried and
   * NOT converted into a provider failure - it leaves this method
   * immediately, so no request is sent.
   */
  async #attempt(
    request: CompetitorProviderRequest,
    handle: string,
    cursor: string | null,
  ): Promise<{
    readonly target: Record<string, unknown>;
    readonly nextCursor: string | null;
    readonly usagePercent: number;
    readonly throttledUntil: Date | null;
  }> {
    let lastError: CompetitorProviderError | null = null;

    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (request.signal.aborted) {
        throw new CompetitorProviderError(
          "provider_error",
          "The collection attempt was cancelled before the provider call.",
        );
      }

      // THE AUTHORIZATION INSTANT. The last decision before the request
      // goes out, asked again for every retry and every page.
      if (request.permit !== undefined) {
        await askPermit(request.permit, request.signal);
      }

      try {
        return await this.#fetchOnce(request, handle, cursor);
      } catch (error) {
        if (error instanceof CompetitorProviderPermitError) {
          // The request was not authorized. It leaves here unchanged: it is
          // not a provider failure and it is never retried.
          throw error;
        }
        if (error instanceof CompetitorProviderError) {
          if (!error.retryable || attempt === 2) throw error;
          lastError = error;
          await delay(250, request.signal);
          continue;
        }
        throw new CompetitorProviderError(
          "provider_error",
          "The provider request failed.",
          { retryable: true },
        );
      }
    }

    throw lastError ??
      new CompetitorProviderError("provider_error", "The provider request failed.");
  }

  async #fetchOnce(
    request: CompetitorProviderRequest,
    handle: string,
    cursor: string | null,
  ): Promise<{
    readonly target: Record<string, unknown>;
    readonly nextCursor: string | null;
    readonly usagePercent: number;
    readonly throttledUntil: Date | null;
  }> {
    const url = buildBusinessDiscoveryUrl({
      apiVersion: this.#apiVersion,
      viewerIgUserId: request.viewerIgUserId,
      handle,
      token: request.token,
      cursor,
    });

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    request.signal.addEventListener("abort", onOuterAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), this.#attemptTimeoutMs);

    try {
      // Raced, not merely signalled: a transport that ignores the abort must
      // not keep the attempt waiting past its ceiling.
      const pending = this.#fetchFn(url, { signal: controller.signal });
      pending.catch(() => undefined);
      const response = await Promise.race([pending, abortRejection(controller.signal)]);

      // The usage headers are read for EVERY response, including the
      // failures, and before the body is consumed.
      const usagePercent = parseUsagePercent(response.headers);

      let bodyText: string;
      try {
        bodyText = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal);
      } catch (error) {
        if (error instanceof CompetitorProviderError) throw error;
        throw new CompetitorProviderError(
          "provider_error",
          "The provider response could not be read.",
          { usagePercent },
        );
      }

      let payload: unknown = null;
      if (bodyText.trim() !== "") {
        try {
          payload = JSON.parse(bodyText);
        } catch {
          throw new CompetitorProviderError(
            "provider_error",
            "The provider response was not valid JSON.",
            { usagePercent },
          );
        }
      }

      // A Graph error can arrive with HTTP 200. It is an error, not an
      // empty success.
      const errorEnvelope = readGraphErrorEnvelope(payload);
      if (errorEnvelope !== null) {
        throw classifyGraphError(errorEnvelope, response.status, usagePercent);
      }

      if (!response.ok) {
        if (response.status >= 500) {
          throw new CompetitorProviderError(
            "provider_error",
            "The provider request failed.",
            { usagePercent, retryable: true },
          );
        }
        throw classifyGraphError(
          {
            code: null,
            subcode: null,
            hasPermissionSignal: false,
            mentionsInsightsScope: false,
          },
          response.status,
          usagePercent,
        );
      }

      const target = readBusinessDiscoveryTarget(payload);

      return { target, nextCursor: null, usagePercent, throttledUntil: null };
    } catch (error) {
      if (error instanceof CompetitorProviderError) throw error;
      if (isAbortError(error)) {
        throw new CompetitorProviderError(
          "provider_error",
          "The provider request did not complete inside its ceiling.",
          { retryable: !request.signal.aborted },
        );
      }
      throw new CompetitorProviderError(
        "provider_error",
        "The provider request failed.",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onOuterAbort);
    }
  }
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
