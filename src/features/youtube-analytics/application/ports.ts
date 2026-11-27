import type {
  YouTubeAnalyticsBreakdownData,
  YouTubeAnalyticsConsentData,
  YouTubeAnalyticsDailyData,
  YouTubeAnalyticsPeriodDays,
  YouTubeAnalyticsRetentionData,
  YouTubeAnalyticsStatusData,
  YouTubeAnalyticsSuccess,
  YouTubeAnalyticsSummaryData,
  YouTubeAnalyticsTopVideosData,
} from "../domain/types";

export interface YouTubeAnalyticsDataParams {
  accountId: string;
  periodDays: YouTubeAnalyticsPeriodDays;
  windowEnd: string;
  videoId?: string;
  signal?: AbortSignal;
}

export interface YouTubeAnalyticsGateway {
  status(accountId: string, signal?: AbortSignal): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsStatusData>>;
  acceptConsent(params: {
    accountId: string;
    purposeVersion: number;
    locale: "en" | "ar";
    connectionRevision: string;
    signal?: AbortSignal;
  }): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsConsentData>>;
  withdrawConsent(params: {
    accountId: string;
    locale: "en" | "ar";
    signal?: AbortSignal;
  }): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsConsentData>>;
  summary(params: YouTubeAnalyticsDataParams): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsSummaryData>>;
  daily(params: YouTubeAnalyticsDataParams): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsDailyData>>;
  topVideos(params: YouTubeAnalyticsDataParams & { startIndex?: number }): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsTopVideosData>>;
  trafficSources(params: Omit<YouTubeAnalyticsDataParams, "videoId">): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsBreakdownData>>;
  geography(params: Omit<YouTubeAnalyticsDataParams, "videoId">): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsBreakdownData>>;
  devices(params: Omit<YouTubeAnalyticsDataParams, "videoId">): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsBreakdownData>>;
  retention(params: YouTubeAnalyticsDataParams & { videoId: string }): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsRetentionData>>;
}
