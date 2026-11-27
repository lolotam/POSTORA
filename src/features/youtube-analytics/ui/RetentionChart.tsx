import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { AnalyticsNotice } from "./AnalyticsNotice";
import { LtrValue } from "./LtrValue";
import { EMPTY_ANALYTICS_VALUE } from "../domain/format";
import type {
  YouTubeAnalyticsRetentionData,
  YouTubeAnalyticsSuccess,
} from "../domain/types";

function percent(value: number | null): string {
  return value === null ? EMPTY_ANALYTICS_VALUE : `${Math.round(value * 100)}%`;
}

function RetentionValues({ data }: { data: YouTubeAnalyticsRetentionData }) {
  const { t } = useTranslation("analytics");
  return (
    <>
      <div
        className="h-56 min-w-0"
        role="img"
        aria-label={t("youtube.retention.description", "Share of the audience still watching at each point of the video.")}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.points.map((point) => ({
            elapsed: percent(point.ratio),
            watchRatio: point.watch_ratio === null ? null : Math.round(point.watch_ratio * 100),
          }))}>
            <XAxis dataKey="elapsed" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Line
              dataKey="watchRatio"
              name={t("youtube.retention.watchRatio", "Audience still watching")}
              type="monotone"
              stroke="currentColor"
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">{t("youtube.retention.tableValues", "Retention values")}</summary>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="text-start">{t("youtube.retention.elapsed", "Video played")}</th>
                <th scope="col" className="text-end">{t("youtube.retention.watchRatio", "Audience still watching")}</th>
                <th scope="col" className="text-end">{t("youtube.retention.relativePerformance", "Relative performance")}</th>
              </tr>
            </thead>
            <tbody>
              {data.points.map((point) => (
                <tr key={point.ratio}>
                  <td><LtrValue>{percent(point.ratio)}</LtrValue></td>
                  <td className="text-end tabular-nums"><LtrValue>{percent(point.watch_ratio)}</LtrValue></td>
                  <td className="text-end tabular-nums"><LtrValue>{percent(point.relative_performance)}</LtrValue></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/**
 * The audience-retention curve of one video.
 *
 * The section is collapsed until the viewer asks for it, because the retention
 * report costs an extra Analytics unit and a Data unit on top of the video's
 * summary and daily trend. The parent owns the expanded flag so the report is
 * requested exactly once per video.
 */
export function RetentionChart({ query, expanded, onExpandedChange }: {
  query: UseQueryResult<YouTubeAnalyticsSuccess<YouTubeAnalyticsRetentionData>, Error>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslation("analytics");
  const data = query.data?.data;

  return (
    <section aria-label={t("youtube.retention.title", "Audience retention")} className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{t("youtube.retention.title", "Audience retention")}</h3>
        <div className="no-print flex flex-wrap items-center gap-2">
          {expanded && data ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t("youtube.retention.refresh", "Refresh retention")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded
              ? t("youtube.retention.hide", "Hide audience retention")
              : t("youtube.retention.load", "Show audience retention")}
          </Button>
        </div>
      </div>
      {!expanded ? null : query.isError ? (
        <AnalyticsNotice error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>
      ) : !data.has_data || data.points.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">{t("youtube.empty", "YouTube has no numbers for this period yet.")}</p>
      ) : (
        <RetentionValues data={data} />
      )}
    </section>
  );
}
