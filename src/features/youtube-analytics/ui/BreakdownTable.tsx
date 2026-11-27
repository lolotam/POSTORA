import { useTranslation } from "react-i18next";
import { LtrValue } from "./LtrValue";
import { formatCount, formatMinutes } from "../domain/format";
import type {
  YouTubeAnalyticsBreakdownData,
  YouTubeAnalyticsBreakdownOperation,
  YouTubeAnalyticsBreakdownRow,
} from "../domain/types";
import { useYouTubeMetricLabels } from "./useYouTubeMetricLabels";

/**
 * Human-readable names for the three breakdown dimensions.
 */
export interface YouTubeBreakdownLabels {
  country(code: string): string;
  device(key: string): string;
  trafficSource(key: string): string;
}

function metricValue(row: YouTubeAnalyticsBreakdownRow, key: "views" | "watch_time"): number | null {
  const metric = row.metrics.find((candidate) => candidate.key === key);
  return metric ? metric.value : null;
}

function largestViews(rows: readonly YouTubeAnalyticsBreakdownRow[]): number {
  return rows.reduce((highest, row) => {
    const views = metricValue(row, "views") ?? 0;
    return views > highest ? views : highest;
  }, 0);
}

export function BreakdownTable({ data, operation, labels }: {
  data: YouTubeAnalyticsBreakdownData;
  operation: YouTubeAnalyticsBreakdownOperation;
  labels: YouTubeBreakdownLabels;
}) {
  const { t, i18n } = useTranslation("analytics");
  const metricLabels = useYouTubeMetricLabels();
  const locale = i18n.language;

  const titles: Record<YouTubeAnalyticsBreakdownOperation, string> = {
    traffic_sources: t("youtube.traffic.title", "Traffic sources"),
    geography: t("youtube.geography.title", "Where your viewers are"),
    devices: t("youtube.devices.title", "Devices your viewers use"),
  };
  const columnLabels: Record<YouTubeAnalyticsBreakdownOperation, string> = {
    traffic_sources: t("youtube.traffic.column", "Traffic source"),
    geography: t("youtube.geography.column", "Country"),
    devices: t("youtube.devices.column", "Device"),
  };

  const labelFor = (key: string): string => {
    if (data.dimension === "country") return labels.country(key);
    if (data.dimension === "device") return labels.device(key);
    return labels.trafficSource(key);
  };

  const maxViews = largestViews(data.rows);

  return (
    <section aria-label={titles[operation]} className="space-y-3 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">{titles[operation]}</h2>
      {!data.has_data || data.rows.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">{t("youtube.empty", "YouTube has no numbers for this period yet.")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="text-start">{columnLabels[operation]}</th>
                <th scope="col" className="text-end">{metricLabels.views}</th>
                <th scope="col" className="text-end">{metricLabels.watch_time}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const views = metricValue(row, "views");
                const watchTime = metricValue(row, "watch_time");
                const share = maxViews > 0 && views !== null ? Math.round((views / maxViews) * 100) : 0;
                return (
                  <tr key={row.key}>
                    <th scope="row" className="text-start font-normal">
                      <span>{labelFor(row.key)}</span>
                      <span aria-hidden className="mt-1 block h-1 w-full max-w-40 rounded bg-muted">
                        <span className="block h-1 rounded bg-primary" style={{ width: `${share}%` }} />
                      </span>
                    </th>
                    <td className="text-end tabular-nums"><LtrValue>{formatCount(views, locale)}</LtrValue></td>
                    <td className="text-end tabular-nums"><LtrValue>{formatMinutes(watchTime, locale)}</LtrValue></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
