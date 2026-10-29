/**
 * The Meta Graph adapter for the OWNER collection, Instagram login.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The HTTP shape of one owner capture for an account that logs in to
 *   Instagram DIRECTLY, against the Instagram API with Instagram Login:
 *   the host, the version, the field lists, the metric sets, the URL
 *   grammar and the reading rules of every answer.
 *
 * WHY THIS IS A DISTINCT ADAPTER AND NOT THE FACEBOOK ONE
 *
 *   The Instagram API with Instagram Login is a DIFFERENT product surface
 *   from the Instagram API with Facebook Login, and Meta documents the
 *   differences. They are not cosmetic:
 *
 *   - The HOST is `graph.instagram.com` and the TOKEN is an Instagram User
 *     access token, not a Facebook User token
 *     (https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login).
 *   - The PERMISSIONS are `instagram_business_basic` and
 *     `instagram_business_manage_insights`
 *     (https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights).
 *   - The IG MEDIA fields `caption` and `media_product_type` are documented
 *     as "Available for Instagram API with Facebook Login only"
 *     (https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media),
 *     so this adapter never asks for them. Asking for a field the provider
 *     does not return is how a collector ends up storing an empty caption
 *     as if the post had none.
 *   - Because `media_product_type` is not available, the media surface
 *     cannot be told apart from the media type, so the media insights are
 *     requested with the INTERSECTION of the documented per-surface metric
 *     sets: the four metrics Meta documents for every surface that has
 *     insights at all.
 *   - The `/media` edge of an Instagram-login account does not return
 *     stories, so there is no story surface to ask about either.
 *
 *   Everything that IS the same is shared: the attempt ceiling, the body
 *   cap, the abort race, the bounded retry policy, the usage headers and
 *   the failure classification live in providerTransport.ts.
 *
 * WHY THE ANSWER SHAPES ARE THE SAME
 *
 *   Meta documents the account insights answer as `data[].total_value.value`
 *   for `metric_type=total_value`, and the media insights answer as
 *   `data[].values[].value`, for BOTH login kinds. The reading rules are
 *   therefore identical, and a missing metric stays null in both.
 *
 * WHY THE THROTTLE BUCKET IS NOT THE FACEBOOK ONE
 *
 *   A direct account has no protected Facebook User credential, so there is
 *   no Facebook credential id to meter against. The bucket is a digest of
 *   the app, the account and the credential generation instead. It is never
 *   the token, and it is never a fabricated Facebook credential id.
 *
 *   The app in that digest is the INSTAGRAM-LOGIN app (`INSTAGRAM_APP_ID`),
 *   never the Facebook-login app: the two logins are metered separately, and
 *   a bucket that named the Facebook app would put a direct account in the
 *   meter of the Facebook grant it never used. When no app id is configured,
 *   the digest carries the stable unconfigured namespace instead of the
 *   Facebook app id.
 */

import {
  CURSOR_GRAMMAR,
  MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
  OwnerProviderError,
  OwnerProviderTransport,
  USAGE_STOP_PERCENT,
  readProviderBoundedText,
  readProviderCount,
  readProviderNextCursor,
  requireProviderDataArray,
  resolveGraphApiVersion,
  sha256Hex,
  type MediaSweepStop,
  type OwnerAccountDay,
  type OwnerMediaInsights,
  type OwnerMediaItem,
  type OwnerMediaSweep,
  type OwnerProfileObservation,
  type OwnerProviderResult,
} from "./providerTransport.ts";

/** The one host this module ever talks to. */
export const INSTAGRAM_GRAPH_HOST = "https://graph.instagram.com";

/**
 * The environment variable that carries the Instagram-login app id.
 *
 * The Instagram-login app is NOT the Facebook-login app: the OAuth flow of
 * `instagram-oauth` exchanges the direct-login code against
 * `INSTAGRAM_APP_ID`, and the direct provider talks to
 * `graph.instagram.com` with that app's token. The Facebook provider keeps
 * `FACEBOOK_APP_ID`.
 */
export const INSTAGRAM_APP_ID_ENV = "INSTAGRAM_APP_ID";

/**
 * The namespace the direct bucket key carries when no app id is configured.
 *
 * It is stable, so an unconfigured deployment keeps ONE bucket namespace
 * instead of a different one per restart, and it is NOT the Facebook app id:
 * the two logins are metered separately and must never share a bucket.
 */
export const UNCONFIGURED_DIRECT_APP_NAMESPACE = "unknown-app";

/**
 * Reads the Instagram-login app id from the environment.
 *
 * The reader is injected, so the rule is testable without an environment:
 * this function asks for `INSTAGRAM_APP_ID` and for NOTHING else, so the
 * Facebook app id can never reach the Instagram-login namespace.
 *
 * A missing or empty value is null: the caller keeps the stable
 * unconfigured namespace instead of borrowing the Facebook app id.
 */
export function resolveDirectAppId(
  read: (name: string) => string | undefined,
): string | null {
  const raw = read(INSTAGRAM_APP_ID_ENV);
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed;
}

