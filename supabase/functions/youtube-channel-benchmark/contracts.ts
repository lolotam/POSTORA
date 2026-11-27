export const YOUTUBE_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const YOUTUBE_BENCHMARK_MAX_CHANNELS = 3 as const;
export const YOUTUBE_BENCHMARK_RECENT_VIDEOS_LIMIT = 10 as const;
export const YOUTUBE_BENCHMARK_DAILY_BUDGET_UNITS = 300 as const;
export const YOUTUBE_BENCHMARK_BUDGET_WINDOW_SECONDS = 48 * 60 * 60;
export const YOUTUBE_BENCHMARK_PER_USER_BURST = { limit: 10, window_seconds: 600 } as const;
export const YOUTUBE_BENCHMARK_PER_USER_DAILY = { limit: 30, window_seconds: 86_400 } as const;

export const YOUTUBE_BENCHMARK_HANDLE_PATTERN = /^@[A-Za-z0-9._-]{3,30}$/;
export const YOUTUBE_BENCHMARK_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export type YouTubeBenchmarkTargetKind = "handle" | "channel_id";

export interface ClassifiedBenchmarkChannelInput {
  kind: YouTubeBenchmarkTargetKind;
  normalized: string;
  queryValue: string;
}

/**
 * Normalizes a channel handle or ID for deduplication and cache keying.
 * Handles are lowercased because YouTube handles are case-insensitive;
 * channel IDs preserve exact case.
 */
export function normalizeBenchmarkChannelInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("@")) return trimmed.toLowerCase();
  return trimmed;
}

/**
 * Classifies and validates a raw user-supplied channel input as either a
 * `@handle` or `UC...` channel ID, returning `null` if it matches neither.
 */
export function classifyBenchmarkChannelInput(
  raw: string,
): ClassifiedBenchmarkChannelInput | null {
  const trimmed = raw.trim();
  if (YOUTUBE_BENCHMARK_HANDLE_PATTERN.test(trimmed)) {
    return { kind: "handle", normalized: trimmed.toLowerCase(), queryValue: trimmed };
  }
  if (YOUTUBE_BENCHMARK_CHANNEL_ID_PATTERN.test(trimmed)) {
    return { kind: "channel_id", normalized: trimmed, queryValue: trimmed };
  }
  return null;
}

export type YouTubeBenchmarkChannelStatus = "found" | "not_found" | "unavailable";

export type YouTubeBenchmarkChannelErrorCode =
  | "quota_exceeded"
  | "reconnect_required"
  | "upstream_unavailable";

export interface YouTubeBenchmarkRecentVideo {
  id: string;
  title: string;
  published_at: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
}

export interface YouTubeBenchmarkChannel {
  input: string;
  status: YouTubeBenchmarkChannelStatus;
  /** Present when status is "unavailable", or when status is "found" and the uploads/videos lookup failed. */
  error?: YouTubeBenchmarkChannelErrorCode;
  channel_id: string | null;
  title: string | null;
  thumbnail_url: string | null;
  subscriber_count: number | null;
  subscriber_count_hidden: boolean;
  view_count: number | null;
  video_count: number | null;
  recent_videos: YouTubeBenchmarkRecentVideo[];
}

export interface YouTubeBenchmarkResponseData {
  account_id: string;
  channels: YouTubeBenchmarkChannel[];
}

export interface YouTubeBenchmarkSuccess {
  schema_version: typeof YOUTUBE_BENCHMARK_SCHEMA_VERSION;
  request_id: string;
  freshness: {
    fetched_at: string;
    source: "provider";
  };
  data: YouTubeBenchmarkResponseData;
}

export const YOUTUBE_BENCHMARK_ERROR_STATUS = {
  unauthenticated: 401,
  invalid_request: 400,
  not_found: 404,
  provider_unsupported: 409,
  missing_scope: 403,
  reconnect_required: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  upstream_unavailable: 502,
  internal_error: 500,
} as const;

export type YouTubeBenchmarkErrorCode = keyof typeof YOUTUBE_BENCHMARK_ERROR_STATUS;

export function isYouTubeBenchmarkErrorCode(
  value: unknown,
): value is YouTubeBenchmarkErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(YOUTUBE_BENCHMARK_ERROR_STATUS, value)
  );
}
