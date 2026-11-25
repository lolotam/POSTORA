import { type KeyboardEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Eye,
  Globe,
  Grid3X3,
  LayoutList,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  RefreshCw,
  Search,
  Youtube,
} from "lucide-react";
import type { useYouTubeStage4 } from "../application/useYouTubeStage4";
import {
  formatCompactCount,
  formatExactCount,
  formatVideoDuration,
  validPublishDate,
} from "../domain/formatVideoMeta";
import type { Stage4VideoVisibility } from "../domain/types";

type Stage4Controller = ReturnType<typeof useYouTubeStage4>;
type Stage4Video = Stage4Controller["videos"]["items"][number];
type VideoFilter = "all" | "videos" | "shorts";
type ViewMode = "grid" | "table";
type GridColumns = 4 | 5 | 6;

const GRID_COLUMN_CLASSES: Record<GridColumns, string> = {
  4: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  5: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
  6: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6",
};
const TABLE_COLUMNS = "md:grid-cols-[minmax(0,1fr)_120px_150px_90px_110px]";

function isShorts(video: Stage4Video): boolean {
  if (typeof video.is_short === "boolean") return video.is_short;
  return /#shorts?\b/i.test(`${video.title}\n${video.description ?? ""}`);
}

function safeThumbnailUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https:\/\//i.test(trimmed) ? trimmed : null;
}

function readInitialGridColumns(): GridColumns {
  try {
    const stored = localStorage.getItem("ytStage4VideoGridColumns");
    if (stored === "4") return 4;
    if (stored === "5") return 5;
    if (stored === "6") return 6;
  } catch {
    return 5;
  }
  return 5;
}

function VisibilityIcon({ visibility, className = "h-3.5 w-3.5" }: {
  visibility: Stage4VideoVisibility | null | undefined;
  className?: string;
}): JSX.Element | null {
  if (visibility === "public") return <Globe className={className} aria-hidden="true" />;
  if (visibility === "unlisted") return <Link2 className={className} aria-hidden="true" />;
  if (visibility === "private") return <Lock className={className} aria-hidden="true" />;
  return null;
}

function VisibilityLabel({ visibility }: {
  visibility: Stage4VideoVisibility | null | undefined;
}): JSX.Element {
  const { t } = useTranslation("automation");
  if (visibility === "public") return <>{t("youtubeStage4.picker.visibilityPublic", "Public")}</>;
  if (visibility === "unlisted") return <>{t("youtubeStage4.picker.visibilityUnlisted", "Unlisted")}</>;
  if (visibility === "private") return <>{t("youtubeStage4.picker.visibilityPrivate", "Private")}</>;
  return <>{"\u2014"}</>;
}

function DateKindLabel({ video, publishDate }: {
  video: Stage4Video;
  publishDate: Date | null;
}): JSX.Element {
  const { t } = useTranslation("automation");
  const dateKind = video.date_kind ?? (publishDate ? "published" : "uploaded");
  if (dateKind === "premiered") return <>{t("youtubeStage4.picker.datePremiered", "Premiered")}</>;
  if (dateKind === "published") return <>{t("youtubeStage4.picker.datePublished", "Published")}</>;
  return <>{t("youtubeStage4.picker.dateUnset", "Uploaded")}</>;
}

function VideoOptionDescription({ id, video, exactCounts = false }: {
  id: string;
  video: Stage4Video;
  exactCounts?: boolean;
}): JSX.Element {
  const { t, i18n } = useTranslation("automation");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const publishDate = validPublishDate(video.published_at);
  const dateText = publishDate ? publishDate.toLocaleDateString(locale) : "\u2014";
  const dateKind = video.date_kind ?? (publishDate ? "published" : "uploaded");
  const dateKindText = dateKind === "premiered"
    ? t("youtubeStage4.picker.datePremiered", "Premiered")
    : dateKind === "published"
      ? t("youtubeStage4.picker.datePublished", "Published")
      : t("youtubeStage4.picker.dateUnset", "Uploaded");
  const visibilityText = video.visibility === "public"
    ? t("youtubeStage4.picker.visibilityPublic", "Public")
    : video.visibility === "unlisted"
      ? t("youtubeStage4.picker.visibilityUnlisted", "Unlisted")
      : video.visibility === "private"
        ? t("youtubeStage4.picker.visibilityPrivate", "Private")
        : "\u2014";
  const durationLabel = formatVideoDuration(video.duration_iso);
  const formatCountValue = exactCounts ? formatExactCount : formatCompactCount;
  const viewsText = formatCountValue(video.view_count, locale);
  const commentsText = formatCountValue(video.comment_count, locale);
  return (
    <span id={id} className="sr-only">
      {`${t("youtubeStage4.picker.colVisibility", "Visibility")}: ${visibilityText} \u00b7 ${dateKindText}: ${dateText}${durationLabel ? ` \u00b7 ${durationLabel}` : ""} \u00b7 ${t("youtubeStage4.picker.colViews", "Views")}: ${viewsText} \u00b7 ${t("youtubeStage4.picker.colComments", "Comments")}: ${commentsText}`}
    </span>
  );
}

