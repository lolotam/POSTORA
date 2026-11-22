/**
 * Domain types for the YouTube management feature.
 *
 * One contract shared with the edge function: these are re-exported from
 * `supabase/functions/youtube-resources/contracts.ts`, never redefined here
 * (ARCHITECTURE.md §22, the same pattern as instagram-insights).
 * Pure TypeScript: no React, no Supabase client, no browser API.
 */

// A single DTO definition keeps UI reads aligned with the actual resource response.
export {
  isYouTubeResourceErrorCode,
  YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE,
} from "../../../../supabase/functions/youtube-resources/contracts";
export type {
  YouTubeCategoryOption,
} from "../../../../supabase/functions/youtube-resources/categories";
export type {
  YouTubeAccountCapabilities,
  YouTubeCapabilityReason,
  YouTubeCapabilityState,
  YouTubeChannelDetails,
  YouTubeResourceErrorCode,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
  YouTubeVideoListItem,
  YouTubeVideosPage,
} from "../../../../supabase/functions/youtube-resources/contracts";
