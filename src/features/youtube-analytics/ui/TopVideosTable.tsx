import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ViewModeToggle, type DataViewMode } from "@/components/data-view/ViewModeToggle";
import { GridColumnControls } from "@/components/data-view/GridColumnControls";
import { GRID_COLUMN_CLASSES, type GridColumns } from "@/components/data-view/gridColumns";
import { SortableColumnHeader } from "@/components/data-view/SortableColumnHeader";
import type { DataViewSortDirection } from "@/components/data-view/sortRows";
import { useStoredChoice } from "@/components/data-view/useStoredChoice";
import type { YouTubeTopVideosInfiniteData } from "../application/useYouTubeTopVideos";
import { formatMetric } from "../domain/format";
import {
  mergeTopVideoPages,
  sortTopVideoRows,
  TOP_VIDEO_COLUMNS,
  type TopVideosColumn,
} from "../domain/topVideosView";
import type { YouTubeAnalyticsMetricKey } from "../domain/types";
import { AnalyticsNotice } from "./AnalyticsNotice";
import { LtrValue } from "./LtrValue";
import { TopVideosGrid } from "./TopVideosGrid";
import { TopVideoThumbnail } from "./TopVideoThumbnail";
import { useYouTubeMetricLabels } from "./useYouTubeMetricLabels";

const METRICS: YouTubeAnalyticsMetricKey[] = ["views", "watch_time", "likes", "subscribers_gained"];

export function TopVideosTable({ data, onInspect, hasNextPage, isFetchingNextPage, onLoadMore, nextPageError, onRetryNextPage }: {
  data: YouTubeTopVideosInfiniteData;
  onInspect: (videoId: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  nextPageError?: unknown;
  onRetryNextPage: () => void;
}) {
  const { t, i18n } = useTranslation("analytics");
  const labels = useYouTubeMetricLabels();
  const [viewMode, setViewMode] = useStoredChoice<DataViewMode>("ytAnalyticsTopVideosView", ["grid", "table"], "table");
  const [gridColumns, setGridColumns] = useStoredChoice<GridColumns>("ytAnalyticsTopVideosGridColumns", [4, 5, 6], 5);
  const [sortColumn, setSortColumn] = useState<TopVideosColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<DataViewSortDirection>("descending");
  const rows = useMemo(() => mergeTopVideoPages(data.pages), [data.pages]);
  const sortedRows = useMemo(() => {
    if (!sortColumn) return rows;
    return sortTopVideoRows(rows, sortColumn, sortDirection, new Intl.Collator(i18n.language, { numeric: true, sensitivity: "base" }));
  }, [i18n.language, rows, sortColumn, sortDirection]);
  const columnLabels: Record<TopVideosColumn, string> = {
    video: t("youtube.video", "Video"),
    published_at: t("youtube.datePublished", "Date published"),
    views: labels.views,
    watch_time: labels.watch_time,
    likes: labels.likes,
    subscribers_gained: labels.subscribers_gained,
  };
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const formatDate = (value: string | null) => {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
  };
  const selectSort = (column: TopVideosColumn) => {
    const definition = TOP_VIDEO_COLUMNS.find((item) => item.id === column)!;
    setSortColumn(column);
    setSortDirection(definition.defaultDirection);
  };

  return (
    <section aria-label={t("youtube.topVideos", "Most viewed videos")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("youtube.topVideos", "Most viewed videos")}</h2>
        <div className="no-print flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {t("youtube.loadedCount", "{{count}} loaded", { count: rows.length })}
          </span>
          {viewMode === "grid" ? <GridColumnControls value={gridColumns} onChange={setGridColumns} perRowLabel={(count) => t("youtube.perRow", "{{count}} per row", { count })} /> : null}
          <ViewModeToggle
            value={viewMode}
            onChange={setViewMode}
            labels={{
              viewMode: t("youtube.viewMode", "View mode"),
              grid: t("youtube.viewGrid", "Grid view"),
              table: t("youtube.viewTable", "Table view"),
            }}
          />
        </div>
      </div>

      {viewMode === "grid" ? (
        <div className="no-print flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="top-videos-sort">{t("youtube.sortBy", "Sort by")}</label>
          <select
            id="top-videos-sort"
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={sortColumn ?? "views"}
            onChange={(event) => selectSort(event.target.value as TopVideosColumn)}
          >
            {TOP_VIDEO_COLUMNS.map((column) => <option key={column.id} value={column.id}>{columnLabels[column.id]}</option>)}
          </select>
          <Button
            size="sm"
            variant="outline"
            aria-label={sortDirection === "ascending" ? t("youtube.sortAscending", "Sort ascending") : t("youtube.sortDescending", "Sort descending")}
            onClick={() => {
              if (!sortColumn) selectSort("views");
              setSortDirection((current) => current === "ascending" ? "descending" : "ascending");
            }}
          >
            {sortDirection === "ascending" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
          </Button>
        </div>
      ) : null}

      {sortedRows.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t("youtube.empty", "YouTube has no numbers for this period yet.")}</p> : viewMode === "grid" ? (
        <TopVideosGrid rows={sortedRows} columnsClass={GRID_COLUMN_CLASSES[gridColumns]} onInspect={onInspect} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="w-12 p-3 text-start">{t("youtube.rank", "#")}</th>
              {TOP_VIDEO_COLUMNS.map((column) => (
                <SortableColumnHeader
                  key={column.id}
                  label={columnLabels[column.id]}
                  direction={sortColumn === column.id ? sortDirection : null}
                  defaultDirection={column.defaultDirection}
                  onSort={(direction) => {
                    setSortColumn(column.id);
                    setSortDirection(direction);
                  }}
                />
              ))}
              <th className="no-print p-3 text-start">{t("youtube.actions", "Actions")}</th>
            </tr></thead>
            <tbody>{sortedRows.map((row, index) => <tr key={row.video_id} className="border-t">
              <td className="p-3 tabular-nums">{index + 1}</td>
              <td className="p-3">
                <button type="button" className="flex min-w-56 items-center gap-3 text-start hover:text-primary" onClick={() => onInspect(row.video_id)}>
                  <TopVideoThumbnail url={row.thumbnail_url} className="w-24 shrink-0" />
                  <span className="line-clamp-2 font-medium">{row.title ?? t("youtube.videoUnavailable", "Video unavailable")}</span>
                </button>
              </td>
              <td className="p-3 whitespace-nowrap">{formatDate(row.published_at)}</td>
              {METRICS.map((key) => <td key={key} className="p-3 tabular-nums"><LtrValue>{formatMetric(row.metrics.find((metric) => metric.key === key), i18n.language)}</LtrValue></td>)}
              <td className="no-print p-3"><div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => onInspect(row.video_id)}>{t("youtube.inspect", "Inspect")}</Button>
                <a className="inline-flex h-9 items-center rounded-md px-2 text-primary underline" href={row.link} target="_blank" rel="noopener noreferrer">{t("youtube.open", "Open")}</a>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}

      {nextPageError ? <AnalyticsNotice error={nextPageError} onRetry={onRetryNextPage} /> : null}
      {hasNextPage ? (
        <Button type="button" variant="outline" className="no-print" disabled={isFetchingNextPage} onClick={onLoadMore}>
          {isFetchingNextPage ? t("youtube.loadingMore", "Loading more…") : t("youtube.loadMore", "Load more")}
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("youtube.videoSubscriberNote", "For one video, YouTube counts only subscriptions from that video's watch page.")}</p>
    </section>
  );
}
