export const YOUTUBE_RESOURCES_SCHEMA_VERSION = 1 as const;

export const YOUTUBE_SCOPE = {
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  upload: "https://www.googleapis.com/auth/youtube.upload",
  force_ssl: "https://www.googleapis.com/auth/youtube.force-ssl",
} as const;

export const YOUTUBE_RESOURCE_ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  media_not_usable: 400,
  unauthorized: 401,
  missing_scope: 403,
  thumbnail_not_allowed: 403,
  not_found: 404,
  method_not_allowed: 405,
  provider_unsupported: 409,
  write_not_enabled: 403,
  edit_conflict: 409,
  outcome_unknown: 502,
  reconnect_required: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  internal_error: 500,
  upstream_unavailable: 502,
} as const;

export type YouTubeResourceErrorCode = keyof typeof YOUTUBE_RESOURCE_ERROR_STATUS;

export function isYouTubeResourceErrorCode(value: unknown): value is YouTubeResourceErrorCode {
  return typeof value === "string" && Object.keys(YOUTUBE_RESOURCE_ERROR_STATUS).includes(value);
}

export const YOUTUBE_RESOURCE_QUOTA_POLICY = {
  provider_quota: "not_tracked",
  unit_costs: { channel: 1, videos_page: 2, video: 1, playlists_page: 1 },
  per_user_burst: { limit: 30, window_seconds: 600 },
  per_user_daily: { limit: 300, window_seconds: 86400 },
} as const;

export type YouTubeScopeState = "granted" | "missing" | "unknown";

export type YouTubeCapabilityReason =
  | "reconnect_required"
  | "missing_scope"
  | "provider_unsupported";

export type YouTubeCapabilityState =
  | { state: "available" }
  | { state: "unknown" }
  | { state: "unavailable"; reason: YouTubeCapabilityReason };

export interface YouTubeAccountCapabilities {
  account_id: string;
  channel_id: string | null;
  channel_title: string | null;
  provider: "native" | "composio";
  connection: "ok" | "reconnect_required";
  scopes: {
    readonly: YouTubeScopeState;
    upload: YouTubeScopeState;
    force_ssl: YouTubeScopeState;
  };
  capabilities: {
    browse: YouTubeCapabilityState;
    upload: YouTubeCapabilityState;
    comments: YouTubeCapabilityState;
    /** Additive: an old server may omit it and an old client may ignore it. */
    edit_metadata?: YouTubeCapabilityState;
    /** Additive: an old server may omit it and an old client may ignore it. */
    manage_thumbnail?: YouTubeCapabilityState;
  };
  quota: typeof YOUTUBE_RESOURCE_QUOTA_POLICY;
}

export interface YouTubeSetThumbnailResult {
  video_id: string;
  applied: true;
}

export interface YouTubeResourceSuccess<T> {
  schema_version: typeof YOUTUBE_RESOURCES_SCHEMA_VERSION;
  request_id: string;
  freshness: { fetched_at: string; source: "database" | "provider" };
  data: T;
}

export interface YouTubeResourceFailure {
  error: YouTubeResourceErrorCode;
  request_id: string;
  retry_after_seconds?: number;
}

export const YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE = 25;
export const YOUTUBE_VIDEOS_MAX_PAGE_SIZE = 50;
export const YOUTUBE_VIDEO_LIST_DESCRIPTION_MAX = 500;
export const YOUTUBE_PLAYLISTS_PAGE_SIZE = 50;
export const YOUTUBE_PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export interface YouTubePlaylistListItem {
  id: string;
  title: string;
  privacy_status: string | null;
  thumbnail_url: string | null;
}

export interface YouTubePlaylistsPage {
  items: YouTubePlaylistListItem[];
  next_page_token: string | null;
}

export interface YouTubeChannelDetails {
  id: string;
  title: string;
  description: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  country: string | null;
  privacy_status: string | null;
  statistics: {
    view_count: number | null;
    subscriber_count: number | null;
    subscriber_count_hidden: boolean;
    video_count: number | null;
  };
}

export interface YouTubeVideoListItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  privacy_status: string | null;
  url: string;
  description?: string | null;
  duration_iso8601?: string | null;
  statistics?: {
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
  };
}

// An empty page may still carry Google's next_page_token (a page of placeholder
// entries, or a 404 on a not-yet-created uploads playlist): key pagination on
// next_page_token, never on items.length.
export interface YouTubeVideosPage {
  items: YouTubeVideoListItem[];
  next_page_token: string | null;
  total_results: number | null;
}

export interface YouTubeVideoDetails {
  id: string;
  channel_id: string;
  title: string;
  description: string;
  thumbnail_url: string | null;
  published_at: string | null;
  tags: string[];
  category_id: string | null;
  default_language: string | null;
  duration_iso8601: string | null;
  privacy_status: string | null;
  upload_status: string | null;
  made_for_kids: boolean | null;
  statistics: {
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
  };
  url: string;
}
