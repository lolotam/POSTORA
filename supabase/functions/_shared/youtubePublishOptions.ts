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
