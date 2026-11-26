import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ViewModeToggle, type DataViewMode } from "@/components/data-view/ViewModeToggle";
import { GridColumnControls } from "@/components/data-view/GridColumnControls";
import type { GridColumns } from "@/components/data-view/gridColumns";
import type { DataViewSortDirection } from "@/components/data-view/sortRows";
import { LIBRARY_VIDEO_COLUMNS, type LibraryVideoColumn, type LibraryVideoFilter } from "../domain/videoLibraryView";

export function YouTubeVideoLibraryToolbar({ viewMode, gridColumns, filter, query, loadedCount, sortColumn, sortDirection, onViewMode, onGridColumns, onFilter, onQuery, onSortColumn, onToggleDirection }: {
  viewMode: DataViewMode;
  gridColumns: GridColumns;
  filter: LibraryVideoFilter;
  query: string;
  loadedCount: number;
  sortColumn: LibraryVideoColumn | null;
  sortDirection: DataViewSortDirection;
  onViewMode: (value: DataViewMode) => void;
  onGridColumns: (value: GridColumns) => void;
  onFilter: (value: LibraryVideoFilter) => void;
  onQuery: (value: string) => void;
  onSortColumn: (value: LibraryVideoColumn | null) => void;
  onToggleDirection: () => void;
}) {
  const { t } = useTranslation("accounts");
  const columnLabels: Record<LibraryVideoColumn, string> = {
    video: t("youtubeManagement.library.colVideo", "Video"),
    visibility: t("youtubeManagement.library.colVisibility", "Visibility"),
    published_at: t("youtubeManagement.library.colPublished", "Date published"),
    duration: t("youtubeManagement.library.colDuration", "Duration"),
    views: t("youtubeManagement.library.colViews", "Views"),
    likes: t("youtubeManagement.library.colLikes", "Likes"),
    comments: t("youtubeManagement.library.colComments", "Comments"),
  };
  const filterLabels: Record<LibraryVideoFilter, string> = {
    all: t("youtubeManagement.library.filterAll", "All"),
    videos: t("youtubeManagement.library.filterVideos", "Videos"),
    shorts: t("youtubeManagement.library.filterShorts", "Shorts"),
  };
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {t("youtubeManagement.library.loadedCount", "{{count}} loaded", { count: loadedCount })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {viewMode === "grid" ? <GridColumnControls value={gridColumns} onChange={onGridColumns} perRowLabel={(count) => t("youtubeManagement.library.perRow", "{{count}} per row", { count })} /> : null}
          <ViewModeToggle
            value={viewMode}
            onChange={onViewMode}
            labels={{
              viewMode: t("youtubeManagement.library.viewMode", "View mode"),
              grid: t("youtubeManagement.library.viewGrid", "Grid view"),
              table: t("youtubeManagement.library.viewTable", "Table view"),
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5">
          {(["all", "videos", "shorts"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              title={value === "shorts" ? t("youtubeManagement.library.shortsHint", "Shorts are detected from #short or #shorts in the title or description.") : undefined}
              onClick={() => onFilter(value)}
            >
              {filterLabels[value]}
            </Button>
          ))}
        </div>
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            className="ps-9"
            aria-label={t("youtubeManagement.library.searchLabel", "Search uploads")}
            placeholder={t("youtubeManagement.library.searchPlaceholder", "Search title, description or video ID")}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </div>
      {viewMode === "grid" ? (
        <div className="flex items-center gap-2">
          <label htmlFor="library-sort" className="text-sm text-muted-foreground">{t("youtubeManagement.library.sortBy", "Sort by")}</label>
          <select
            id="library-sort"
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={sortColumn ?? ""}
            onChange={(event) => onSortColumn(event.target.value ? (event.target.value as LibraryVideoColumn) : null)}
          >
            <option value="">{t("youtubeManagement.library.sortDefault", "Upload order")}</option>
            {LIBRARY_VIDEO_COLUMNS.map((column) => <option key={column.id} value={column.id}>{columnLabels[column.id]}</option>)}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={sortColumn === null}
            aria-label={sortDirection === "ascending"
              ? t("youtubeManagement.library.sortAscending", "Sort ascending")
              : t("youtubeManagement.library.sortDescending", "Sort descending")}
            onClick={onToggleDirection}
          >
            {sortDirection === "ascending" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