function VideoDate({ video, withVisibility = false, className = "" }: {
  video: Stage4Video;
  withVisibility?: boolean;
  className?: string;
}): JSX.Element {
  const { i18n } = useTranslation("automation");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const publishDate = validPublishDate(video.published_at);
  return (
    <span className={`text-xs text-muted-foreground ${className}`}>
      <span className="flex items-center gap-1.5 text-foreground">
        {withVisibility && <VisibilityIcon visibility={video.visibility} />}
        {publishDate ? <time dateTime={publishDate.toISOString()}>{publishDate.toLocaleDateString(locale)}</time> : "\u2014"}
      </span>
      <span className="mt-0.5 block">
        <DateKindLabel video={video} publishDate={publishDate} />
      </span>
    </span>
  );
}

export function Stage4VideoThumbnail({ video, className = "h-14 w-24", durationLabel = null }: {
  video: Stage4Video;
  className?: string;
  durationLabel?: string | null;
}): JSX.Element {
  const { t } = useTranslation("automation");
  const thumbUrl = safeThumbnailUrl(video.thumbnail_url);
  return (
    <span className={`relative ${className} shrink-0 overflow-hidden rounded-md border bg-muted flex items-center justify-center`}>
      {thumbUrl ? (
        <img src={thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Youtube className="h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
      )}
      {isShorts(video) && (
        <span className="absolute top-1.5 start-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {t("youtubeStage4.picker.typeShorts", "Shorts")}
        </span>
      )}
      {durationLabel && (
        <span className="absolute bottom-1.5 end-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
          {durationLabel}
        </span>
      )}
    </span>
  );
}

function PickerHeader({ stage4, viewMode, onViewMode }: {
  stage4: Stage4Controller;
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t("youtubeStage4.picker.title", "Your uploads")}</h2>
        <Badge variant="secondary" className="rounded-full px-2 py-0 text-[11px] font-normal">
          {t("youtubeStage4.picker.loadedCount", "{{count}} loaded", { count: stage4.videos.items.length })}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {viewMode === "grid" && (
          <Button size="sm" variant="ghost" data-testid="yt-stage4-view-all" onClick={() => onViewMode("table")}>
            {t("youtubeStage4.picker.viewAll", "View all")}
          </Button>
        )}
        <div className="flex rounded-md border p-0.5" aria-label={t("youtubeStage4.picker.viewMode", "View mode")}>
          <Button
            size="sm"
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            data-testid="yt-stage4-view-grid"
            aria-label={t("youtubeStage4.picker.viewGrid", "Grid view")}
            aria-pressed={viewMode === "grid"}
            onClick={() => onViewMode("grid")}
          >
            <Grid3X3 className="h-4 w-4 me-1.5" aria-hidden="true" />
            {t("youtubeStage4.picker.viewGrid", "Grid view")}
          </Button>
          <Button
            size="sm"
            variant={viewMode === "table" ? "secondary" : "ghost"}
            data-testid="yt-stage4-view-table"
            aria-label={t("youtubeStage4.picker.viewTable", "Table view")}
            aria-pressed={viewMode === "table"}
            onClick={() => onViewMode("table")}
          >
            <LayoutList className="h-4 w-4 me-1.5" aria-hidden="true" />
            {t("youtubeStage4.picker.viewTable", "Table view")}
          </Button>
        </div>
        <Button size="sm" variant="outline" onClick={stage4.videos.reload} disabled={stage4.videos.loading}>
          {stage4.videos.loading ? <Loader2 className="h-4 w-4 animate-spin me-1.5" /> : <RefreshCw className="h-4 w-4 me-1.5" />}
          {t("common:refresh", "Refresh")}
        </Button>
      </div>
    </div>
  );
}

