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
  YouTubeCreatePlaylistData,
  YouTubePlaylistListItem,
  YouTubePlaylistsPage,
  YouTubeResourceErrorCode,
  YouTubeResourceSuccess,
  YouTubeSetThumbnailResult,
  YouTubeVideoDetails,
  YouTubeVideoListItem,
  YouTubeVideosPage,
} from "../../../../supabase/functions/youtube-resources/contracts";

// The MIME allow-list of a direct `thumbnails.set` upload belongs to the edge
// operation that enforces it (ARCHITECTURE.md §22): one definition, so the
// picker and the server can never disagree about what is uploadable. It is
// narrower than the upload-time intake's list, which also admits WebP.
export { DIRECT_THUMBNAIL_MIMES } from "../../../../supabase/functions/youtube-resources/thumbnailMedia";

// The caption contract and the caption rules the browser needs live in
// `domain/captions.ts`, which re-exports the edge function's caption
// shapes (ARCHITECTURE.md §22) and owns the byte limit the page measures
// before it sends anything.
export {
  CAPTION_CONTENT_MAX_BYTES,
  CAPTION_DAILY_UPLOAD_ALLOWANCE,
  CAPTION_LANGUAGE_PATTERN,
  CAPTION_TRACK_NAME_MAX_LENGTH,
} from "./captions";
export type {
  YouTubeCaptionFormat,
  YouTubeCaptionTrack,
  YouTubeCaptionsListData,
  YouTubeCaptionUploadOutcome,
  YouTubeCaptionUploadResult,
  YouTubeUploadCaptionData,
} from "./captions";
