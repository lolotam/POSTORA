import { Globe, Link2, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SortableColumnHeader } from "@/components/data-view/SortableColumnHeader";
import type { DataViewSortDirection } from "@/components/data-view/sortRows";
import { formatIsoDuration } from "../domain/formatIsoDuration";
import { LIBRARY_VIDEO_COLUMNS, type LibraryVideoColumn } from "../domain/videoLibraryView";
import type { YouTubeVideoListItem } from "../domain/types";
import { YouTubeVideoThumbnail } from "./YouTubeVideoThumbnail";

export function YouTubeVideoLibraryTable({ videos, selectedVideoId, sortColumn, sortDirection, visibilityLabels, onSort, onSelect }: {
  videos: readonly YouTubeVideoListItem[];
  selectedVideoId: string | null;
  sortColumn: LibraryVideoColumn | null;
  sortDirection: DataViewSortDirection;
  visibilityLabels: Readonly<Record<string, string>>;
  onSort: (column: LibraryVideoColumn, direction: DataViewSortDirection) => void;
  onSelect: (videoId: string) => void;
}) {
  const { t, i18n } = useTranslation("accounts");
  const numberFormat = new Intl.NumberFormat(i18n.language);
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const labels: Record<LibraryVideoColumn, string> = {
    video: t("youtubeManagement.library.colVideo", "Video"),
    visibility: t("youtubeManagement.library.colVisibility", "Visibility"),
    published_at: t("youtubeManagement.library.colPublished", "Date published"),
    duration: t("youtubeManagement.library.colDuration", "Duration"),
    views: t("youtubeManagement.library.colViews", "Views"),
    likes: t("youtubeManagement.library.colLikes", "Likes"),
    comments: t("youtubeManagement.library.colComments", "Comments"),
  };
  const count = (value: number | null | undefined) => value === null || value === undefined ? "—" : numberFormat.format(value);
  const formatDate = (value: string | null) => {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
  };
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[1100px] text-sm">
        <thead className="bg-muted/50"><tr>
          <th className="w-12 p-3 text-start">{t("youtubeManagement.library.colRank", "#")}</th>
          {LIBRARY_VIDEO_COLUMNS.map((column) => (
            <SortableColumnHeader
              key={column.id}
              label={labels[column.id]}
              direction={sortColumn === column.id ? sortDirection : null}
              defaultDirection={column.defaultDirection}
              onSort={(direction) => onSort(column.id, direction)}
            />
          ))}
        </tr></thead>
        <tbody>{videos.map((video, index) => {
          const VisibilityIcon = video.privacy_status === "public"
            ? Globe
            : video.privacy_status === "unlisted"
              ? Link2
              : video.privacy_status === "private"
                ? Lock
                : null;
          return (
            <tr key={video.id} className="border-t">
              <td className="p-3 tabular-nums">{index + 1}</td>
              <td className="p-3">
                <button
                  type="button"
                  aria-pressed={video.id === selectedVideoId}
                  onClick={() => onSelect(video.id)}
                  className="flex min-w-56 items-center gap-3 text-start hover:text-primary"
                >
                  <YouTubeVideoThumbnail url={video.thumbnail_url} duration={video.duration_iso8601} className="w-24 shrink-0" />
                  <span className="line-clamp-2 font-medium">{video.title}</span>
                </button>
              </td>
              <td className="p-3 whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5">
                  {VisibilityIcon ? <VisibilityIcon className="h-4 w-4" aria-hidden="true" /> : null}
                  {video.privacy_status ? visibilityLabels[video.privacy_status] ?? video.privacy_status : "—"}
                </span>
              </td>
              <td className="p-3 whitespace-nowrap">{formatDate(video.published_at)}</td>
              <td className="p-3 tabular-nums">{formatIsoDuration(video.duration_iso8601 ?? null) ?? "—"}</td>
              <td className="p-3 tabular-nums">{count(video.statistics?.view_count)}</td>
              <td className="p-3 tabular-nums">{count(video.statistics?.like_count)}</td>
              <td className="p-3 tabular-nums">{count(video.statistics?.comment_count)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