function FilterButton({ filter, activeFilter, onSelect }: {
  filter: VideoFilter;
  activeFilter: VideoFilter;
  onSelect: (filter: VideoFilter) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  const labels: Record<VideoFilter, string> = {
    all: t("youtubeStage4.picker.filterAll", "All"),
    videos: t("youtubeStage4.picker.filterVideos", "Videos"),
    shorts: t("youtubeStage4.picker.filterShorts", "Shorts"),
  };
  return (
    <button
      type="button"
      aria-pressed={activeFilter === filter}
      data-testid={`yt-stage4-video-filter-${filter}`}
      onClick={() => onSelect(filter)}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        activeFilter === filter
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {labels[filter]}
    </button>
  );
}

function GridColumnControls({ gridColumns, onColumns }: {
  gridColumns: GridColumns;
  onColumns: (columns: GridColumns) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5">
      {([4, 5, 6] as const).map((columns) => (
        <button
          key={columns}
          type="button"
          data-testid={`yt-stage4-grid-cols-${columns}`}
          aria-label={t("youtubeStage4.picker.perRow", "{{count}} per row", { count: columns })}
          aria-pressed={gridColumns === columns}
          onClick={() => onColumns(columns)}
          className={`rounded px-2 py-1 text-xs font-medium tabular-nums ${
            gridColumns === columns ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {columns}
        </button>
      ))}
    </div>
  );
}

function PickerFilters({ filter, query, viewMode, gridColumns, onFilter, onQuery, onColumns }: {
  filter: VideoFilter;
  query: string;
  viewMode: ViewMode;
  gridColumns: GridColumns;
  onFilter: (filter: VideoFilter) => void;
  onQuery: (query: string) => void;
  onColumns: (columns: GridColumns) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="flex flex-col gap-3 border-y bg-muted/20 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "videos", "shorts"] as const).map((videoFilter) => (
            <FilterButton key={videoFilter} filter={videoFilter} activeFilter={filter} onSelect={onFilter} />
          ))}
        </div>
        {viewMode === "grid" && <GridColumnControls gridColumns={gridColumns} onColumns={onColumns} />}
      </div>
      <div className="relative w-full sm:max-w-xs">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          data-testid="yt-stage4-video-search"
          placeholder={t("youtubeStage4.picker.filterPlaceholder", "Filter videos...")}
          aria-label={t("youtubeStage4.picker.filterAria", "Filter videos")}
          className="h-9 bg-background ps-9 text-sm"
        />
      </div>
    </div>
  );
}

function PickerColumns(): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div
      data-testid="yt-stage4-table-columns"
      className={`hidden md:grid ${TABLE_COLUMNS} items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground`}
    >
      <span>{t("youtubeStage4.picker.colVideo", "Video")}</span>
      <span>{t("youtubeStage4.picker.colVisibility", "Visibility")}</span>
      <span>{t("youtubeStage4.picker.colDate", "Date")}</span>
      <span className="text-end">{t("youtubeStage4.picker.colViews", "Views")}</span>
      <span className="text-end">{t("youtubeStage4.picker.colComments", "Comments")}</span>
    </div>
  );
}

function MobileVideoMeta({ video }: { video: Stage4Video }): JSX.Element {
  const { i18n } = useTranslation("automation");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const publishDate = validPublishDate(video.published_at);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground md:hidden">
      <span className="flex items-center gap-1">
        <VisibilityIcon visibility={video.visibility} className="h-3 w-3" />
        <VisibilityLabel visibility={video.visibility} />
      </span>
      {publishDate && <time dateTime={publishDate.toISOString()}>{publishDate.toLocaleDateString(locale)}</time>}
      <DateKindLabel video={video} publishDate={publishDate} />
      <span className="flex items-center gap-1 tabular-nums">
        <Eye className="h-3 w-3" aria-hidden="true" />
        {formatCompactCount(video.view_count, locale)}
      </span>
      <span className="flex items-center gap-1 tabular-nums">
        <MessageSquare className="h-3 w-3" aria-hidden="true" />
        {formatCompactCount(video.comment_count, locale)}
      </span>
    </span>
  );
}

function VideoSummaryCell({ video }: { video: Stage4Video }): JSX.Element {
  const description = video.description?.trim();
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Stage4VideoThumbnail video={video} durationLabel={formatVideoDuration(video.duration_iso)} />
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium leading-5">{video.title}</span>
        <span className="mt-1 block truncate text-[11px] text-muted-foreground">{description || video.id}</span>
        <MobileVideoMeta video={video} />
      </span>
    </span>
  );
}

function VideoRow({ video, selected, onSelect }: {
  video: Stage4Video;
  selected: boolean;
  onSelect: (videoId: string) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation("automation");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const descriptionId = `yt-stage4-video-meta-${video.id}`;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={video.title}
      aria-describedby={descriptionId}
      onClick={() => onSelect(video.id)}
      className={`w-full grid grid-cols-1 ${TABLE_COLUMNS} items-center gap-3 border-s-2 px-4 py-2.5 text-start transition-colors ${
        selected ? "bg-primary/5 border-s-primary" : "border-s-transparent hover:bg-muted/40"
      }`}
    >
      <VideoOptionDescription id={descriptionId} video={video} exactCounts />
      <VideoSummaryCell video={video} />
      <span className="hidden md:flex items-center gap-1.5 text-xs">
        <VisibilityIcon visibility={video.visibility} />
        <VisibilityLabel visibility={video.visibility} />
      </span>
      <VideoDate video={video} className="hidden md:block" />
      <span className="hidden md:flex items-center justify-end gap-1.5 text-xs tabular-nums">
        <Eye className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        {formatExactCount(video.view_count, locale)}
      </span>
      <span className="hidden md:flex items-center justify-end gap-1.5 text-xs tabular-nums">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        {formatExactCount(video.comment_count, locale)}
        {selected && (
          <Badge variant="default" className="rounded-full px-2 text-[10px] font-normal">
            {t("youtubeStage4.picker.activeVideo", "Selected")}
          </Badge>
        )}
      </span>
    </button>
  );
}

function VideoCard({ video, selected, onSelect }: {
  video: Stage4Video;
  selected: boolean;
  onSelect: (videoId: string) => void;
}): JSX.Element {
  const { i18n } = useTranslation("automation");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const descriptionId = `yt-stage4-video-meta-${video.id}`;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={video.title}
      aria-describedby={descriptionId}
      onClick={() => onSelect(video.id)}
      className={`h-full flex flex-col overflow-hidden rounded-lg border bg-card text-start transition-colors ${
        selected ? "border-primary ring-1 ring-primary" : "hover:border-primary/40 hover:bg-muted/20"
      }`}
    >
      <VideoOptionDescription id={descriptionId} video={video} />
      <Stage4VideoThumbnail
        video={video}
        className="aspect-video w-full rounded-none border-0"
        durationLabel={formatVideoDuration(video.duration_iso)}
      />
      <span className="flex flex-1 flex-col gap-2 p-3">
        <span className="line-clamp-2 min-h-10 text-sm font-medium leading-5">{video.title}</span>
        <VideoDate video={video} withVisibility />
        <span className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 tabular-nums">
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            {formatCompactCount(video.view_count, locale)}
          </span>
          <span className="flex items-center gap-1.5 tabular-nums">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {formatCompactCount(video.comment_count, locale)}
          </span>
        </span>
      </span>
    </button>
  );
}

function PickerResults({ stage4, visibleVideos, viewMode, gridColumns, onReset }: {
  stage4: Stage4Controller;
  visibleVideos: Stage4Video[];
  viewMode: ViewMode;
  gridColumns: GridColumns;
  onReset: () => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  const handleListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visibleVideos.length === 0) return;
    const supportedKeys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
    if (!supportedKeys.includes(event.key)) return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const activeElement = document.activeElement as HTMLElement | null;
    const domIndex = activeElement ? options.indexOf(activeElement as HTMLButtonElement) : -1;
    const selectedIndex = visibleVideos.findIndex((video) => video.id === stage4.effectiveVideoId);
    const baseIndex = domIndex >= 0 ? domIndex : selectedIndex;
    const horizontalStep = document.dir === "rtl" ? -1 : 1;
    let nextIndex = baseIndex < 0 ? 0 : baseIndex;
    if (event.key === "ArrowDown") nextIndex = baseIndex < 0 ? 0 : baseIndex + 1;
    if (event.key === "ArrowUp") nextIndex = baseIndex <= 0 ? 0 : baseIndex - 1;
    if (event.key === "ArrowRight") nextIndex = baseIndex < 0 ? 0 : baseIndex + horizontalStep;
    if (event.key === "ArrowLeft") nextIndex = baseIndex < 0 ? 0 : baseIndex - horizontalStep;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visibleVideos.length - 1;
    nextIndex = Math.max(0, Math.min(nextIndex, visibleVideos.length - 1));
    event.preventDefault();
    const target = visibleVideos[nextIndex];
    if (!target) return;
    stage4.setSelectedVideoId(target.id);
    options[nextIndex]?.focus();
  };
  return (
    <>
      <div
        role="listbox"
        aria-label={t("youtubeStage4.picker.title", "Your uploads")}
        onKeyDown={handleListboxKeyDown}
        className={viewMode === "grid"
          ? `grid max-h-[560px] gap-3 overflow-y-auto p-4 ${GRID_COLUMN_CLASSES[gridColumns]}`
          : "divide-y max-h-[440px] overflow-y-auto"}
      >
        {visibleVideos.map((video) => (
          viewMode === "grid"
            ? (
              <VideoCard
                key={video.id}
                video={video}
                selected={video.id === stage4.effectiveVideoId}
                onSelect={stage4.setSelectedVideoId}
              />
            )
            : (
              <VideoRow
                key={video.id}
                video={video}
                selected={video.id === stage4.effectiveVideoId}
                onSelect={stage4.setSelectedVideoId}
              />
            )
        ))}
      </div>
      {stage4.videos.items.length === 0 && !stage4.videos.loading && (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t("youtubeStage4.picker.empty", "No uploads found for this channel.")}
        </p>
      )}
      {stage4.videos.items.length > 0 && visibleVideos.length === 0 && (
        <div className="space-y-3 px-4 py-8 text-center" data-testid="yt-stage4-picker-no-match">
          <p className="text-sm text-muted-foreground">{t("youtubeStage4.picker.noMatch", "No uploads match these filters.")}</p>
          <Button size="sm" variant="outline" onClick={onReset}>
            {t("youtubeStage4.picker.resetFilters", "Reset filters")}
          </Button>
        </div>
      )}
      {stage4.videos.nextCursor && (
        <div className="border-t px-4 py-3 text-center">
          <Button size="sm" variant="ghost" onClick={stage4.videos.loadMore} disabled={stage4.videos.loading}>
            {t("youtubeStage4.picker.loadMore", "Load more uploads")}
          </Button>
        </div>
      )}
    </>
  );
}

export function StudioVideoPicker({ stage4 }: { stage4: Stage4Controller }): JSX.Element {
  const { t } = useTranslation("automation");
  const [filter, setFilter] = useState<VideoFilter>("all");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [gridColumns, setGridColumns] = useState<GridColumns>(readInitialGridColumns);
  const visibleVideos = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return stage4.videos.items.filter((video) => {
      const matchesType = filter === "all" || (filter === "shorts" ? isShorts(video) : !isShorts(video));
      const matchesQuery = !normalizedQuery
        || video.title.toLocaleLowerCase().includes(normalizedQuery)
        || (video.description ?? "").toLocaleLowerCase().includes(normalizedQuery)
        || video.id.toLocaleLowerCase().includes(normalizedQuery);
      return matchesType && matchesQuery;
    });
  }, [filter, query, stage4.videos.items]);
  const resetFilters = () => {
    setFilter("all");
    setQuery("");
  };
  const selectGridColumns = (columns: GridColumns) => {
    setGridColumns(columns);
    try {
      localStorage.setItem("ytStage4VideoGridColumns", String(columns));
    } catch {
      // The selected layout still applies when browser storage is unavailable.
    }
  };

  return (
    <section data-testid="yt-stage4-studio-picker" className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <PickerHeader stage4={stage4} viewMode={viewMode} onViewMode={setViewMode} />
      <PickerFilters
        filter={filter}
        query={query}
        viewMode={viewMode}
        gridColumns={gridColumns}
        onFilter={setFilter}
        onQuery={setQuery}
        onColumns={selectGridColumns}
      />
      {stage4.videos.error && (
        <p className="border-b px-4 py-3 text-sm text-destructive sm:px-5">
          {t("youtubeStage4.picker.error", "Couldn't load your uploads.")}
        </p>
      )}
      {viewMode === "table" && <PickerColumns />}
      <PickerResults
        stage4={stage4}
        visibleVideos={visibleVideos}
        viewMode={viewMode}
        gridColumns={gridColumns}
        onReset={resetFilters}
      />
    </section>
  );
}
