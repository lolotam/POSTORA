/**
 * The Meta Graph adapter for the OWNER collection, Facebook login.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The HTTP shape of one owner capture for a Facebook-login account: the
 *   URL grammar, the account profile, the account day, the media inventory
 *   sweep, the field lists, the metric sets and the reading rules of every
 *   answer.
 *
 *   The transport itself - the attempt ceiling, the body cap, the abort
 *   race, the bounded retry policy, the usage-header reading and the
 *   failure classification - lives in providerTransport.ts, because the
 *   Instagram-login adapter needs exactly the same machinery on a
 *   different host.
 *
 * WHY THIS IS NOT THE INSTAGRAM-LOGIN ADAPTER
 *
 *   A Facebook-login account and an Instagram-login account are answered by
 *   DIFFERENT hosts with DIFFERENT fields and DIFFERENT permission names.
 *   This adapter talks to graph.facebook.com with a Facebook User token and
 *   the Facebook-login field list. The Instagram-login adapter
 *   (directGraphProvider.ts) talks to graph.instagram.com with an Instagram
 *   User token and the field list Meta documents for that login. Swapping
 *   the hostname between them would ask for fields the provider does not
 *   return and would read answers that mean something else.
 *
 * WHY THE PAGINATION CURSOR IS REBUILT AND NEVER FOLLOWED
 *
 *   The provider's `paging.next` is a URL that may point anywhere. It is
 *   never requested. The cursor VALUE is validated against a strict
 *   character allow-list and is re-inserted into a request this module
 *   builds itself, on the one host this module trusts.
 *
 *   The PRESENCE of that URL is also the signal that another page exists.
 *   A page without a `paging.next` is the last page, so the sweep stops
 *   there instead of spending one more call on a cursor the provider never
 *   offered a next-page for.
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

import {
  CURSOR_GRAMMAR,
  MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  OwnerProviderError,
  OwnerProviderPermitError,
  OwnerProviderTransport,
  PROVIDER_ATTEMPT_TIMEOUT_MS,
  USAGE_STOP_PERCENT,
  classifyOwnerGraphError,
  parseOwnerUsagePercent,
  readOwnerGraphErrorEnvelope,
  readProviderBoundedText,
  readProviderCount,
  readProviderNextCursor,
  readRetryAfter,
  requireProviderDataArray,
  resolveGraphApiVersion,
  sha256Hex,
  type MediaSweepStop,
  type OwnerAccountDay,
  type OwnerMediaInsights,
  type OwnerMediaItem,
  type OwnerMediaSweep,
  type OwnerProfileObservation,
  type OwnerProviderErrorKind,
  type OwnerProviderErrorOptions,
  type OwnerProviderPermit,
  type OwnerProviderResult,
} from "./providerTransport.ts";

/** The one host this module ever talks to. */
const GRAPH_HOST = "https://graph.facebook.com";

/** The default Graph version. */
export const DEFAULT_GRAPH_API_VERSION = "v22.0";

/**
 * The shared surface, re-exported.
 *
 * These names used to live here. They now live in providerTransport.ts,
 * because the Instagram-login adapter needs the same machinery, and they
 * are re-exported so the Graph family keeps ONE import site for the shared
 * contract.
 */
export {
  MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  PROVIDER_ATTEMPT_TIMEOUT_MS,
  OwnerProviderError,
  OwnerProviderPermitError,
  USAGE_STOP_PERCENT,
  classifyOwnerGraphError,
  parseOwnerUsagePercent,
  readOwnerGraphErrorEnvelope,
  readRetryAfter,
  sha256Hex,
};
export type {
  MediaSweepStop,
  OwnerAccountDay,
  OwnerMediaInsights,
  OwnerMediaItem,
  OwnerMediaSweep,
  OwnerProfileObservation,
  OwnerProviderErrorKind,
  OwnerProviderErrorOptions,
  OwnerProviderPermit,
  OwnerProviderResult,
};

/** The page size of the media connection. */
export const MEDIA_PAGE_SIZE = 50;

/**
 * The account day metrics this adapter collects.
 *
 * Meta documents `reach`, `views`, `accounts_engaged` and
 * `total_interactions` with the `day` period and the `total_value` metric
 * type for BOTH login kinds
 * (https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights).
 */
const ACCOUNT_DAY_METRICS = ["reach", "views", "accounts_engaged", "total_interactions"];

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
 * The media type of an Instagram Media ALBUM.
 *
 * Meta documents, under "Album metrics" of the media insights reference
 * (https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights):
 * "Insights data is not available for any media WITHIN an Instagram Media
 * album."
 *
 * The sentence is about the CHILDREN of an album - the single images and
 * videos it holds. The album itself is a FEED media and it HAS insights, so
 * it is collected with the documented FEED metrics.
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

/**
 * Validates the configured Graph version.
 *
 * A malformed version is a configuration refusal, not a silent default.
 */
