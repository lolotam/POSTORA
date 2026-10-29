/**
 * Frozen owner-report domain types for Instagram insights.
 *
 * Sourced directly from `supabase/functions/instagram-insights-report/contracts.ts`.
 * Pure TypeScript types: runtime-neutral, no DOM, no React, no Supabase client.
 */

export const OWNER_REPORT_SCHEMA_VERSION = 1;

export const OWNER_REPORT_PERIOD_DAYS = [7, 14, 30, 90] as const;
export type OwnerReportPeriodDays = (typeof OWNER_REPORT_PERIOD_DAYS)[number];

export const OWNER_REPORT_LAG_NOTE = "provider_data_may_lag_up_to_48h" as const;
export type OwnerReportLagNote = typeof OWNER_REPORT_LAG_NOTE;

export type OwnerReportScope = {
  ownerId: string;
  socialAccountId: string;
  platform: "instagram";
};

export type OwnerReportSource = "graph_own";

export type OwnerReportCursor = {
  publishedAt: string;
  mediaId: string;
};

export type OwnerReportMetricBasis = "views" | "reach" | "interactions";

export type OwnerReportRowStatus = "pending" | "ok" | "unavailable" | "error";

export type OwnerReportSyncStatus = "ok" | "partial" | "error" | "never";

export type OwnerReportCoverage = "complete" | "partial" | "unknown";

export type OwnerReportReasonCode =
  | "ok"
  | "never_synced"
  | "scope_missing"
  | "reauth_required"
  | "throttled"
  | "usage_limit_reached"
  | "provider_unavailable"
  | "provider_error"
  | "network_error"
  | "write_failed"
  | "inventory_truncated"
  | "baseline_history_incomplete"
  | "unknown";

export type OutlierFormat = "reel" | "non_reel";

export type OutlierLabel =
  | "outlier"
  | "above"
  | "normal"
  | "below"
  | "too_early"
  | "no_data"
  | "small_baseline";

export type OwnerReportEngagementRate = {
  value: number | null;
  unit: "percent";
  denominatorMetric: "reach";
  numeratorMetrics: readonly ["likes", "comments", "saved", "shares"];
};

export type OwnerReportOutlier = {
  score: number | null;
  label: OutlierLabel;
  baselineMedian: number | null;
  baselineSize: number;
  metricBasis: OwnerReportMetricBasis | null;
};

export type OwnerReportMediaMetrics = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  totalInteractions: number | null;
  follows: number | null;
  profileVisits: number | null;
  replies: number | null;
  igReelsAvgWatchTimeMs: number | null;
};

export type OwnerReportMediaItem = {
  mediaId: string;
  postId: string | null;
  publishedAt: string;
  capturedAt: string;
  capturedOn: string;
  captureTimezone: string;
  format: OutlierFormat;
  mediaProductType: string | null;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  status: OwnerReportRowStatus;
  metrics: OwnerReportMediaMetrics;
  engagementRate: OwnerReportEngagementRate;
  outlier: OwnerReportOutlier;
};

export type OwnerReportMediaCoverage = {
  received: number;
  inWindow: number;
  reel: number;
  nonReel: number;
  excludedStory: number;
  excludedUnsupported: number;
  excludedUnknown: number;
  excludedNoCapture: number;
  excludedFuture: number;
};

export type OwnerReportMediaPage = {
  items: OwnerReportMediaItem[];
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: OwnerReportCursor | null;
};

export type OwnerReportDailyRow = {
  metricDate: string;
  providerDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  providerTimezone: string | null;
  status: OwnerReportRowStatus;
  capturedAt: string;
  reach: number | null;
  views: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  follows: number | null;
  unfollows: number | null;
};

export type OwnerReportProfileObservation = {
  observedAt: string;
  observedOn: string;
  captureTimezone: string;
  status: OwnerReportRowStatus;
  followersCount: number | null;
  mediaCount: number | null;
};

export type OwnerReportFreshness = {
  status: OwnerReportSyncStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastPartialAt: string | null;
  partial: boolean;
  truncated: boolean;
  retryAt: string | null;
  reason: OwnerReportReasonCode | null;
};

export type OwnerReportCompleteness = {
  baselineHistoryComplete: boolean;
  inventoryTruncated: boolean;
  coverage: OwnerReportCoverage;
  oldestMediaPublishedAt: string | null;
  newestMediaPublishedAt: string | null;
};

export type OwnerReport = {
  schemaVersion: typeof OWNER_REPORT_SCHEMA_VERSION;
  source: OwnerReportSource;
  scope: OwnerReportScope;
  generatedAt: string;
  period: {
    days: OwnerReportPeriodDays;
    windowStart: string;
    windowEnd: string;
  };
  freshness: OwnerReportFreshness;
  completeness: OwnerReportCompleteness;
  profile: OwnerReportProfileObservation | null;
  media: OwnerReportMediaPage;
  daily: OwnerReportDailyRow[];
  coverage: OwnerReportMediaCoverage;
  lagNote: OwnerReportLagNote;
};
