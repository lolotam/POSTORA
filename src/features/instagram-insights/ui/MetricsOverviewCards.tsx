import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Users, Eye, TrendingUp, Sparkles, MousePointerClick } from "lucide-react";
import type { TFunction } from "i18next";
import { formatCompactNumber } from "../domain/formatters";
import type { OwnerReport, OwnerReportPeriodReach } from "../domain/types";
import { summarizeDailyMetric, type DailyMetricSummary } from "../domain/dailyMetrics";

export type MetricsOverviewCardsProps = {
  report: OwnerReport | undefined;
  isLoading?: boolean;
};

/** Why the period has no exact unique reach, in the owner's words. */
function periodReachGap(t: TFunction, reach: OwnerReportPeriodReach | undefined): string {
  if (reach?.status !== "unavailable") {
    return t("instagram.periodReachUnavailable", "An exact period total is required for unique reach.");
  }
  if (reach.reason === "period_too_long") {
    return t("instagram.periodReachTooLong", "Meta reports exact unique reach for periods of up to 30 days.");
  }
  if (reach.reason === "provider_unavailable") {
    return t("instagram.periodReachProviderUnavailable", "Meta did not report the unique reach of this period.");
  }
  return t("instagram.periodReachNotCollected", "The unique reach of this period has not been collected yet.");
}

export function MetricsOverviewCards({ report }: MetricsOverviewCardsProps) {
  const { t } = useTranslation("analytics");

  const followersCount = report?.account.latestProfileObservation?.followersCount ?? null;

  // Daily metrics are summed across the authoritative display window. Reach
  // is the provider's exact period total, never a sum of daily reach.
  const views = report ? summarizeDailyMetric(report, "views") : undefined;
  const interactions = report ? summarizeDailyMetric(report, "totalInteractions") : undefined;
  const accountsEngaged = report ? summarizeDailyMetric(report, "accountsEngaged") : undefined;
  const periodReach = report?.account.periodReach;
  const unavailable = t("instagram.metricUnavailable", "Not available");
  const metricValue = (summary?: DailyMetricSummary) => summary?.value === null || !summary
    ? unavailable : formatCompactNumber(summary.value);
  const coverage = (summary?: DailyMetricSummary) => summary?.status === "partial"
    ? t("instagram.metricPartialCoverage", "Partial: {{availableDays}} of {{expectedDays}} days", summary)
    : null;

  const cards = [
    {
      title: t("instagram.followers", "Followers"),
      value: followersCount === null ? unavailable : formatCompactNumber(followersCount),
      subtext: t("instagram.profileObservation", "Current audience"),
      icon: Users,
      color: "text-rose-500",
      bg: "bg-rose-500/10",
      border: "border-rose-500/20",
    },
    {
      title: t("instagram.reach", "Total Reach"),
      value: periodReach?.status === "available" ? formatCompactNumber(periodReach.value) : unavailable,
      subtext: periodReach?.status === "available"
        ? t("instagram.periodReachExact", "Unique accounts reached in the period")
        : periodReachGap(t, periodReach),
      icon: TrendingUp,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
    },
    {
      title: t("instagram.views", "Total Views"),
      value: metricValue(views),
      subtext: coverage(views) ?? t("instagram.viewsCount", "Provider-reported views"),
      icon: Eye,
      color: "text-violet-500",
      bg: "bg-violet-500/10",
      border: "border-violet-500/20",
    },
    {
      title: t("instagram.interactions", "Interactions"),
      value: metricValue(interactions),
      subtext: coverage(interactions) ?? t("instagram.likesCommentsShares", "Likes, comments, shares, saves"),
      icon: Sparkles,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
    },
    {
      title: t("instagram.accountsEngaged", "Accounts engaged"),
      value: metricValue(accountsEngaged),
      subtext: coverage(accountsEngaged) ?? t("instagram.accountsEngagedDailySum", "Sum of the daily engaged accounts"),
      icon: MousePointerClick,
      color: "text-sky-500",
      bg: "bg-sky-500/10",
      border: "border-sky-500/20",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
      {cards.map((card, idx) => {
        const Icon = card.icon;
        return (
          <Card key={idx} className={`border ${card.border} bg-card overflow-hidden`}>
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{card.title}</span>
                <div className={`p-2 rounded-lg ${card.bg}`}>
                  <Icon className={`h-4 w-4 ${card.color}`} />
                </div>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-bold tracking-tight">{card.value}</div>
                <p className="text-[11px] text-muted-foreground mt-1">{card.subtext}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
