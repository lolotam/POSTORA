import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DataViewMode } from "@/components/data-view/ViewModeToggle";
import { GRID_COLUMN_CLASSES, type GridColumns } from "@/components/data-view/gridColumns";
import type { DataViewSortDirection } from "@/components/data-view/sortRows";
import { useStoredChoice } from "@/components/data-view/useStoredChoice";
import type { YouTubeVideoListItem } from "../domain/types";
import {
  filterLibraryVideos,
  LIBRARY_VIDEO_COLUMNS,
  sortLibraryVideos,
  type LibraryVideoColumn,
  type LibraryVideoFilter,
} from "../domain/videoLibraryView";
import { YouTubeVideoLibraryGrid } from "./YouTubeVideoLibraryGrid";
import { YouTubeVideoLibraryTable } from "./YouTubeVideoLibraryTable";
import { YouTubeVideoLibraryToolbar } from "./YouTubeVideoLibraryToolbar";

export interface YouTubeVideoLibraryProps {
  videos: readonly YouTubeVideoListItem[];
  selectedVideoId: string | null;
  onSelect: (videoId: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

export function YouTubeVideoLibrary(props: YouTubeVideoLibraryProps): JSX.Element {
  const { videos, selectedVideoId, onSelect, hasMore, isLoadingMore, onLoadMore } = props;
  const { t, i18n } = useTranslation("accounts");
  const [viewMode, setViewMode] = useStoredChoice<DataViewMode>("ytManagementLibraryView", ["grid", "table"], "table");
  const [gridColumns, setGridColumns] = useStoredChoice<GridColumns>("ytManagementLibraryGridColumns", [4, 5, 6], 5);
  const [filter, setFilter] = useState<LibraryVideoFilter>("all");
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<LibraryVideoColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<DataViewSortDirection>("descending");
  const visibilityLabels = useMemo<Record<string, string>>(() => ({
    public: t("youtubeManagement.library.visibilityPublic", "Public"),
    unlisted: t("youtubeManagement.library.visibilityUnlisted", "Unlisted"),
    private: t("youtubeManagement.library.visibilityPrivate", "Private"),
  }), [t]);
  const filtered = useMemo(() => filterLibraryVideos(videos, filter, query), [videos, filter, query]);
  const visibleVideos = useMemo(() => {
    if (!sortColumn) return filtered;
    return sortLibraryVideos(
      filtered,
      sortColumn,
      sortDirection,
      {
        visibilityLabels,
        collator: new Intl.Collator(i18n.language, { numeric: true, sensitivity: "base" }),
      },
    );
  }, [filtered, i18n.language, sortColumn, sortDirection, visibilityLabels]);
  const selectSortColumn = (column: LibraryVideoColumn | null) => {
    setSortColumn(column);
    if (column) {
      setSortDirection(LIBRARY_VIDEO_COLUMNS.find((item) => item.id === column)?.defaultDirection ?? "descending");
    }
  };
  const resetFilters = () => {
    setFilter("all");
    setQuery("");
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">{t("youtubeManagement.library.title", "Uploaded videos")}</h3>
      <YouTubeVideoLibraryToolbar
        viewMode={viewMode}
        gridColumns={gridColumns}
        filter={filter}
        query={query}
        loadedCount={videos.length}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onViewMode={setViewMode}
        onGridColumns={setGridColumns}
        onFilter={setFilter}
        onQuery={setQuery}
        onSortColumn={selectSortColumn}
        onToggleDirection={() => {
          if (!sortColumn) {
            selectSortColumn("views");
            return;
          }
          setSortDirection((current) => current === "ascending" ? "descending" : "ascending");
        }}
      />

      {videos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {hasMore
            ? t("youtubeManagement.library.moreAvailable", "More results are available, load the next page")
            : t("youtubeManagement.library.empty", "This channel has no uploaded videos yet.")}
        </p>
      ) : visibleVideos.length === 0 ? (
        <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">{t("youtubeManagement.library.noMatch", "No uploads match these filters")}</p>
          <Button size="sm" variant="outline" onClick={resetFilters}>{t("youtubeManagement.library.resetFilters", "Reset filters")}</Button>
        </div>
      ) : viewMode === "grid" ? (
        <YouTubeVideoLibraryGrid
          videos={visibleVideos}
          columnsClass={GRID_COLUMN_CLASSES[gridColumns]}
          selectedVideoId={selectedVideoId}
          visibilityLabels={visibilityLabels}
          onSelect={onSelect}
        />
      ) : (
        <YouTubeVideoLibraryTable
          videos={visibleVideos}
          selectedVideoId={selectedVideoId}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          visibilityLabels={visibilityLabels}
          onSort={(column, direction) => {
            setSortColumn(column);
            setSortDirection(direction);
          }}
          onSelect={onSelect}
        />
      )}

      {hasMore ? (
        <Button size="sm" variant="outline" disabled={isLoadingMore} onClick={onLoadMore}>
          {t("youtubeManagement.library.loadMore", "Load more")}
        </Button>
      ) : null}
    </div>
  );
}
