import { type KeyboardEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, Search, Youtube } from "lucide-react";
import type { useYouTubeStage4 } from "../application/useYouTubeStage4";

type Stage4Controller = ReturnType<typeof useYouTubeStage4>;
type Stage4Video = Stage4Controller["videos"]["items"][number];
type VideoFilter = "all" | "videos" | "shorts";

function isShorts(video: Stage4Video): boolean {
  if (typeof video.is_short === "boolean") return video.is_short;
  return /#shorts?\b/i.test(video.title);
}

function safeThumbnailUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https:\/\//i.test(trimmed) ? trimmed : null;
}

function validPublishDate(publishedAt: string | null): Date | null {
  if (!publishedAt) return null;
  const date = new Date(publishedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function Stage4VideoThumbnail({ video, className = "h-14 w-24" }: {
  video: Stage4Video;
  className?: string;
}): JSX.Element {
  const thumbUrl = safeThumbnailUrl(video.thumbnail_url);
  return (
    <span className={`relative ${className} shrink-0 overflow-hidden rounded-md border bg-muted flex items-center justify-center`}>
      {thumbUrl ? (
        <img src={thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Youtube className="h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
      )}
    </span>
  );
}

function PickerHeader({ stage4 }: { stage4: Stage4Controller }): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t("youtubeStage4.picker.title", "Your uploads")}</h2>
        <Badge variant="secondary" className="rounded-full px-2 py-0 text-[11px] font-normal">
          {t("youtubeStage4.picker.loadedCount", "{{count}} loaded", { count: stage4.videos.items.length })}
        </Badge>
      </div>
      <Button size="sm" variant="outline" onClick={stage4.videos.reload} disabled={stage4.videos.loading}>
        {stage4.videos.loading ? <Loader2 className="h-4 w-4 animate-spin me-1.5" /> : <RefreshCw className="h-4 w-4 me-1.5" />}
        {t("common:refresh", "Refresh")}
      </Button>
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

function PickerFilters({ filter, query, onFilter, onQuery }: {
  filter: VideoFilter;
  query: string;
  onFilter: (filter: VideoFilter) => void;
  onQuery: (query: string) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="flex flex-col gap-3 border-y bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "videos", "shorts"] as const).map((videoFilter) => (
          <FilterButton key={videoFilter} filter={videoFilter} activeFilter={filter} onSelect={onFilter} />
        ))}
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
    <div className="hidden sm:grid sm:grid-cols-[minmax(0,1fr)_110px_130px_110px] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
      <span>{t("youtubeStage4.picker.colVideo", "Video")}</span>
      <span>{t("youtubeStage4.picker.colType", "Type")}</span>
      <span>{t("youtubeStage4.picker.colDate", "Date")}</span>
      <span className="text-end">{t("youtubeStage4.picker.colComments", "Comments")}</span>
    </div>
  );
}

function VideoDate({ video }: { video: Stage4Video }): JSX.Element {
  const { t, i18n } = useTranslation("automation");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const publishDate = validPublishDate(video.published_at);
  return (
    <span className="hidden sm:block text-xs text-muted-foreground">
      <span className="block text-foreground">
        {publishDate ? <time dateTime={publishDate.toISOString()}>{publishDate.toLocaleDateString(locale)}</time> : "—"}
      </span>
      <span className="mt-0.5 block">
        {publishDate
          ? t("youtubeStage4.picker.datePublished", "Published")
          : t("youtubeStage4.picker.dateUnset", "Uploaded")}
      </span>
    </span>
  );
}

function VideoSummaryCell({ video }: { video: Stage4Video }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Stage4VideoThumbnail video={video} />
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium leading-5">{video.title}</span>
        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{video.id}</span>
      </span>
    </span>
  );
}

function VideoTypeBadge({ video }: { video: Stage4Video }): JSX.Element {
  const { t } = useTranslation("automation");
  const shorts = isShorts(video);
  return (
    <span className="hidden sm:flex">
      <Badge variant={shorts ? "secondary" : "outline"} className="text-[11px] font-normal">
        {shorts ? t("youtubeStage4.picker.typeShorts", "Shorts") : t("youtubeStage4.picker.typeVideo", "Video")}
      </Badge>
    </span>
  );
}

function VideoSelectionBadge({ selected }: { selected: boolean }): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <span className="hidden sm:flex items-center justify-end">
      <Badge variant={selected ? "default" : "outline"} className="rounded-full px-2.5 text-[11px] font-normal">
        {selected ? t("youtubeStage4.picker.activeVideo", "Selected") : t("youtubeStage4.picker.selectComments", "View")}
      </Badge>
    </span>
  );
}

function VideoRow({ video, selected, onSelect }: {
  video: Stage4Video;
  selected: boolean;
  onSelect: (videoId: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={video.title}
      onClick={() => onSelect(video.id)}
      className={`w-full grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_110px_130px_110px] items-center gap-3 border-s-2 px-4 py-2.5 text-start transition-colors ${
        selected ? "bg-primary/5 border-s-primary" : "border-s-transparent hover:bg-muted/40"
      }`}
    >
      <VideoSummaryCell video={video} />
      <VideoTypeBadge video={video} />
      <VideoDate video={video} />
      <VideoSelectionBadge selected={selected} />
    </button>
  );
}

function PickerResults({ stage4, visibleVideos, onReset }: {
  stage4: Stage4Controller;
  visibleVideos: Stage4Video[];
  onReset: () => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  const handleListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visibleVideos.length === 0) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const activeElement = document.activeElement as HTMLElement | null;
    const domIndex = activeElement ? options.indexOf(activeElement as HTMLButtonElement) : -1;
    const selectedIndex = visibleVideos.findIndex((video) => video.id === stage4.effectiveVideoId);
    const baseIndex = domIndex >= 0 ? domIndex : selectedIndex;
    let nextIndex = 0;
    if (event.key === "ArrowDown") {
      nextIndex = baseIndex < 0 ? 0 : Math.min(baseIndex + 1, visibleVideos.length - 1);
    } else if (event.key === "ArrowUp") {
      nextIndex = baseIndex <= 0 ? 0 : baseIndex - 1;
    } else if (event.key === "End") {
      nextIndex = visibleVideos.length - 1;
    }
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
        className="divide-y max-h-[340px] overflow-y-auto"
      >
        {visibleVideos.map((video) => (
          <VideoRow
            key={video.id}
            video={video}
            selected={video.id === stage4.effectiveVideoId}
            onSelect={stage4.setSelectedVideoId}
          />
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
  const visibleVideos = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return stage4.videos.items.filter((video) => {
      const matchesType = filter === "all" || (filter === "shorts" ? isShorts(video) : !isShorts(video));
      const matchesQuery = !normalizedQuery
        || video.title.toLocaleLowerCase().includes(normalizedQuery)
        || video.id.toLocaleLowerCase().includes(normalizedQuery);
      return matchesType && matchesQuery;
    });
  }, [filter, query, stage4.videos.items]);
  const resetFilters = () => {
    setFilter("all");
    setQuery("");
  };

  return (
    <section data-testid="yt-stage4-studio-picker" className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <PickerHeader stage4={stage4} />
      <PickerFilters filter={filter} query={query} onFilter={setFilter} onQuery={setQuery} />
      {stage4.videos.error && (
        <p className="border-b px-4 py-3 text-sm text-destructive sm:px-5">
          {t("youtubeStage4.picker.error", "Couldn't load your uploads.")}
        </p>
      )}
      <PickerColumns />
      <PickerResults stage4={stage4} visibleVideos={visibleVideos} onReset={resetFilters} />
    </section>
  );
}
