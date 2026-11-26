import { Globe, Link2, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { YouTubeVideoListItem } from "../domain/types";
import { YouTubeVideoThumbnail } from "./YouTubeVideoThumbnail";

export function YouTubeVideoLibraryGrid({ videos, columnsClass, selectedVideoId, visibilityLabels, onSelect }: {
  videos: readonly YouTubeVideoListItem[];
  columnsClass: string;
  selectedVideoId: string | null;
  visibilityLabels: Readonly<Record<string, string>>;
  onSelect: (videoId: string) => void;
}) {
  const { t, i18n } = useTranslation("accounts");
  const numberFormat = new Intl.NumberFormat(i18n.language);
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const count = (value: number | null | undefined) => value === null || value === undefined ? "—" : numberFormat.format(value);
  const formatDate = (value: string | null) => {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
  };
  return (
    <div className={`grid gap-3 ${columnsClass}`}>
      {videos.map((video, index) => {
        const VisibilityIcon = video.privacy_status === "public"
          ? Globe
          : video.privacy_status === "unlisted"
            ? Link2
            : video.privacy_status === "private"
              ? Lock
              : null;
        return (
          <button
            key={video.id}
            type="button"
            aria-pressed={video.id === selectedVideoId}
            onClick={() => onSelect(video.id)}
            className={`space-y-3 rounded-lg border p-3 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${video.id === selectedVideoId ? "border-primary" : ""}`}
          >
            <div className="relative">
              <YouTubeVideoThumbnail url={video.thumbnail_url} duration={video.duration_iso8601} />
              <span className="absolute start-2 top-2 rounded bg-background/90 px-1.5 py-0.5 text-xs font-medium">#{index + 1}</span>
            </div>
            <div>
              <h3 className="line-clamp-2 min-h-10 font-medium">{video.title}</h3>
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                {VisibilityIcon ? <VisibilityIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                <span>{video.privacy_status ? visibilityLabels[video.privacy_status] ?? video.privacy_status : "—"}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(video.published_at)}</span>
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              {([
                ["youtubeManagement.library.colViews", "Views", video.statistics?.view_count],
                ["youtubeManagement.library.colLikes", "Likes", video.statistics?.like_count],
                ["youtubeManagement.library.colComments", "Comments", video.statistics?.comment_count],
              ] as const).map(([key, fallback, value]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">{t(key, fallback)}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{count(value)}</dd>
                </div>
              ))}
            </dl>
          </button>
        );
      })}
    </div>
  );
}
