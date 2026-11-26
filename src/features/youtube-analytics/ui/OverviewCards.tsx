import { useTranslation } from "react-i18next";
import { LtrValue } from "./LtrValue";
import { YOUTUBE_ANALYTICS_SUMMARY_METRICS, type YouTubeAnalyticsSummaryData } from "../domain/types";
import { formatMetric } from "../domain/format";
import { useYouTubeMetricLabels } from "./useYouTubeMetricLabels";

export function OverviewCards({ data, forVideo = false }: { data: YouTubeAnalyticsSummaryData; forVideo?: boolean }) {
  const { t, i18n } = useTranslation("analytics");
  const labels = useYouTubeMetricLabels();
  return (
    <section aria-label={t("youtube.overview", "Overview")} className="space-y-3">
      <h2 className="text-lg font-semibold">{t("youtube.overview", "Overview")}</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {YOUTUBE_ANALYTICS_SUMMARY_METRICS.map((definition) => {
          const metric = data.metrics.find((candidate) => candidate.key === definition.key);
          return (
            <article key={definition.key} className="rounded-lg border bg-card p-4">
              <h3 className="text-sm text-muted-foreground">{labels[definition.key]}</h3>
              <p className="mt-2 text-xl font-semibold tabular-nums"><LtrValue>{formatMetric(metric, i18n.language)}</LtrValue></p>
            </article>
          );
        })}
      </div>
      {!data.has_data ? <p role="status" className="text-sm text-muted-foreground">{t("youtube.empty", "YouTube has no numbers for this period yet.")}</p> : null}
      {forVideo ? <p className="text-xs text-muted-foreground">{t("youtube.videoSubscriberNote", "For one video, YouTube counts only subscriptions from that video's watch page.")}</p> : null}
    </section>
  );
}
