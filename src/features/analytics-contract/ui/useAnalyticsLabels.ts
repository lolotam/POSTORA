import { useTranslation } from "react-i18next";

/** Static keys keep the translated metric/status vocabulary checked by CI. */
export function useAnalyticsLabels() {
  const { t } = useTranslation("analytics");
  const metrics = {
    reach: t("owned.metrics.reach", "Reach"),
    views: t("owned.metrics.views", "Views"),
    unique_viewers: t("owned.metrics.unique_viewers", "Unique viewers"),
    profile_views: t("owned.metrics.profile_views", "Profile views"),
    impressions: t("owned.metrics.impressions", "Impressions"),
    engagements: t("owned.metrics.engagements", "Engagements"),
    likes: t("owned.metrics.likes", "Likes"),
    comments: t("owned.metrics.comments", "Comments"),
    replies: t("owned.metrics.replies", "Replies"),
    shares: t("owned.metrics.shares", "Shares"),
    reposts: t("owned.metrics.reposts", "Reposts"),
    quotes: t("owned.metrics.quotes", "Quotes"),
    saves: t("owned.metrics.saves", "Saves"),
    followers: t("owned.metrics.followers", "Followers"),
    follower_change: t("owned.metrics.follower_change", "Follower change"),
  };
  const sync = {
    never_synced: t("owned.sync.never_synced", "Never synced"),
    syncing: t("owned.sync.syncing", "Syncing"),
    fresh: t("owned.sync.fresh", "Up to date"),
    stale: t("owned.sync.stale", "Needs updating"),
    partial: t("owned.sync.partial", "Partial data"),
    failed: t("owned.sync.failed", "Sync failed; saved data remains available"),
  };
  const windows = {
    day: t("owned.windows.day", "daily"),
    lifetime: t("owned.windows.lifetime", "lifetime"),
    period_total: t("owned.windows.period_total", "period total"),
    point_in_time: t("owned.windows.point_in_time", "point in time"),
  };
  const aggregations = {
    sum: t("owned.aggregations.sum", "sum"),
    last: t("owned.aggregations.last", "last value"),
    not_summable: t("owned.aggregations.not_summable", "not summable"),
  };
  const reasons: Record<string, string> = {
    reauth_required: t("owned.reasons.reauth_required", "Reconnect the account to resume collection."),
    permission_missing: t("owned.reasons.permission_missing", "A required permission is missing."),
    provider_error: t("owned.reasons.provider_error", "The platform measurement could not be retrieved."),
    window_mismatch: t("owned.reasons.window_mismatch", "This reporting period has not been verified for the connection."),
    outside_retention: t("owned.reasons.outside_retention", "The period is outside available history."),
    capability_unverified: t("owned.reasons.capability_unverified", "This metric has not been verified yet."),
    not_offered: t("owned.reasons.not_offered", "The platform does not offer this metric."),
    not_collected: t("owned.reasons.not_collected", "This measurement has not been collected yet."),
    storage_unavailable: t("owned.reasons.storage_unavailable", "Saved data could not be read. Please retry."),
    account_not_found: t("owned.reasons.account_not_found", "The account is missing or unavailable to you."),
    invalid_contract: t("owned.reasons.invalid_contract", "The report response is invalid. Please retry."),
    audit_unavailable: t("owned.reasons.audit_unavailable", "The report read could not be recorded. Please retry."),
  };
  return { metrics, sync, windows, aggregations, reasons };
}
