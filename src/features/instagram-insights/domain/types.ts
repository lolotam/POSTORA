/**
 * Frozen owner-report domain types for Instagram insights.
 *
 * Sourced directly from `supabase/functions/instagram-insights-report/contracts.ts`.
 * Pure TypeScript types: runtime-neutral, no DOM, no React, no Supabase client.
 */

// A single DTO definition keeps UI reads aligned with the actual report response.
export {
  OWNER_REPORT_SCHEMA_VERSION,
  OWNER_REPORT_PERIOD_DAYS,
  OWNER_REPORT_LAG_NOTE,
} from "../../../../supabase/functions/instagram-insights-report/contracts";
export type {
  OwnerReportPeriodDays,
  OwnerReportLagNote,
  OwnerReportScope,
  OwnerReportSource,
  OwnerReportCursor,
  OwnerReportMetricBasis,
  OwnerReportRowStatus,
  OwnerReportSyncStatus,
  OwnerReportCoverage,
  OwnerReportReasonCode,
  OwnerReportEngagementRate,
  OwnerReportOutlier,
  OwnerReportMediaMetrics,
  OwnerReportMediaItem,
  OwnerReportMediaCoverage,
  OwnerReportMediaPage,
  OwnerReportDailyRow,
  OwnerReportProfileObservation,
  OwnerReportFreshness,
  OwnerReportCompleteness,
  OwnerReport,
} from "../../../../supabase/functions/instagram-insights-report/contracts";
export type {
  OutlierFormat,
  OutlierLabel,
} from "../../../../supabase/functions/_shared/outlierScore";
