import { sortRows, type DataViewSortDirection } from "@/components/data-view/sortRows";
import type {
  YouTubeAnalyticsMetricKey,
  YouTubeAnalyticsSuccess,
  YouTubeAnalyticsTopVideoRow,
  YouTubeAnalyticsTopVideosData,
} from "./types";

export type TopVideosColumn = "video" | "published_at" | "views" | "watch_time" | "likes" | "subscribers_gained";

export const TOP_VIDEO_COLUMNS: ReadonlyArray<{
  id: TopVideosColumn;
  defaultDirection: DataViewSortDirection;
}> = [
  { id: "video", defaultDirection: "ascending" },
  { id: "published_at", defaultDirection: "descending" },
  { id: "views", defaultDirection: "descending" },
  { id: "watch_time", defaultDirection: "descending" },
  { id: "likes", defaultDirection: "descending" },
  { id: "subscribers_gained", defaultDirection: "descending" },
];

export function mergeTopVideoPages(
  pages: readonly YouTubeAnalyticsSuccess<YouTubeAnalyticsTopVideosData>[],
): YouTubeAnalyticsTopVideoRow[] {
  const seen = new Set<string>();
  const rows: YouTubeAnalyticsTopVideoRow[] = [];
  for (const page of pages) {
    for (const row of page.data.rows) {
      if (seen.has(row.video_id)) continue;
      seen.add(row.video_id);
      rows.push(row);
    }
  }
  return rows;
}

function metric(row: YouTubeAnalyticsTopVideoRow, key: YouTubeAnalyticsMetricKey): number | null {
  return row.metrics.find((item) => item.key === key)?.value ?? null;
}

export function sortTopVideoRows(
  rows: readonly YouTubeAnalyticsTopVideoRow[],
  column: TopVideosColumn,
  direction: DataViewSortDirection,
  collator?: Intl.Collator,
): YouTubeAnalyticsTopVideoRow[] {
  return sortRows(rows, (row) => {
    if (column === "video") return row.title;
    if (column === "published_at") return row.published_at === null ? null : Date.parse(row.published_at);
    return metric(row, column);
  }, direction, collator);
}