export function resolveOwnerGraphApiVersion(raw: string | null | undefined): string {
  return resolveGraphApiVersion(raw, DEFAULT_GRAPH_API_VERSION);
}

/**
 * The documented media insights metrics of one media.
 *
 * The set depends on the media's own surface, because Meta documents which
 * metric exists for which surface.
 *
 * An ALBUM is a FEED media: the media insights reference says that "Insights
 * data is not available for any media WITHIN an Instagram Media album", and
 * the children of an album are the ones without insights - not the album
 * itself. The album is therefore collected with the documented FEED metrics.
 *
 * An unknown product type gets the intersection of the documented sets, so
 * the request stays inside what the provider certainly has.
 */
export function mediaInsightMetricsFor(
  mediaProductType: string | null,
  mediaType: string | null,
): readonly string[] {
  if (mediaType !== null && mediaType.trim().toUpperCase() === ALBUM_MEDIA_TYPE) {
    return MEDIA_INSIGHT_METRICS_BY_PRODUCT_TYPE.FEED;
  }

  const key = mediaProductType === null ? "" : mediaProductType.trim().toUpperCase();
  const documented = MEDIA_INSIGHT_METRICS_BY_PRODUCT_TYPE[key];
  if (documented !== undefined) return documented;

  return UNIVERSAL_MEDIA_INSIGHT_METRICS;
}

/**
 * The Graph adapter for the owner collection.
 */
export class InstagramGraphProvider {
  readonly #apiVersion: string;
  readonly #appId: string | null;
  readonly #transport: OwnerProviderTransport;

  constructor(options: OwnerGraphProviderOptions = {}) {
    this.#apiVersion = resolveOwnerGraphApiVersion(options.apiVersion ?? null);
    this.#appId = options.appId ?? null;
    this.#transport = new OwnerProviderTransport({
      fetchFn: options.fetchFn,
      attemptTimeoutMs: options.attemptTimeoutMs,
    });
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
    /**
     * The per-request admission permit.
     *
     * It is asked immediately before the request leaves the process. It is
     * never optional in production: the caller always binds it.
     */
    readonly permit?: OwnerProviderPermit;
  }): Promise<OwnerProviderResult<OwnerProfileObservation>> {
    const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igUserId)}` +
      `?fields=followers_count,media_count` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#transport.attempt(url, input.signal, {
      permit: input.permit,
    });

    const payload = this.#requireObject(response.payload);
    const followers = readProviderCount(payload, "followers_count");
    const media = readProviderCount(payload, "media_count");

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
    readonly permit?: OwnerProviderPermit;
  }): Promise<OwnerProviderResult<OwnerAccountDay>> {
    const since = Date.parse(`${input.date}T00:00:00+03:00`);
    const until = since + 86_400_000 - 1;

    const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igUserId)}` +
      `/insights?metric=${encodeURIComponent(ACCOUNT_DAY_METRICS.join(","))}` +
      `&period=day&metric_type=total_value` +
      `&since=${Math.floor(since / 1000)}&until=${Math.floor(until / 1000)}` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#transport.attempt(url, input.signal, {
      permit: input.permit,
    });
    const rows = requireProviderDataArray(response.payload);

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
    readonly permit?: OwnerProviderPermit;
  }): Promise<OwnerProviderResult<OwnerMediaInsights>> {
    const metrics = mediaInsightMetricsFor(input.mediaProductType, input.mediaType);

    const url = `${GRAPH_HOST}/${this.#apiVersion}/${encodeURIComponent(input.igMediaId)}` +
      `/insights?metric=${encodeURIComponent(metrics.join(","))}` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#transport.attempt(url, input.signal, {
      maxAttempts: 1,
      attemptTimeoutMs: MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
      permit: input.permit,
    });
    const rows = requireProviderDataArray(response.payload);

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

    return { value: { metrics: reported }, usagePercent: response.usagePercent };
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
    readonly permit?: OwnerProviderPermit;
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

      const response = await this.#transport.attempt(url, input.signal, {
        permit: input.permit,
      });
      usagePercent = Math.max(usagePercent, response.usagePercent);
      pagesFetched += 1;

      const rows = requireProviderDataArray(response.payload);

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

      // A page without a `paging.next` is the last page. The cursor is only
      // read when the provider offered a next-page URL, and the URL itself
      // is never requested.
      const next = readProviderNextCursor(response.payload);
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
      thumbnail_url: readProviderBoundedText(record, "thumbnail_url", MAX_TEXT_LENGTH),
      caption: readProviderBoundedText(record, "caption", MAX_TEXT_LENGTH),
      permalink: readProviderBoundedText(record, "permalink", MAX_TEXT_LENGTH),
      published_at: publishedAt,
      like_count_public: readProviderCount(record, "like_count"),
      comments_count_public: readProviderCount(record, "comments_count"),
    };
  }
}
