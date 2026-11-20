export const YOUTUBE_RESOURCES_SCHEMA_VERSION = 1 as const;

export const YOUTUBE_SCOPE = {
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  upload: "https://www.googleapis.com/auth/youtube.upload",
  force_ssl: "https://www.googleapis.com/auth/youtube.force-ssl",
} as const;

export const YOUTUBE_RESOURCE_ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  unauthorized: 401,
  missing_scope: 403,
  not_found: 404,
  method_not_allowed: 405,
  provider_unsupported: 409,
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
  unit_costs: { channel: 1, videos_page: 1, video: 1 },
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
  };
  quota: typeof YOUTUBE_RESOURCE_QUOTA_POLICY;
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
