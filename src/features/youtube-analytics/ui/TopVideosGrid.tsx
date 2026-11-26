import { useTranslation } from "react-i18next";
import type { YouTubeAnalyticsMetricKey, YouTubeAnalyticsTopVideoRow } from "../domain/types";
import { formatMetric } from "../domain/format";
import { LtrValue } from "./LtrValue";
import { TopVideoThumbnail } from "./TopVideoThumbnail";
import { useYouTubeMetricLabels } from "./useYouTubeMetricLabels";

const METRICS: YouTubeAnalyticsMetricKey[] = ["views", "watch_time", "likes", "subscribers_gained"];

export function TopVideosGrid({ rows, columnsClass, onInspect }: {
  rows: readonly YouTubeAnalyticsTopVideoRow[];
  columnsClass: string;
  onInspect: (videoId: string) => void;
}) {
  const { t, i18n } = useTranslation("analytics");
  const labels = useYouTubeMetricLabels();
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const formatDate = (value: string | null) => {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
  };
  return (
    <div className={`grid gap-3 ${columnsClass}`}>
      {rows.map((row, index) => (
        <article
          key={row.video_id}
          className="flex flex-col justify-between space-y-3 rounded-lg border p-3 text-start transition-colors hover:bg-muted/40"
        >
          <button
            type="button"
            aria-label={row.title ?? t("youtube.videoUnavailable", "Video unavailable")}
            onClick={() => onInspect(row.video_id)}
            className="w-full space-y-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="relative">
              <TopVideoThumbnail url={row.thumbnail_url} />
              <span className="absolute start-2 top-2 rounded bg-background/90 px-1.5 py-0.5 text-xs font-medium">#{index + 1}</span>
            </div>
            <div>
              <h3 className="line-clamp-2 min-h-10 font-medium">{row.title ?? t("youtube.videoUnavailable", "Video unavailable")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDate(row.published_at)}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              {METRICS.map((key) => (
                <div key={key}>
                  <dt className="text-muted-foreground">{labels[key]}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">
                    <LtrValue>{formatMetric(row.metrics.find((metric) => metric.key === key), i18n.language)}</LtrValue>
                  </dd>
                </div>
              ))}
            </dl>
          </button>
          <div>
            <a
              className="inline-flex text-sm text-primary underline"
              href={row.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("youtube.open", "Open")}
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}
