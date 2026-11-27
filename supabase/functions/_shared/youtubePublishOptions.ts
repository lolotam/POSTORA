/**
 * Canonical YouTube publishing option contract.
 *
 * One owner for the facts every surface has to agree on: the field names the
 * public API reads, the legacy aliases it still accepts, Postora's explicit
 * privacy default, and how the YouTube Data API treats each option at upload
 * time.
 *
 * Code consumers:
 *   supabase/functions/n8n-api/index.ts       public REST API and n8n
 *   supabase/functions/mcp/index.ts           MCP `create_post`
 *   supabase/functions/process-post/          native YouTube publisher
 *
 * Browser surfaces that have to agree with it:
 *   src/pages/docs/YoutubeApi.tsx             developer documentation
 *   src/components/api-playground/            in-app request playground
 *
 * Provider facts and Postora's defaults are stated once here so no second copy
 * can drift away from them.
 */

/** Privacy statuses the YouTube Data API accepts for `status.privacyStatus`. */
export const YOUTUBE_PRIVACY_VALUES = ["public", "unlisted", "private"] as const;

export type YoutubePrivacyStatus = (typeof YOUTUBE_PRIVACY_VALUES)[number];

/** Minimum lead time YouTube requires before a scheduled `status.publishAt` timestamp. */
export const YOUTUBE_PUBLISH_AT_MIN_LEAD_MS = 15 * 60 * 1000;

/** Nominal 2-year upper bound (in ms) for `status.publishAt` validation. */
export const YOUTUBE_PUBLISH_AT_MAX_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export const YOUTUBE_STALE_SCHEDULE_WARNING_MESSAGE =
  "The YouTube schedule time could not be used, so the video was uploaded as private and not scheduled.";

export type YoutubePublishAtInvalidReason =
  | "malformed"
  | "too_soon"
  | "expired"
  | "too_far"
  | "wrong_type";

export type YoutubePublishAtResolution =
  | { ok: true; publishAt: string }
  | { ok: false; reason: YoutubePublishAtInvalidReason };

const RFC3339_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * Postora publishes as `private` when the caller does not choose a privacy
 * status.
 *
 * This is deliberately different from the YouTube Data API, which defaults an
 * upload to `public` when `status.privacyStatus` is absent. An API caller
 * that omits the field therefore gets a private video from Postora, and that
 * has to be stated wherever the option is documented.
 */
export const YOUTUBE_DEFAULT_PRIVACY: YoutubePrivacyStatus = "private";

/** YouTube's default video category (`22` = People & Blogs). */
export const YOUTUBE_DEFAULT_CATEGORY_ID = "22";

/**
 * Options that have more than one accepted field name.
 *
 * The canonical name is the one the API documents and the one every new
 * caller should use. The alias is the name Postora's own website
 * documentation and the in-app playground used to publish, so requests built
 * from those examples keep working.
 */
export const YOUTUBE_OPTION_ALIASES = {
  youtube_category: "youtube_category_id",
  youtube_allow_embedding: "youtube_embeddable",
} as const;

export type YoutubeOptionAlias =
  (typeof YOUTUBE_OPTION_ALIASES)[keyof typeof YOUTUBE_OPTION_ALIASES];

/**
 * Options the YouTube Data API accepts in a request body but does not list as
 * settable by `videos.insert`.
 *
 * Postora still sends them, because the provider may honour them anyway, and
 * it reports them back so no caller is told an option was applied when the
 * provider never confirmed it.
 */
export const YOUTUBE_UPLOAD_UNCONFIRMED_OPTIONS = [
  {
    option: "youtube_default_audio_language",
    metadataKey: "youtube_audio_language",
  },
  {
    option: "youtube_allowed_countries",
    metadataKey: "youtube_allowed_countries",
  },
  {
    option: "youtube_blocked_countries",
    metadataKey: "youtube_blocked_countries",
  },
] as const;

export interface YoutubePublishOptionsResolution {
  /** Resolved option values, keyed by canonical field name. */
  options: Record<string, unknown>;
  /**
   * Legacy aliases that were present alongside the canonical field with a
   * different value. The canonical value wins; the alias is reported so a
   * caller can see that one of its two names was ignored.
   */
  conflictingAliases: YoutubeOptionAlias[];
  ignoredPrivacyFields: ("youtube_privacy_status" | "youtube_visibility")[];
}

/**
 * Picks the value of one option, preferring its canonical field name.
 *
 * The canonical name always wins. An alias is used only when the canonical
 * field is absent, so a request that sets both is never ambiguous.
 */
