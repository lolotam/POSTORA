export type * from "./domain/types";
export {
  ANALYTICS_CONTRACT_VERSION, ANALYTICS_METRIC_KEYS, ANALYTICS_PLATFORMS, UNAVAILABLE_REASONS,
  summarizeDailyMetricValues, metricDelta, analyticsSyncState, unavailableMetric, isAnalyticsMetricMeasurable, isAnalyticsAccountMetricIncomplete,
} from "../../../supabase/functions/_shared/analyticsContract.ts";
export { ANALYTICS_PERIOD_DAYS, closedAnalyticsPeriods, analyticsWindowForPeriod, analyticsDayBucket } from "../../../supabase/functions/_shared/analyticsCalendar.ts";
export { ANALYTICS_METRIC_REGISTRY, ANALYTICS_PLATFORM_CONFIGURATION, analyticsDefinitions } from "../../../supabase/functions/_shared/analyticsRegistry.ts";
export { ANALYTICS_REPORT_SCHEMA, parseAnalyticsReport, normalizeAnalyticsPermalink } from "../../../supabase/functions/_shared/analyticsSchema.ts";
