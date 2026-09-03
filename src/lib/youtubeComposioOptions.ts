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

export function youtubeOptionsUnsupportedOnComposio(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  if (!metadata) return [];
  return YOUTUBE_COMPOSIO_UNSUPPORTED_OPTION_KEYS.filter((key) => {
    const value = metadata[key];
    if (
      [
        "youtube_made_for_kids",
        "youtube_contains_synthetic_media",
        "youtube_has_paid_promotion",
      ].includes(key)
    )
      return value === true;
    if (
      [
        "youtube_notify_subscribers",
        "youtube_allow_embedding",
        "youtube_public_stats_viewable",
      ].includes(key)
    )
      return value === false;
    if (key === "youtube_license") return value === "creativeCommon";
    if (
      key === "youtube_allowed_countries" ||
      key === "youtube_blocked_countries"
    )
      return Array.isArray(value) && value.length > 0;
    return typeof value === "string" && value.trim().length > 0;
  });
}
