import { useAnalyticsLabels } from "./useAnalyticsLabels";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsMetricResult, AnalyticsReport, MetricValue } from "../domain/types";

export function AnalyticsMetricValue({ metric }: { metric: MetricValue }) {
  const { t, i18n } = useTranslation("analytics");
  const labels = useAnalyticsLabels();
  if (metric.status === "unavailable") return <span>{t("owned.unavailable", "Not available")} · {labels.reasons[metric.reason]}</span>;
  return <span>{metric.value.toLocaleString(i18n.language)}{metric.status === "partial" && <> · {t("owned.partialCoverage", "Partial: {{available}}/{{expected}} days", {
    available: metric.coverage.availableDays, expected: metric.coverage.expectedDays,
  })}</>}</span>;
}

function MetricDetails({ metric }: { metric: AnalyticsMetricResult }) {
  const { t } = useTranslation("analytics");
  const labels = useAnalyticsLabels();
  return <details className="text-xs text-muted-foreground">
    <summary className="cursor-pointer">{t("owned.definition", "Definition and source")}</summary>
    <p>{t(metric.definition.definitionKey, t("owned.definitionText", "{{metric}} reported by {{platform}} ({{window}}); {{aggregation}} aggregation.", {
      metric: metric.definition.providerMetric ?? metric.definition.key, platform: metric.definition.platform,
      window: labels.windows[metric.definition.windowKind],
      aggregation: labels.aggregations[metric.definition.aggregation],
    }))}</p>
    <p>{metric.definition.providerMetric ?? t("owned.unavailable", "Not available")} · {metric.definition.apiVersion}</p>
    <p>{t("owned.observedAt", "Observed at")}: {metric.observedAt ?? t("owned.unavailable", "Not available")}</p>
    <p>{t("owned.previous", "Previous period")}: <AnalyticsMetricValue metric={metric.previous} /></p>
  </details>;
}

export function SavedAnalyticsReport({ report }: { report: AnalyticsReport }) {
  const { t } = useTranslation("analytics");
  const labels = useAnalyticsLabels();
  const [sortByViews, setSortByViews] = useState(false);
  const posts = report.posts.items;
  const visible = report.metrics.filter((metric) => metric.definition.capability === "available" || ["reach", "views", "profile_views", "engagements", "followers", "follower_change"].includes(metric.definition.key));
  const viewCount = (post: AnalyticsReport["posts"]["items"][number]) => {
    const metric = post.metrics.find((metric) => metric.definition.key === "views")?.current;
    return metric?.status === "available" ? metric.value : -1;
  };
  const orderedPosts = sortByViews ? [...posts].sort((left, right) => viewCount(right) - viewCount(left)) : posts;
  const time = (instant: string | null) => instant ?? t("owned.unavailable", "Not available");
  return <div className="space-y-5">
    <div role="status" className="rounded-lg border p-4 space-y-1 text-sm" aria-live="polite">
      <p className="font-medium">{labels.sync[report.sync.status]}</p>
      {report.sync.reason && <p>{labels.reasons[report.sync.reason]}</p>}
      <p>{t("owned.updatedAt", "Last collection")}: {time(report.sync.collectedAt)}</p>
      <p>{t("owned.dataAsOf", "Data as of")}: {time(report.sync.asOf)}</p>
      {report.retryAt && <p>{t("owned.retryAt", "Retry after")}: {report.retryAt}</p>}
      {report.truncated && <p>{t("owned.truncated", "Collection is incomplete. Some posts are missing.")}</p>}
    </div>
    <p className="text-sm text-muted-foreground">{report.period.since} – {report.period.until} · {report.period.timezone}</p>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {visible.map((metric) => <article key={metric.definition.key} className="rounded-lg border bg-card p-4 space-y-2">
        <h3 className="font-medium">{labels.metrics[metric.definition.key]}</h3>
        <div className="text-lg tabular-nums"><AnalyticsMetricValue metric={metric.current} /></div>
        <p className="text-xs text-muted-foreground">{t("owned.comparison", "Compared with previous period")}: {metric.delta.status === "available"
          ? `${metric.delta.percentage!.toFixed(1)}% (${metric.delta.absolute! > 0 ? "+" : ""}${metric.delta.absolute})`
          : t("owned.unavailable", "Not available")}</p>
        <MetricDetails metric={metric} />
      </article>)}
    </div>
    {visible.filter((metric) => metric.trend.length > 0).map((metric) => <section key={metric.definition.key} className="rounded-lg border p-4 min-w-0">
      <h3>{labels.metrics[metric.definition.key]} · {t("owned.trend", "Daily trend")}</h3>
      <div className="h-48" role="img" aria-label={t("owned.trendDescription", "Missing days appear as gaps in the daily trend.")}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={metric.trend.map((day) => ({ date: day.date, value: day.metric.status === "available" ? day.metric.value : null }))}>
          <XAxis dataKey="date" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip />
          <Line dataKey="value" name={labels.metrics[metric.definition.key]} type="monotone" stroke="currentColor" connectNulls={false} />
        </LineChart></ResponsiveContainer>
      </div>
      <details><summary className="text-xs cursor-pointer">{t("owned.dailyValues", "Daily values")}</summary>
        <ul className="text-sm">{metric.trend.map((day) => <li key={day.date}>{day.date}: <AnalyticsMetricValue metric={day.metric} /></li>)}</ul>
      </details>
    </section>)}
    <section className="space-y-3">
      <h3 className="font-medium">{t("owned.posts", "Post performance")}</h3>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={sortByViews} onChange={(event) => setSortByViews(event.target.checked)} />{t("owned.topLoaded", "Rank loaded posts by lifetime views")}</label>
      {sortByViews && <p className="text-xs text-muted-foreground">{t("owned.rankingScope", "Ranking covers loaded posts only. Load more to include the rest; unavailable views are placed last.")}</p>}
      {report.posts.status !== "available" && <p role="status">{t("owned.postsIncomplete", "Post coverage is incomplete.")} {report.posts.reason && labels.reasons[report.posts.reason]}</p>}
      {posts.length === 0 && <p>{t("owned.noPosts", "No saved posts in this period.")}</p>}
      {orderedPosts.map((post) => <article key={post.id} className="rounded-lg border p-4 space-y-2">
        <p className="break-words whitespace-pre-wrap">{post.text || post.id}</p><p className="text-xs">{post.publishedAt}</p>
        {post.permalink && <a className="text-sm underline" href={post.permalink} target="_blank" rel="noopener noreferrer">{t("owned.openPost", "Open post")}</a>}
        <dl className="grid gap-2 sm:grid-cols-2">{post.metrics.filter((metric) => metric.definition.capability === "available").map((metric) => <div key={metric.definition.key}>
          <dt className="text-sm text-muted-foreground">{labels.metrics[metric.definition.key]}</dt>
          <dd><AnalyticsMetricValue metric={metric.current} /><MetricDetails metric={metric} /></dd>
        </div>)}</dl>
      </article>)}
    </section>
  </div>;
}
