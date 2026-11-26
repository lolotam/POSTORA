export const YOUTUBE_ANALYTICS_SCHEMA_VERSION = 1;
export const ANALYTICS_PURPOSE_VERSION = 1;

export const YOUTUBE_ANALYTICS_OPERATIONS = [
  "status",
  "consent_accept",
  "consent_withdraw",
  "summary",
  "daily",
  "top_videos",
] as const;

export type YouTubeAnalyticsOperation = (typeof YOUTUBE_ANALYTICS_OPERATIONS)[number];
export type YouTubeAnalyticsDataOperation = "summary" | "daily" | "top_videos";

export const YOUTUBE_ANALYTICS_PERIOD_DAYS = [7, 14, 30, 90] as const;
export type YouTubeAnalyticsPeriodDays = 7 | 14 | 30 | 90;
export const YOUTUBE_ANALYTICS_TIME_ZONE = "America/Los_Angeles" as const;

export const YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
export const YOUTUBE_ANALYTICS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const YOUTUBE_ANALYTICS_REVISION_PATTERN = /^[0-9a-f]{32}$/;

export const YOUTUBE_ANALYTICS_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

export const YOUTUBE_ANALYTICS_SUMMARY_METRICS = [
  { key: "views", googleMetric: "views", unit: "count" },
  { key: "watch_time", googleMetric: "estimatedMinutesWatched", unit: "minutes" },
  { key: "average_view_duration", googleMetric: "averageViewDuration", unit: "seconds" },
  { key: "subscribers_gained", googleMetric: "subscribersGained", unit: "count" },
  { key: "subscribers_lost", googleMetric: "subscribersLost", unit: "count" },
  { key: "likes", googleMetric: "likes", unit: "count" },
  { key: "comments", googleMetric: "comments", unit: "count" },
  { key: "shares", googleMetric: "shares", unit: "count" },
] as const;

export const YOUTUBE_ANALYTICS_DAILY_METRICS = [
  { key: "views", googleMetric: "views", unit: "count" },
  { key: "watch_time", googleMetric: "estimatedMinutesWatched", unit: "minutes" },
  { key: "subscribers_gained", googleMetric: "subscribersGained", unit: "count" },
  { key: "subscribers_lost", googleMetric: "subscribersLost", unit: "count" },
] as const;

export const YOUTUBE_ANALYTICS_TOP_VIDEOS_PAGE_SIZE = 10;
export const YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_RESULTS = 200;
export const YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_START_INDEX = 191;

export const YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS = [
  { key: "watch_time", googleMetric: "estimatedMinutesWatched", unit: "minutes" },
  { key: "views", googleMetric: "views", unit: "count" },
  { key: "likes", googleMetric: "likes", unit: "count" },
  { key: "subscribers_gained", googleMetric: "subscribersGained", unit: "count" },
] as const;

export const YOUTUBE_ANALYTICS_LIMITS = {
  admission: { max: 120, windowSeconds: 60 },
  dataBurst: { max: 60, windowSeconds: 600 },
  dataDaily: { max: 300, windowSeconds: 86400 },
  sharedData: { max: 1000, windowSeconds: 172800 },
  sharedAnalytics: { max: 2000, windowSeconds: 172800 },
} as const;

export const YOUTUBE_ANALYTICS_ERRORS = {
  invalid_request: { status: 400, scope: "block" },
  window_stale: { status: 409, scope: "block" },
  unauthorized: { status: 401, scope: "session" },
  not_enabled: { status: 403, scope: "account" },
  consent_required: { status: 403, scope: "account" },
  consent_version_stale: { status: 409, scope: "block" },
  missing_scope: { status: 403, scope: "account" },
  not_found: { status: 404, scope: "account" },
  video_not_found: { status: 404, scope: "video" },
  method_not_allowed: { status: 405, scope: "request" },
  provider_unsupported: { status: 409, scope: "account" },
  reconnect_required: { status: 409, scope: "account" },
  connection_changed: { status: 409, scope: "account" },
  rate_limited: { status: 429, scope: "block" },
  capacity_reached: { status: 429, scope: "block" },
  quota_exceeded: { status: 429, scope: "block" },
  settings_unavailable: { status: 503, scope: "block" },
  upstream_unavailable: { status: 502, scope: "block" },
  internal_error: { status: 500, scope: "block" },
} as const;

export type YouTubeAnalyticsErrorCode = keyof typeof YOUTUBE_ANALYTICS_ERRORS;
export type YouTubeAnalyticsErrorStatus = (typeof YOUTUBE_ANALYTICS_ERRORS)[YouTubeAnalyticsErrorCode]["status"];
export type YouTubeAnalyticsPageScope = (typeof YOUTUBE_ANALYTICS_ERRORS)[YouTubeAnalyticsErrorCode]["scope"];

