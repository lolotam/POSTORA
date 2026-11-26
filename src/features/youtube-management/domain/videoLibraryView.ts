import { sortRows, type DataViewSortDirection } from "@/components/data-view/sortRows";
import { isoDurationSeconds } from "./formatIsoDuration";
import type { YouTubeVideoListItem } from "./types";

export type LibraryVideoFilter = "all" | "videos" | "shorts";
export type LibraryVideoColumn = "video" | "visibility" | "published_at" | "duration" | "views" | "likes" | "comments";

export const LIBRARY_VIDEO_COLUMNS: ReadonlyArray<{
  id: LibraryVideoColumn;
  defaultDirection: DataViewSortDirection;
}> = [
  { id: "video", defaultDirection: "ascending" },
  { id: "visibility", defaultDirection: "ascending" },
  { id: "published_at", defaultDirection: "descending" },
  { id: "duration", defaultDirection: "descending" },
  { id: "views", defaultDirection: "descending" },
  { id: "likes", defaultDirection: "descending" },
  { id: "comments", defaultDirection: "descending" },
];

export function isLikelyShort(video: Pick<YouTubeVideoListItem, "title" | "description">): boolean {
  return /#shorts?\b/i.test(`${video.title}\n${video.description ?? ""}`);
}

export function filterLibraryVideos(
  videos: readonly YouTubeVideoListItem[],
  filter: LibraryVideoFilter,
  query: string,
): YouTubeVideoListItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  return videos.filter((video) => {
    if (filter === "shorts" && !isLikelyShort(video)) return false;
    if (filter === "videos" && isLikelyShort(video)) return false;
    return normalized.length === 0 || `${video.title}\n${video.description ?? ""}\n${video.id}`
      .toLocaleLowerCase().includes(normalized);
  });
}

export function sortLibraryVideos(
  videos: readonly YouTubeVideoListItem[],
  column: LibraryVideoColumn,
  direction: DataViewSortDirection,
  options: { visibilityLabels: Readonly<Record<string, string>>; collator?: Intl.Collator },
): YouTubeVideoListItem[] {
  const { visibilityLabels, collator } = options;
  return sortRows(videos, (video) => {
    switch (column) {
      case "video": return video.title;
      case "visibility": return video.privacy_status ? visibilityLabels[video.privacy_status] ?? video.privacy_status : null;
      case "published_at": return video.published_at === null ? null : Date.parse(video.published_at);
      case "duration": return isoDurationSeconds(video.duration_iso8601 ?? null);
      case "views": return video.statistics?.view_count ?? null;
      case "likes": return video.statistics?.like_count ?? null;
      case "comments": return video.statistics?.comment_count ?? null;
    }
  }, direction, collator);
}
