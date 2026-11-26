import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LtrValue } from "./LtrValue";
import { buildTrendSeries } from "../domain/trendSeries";
import { formatAnalyticsDate, formatCount, formatMinutes } from "../domain/format";
import type { YouTubeAnalyticsDailyData, YouTubeAnalyticsRequestedWindow } from "../domain/types";
import { useYouTubeMetricLabels } from "./useYouTubeMetricLabels";

const METRICS = ["views", "watch_time", "subscribers_gained", "subscribers_lost"] as const;
type TrendMetric = (typeof METRICS)[number];

export function DailyTrend({ data, requestedWindow, forVideo = false }: {
  data: YouTubeAnalyticsDailyData;
  requestedWindow: YouTubeAnalyticsRequestedWindow;
  forVideo?: boolean;
}) {
  const { t, i18n } = useTranslation("analytics");
  const labels = useYouTubeMetricLabels();
  const [metric, setMetric] = useState<TrendMetric>("views");
  const points = buildTrendSeries(requestedWindow, data.rows);
  const format = (value: number | null) => metric === "watch_time" ? formatMinutes(value, i18n.language) : formatCount(value, i18n.language);

  return (
    <section aria-label={t("youtube.dailyTrend", "Daily trend")} className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("youtube.dailyTrend", "Daily trend")}</h2>
        <label className="flex items-center gap-2 text-sm">
          <span>{t("youtube.metric", "Metric")}</span>
          <select className="rounded-md border bg-background px-2 py-1" value={metric} onChange={(event) => setMetric(event.target.value as TrendMetric)}>
            {METRICS.map((key) => <option key={key} value={key}>{labels[key]}</option>)}
          </select>
        </label>
      </div>
      {data.coverage.last_day !== null ? (
        <p className="text-sm text-muted-foreground">{t("youtube.lastDailyDay", "Last day with daily numbers:")} <LtrValue>{formatAnalyticsDate(data.coverage.last_day, i18n.language)}</LtrValue></p>
      ) : null}
      {data.coverage.days_missing > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("youtube.daysMissing", "YouTube did not return daily numbers for {{count}} day(s) of this period.", { count: data.coverage.days_missing })}
        </p>
      ) : null}
      <div className="h-56 min-w-0" role="img" aria-label={t("youtube.trendDescription", "Days YouTube did not return appear as gaps.")}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points}>
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Line dataKey={metric} name={labels[metric]} type="monotone" stroke="currentColor" connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">{t("youtube.dailyValues", "Daily values")}</summary>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead><tr><th className="text-start">{t("youtube.day", "Day")}</th><th className="text-start">{labels[metric]}</th></tr></thead>
            <tbody>{points.map((point) => <tr key={point.day}><td><LtrValue>{formatAnalyticsDate(point.day, i18n.language)}</LtrValue></td><td><LtrValue>{format(point[metric])}</LtrValue></td></tr>)}</tbody>
          </table>
        </div>
      </details>
      {forVideo ? <p className="text-xs text-muted-foreground">{t("youtube.videoSubscriberNote", "For one video, YouTube counts only subscriptions from that video's watch page.")}</p> : null}
    </section>
  );
}
