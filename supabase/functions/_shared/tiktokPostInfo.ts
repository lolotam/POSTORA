/**
 * Provider `post_info` for TikTok review posts.
 *
 * The review handler and process-post both send this shape. One function owns
 * the mapping so a flag cannot drift between the two callers. Pure: no I/O.
 */

export type TikTokPostSettings = {
  readonly privacy: string;
  readonly allowComment: boolean;
  readonly allowDuet: boolean;
  readonly allowStitch: boolean;
  readonly disclose: boolean;
  readonly yourBrand: boolean;
  readonly brandedContent: boolean;
  readonly aiGenerated: boolean;
};

export type TikTokPostInfo = {
  readonly title: string;
  readonly privacy_level: string;
  readonly disable_comment: boolean;
  readonly disable_duet: boolean;
  readonly disable_stitch: boolean;
  readonly brand_organic_toggle: boolean;
  readonly brand_content_toggle: boolean;
  readonly is_aigc: boolean;
};

/**
 * Reads the camelCase settings in the consented review snapshot.
 * Returns null when privacy was not stored as a non-empty string so a failed
 * or partial snapshot cannot be published as an unrestricted post.
 * Booleans are strict: only JSON `true` enables the flag.
 */
export function tiktokPostSettingsFromReview(
  value: unknown,
): TikTokPostSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  const privacy = settings.privacy;
  if (typeof privacy !== "string" || privacy.length === 0) {
    return null;
  }
  return {
    privacy,
    allowComment: settings.allowComment === true,
    allowDuet: settings.allowDuet === true,
    allowStitch: settings.allowStitch === true,
    disclose: settings.disclose === true,
    yourBrand: settings.yourBrand === true,
    brandedContent: settings.brandedContent === true,
    aiGenerated: settings.aiGenerated === true,
  };
}

/**
 * Maps reviewed settings onto TikTok `post_info`.
 * Never truncates `caption`; the publish policy rejects titles over 2200
 * UTF-16 code units before this runs.
 * Every boolean is sent even when false. The legacy publisher omitted
 * `disable_*` unless the user turned the interaction off, which is a
 * different contract than Content Posting.
 */
export function buildTikTokPostInfo(
  caption: string,
  settings: TikTokPostSettings,
): TikTokPostInfo {
  if (settings.privacy.length === 0) {
    throw new Error("TIKTOK_POST_INFO_PRIVACY_REQUIRED");
  }
  return {
    title: caption,
    privacy_level: settings.privacy,
    disable_comment: !settings.allowComment,
    disable_duet: !settings.allowDuet,
    disable_stitch: !settings.allowStitch,
    brand_organic_toggle: settings.disclose && settings.yourBrand,
    brand_content_toggle: settings.disclose && settings.brandedContent,
    is_aigc: settings.aiGenerated,
  };
}
