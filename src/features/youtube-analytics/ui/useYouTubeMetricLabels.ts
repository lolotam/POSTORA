import { useTranslation } from "react-i18next";
import type { YouTubeAnalyticsMetricKey } from "../domain/types";

export function useYouTubeMetricLabels(): Record<YouTubeAnalyticsMetricKey, string> {
  const { t } = useTranslation("analytics");
  return {
    views: t("youtube.metrics.views", "Views"),
    watch_time: t("youtube.metrics.watch_time", "Watch time"),
    average_view_duration: t("youtube.metrics.average_view_duration", "Average view duration"),
    subscribers_gained: t("youtube.metrics.subscribers_gained", "Subscribers gained"),
    subscribers_lost: t("youtube.metrics.subscribers_lost", "Subscribers lost"),
    likes: t("youtube.metrics.likes", "Likes"),
    comments: t("youtube.metrics.comments", "Comments"),
    shares: t("youtube.metrics.shares", "Shares"),
  };
}
