import {
  ANALYTICS_METRIC_KEYS, ANALYTICS_PLATFORMS,
  type AnalyticsMetricKey, type AnalyticsMetricLevel, type AnalyticsPlatform, type MetricDefinition,
} from "./analyticsContract.ts";

const LIVE_EVIDENCE = "docs/journeys/2026-11-01-meta-live-capabilities.md#closed-window-and-dst-observations";
const VERIFIED_AT = "2026-11-01T05:24:05.148333Z";
export const ANALYTICS_PLATFORM_CONFIGURATION: Record<AnalyticsPlatform, {
  staleAfterSeconds: number; providerBucketTimezone: string | null; calendarEvidenceRef: string | null;
}> = {
  instagram: { staleAfterSeconds: 172800, providerBucketTimezone: null, calendarEvidenceRef: null },
  facebook: { staleAfterSeconds: 172800, providerBucketTimezone: "America/Los_Angeles", calendarEvidenceRef: LIVE_EVIDENCE },
  threads: { staleAfterSeconds: 172800, providerBucketTimezone: "America/Los_Angeles", calendarEvidenceRef: LIVE_EVIDENCE },
};

function unverifiedDefinition(platform: AnalyticsPlatform, level: AnalyticsMetricLevel, key: AnalyticsMetricKey): MetricDefinition {
  return {
    key, platform, level, providerMetric: null,
    apiVersion: platform === "threads" ? "v1.0" : platform === "facebook" ? "v25.0" : "v22.0",
    unit: ["reach", "unique_viewers", "followers", "follower_change"].includes(key) ? "accounts" : "count",
    windowKind: level === "post" ? "lifetime" : "period_total", aggregation: "not_summable",
    providerBucketTimezone: null, definitionKey: `metricDefinitions.${platform}.${level}.${key}`,
    minimumPermission: null, capability: "unverified", evidenceRef: null, verifiedAt: null, exactPeriodVerified: false,
  };
}

function verifiedDefinition(base: MetricDefinition, observation: Pick<MetricDefinition,
  "providerMetric" | "windowKind" | "aggregation" | "exactPeriodVerified">): MetricDefinition {
  return {
    ...base, ...observation, capability: "available",
    verifiedAt: base.level === "post" && base.platform === "threads" ? "2026-11-01T05:38:00.349498Z" : VERIFIED_AT,
    evidenceRef: LIVE_EVIDENCE,
    minimumPermission: base.platform === "threads" ? "threads_manage_insights" : "read_insights",
    providerBucketTimezone: observation.windowKind === "day" ? "America/Los_Angeles" : null,
  };
}

function definition(platform: AnalyticsPlatform, level: AnalyticsMetricLevel, key: AnalyticsMetricKey): MetricDefinition {
  const base = unverifiedDefinition(platform, level, key);
  if (platform === "instagram") return base;
  if (platform === "threads" && level === "post" && ["views", "likes", "replies", "reposts", "quotes", "shares"].includes(key)) {
    return verifiedDefinition(base, { providerMetric: key, windowKind: "lifetime", aggregation: "not_summable", exactPeriodVerified: false });
  }
  if (platform === "facebook" && level === "post" && (key === "views" || key === "unique_viewers")) {
    return verifiedDefinition(base, { providerMetric: key === "views" ? "post_media_view" : "post_total_media_view_unique",
      windowKind: "lifetime", aggregation: "not_summable", exactPeriodVerified: false });
  }
  if (level !== "account") return base;
  if (platform === "threads") {
    if (key === "profile_views") return verifiedDefinition(base, { providerMetric: "views", windowKind: "day", aggregation: "sum", exactPeriodVerified: true });
    if (key === "followers") return verifiedDefinition(base, { providerMetric: "followers_count", windowKind: "point_in_time", aggregation: "last", exactPeriodVerified: false });
    if (["likes", "replies", "reposts", "quotes"].includes(key)) {
      return verifiedDefinition(base, { providerMetric: key, windowKind: "period_total", aggregation: "not_summable", exactPeriodVerified: false });
    }
    return base;
  }
  const daily: Partial<Record<AnalyticsMetricKey, { providerMetric: string; aggregation: MetricDefinition["aggregation"] }>> = {
    views: { providerMetric: "page_media_view", aggregation: "sum" },
    unique_viewers: { providerMetric: "page_total_media_view_unique", aggregation: "not_summable" },
    engagements: { providerMetric: "page_post_engagements", aggregation: "sum" },
    followers: { providerMetric: "page_follows", aggregation: "last" },
  };
  const observed = daily[key];
  return observed ? verifiedDefinition(base, { ...observed, windowKind: "day", exactPeriodVerified: observed.aggregation !== "not_summable" }) : base;
}

export const ANALYTICS_METRIC_REGISTRY: readonly MetricDefinition[] = ANALYTICS_PLATFORMS.flatMap((platform) =>
  (["account", "post"] as const).flatMap((level) => ANALYTICS_METRIC_KEYS.map((key) => definition(platform, level, key))));

export function analyticsDefinitions(platform: AnalyticsPlatform, level: AnalyticsMetricLevel): MetricDefinition[] {
  return ANALYTICS_METRIC_REGISTRY.filter((entry) => entry.platform === platform && entry.level === level);
}
