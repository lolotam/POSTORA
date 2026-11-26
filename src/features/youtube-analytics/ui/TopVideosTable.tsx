import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LtrValue } from "./LtrValue";
import { formatMetric } from "../domain/format";
import type { YouTubeAnalyticsMetricKey, YouTubeAnalyticsTopVideosData } from "../domain/types";
import { useYouTubeMetricLabels } from "./useYouTubeMetricLabels";

const COLUMNS: YouTubeAnalyticsMetricKey[] = ["views", "watch_time", "likes", "subscribers_gained"];

export function TopVideosTable({ data, onInspect }: { data: YouTubeAnalyticsTopVideosData; onInspect: (videoId: string) => void }) {
  const { t, i18n } = useTranslation("analytics");
  const labels = useYouTubeMetricLabels();
  return (
    <section aria-label={t("youtube.topVideos", "Most viewed videos")} className="space-y-3">
      <h2 className="text-lg font-semibold">{t("youtube.topVideos", "Most viewed videos")}</h2>
      {data.rows.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t("youtube.empty", "YouTube has no numbers for this period yet.")}</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-3 text-start">{t("youtube.video", "Video")}</th>
              {COLUMNS.map((key) => <th key={key} className="p-3 text-start">{labels[key]}</th>)}
              <th className="p-3 text-start">{t("youtube.actions", "Actions")}</th>
            </tr></thead>
            <tbody>{data.rows.map((row) => <tr key={row.video_id} className="border-t">
              <td className="p-3">{row.title ?? t("youtube.videoUnavailable", "Video unavailable")}</td>
              {COLUMNS.map((key) => <td key={key} className="p-3 tabular-nums"><LtrValue>{formatMetric(row.metrics.find((metric) => metric.key === key), i18n.language)}</LtrValue></td>)}
              <td className="p-3"><div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => onInspect(row.video_id)}>{t("youtube.inspect", "Inspect")}</Button>
                <a className="inline-flex h-9 items-center rounded-md px-2 text-primary underline" href={row.link} target="_blank" rel="noopener noreferrer">{t("youtube.open", "Open")}</a>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("youtube.videoSubscriberNote", "For one video, YouTube counts only subscriptions from that video's watch page.")}</p>
    </section>
  );
}
