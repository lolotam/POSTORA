import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { computeRecentVideoAverages } from "../domain/benchmark";
import type { YouTubeBenchmarkErrorCode } from "../domain/types";
import type { YouTubeBenchmarkColumn } from "../application/useYouTubeChannelBenchmark";

export interface YouTubeBenchmarkColumnCardProps {
  column: YouTubeBenchmarkColumn;
  onRetry: () => void;
}

const EMPTY_VALUE = "—";

/**
 * The sentence of one benchmark failure.
 *
 * The three channel-level codes are deliberately distinct. "No channel found"
 * is NEVER one of them: it is the answer for a channel the provider says does
 * not exist, and using it for a quota or an outage would tell the creator
 * that a real competitor is gone.
 */
function benchmarkFailureMessage(code: YouTubeBenchmarkErrorCode, t: TFunction): string {
  switch (code) {
    case "quota_exceeded":
      return t(
        "youtubeBenchmark.quotaExceeded",
        "YouTube benchmark quota limit reached. Try again after the daily reset.",
      );
    case "reconnect_required":
    case "missing_scope":
      return t(
        "youtubeBenchmark.reconnectRequired",
        "Reconnect this YouTube channel to compare public channels.",
      );
    case "rate_limited":
      return t(
        "youtubeBenchmark.rateLimited",
        "Too many comparison requests. Try again in a few minutes.",
      );
    case "not_found":
      return t(
        "youtubeBenchmark.connectionNotFound",
        "Postora could not find the connected YouTube channel for this comparison.",
      );
    default:
      return t(
        "youtubeBenchmark.upstreamUnavailable",
        "YouTube public channel data is temporarily unavailable.",
      );
  }
}

function formatCount(value: number | null, locale: string): string {
  return value === null ? EMPTY_VALUE : new Intl.NumberFormat(locale).format(value);
}

function formatTimestamp(value: string | null, locale: string): string {
  if (value === null) return EMPTY_VALUE;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

/**
 * One channel of the comparison.
 *
 * Each column carries its own state: a channel that was read, a channel the
 * provider does not have, and a channel that could not be read are three
 * different answers and are never merged into one.
 */
export function YouTubeBenchmarkColumnCard(props: YouTubeBenchmarkColumnCardProps): JSX.Element {
  const { column, onRetry } = props;
  const { t, i18n } = useTranslation("accounts");
  const locale = i18n.language.startsWith("ar") ? "ar" : "en";

  const channel = column.channel;
  const averages = channel ? computeRecentVideoAverages(channel.recent_videos) : null;

  const retryButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={onRetry}
      aria-label={t("youtubeBenchmark.retryLabel", "Retry {{input}}", { input: column.input })}
    >
      {t("youtubeBenchmark.retry", "Retry")}
    </Button>
  );

  return (
    <article
      className="space-y-3 rounded-lg border p-4"
      data-testid={`benchmark-column-${column.input}`}
      aria-label={column.input}
    >
      <header className="flex items-start gap-3">
        {channel?.thumbnail_url ? (
          <img
            src={channel.thumbnail_url}
            alt=""
            loading="lazy"
            className="h-12 w-12 shrink-0 rounded-full object-cover"
          />
        ) : null}
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">
            {channel?.title ?? column.input}
          </h3>
          <p className="text-sm text-muted-foreground">{column.input}</p>
        </div>
      </header>

      {column.state === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("youtubeBenchmark.loading", "Loading…")}
        </p>
      ) : null}

      {column.state === "failed" && column.error ? (
        <Alert role="alert">
          <AlertDescription className="space-y-2">
            <p>{benchmarkFailureMessage(column.error.code, t)}</p>
            {retryButton}
          </AlertDescription>
        </Alert>
      ) : null}

      {channel && channel.status === "not_found" ? (
        <p className="text-sm" data-testid="benchmark-not-found">
          {t("youtubeBenchmark.notFound", "No channel found for this handle or channel ID.")}
        </p>
      ) : null}

      {channel && channel.status === "unavailable" ? (
        <Alert role="alert">
          <AlertDescription className="space-y-2">
            <p>{benchmarkFailureMessage(channel.error ?? "upstream_unavailable", t)}</p>
            {retryButton}
          </AlertDescription>
        </Alert>
      ) : null}

      {channel && channel.status === "found" ? (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("youtubeBenchmark.subscribers", "Subscribers")}</dt>
            <dd className="text-end font-medium">
              {channel.subscriber_count_hidden
                ? t("youtubeBenchmark.subscribersHidden", "Hidden by channel owner")
                : formatCount(channel.subscriber_count, locale)}
            </dd>
            <dt className="text-muted-foreground">{t("youtubeBenchmark.totalViews", "Total views")}</dt>
            <dd className="text-end font-medium">{formatCount(channel.view_count, locale)}</dd>
            <dt className="text-muted-foreground">{t("youtubeBenchmark.totalVideos", "Total videos")}</dt>
            <dd className="text-end font-medium">{formatCount(channel.video_count, locale)}</dd>
          </dl>

          {channel.error ? (
            <Alert role="alert">
              <AlertDescription className="space-y-2">
                <p>{benchmarkFailureMessage(channel.error, t)}</p>
                {retryButton}
              </AlertDescription>
            </Alert>
          ) : null}

          {averages ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-3 text-sm">
              <dt className="text-muted-foreground">
                {t("youtubeBenchmark.averageViews", "Average views (last {{count}} videos)", {
                  count: averages.sampleCount,
                })}
              </dt>
              <dd className="text-end font-medium">{formatCount(averages.averageViews, locale)}</dd>
              <dt className="text-muted-foreground">{t("youtubeBenchmark.averageLikes", "Average likes")}</dt>
              <dd className="text-end font-medium">{formatCount(averages.averageLikes, locale)}</dd>
              <dt className="text-muted-foreground">
                {t("youtubeBenchmark.averageComments", "Average comments")}
              </dt>
              <dd className="text-end font-medium">{formatCount(averages.averageComments, locale)}</dd>
            </dl>
          ) : null}

          <div className="border-t pt-3">
            <h4 className="mb-2 text-sm font-medium">
              {t("youtubeBenchmark.recentVideos", "Recent videos")}
            </h4>
            {channel.recent_videos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("youtubeBenchmark.noRecentVideos", "No recent public videos were returned.")}
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {channel.recent_videos.map((video) => (
                  <li key={video.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">{video.title}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatCount(video.view_count, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}