export type YouTubeAnalyticsConsentState = "none" | "accepted" | "outdated" | "withdrawn";

export interface YouTubeAnalyticsConsent {
  state: YouTubeAnalyticsConsentState;
  version: number;
}

export interface YouTubeAnalyticsRequestedWindow {
  start_date: string;
  end_date: string;
  days: YouTubeAnalyticsPeriodDays;
  time_zone: typeof YOUTUBE_ANALYTICS_TIME_ZONE;
}

export interface YouTubeAnalyticsSuccess<T> {
  schema_version: typeof YOUTUBE_ANALYTICS_SCHEMA_VERSION;
  request_id: string;
  connection_revision: string;
  freshness: { fetched_at: string; source: "database" | "provider" };
  requested_window?: YouTubeAnalyticsRequestedWindow;
  data: T;
}

export interface YouTubeAnalyticsErrorResponse {
  error: YouTubeAnalyticsErrorCode;
  request_id: string;
  connection_revision?: string;
  reporting_end_date?: string;
  accepted_window_ends?: [string, string];
  consent?: YouTubeAnalyticsConsent;
  purpose_version?: number;
  retry_after_seconds?: number;
  detail?: "grant_not_effective";
}

export type YouTubeAnalyticsMetricKey =
  | "views"
  | "watch_time"
  | "average_view_duration"
  | "subscribers_gained"
  | "subscribers_lost"
  | "likes"
  | "comments"
  | "shares";

export interface YouTubeAnalyticsMetric {
  key: YouTubeAnalyticsMetricKey;
  unit: "count" | "minutes" | "seconds";
  value: number | null;
}

export interface YouTubeAnalyticsSummaryData {
  metrics: YouTubeAnalyticsMetric[];
  has_data: boolean;
}

export interface YouTubeAnalyticsDailyRow {
  day: string;
  metrics: YouTubeAnalyticsMetric[];
}

export interface YouTubeAnalyticsDailyData {
  rows: YouTubeAnalyticsDailyRow[];
  coverage: {
    first_day: string | null;
    last_day: string | null;
    days_returned: number;
    days_missing: number;
  };
}

export interface YouTubeAnalyticsTopVideoRow {
  video_id: string;
  title: string | null;
  published_at: string | null;
  thumbnail_url?: string | null;
  link: string;
  metrics: YouTubeAnalyticsMetric[];
}

export interface YouTubeAnalyticsTopVideosData {
  rows: YouTubeAnalyticsTopVideoRow[];
  titles: "complete" | "partial" | "unavailable";
  has_more: boolean;
  next_start_index: number | null;
}

export interface YouTubeAnalyticsStatusData {
  available: true;
  reason: "ok";
  connection_revision: string;
  reporting_end_date: string;
  accepted_window_ends: [string, string];
  consent: YouTubeAnalyticsConsent;
  purpose_version: number;
  periods: typeof YOUTUBE_ANALYTICS_PERIOD_DAYS;
  limits: typeof YOUTUBE_ANALYTICS_LIMITS;
}

export interface YouTubeAnalyticsConsentData {
  recorded: boolean;
  consent: YouTubeAnalyticsConsent;
  purpose_version: number;
}

export type YouTubeAnalyticsDataForOperation = {
  summary: YouTubeAnalyticsSummaryData;
  daily: YouTubeAnalyticsDailyData;
  top_videos: YouTubeAnalyticsTopVideosData;
};

export interface YouTubeAnalyticsStatusRequest {
  operation: "status";
  account_id: string;
}

export interface YouTubeAnalyticsConsentAcceptRequest {
  operation: "consent_accept";
  account_id: string;
  purpose_version: number;
  locale: "en" | "ar";
  connection_revision: string;
}

export interface YouTubeAnalyticsConsentWithdrawRequest {
  operation: "consent_withdraw";
  account_id: string;
  locale?: "en" | "ar";
}

interface YouTubeAnalyticsDataRequestBase {
  account_id: string;
  period_days: YouTubeAnalyticsPeriodDays;
  window_end: string;
}

export interface YouTubeAnalyticsSummaryRequest extends YouTubeAnalyticsDataRequestBase {
  operation: "summary";
  video_id?: string;
}

export interface YouTubeAnalyticsDailyRequest extends YouTubeAnalyticsDataRequestBase {
  operation: "daily";
  video_id?: string;
}

export interface YouTubeAnalyticsTopVideosRequest extends YouTubeAnalyticsDataRequestBase {
  operation: "top_videos";
  start_index?: number;
}

export type YouTubeAnalyticsRequest =
  | YouTubeAnalyticsStatusRequest
  | YouTubeAnalyticsConsentAcceptRequest
  | YouTubeAnalyticsConsentWithdrawRequest
  | YouTubeAnalyticsSummaryRequest
  | YouTubeAnalyticsDailyRequest
  | YouTubeAnalyticsTopVideosRequest;
