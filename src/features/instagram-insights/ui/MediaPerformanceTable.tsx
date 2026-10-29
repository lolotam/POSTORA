import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ExternalLink,
  Film,
  Image as ImageIcon,
  ArrowUpDown,
  Filter,
  Eye,
  Heart,
  MessageCircle,
  Share2,
  Bookmark,
  TrendingUp,
} from "lucide-react";
import {
  formatCompactNumber,
  formatEngagementRate,
  formatMetricNumber,
  formatOutlierBadge,
} from "../domain/formatters";
import type { OwnerReportMediaItem, OwnerReportMediaPage } from "../domain/types";

export type MediaPerformanceTableProps = {
  media: OwnerReportMediaPage | undefined;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
};

export function MediaPerformanceTable({
  media,
  onLoadMore,
  isLoadingMore = false,
}: MediaPerformanceTableProps) {
  const { t } = useTranslation("analytics");
  const [formatFilter, setFormatFilter] = useState<"all" | "reel" | "non_reel">("all");
  const [sortBy, setSortBy] = useState<"newest" | "engagement" | "reach" | "views">("newest");

  const filteredAndSortedItems = useMemo(() => {
    let result = [...(media?.items ?? [])];

    if (formatFilter !== "all") {
      result = result.filter((item) => item.format === formatFilter);
    }

    result.sort((a, b) => {
      switch (sortBy) {
        case "engagement": {
          const aRate = a.engagementRate.value ?? -1;
          const bRate = b.engagementRate.value ?? -1;
          return bRate - aRate;
        }
        case "reach": {
          const aReach = a.metrics.reach ?? -1;
          const bReach = b.metrics.reach ?? -1;
          return bReach - aReach;
        }
        case "views": {
          const aViews = a.metrics.views ?? -1;
          const bViews = b.metrics.views ?? -1;
          return bViews - aViews;
        }
        case "newest":
        default:
          return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      }
    });

    return result;
  }, [media?.items, formatFilter, sortBy]);

  return (
    <Card className="border border-border/70 bg-card/60 backdrop-blur-sm overflow-hidden">
      <CardHeader className="p-4 sm:p-5 border-b border-border/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Film className="h-4 w-4 text-rose-500" />
          <CardTitle className="text-sm font-semibold">
            {t("instagram.mediaPerformance", "Media Performance & Outliers")}
          </CardTitle>
          <Badge variant="outline" className="text-[11px] h-5 px-1.5 font-normal">
            {filteredAndSortedItems.length}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Format filter */}
          <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/50 text-xs">
            <Button
              type="button"
              size="sm"
              variant={formatFilter === "all" ? "secondary" : "ghost"}
              onClick={() => setFormatFilter("all")}
              className="h-6 px-2 text-[11px] rounded"
            >
              {t("common:all", "All")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={formatFilter === "reel" ? "secondary" : "ghost"}
              onClick={() => setFormatFilter("reel")}
              className="h-6 px-2 text-[11px] rounded"
            >
              {t("instagram.reels", "Reels")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={formatFilter === "non_reel" ? "secondary" : "ghost"}
              onClick={() => setFormatFilter("non_reel")}
              className="h-6 px-2 text-[11px] rounded"
            >
              {t("instagram.posts", "Posts")}
            </Button>
          </div>

          {/* Sort toggle */}
          <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/50 text-xs">
            <Button
              type="button"
              size="sm"
              variant={sortBy === "newest" ? "secondary" : "ghost"}
              onClick={() => setSortBy("newest")}
              className="h-6 px-2 text-[11px] rounded"
            >
              {t("instagram.newest", "Newest")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sortBy === "engagement" ? "secondary" : "ghost"}
              onClick={() => setSortBy("engagement")}
              className="h-6 px-2 text-[11px] rounded"
            >
              {t("instagram.engagement", "Engagement")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sortBy === "reach" ? "secondary" : "ghost"}
              onClick={() => setSortBy("reach")}
              className="h-6 px-2 text-[11px] rounded"
            >
              {t("instagram.reach", "Reach")}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {filteredAndSortedItems.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            {t("instagram.noMediaInWindow", "No media published in this period.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/30 border-b border-border/50 text-muted-foreground uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-2.5 px-3 sm:px-4 font-medium">{t("instagram.content", "Content")}</th>
                  <th className="py-2.5 px-3 font-medium">{t("instagram.type", "Type")}</th>
                  <th className="py-2.5 px-3 font-medium">{t("instagram.published", "Published")}</th>
                  <th className="py-2.5 px-3 font-medium text-right">{t("instagram.reach", "Reach")}</th>
                  <th className="py-2.5 px-3 font-medium text-right">{t("instagram.views", "Views")}</th>
                  <th className="py-2.5 px-3 font-medium text-right">{t("instagram.engagement", "Eng. Rate")}</th>
                  <th className="py-2.5 px-3 font-medium text-center">{t("instagram.outlierScore", "Outlier Score")}</th>
                  <th className="py-2.5 px-3 sm:px-4 text-center font-medium">{t("instagram.actions", "Link")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filteredAndSortedItems.map((item) => {
                  const badge = formatOutlierBadge(item.outlier.label, item.outlier.score);
                  const isReel = item.format === "reel";

                  return (
                    <tr key={item.mediaId} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-3 sm:px-4">
                        <div className="flex items-center gap-2.5 max-w-[240px]">
                          <div className="relative w-9 h-9 rounded-md bg-muted/70 overflow-hidden shrink-0 flex items-center justify-center border border-border/50">
                            {item.thumbnailUrl ? (
                              <img
                                src={item.thumbnailUrl}
                                alt="media"
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  // Fallback to icon if thumbnail expired
                                  (e.currentTarget as HTMLElement).style.display = "none";
                                }}
                              />
                            ) : isReel ? (
                              <Film className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ImageIcon className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                          <span className="font-mono text-[11px] text-muted-foreground truncate">
                            {item.mediaId}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4 capitalize">
                          {isReel ? "Reel" : item.mediaProductType || "Post"}
                        </Badge>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap text-muted-foreground">
                        {new Date(item.publishedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </td>

                      <td className="py-3 px-3 text-right font-medium">
                        {formatCompactNumber(item.metrics.reach)}
                      </td>

                      <td className="py-3 px-3 text-right font-medium">
                        {formatCompactNumber(item.metrics.views)}
                      </td>

                      <td className="py-3 px-3 text-right font-semibold text-rose-500">
                        {formatEngagementRate(item.engagementRate)}
                      </td>

                      <td className="py-3 px-3 text-center">
                        <Badge
                          variant={badge.variant === "success" ? "default" : badge.variant === "destructive" ? "destructive" : "outline"}
                          className={`text-[10px] py-0.5 px-2 font-medium ${
                            badge.variant === "warning" ? "border-amber-500/50 text-amber-500" : ""
                          }`}
                          title={
                            item.outlier.baselineSize > 0
                              ? `Cohort: ${item.outlier.metricBasis ?? "views"}, Baseline: ${item.outlier.baselineSize} items, median: ${item.outlier.baselineMedian}`
                              : undefined
                          }
                        >
                          {badge.text}
                        </Badge>
                      </td>

                      <td className="py-3 px-3 sm:px-4 text-center">
                        {item.permalink ? (
                          <a
                            href={item.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title={t("instagram.openOnInstagram", "Open on Instagram")}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {media?.hasMore && onLoadMore && (
          <div className="p-3 border-t border-border/50 text-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoadingMore}
              onClick={onLoadMore}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {isLoadingMore ? t("common:loading", "Loading...") : t("actions.loadMore", "Load more")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
