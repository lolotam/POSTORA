import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Users, Eye, TrendingUp, Sparkles } from "lucide-react";
import { formatCompactNumber } from "../domain/formatters";
import type { OwnerReport } from "../domain/types";

export type MetricsOverviewCardsProps = {
  report: OwnerReport | undefined;
  isLoading?: boolean;
};

export function MetricsOverviewCards({ report }: MetricsOverviewCardsProps) {
  const { t } = useTranslation("analytics");

  const followersCount = report?.profile?.followersCount ?? null;

  // Aggregate daily metrics across the display window
  let totalReach: number | null = null;
  let totalViews: number | null = null;
  let totalInteractions: number | null = null;

  if (report?.daily && report.daily.length > 0) {
    let hasReach = false;
    let reachSum = 0;
    let hasViews = false;
    let viewsSum = 0;
    let hasInteractions = false;
    let interactionsSum = 0;

    for (const day of report.daily) {
      if (day.status === "ok") {
        if (day.reach !== null && Number.isFinite(day.reach)) {
          reachSum += day.reach;
          hasReach = true;
        }
        if (day.views !== null && Number.isFinite(day.views)) {
          viewsSum += day.views;
          hasViews = true;
        }
        if (day.totalInteractions !== null && Number.isFinite(day.totalInteractions)) {
          interactionsSum += day.totalInteractions;
          hasInteractions = true;
        }
      }
    }

    if (hasReach) totalReach = reachSum;
    if (hasViews) totalViews = viewsSum;
    if (hasInteractions) totalInteractions = interactionsSum;
  }

  const cards = [
    {
      title: t("instagram.followers", "Followers"),
      value: formatCompactNumber(followersCount),
      subtext: t("instagram.profileObservation", "Current audience"),
      icon: Users,
      color: "text-rose-500",
      bg: "bg-rose-500/10",
      border: "border-rose-500/20",
    },
    {
      title: t("instagram.reach", "Total Reach"),
      value: formatCompactNumber(totalReach),
      subtext: t("instagram.uniqueAccounts", "Unique accounts reached"),
      icon: TrendingUp,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
    },
    {
      title: t("instagram.views", "Total Views"),
      value: formatCompactNumber(totalViews),
      subtext: t("instagram.impressionsCount", "Reel & post impressions"),
      icon: Eye,
      color: "text-violet-500",
      bg: "bg-violet-500/10",
      border: "border-violet-500/20",
    },
    {
      title: t("instagram.interactions", "Interactions"),
      value: formatCompactNumber(totalInteractions),
      subtext: t("instagram.likesCommentsShares", "Likes, comments, shares, saves"),
      icon: Sparkles,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
                <p className="text-[11px] text-muted-foreground mt-1 truncate">{card.subtext}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