/** The default Instagram API version. It is pinned like the Facebook one. */
export const DEFAULT_INSTAGRAM_GRAPH_API_VERSION = "v22.0";

/** The page size of the media connection. */
export const DIRECT_MEDIA_PAGE_SIZE = 50;

/**
 * The account day metrics this adapter collects.
 *
 * The same four interaction metrics the Facebook-login adapter collects, and
 * the same documented request: `metric_type=total_value`, `period=day` and
 * an explicit `since`/`until` range.
 */
const DIRECT_ACCOUNT_DAY_METRICS = ["reach", "views", "accounts_engaged", "total_interactions"];

/**
 * The media insights metrics for an Instagram-login account.
 *
 * `media_product_type` is not available with this login, so the surface of
 * a media cannot be named. These four metrics are the intersection of the
 * documented per-surface sets: Meta documents `views`, `reach`, `shares`
 * and `total_interactions` for every surface that has insights at all
 * (FEED, REELS and STORY).
 */
const DIRECT_MEDIA_INSIGHT_METRICS: readonly string[] = [
  "views",
  "reach",
  "shares",
  "total_interactions",
];

/**
 * The media fields this adapter requests.
 *
 * `caption` and `media_product_type` are deliberately absent: Meta
 * documents both as "Available for Instagram API with Facebook Login only".
 */
const DIRECT_MEDIA_FIELDS = [
  "id",
  "media_type",
  "timestamp",
  "permalink",
  "thumbnail_url",
  "like_count",
  "comments_count",
].join(",");

/** The longest text the accepted snapshot columns accept. */
const MAX_TEXT_LENGTH = 2000;

export interface OwnerDirectGraphProviderOptions {
  /** The Instagram API version. Defaults to v22.0 and is validated. */
  readonly apiVersion?: string;
  /**
   * The Instagram-login app id.
   *
   * It is used only to build the shared throttle bucket key, and it is the
   * app of the Instagram Login - not the Facebook-login app.
   */
  readonly appId?: string | null;
  /** The transport. Injectable so a test never reaches the network. */
  readonly fetchFn?: typeof fetch;
  /** The per-attempt ceiling. */
  readonly attemptTimeoutMs?: number;
}

/**
 * Validates the configured Instagram API version.
 *
 * A malformed version is a configuration refusal, not a silent default.
 */
export function resolveOwnerInstagramApiVersion(raw: string | null | undefined): string {
  return resolveGraphApiVersion(raw, DEFAULT_INSTAGRAM_GRAPH_API_VERSION);
}

/**
 * The documented media insights metrics of one media, for this login.
 *
 * `media_product_type` is not available with this login, so the surface of
 * a media cannot be named and EVERY media is asked with the documented
 * INTERSECTION of the per-surface sets.
 *
 * An album is a FEED media, and the intersection contains the documented
 * FEED metrics, so an album is asked with the very same set. The media
 * insights reference says that "Insights data is not available for any
 * media WITHIN an Instagram Media album"
 * (https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights),
 * and that sentence is about the CHILDREN of an album - not about the album
 * itself.
 */
export function directMediaInsightMetrics(): readonly string[] {
  return DIRECT_MEDIA_INSIGHT_METRICS;
}

/**
 * The Instagram-login Graph adapter for the owner collection.
 */
export class InstagramDirectGraphProvider {
  readonly #apiVersion: string;
  readonly #appId: string | null;
  readonly #transport: OwnerProviderTransport;