function pickCanonicalValue(
  values: Record<string, unknown>,
  canonical: string,
  alias: string,
): { value: unknown; conflicted: boolean } {
  const canonicalValue = values[canonical];
  const aliasValue = values[alias];
  const hasCanonical = canonicalValue !== undefined && canonicalValue !== null;
  const hasAlias = aliasValue !== undefined && aliasValue !== null;

  if (hasCanonical) {
    return {
      value: canonicalValue,
      conflicted: hasAlias && aliasValue !== canonicalValue,
    };
  }
  return { value: hasAlias ? aliasValue : undefined, conflicted: false };
}

/**
 * Resolves the YouTube options that accept more than one field name.
 */
export function resolveYoutubePublishOptions(
  source: object | null | undefined,
): YoutubePublishOptionsResolution {
  const values = (source ?? {}) as Record<string, unknown>;
  const options: Record<string, unknown> = {};
  const conflictingAliases: YoutubeOptionAlias[] = [];

  for (const [canonical, alias] of Object.entries(YOUTUBE_OPTION_ALIASES)) {
    const picked = pickCanonicalValue(values, canonical, alias);
    if (picked.value !== undefined) options[canonical] = picked.value;
    if (picked.conflicted) conflictingAliases.push(alias as YoutubeOptionAlias);
  }

  const privacyFields = ["youtube_privacy_status", "youtube_visibility"] as const;
  const ignoredPrivacyFields = privacyFields.filter((field) => values[field] != null);
  if (values.youtube_privacy != null) options.youtube_privacy = values.youtube_privacy;
  return { options, conflictingAliases, ignoredPrivacyFields };
}

/**
 * Normalises a privacy value to a status the YouTube Data API accepts.
 *
 * Anything unrecognised falls back to {@link YOUTUBE_DEFAULT_PRIVACY} rather
 * than to the provider's own `public` default.
 */
export function youtubePrivacyOrDefault(value: unknown): YoutubePrivacyStatus {
  return YOUTUBE_PRIVACY_VALUES.includes(value as YoutubePrivacyStatus)
    ? (value as YoutubePrivacyStatus)
    : YOUTUBE_DEFAULT_PRIVACY;
}

/**
 * Returns `true` whenever `metadata.youtube_publish_at` is anything other than
 * `undefined`, `null`, or `""` — including whitespace-only strings and
 * wrong-typed values, so any unusable schedule request still forces `private`.
 */
export function hasYoutubeScheduleRequest(
  metadata: object | null | undefined,
): boolean {
  const value = (metadata as Record<string, unknown> | null | undefined)?.youtube_publish_at;
  return value !== undefined && value !== null && value !== "";
}

function parseStrictRfc3339Ms(raw: string): number | null {
  const trimmed = raw.trim();
  const match = RFC3339_TIMESTAMP_RE.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  // Reject calendar rollovers such as 2026-02-30 or non-leap 2026-02-29.
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }

  const parsedMs = Date.parse(trimmed);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

/**
 * Validates and normalises a `youtube_publish_at` value against `now`.
 *
 * Boundary cases:
 * - non-string -> `wrong_type`
 * - non-RFC3339 or impossible calendar date -> `malformed`
 * - <= now -> `expired`
 * - > now and < now + 15m -> `too_soon`
 * - > now + 2 calendar years (UTC) -> `too_far`
 */
export function resolveYoutubePublishAt(
  value: unknown,
  now: Date = new Date(),
): YoutubePublishAtResolution {
  if (typeof value !== "string") {
    return { ok: false, reason: "wrong_type" };
  }

  const parsedMs = parseStrictRfc3339Ms(value);
  if (parsedMs === null) {
    return { ok: false, reason: "malformed" };
  }

  const nowMs = now.getTime();
  if (parsedMs <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  if (parsedMs < nowMs + YOUTUBE_PUBLISH_AT_MIN_LEAD_MS) {
    return { ok: false, reason: "too_soon" };
  }

  const maxDate = new Date(nowMs);
  maxDate.setUTCFullYear(maxDate.getUTCFullYear() + 2);
  if (parsedMs > maxDate.getTime()) {
    return { ok: false, reason: "too_far" };
  }

  return { ok: true, publishAt: new Date(parsedMs).toISOString() };
}

/**
 * Returns `"private"` whenever a schedule request is present (valid or not),
 * and the normalised `youtube_visibility` otherwise.
 */
export function effectiveYoutubePrivacy(
  metadata: object | null | undefined,
): YoutubePrivacyStatus {
  if (hasYoutubeScheduleRequest(metadata)) {
    return "private";
  }
  return youtubePrivacyOrDefault(
    (metadata as Record<string, unknown> | null | undefined)?.youtube_visibility,
  );
}
