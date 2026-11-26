import { useTranslation } from "react-i18next";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AnalyticsNotice } from "./AnalyticsNotice";
import { OverviewCards } from "./OverviewCards";
import { DailyTrend } from "./DailyTrend";
import type {
  YouTubeAnalyticsDailyData,
  YouTubeAnalyticsRequestedWindow,
  YouTubeAnalyticsSuccess,
  YouTubeAnalyticsSummaryData,
} from "../domain/types";

export function VideoAnalyticsPanel(props: {
  videoId: string;
  requestedWindow: YouTubeAnalyticsRequestedWindow;
  summary: UseQueryResult<YouTubeAnalyticsSuccess<YouTubeAnalyticsSummaryData>, Error>;
  daily: UseQueryResult<YouTubeAnalyticsSuccess<YouTubeAnalyticsDailyData>, Error>;
  onClose: () => void;
}) {
  const { videoId, requestedWindow, summary, daily, onClose } = props;
  const { t } = useTranslation("analytics");
  return (
    <section aria-label={t("youtube.videoAnalytics", "Video analytics")} className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("youtube.videoAnalytics", "Video analytics")}: {videoId}</h2>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("youtube.close", "Close")}</Button>
      </div>
      {summary.isError ? <AnalyticsNotice error={summary.error} onRetry={() => void summary.refetch()} />
        : summary.data ? <OverviewCards data={summary.data.data} forVideo />
          : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
      {daily.isError ? <AnalyticsNotice error={daily.error} onRetry={() => void daily.refetch()} />
        : daily.data ? <DailyTrend data={daily.data.data} requestedWindow={requestedWindow} forVideo />
          : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
    </section>
  );
}