  constructor(options: OwnerDirectGraphProviderOptions = {}) {
    this.#apiVersion = resolveOwnerInstagramApiVersion(options.apiVersion ?? null);
    this.#appId = options.appId ?? null;
    this.#transport = new OwnerProviderTransport({
      fetchFn: options.fetchFn,
      attemptTimeoutMs: options.attemptTimeoutMs,
    });
  }

  /**
   * The shared throttle bucket key of a DIRECT account.
   *
   * A direct account has no protected Facebook User credential, so the
   * Facebook bucket key has no input here. The bucket is a digest of the
   * app, the social account and the credential generation: the generation
   * is part of the identity because a reconnect starts a new grant, and the
   * token is never part of it.
   */
  async bucketKey(
    socialAccountId: string,
    credentialGeneration: number,
  ): Promise<string> {
    const namespace = this.#appId ?? UNCONFIGURED_DIRECT_APP_NAMESPACE;
    return await sha256Hex(
      `instagram-login:${namespace}:${socialAccountId}:${credentialGeneration}`,
    );
  }

  /** The account profile observation. */
  async fetchAccountProfile(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerProfileObservation>> {
    const url = `${INSTAGRAM_GRAPH_HOST}/${this.#apiVersion}/${
      encodeURIComponent(input.igUserId)
    }` +
      `?fields=followers_count,media_count` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#transport.attempt(url, input.signal);

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
   * The documented request for this login is the same one the Facebook
   * login uses: `metric_type=total_value`, `period=day` and an explicit
   * `since`/`until` range, answered with `data[].total_value.value`.
   */
  async fetchAccountDay(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly date: string;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerAccountDay>> {
    const since = Date.parse(`${input.date}T00:00:00+03:00`);
    const until = since + 86_400_000 - 1;

    const url = `${INSTAGRAM_GRAPH_HOST}/${this.#apiVersion}/${
      encodeURIComponent(input.igUserId)
    }` +
      `/insights?metric=${encodeURIComponent(DIRECT_ACCOUNT_DAY_METRICS.join(","))}` +
      `&period=day&metric_type=total_value` +
      `&since=${Math.floor(since / 1000)}&until=${Math.floor(until / 1000)}` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#transport.attempt(url, input.signal);
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
      if (!DIRECT_ACCOUNT_DAY_METRICS.includes(name)) continue;

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
   * The metric set is the documented intersection, because the surface of a
   * media cannot be named with this login. The answer is read from
   * `data[].values[]`, which is the shape Meta documents for the media
   * insights of both login kinds.
   *
   * The attempt is bounded to four seconds and it is NEVER retried
   * automatically: the media continuation is a bounded sweep, and a retry
   * would spend the run's budget twice for the same media.
   */
  async fetchMediaInsights(input: {
    readonly igMediaId: string;
    readonly token: string;
    /**
     * The media surface, when the row carries one.
     *
     * It is IGNORED here on purpose: `media_product_type` is not available
     * with this login, so a stored surface belongs to another login kind and
     * naming it would ask for metrics Meta documents for the wrong surface.
     */
    readonly mediaProductType: string | null;
    /**
     * The media type.
     *
     * It is IGNORED here too: the surface of a media cannot be named with
     * this login, so every media is asked with the documented intersection.
     */
    readonly mediaType: string | null;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerMediaInsights>> {
    const metrics = directMediaInsightMetrics();

    const url = `${INSTAGRAM_GRAPH_HOST}/${this.#apiVersion}/${
      encodeURIComponent(input.igMediaId)
    }` +
      `/insights?metric=${encodeURIComponent(metrics.join(","))}` +
      `&access_token=${encodeURIComponent(input.token)}`;

    const response = await this.#transport.attempt(url, input.signal, {
      maxAttempts: 1,
      attemptTimeoutMs: MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
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
   * start was seen, or the feed ended. A page without a `paging.next` is
   * the last page, so the sweep never spends a call on a cursor the
   * provider never offered a next-page URL for.
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
    const pageSize = input.pageSize ?? DIRECT_MEDIA_PAGE_SIZE;

    const items: OwnerMediaItem[] = [];
    let pagesFetched = 0;
    let usagePercent = 0;
    let cursor = input.cursor;
    let oldestReturnedAt: string | null = null;
    let truncated = false;
    let windowCovered = false;
    let stopped: MediaSweepStop = "feed_exhausted";

    while (pagesFetched < input.maxPages) {
      const url = `${INSTAGRAM_GRAPH_HOST}/${this.#apiVersion}/${
        encodeURIComponent(input.igUserId)
      }` +
        `/media?fields=${encodeURIComponent(DIRECT_MEDIA_FIELDS)}&limit=${pageSize}` +
        (cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`) +
        `&access_token=${encodeURIComponent(input.token)}`;

      const response = await this.#transport.attempt(url, input.signal);
      usagePercent = Math.max(usagePercent, response.usagePercent);
      pagesFetched += 1;

      const rows = requireProviderDataArray(response.payload);

      for (const row of rows) {
        const record = this.#requireObject(row);
        const published = this.#readPublishedAt(record);
        const publishedMs = Date.parse(published);

        if (publishedMs < windowStart) {
          windowCovered = true;
          stopped = "window_covered";
          break;
        }

        if (oldestReturnedAt === null || published < oldestReturnedAt) {
          oldestReturnedAt = published;
        }

        items.push(this.#readMediaItem(record, published));
      }

      if (windowCovered) break;

      if (usagePercent >= USAGE_STOP_PERCENT) {
        truncated = true;
        stopped = "usage_stop";
        break;
      }

      const next = readProviderNextCursor(response.payload);
      if (next === null) {
        windowCovered = true;
        stopped = "feed_exhausted";
        break;
      }

      if (!CURSOR_GRAMMAR.test(next)) {
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

    const mediaType = record.media_type;
    if (mediaType !== undefined && mediaType !== null && typeof mediaType !== "string") {
      throw new OwnerProviderError(
        "The provider returned a malformed media type.",
        { kind: "provider_error" },
      );
    }

    // The media product type and the caption are NOT read with this login:
    // Meta documents both as Facebook-login only. The stored row therefore
    // carries no caption and no surface for this login kind, and it says so
    // with a null rather than with a guess.
    return {
      ig_media_id: id,
      media_product_type: null,
      media_type: typeof mediaType === "string" && mediaType.trim() !== ""
        ? mediaType.trim().toUpperCase().slice(0, 32)
        : null,
      thumbnail_url: readProviderBoundedText(record, "thumbnail_url", MAX_TEXT_LENGTH),
      caption: null,
      permalink: readProviderBoundedText(record, "permalink", MAX_TEXT_LENGTH),
      published_at: publishedAt,
      like_count_public: readProviderCount(record, "like_count"),
      comments_count_public: readProviderCount(record, "comments_count"),
    };
  }
}
