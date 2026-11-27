import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { YouTubeResourceError } from "../domain/errors";
import type {
  YouTubeCaptionFormat,
  YouTubeCaptionTrack,
  YouTubeCaptionUploadResult,
  YouTubeCapabilityState,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
} from "../domain/types";
import type { YouTubeThumbnailCandidate, YouTubeThumbnailOutcome } from "../domain/thumbnail";
import type { EditSaveResult, EditSnapshotInput } from "./YouTubeVideoEditCard";
import { YouTubeVideoEditCard } from "./YouTubeVideoEditCard";
import { YouTubeThumbnailChange } from "./YouTubeThumbnailChange";
import { YouTubeCaptionsSection } from "./YouTubeCaptionsSection";
import { YouTubeResourceNotice } from "./YouTubeResourceNotice";

export function YouTubeVideoDrawer({
  open,
  onOpenChange,
  locale,
  video,
  canEdit,
  disabledReason,
  accountId,
  region,
  onSnapshot,
  onSave,
  thumbnailCapability,
  thumbnailCandidates,
  thumbnailCandidatesLoading,
  thumbnailCandidatesError,
  onRetryThumbnailCandidates,
  onSetThumbnail,
  captionsCapability,
  onListCaptions,
  onUploadCaption,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: "en" | "ar";
  video: UseQueryResult<YouTubeResourceSuccess<YouTubeVideoDetails>, Error>;
  canEdit: boolean;
  disabledReason: string;
  accountId?: string | null;
  region?: string;
  onSnapshot?: (videoId: string) => Promise<EditSnapshotInput>;
  onSave?: (draft: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    baseRevision: string;
  }) => Promise<EditSaveResult>;
  /** The server's derived thumbnail capability; null until it is known. */
  thumbnailCapability?: YouTubeCapabilityState | null;
  /** The creator's own library images, filtered by the picker. */
  thumbnailCandidates?: readonly YouTubeThumbnailCandidate[];
  thumbnailCandidatesLoading?: boolean;
  thumbnailCandidatesError?: unknown;
  onRetryThumbnailCandidates?: () => void;
  onSetThumbnail?: (mediaFileId: string) => Promise<YouTubeThumbnailOutcome>;
  /** The server's derived caption capability; null until it is known. */
  captionsCapability?: YouTubeCapabilityState | null;
  /** Lists the video's caption tracks; never called without a click. */
  onListCaptions?: (videoId: string) => Promise<YouTubeCaptionTrack[]>;
  /** Uploads one caption track after the creator confirms it. */
  onUploadCaption?: (params: {
    videoId: string;
    language: string;
    name: string;
    format: YouTubeCaptionFormat;
    content: string;
  }) => Promise<YouTubeCaptionUploadResult>;
}) {
  const { t, i18n } = useTranslation("accounts");
  const details = video.data?.data;
  const fetchedAt = video.data?.freshness.fetched_at;
  const parsedAt = fetchedAt ? new Date(fetchedAt) : null;
  const updatedLabel = parsedAt && !Number.isNaN(parsedAt.getTime())
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(parsedAt)
    : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={locale === "ar" ? "left" : "right"}
        dir={locale === "ar" ? "rtl" : "ltr"}
        className="w-full sm:max-w-xl lg:max-w-2xl overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle>{details?.title ?? t("youtubeManagement.drawer.title", "Video details")}</SheetTitle>
          <SheetDescription className="sr-only">{t("youtubeManagement.drawer.description", "Details, metadata and editing controls for the selected video.")}</SheetDescription>
        </SheetHeader>
        {video.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">{t("youtubeManagement.loading", "Loading…")}</p>
        ) : video.isError ? (
          <YouTubeResourceNotice
            code={video.error instanceof YouTubeResourceError ? video.error.code : "upstream_unavailable"}
            retryAfterSeconds={video.error instanceof YouTubeResourceError ? video.error.retryAfterSeconds : null}
            onRetry={() => void video.refetch()}
          />
        ) : details && fetchedAt ? (
          <div className="space-y-4">
            <YouTubeVideoEditCard
              video={details}
              fetchedAt={fetchedAt}
              canEdit={canEdit}
              accountId={accountId}
              region={region}
              onSnapshot={onSnapshot}
              onSave={onSave}
              disabledReason={disabledReason}
            />
            <YouTubeThumbnailChange
              capability={thumbnailCapability ?? null}
              candidates={thumbnailCandidates ?? []}
              candidatesLoading={thumbnailCandidatesLoading ?? false}
              candidatesError={thumbnailCandidatesError ?? null}
              onRetryCandidates={onRetryThumbnailCandidates}
              onSetThumbnail={onSetThumbnail}
            />
            <YouTubeCaptionsSection
              key={details.id}
              capability={captionsCapability ?? null}
              videoId={details.id}
              onListCaptions={onListCaptions}
              onUploadCaption={onUploadCaption}
            />
            {updatedLabel ? <p className="text-xs text-muted-foreground">{t("youtubeManagement.fetchedAt", "Updated {{time}}", { time: updatedLabel })}</p> : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
