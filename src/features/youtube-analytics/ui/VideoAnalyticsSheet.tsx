import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  YouTubeAnalyticsDailyData,
  YouTubeAnalyticsRequestedWindow,
  YouTubeAnalyticsRetentionData,
  YouTubeAnalyticsSuccess,
  YouTubeAnalyticsSummaryData,
} from "../domain/types";
import { VideoAnalyticsPanel } from "./VideoAnalyticsPanel";

export function VideoAnalyticsSheet({ open, onOpenChange, locale, title, videoId, requestedWindow, summary, daily, retention, retentionExpanded, onExpandRetention }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: "en" | "ar";
  title?: string | null;
  videoId: string;
  requestedWindow: YouTubeAnalyticsRequestedWindow;
  summary: UseQueryResult<YouTubeAnalyticsSuccess<YouTubeAnalyticsSummaryData>, Error>;
  daily: UseQueryResult<YouTubeAnalyticsSuccess<YouTubeAnalyticsDailyData>, Error>;
  retention?: UseQueryResult<YouTubeAnalyticsSuccess<YouTubeAnalyticsRetentionData>, Error>;
  retentionExpanded?: boolean;
  onExpandRetention?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation("analytics");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={locale === "ar" ? "left" : "right"}
        dir={locale === "ar" ? "rtl" : "ltr"}
        className="w-full sm:max-w-xl lg:max-w-2xl overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle>{title ?? `${t("youtube.videoAnalytics", "Video analytics")}: ${videoId}`}</SheetTitle>
          <SheetDescription className="sr-only">{t("youtube.videoDrawerDescription", "Detailed analytics for the selected video.")}</SheetDescription>
        </SheetHeader>
        <VideoAnalyticsPanel
          videoId={videoId}
          requestedWindow={requestedWindow}
          summary={summary}
          daily={daily}
          retention={retention}
          retentionExpanded={retentionExpanded}
          onExpandRetention={onExpandRetention}
        />
      </SheetContent>
    </Sheet>
  );
}
