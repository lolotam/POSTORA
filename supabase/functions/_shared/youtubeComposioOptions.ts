/**
 * The subset of PlatformMetadata needed to decide whether Composio can
 * faithfully represent a YouTube upload. Kept structural so callers do not
 * create another copy of process-post's legacy metadata contract.
 */
export type YouTubeComposioMetadata = Record<string, unknown>;

export const YOUTUBE_COMPOSIO_UNSUPPORTED_OPTION_KEYS = [
  "youtube_made_for_kids",
  "youtube_notify_subscribers",
  "youtube_allow_embedding",
  "youtube_public_stats_viewable",
  "youtube_contains_synthetic_media",
  "youtube_has_paid_promotion",
  "youtube_video_language",
  "youtube_audio_language",
  "youtube_recording_date",
  "youtube_license",
  "youtube_allowed_countries",
  "youtube_blocked_countries",
  "youtube_first_comment",
] as const;

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Returns only keys whose current value Composio's YouTube upload cannot express. */
export function youtubeOptionsUnsupportedOnComposio(
  metadata: YouTubeComposioMetadata | null | undefined,
): string[] {
  if (!metadata) return [];

  return YOUTUBE_COMPOSIO_UNSUPPORTED_OPTION_KEYS.filter((key) => {
    const value = metadata[key];
    switch (key) {
      case "youtube_made_for_kids":
      case "youtube_contains_synthetic_media":
      case "youtube_has_paid_promotion":
        return value === true;
      case "youtube_notify_subscribers":
      case "youtube_allow_embedding":
      case "youtube_public_stats_viewable":
        return value === false;
      case "youtube_license":
        return value === "creativeCommon";
      case "youtube_allowed_countries":
      case "youtube_blocked_countries":
        return nonEmptyArray(value);
      default:
        return nonEmptyString(value);
    }
  });
}
