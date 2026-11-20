import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { YouTubeVideoListItem } from "../domain/types";

export interface YouTubeVideoLibraryProps {
  videos: readonly YouTubeVideoListItem[];
  selectedVideoId: string | null;
  onSelect: (videoId: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

// A presentational list: the caller renders errors with YouTubeResourceNotice,
// so the empty text appears only when there truly are zero items and no error.
// "Load more" follows hasMore alone: an empty page may still carry a
// next_page_token, so pagination never keys on items.length.
export function YouTubeVideoLibrary(props: YouTubeVideoLibraryProps): JSX.Element {
  const { videos, selectedVideoId, onSelect, hasMore, isLoadingMore, onLoadMore } = props;
  const { t } = useTranslation("accounts");

  return (
    <div className="space-y-2">
      {videos.length === 0 ? (
        hasMore ? (
          <p className="text-sm text-muted-foreground">
            {t("youtubeManagement.library.moreAvailable", "More results are available, load the next page")}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("youtubeManagement.library.empty", "This channel has no uploaded videos yet.")}
          </p>
        )
      ) : (
        <>
          <h3 className="text-sm font-semibold text-muted-foreground">
            {t("youtubeManagement.library.title", "Uploaded videos")}
          </h3>
          <ul className="space-y-1">
            {videos.map((video) => (
              <li key={video.id}>
                <button
                  type="button"
                  aria-pressed={video.id === selectedVideoId}
                  onClick={() => onSelect(video.id)}
                  className={`w-full rounded-md border px-3 py-2 text-start text-sm hover:bg-accent ${
                    video.id === selectedVideoId ? "border-primary bg-accent" : "border-input"
                  }`}
                >
                  <span className="block font-medium">{video.title}</span>
                  <span className="block text-xs text-muted-foreground">{video.privacy_status ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {hasMore ? (
        <Button size="sm" variant="outline" disabled={isLoadingMore} onClick={onLoadMore}>
          {t("youtubeManagement.library.loadMore", "Load more")}
        </Button>
      ) : null}
    </div>
  );
}
