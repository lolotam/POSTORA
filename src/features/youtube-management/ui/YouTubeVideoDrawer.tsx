import { useEffect, useState } from "react";
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
import type { YouTubePlayerSizeMode } from "../domain/player";
import type {
  YouTubeCaptionFormat,
  YouTubeCaptionTrack,
  YouTubeCaptionUploadResult,
  YouTubeCapabilityState,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
} from "../domain/types";
import type { YouTubeThumbnailCandidate, YouTubeThumbnailOutcome } from "../domain/thumbnail";
import type { YouTubePackagingScoreGateway } from "../application/ports";
import type { EditableYouTubePrivacy, EditSaveResult, EditSnapshotInput } from "./YouTubeVideoEditCard";
import type { ResolvedTier } from "@/components/ai/ResolvedModelCards";
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
  onRequestPackagingScore,
  thumbnailCapability,
  thumbnailCandidates,
  thumbnailCandidatesLoading,
  thumbnailCandidatesError,
  onRetryThumbnailCandidates,
  onSetThumbnail,
  currentThumbnailUrl,
  onUploadThumbnailImage,
  onGenerateThumbnailImage,
  resolvedImageTiers,
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
    privacyStatus?: EditableYouTubePrivacy;
    privacyConfirmation?: { to: EditableYouTubePrivacy };
  }) => Promise<EditSaveResult>;
  onRequestPackagingScore?: YouTubePackagingScoreGateway["scorePackaging"];
  /** The server's derived thumbnail capability; null until it is known. */
  thumbnailCapability?: YouTubeCapabilityState | null;
  /** The creator's own library images, filtered by the picker. */
  thumbnailCandidates?: readonly YouTubeThumbnailCandidate[];
  thumbnailCandidatesLoading?: boolean;
  thumbnailCandidatesError?: unknown;
  onRetryThumbnailCandidates?: () => void;
  onSetThumbnail?: (mediaFileId: string) => Promise<YouTubeThumbnailOutcome>;
  /** The thumbnail the video shows today. */
  currentThumbnailUrl?: string | null;
  /** Stores an image the creator picked on this device. */
  onUploadThumbnailImage?: (params: {
    blob: Blob;
    fileName: string;
    mimeType: "image/jpeg" | "image/png";
  }) => Promise<YouTubeThumbnailCandidate>;
  /** Generates a thumbnail image with the app's own image generator. */
  onGenerateThumbnailImage?: (params: {
    prompt: string;
    referenceImage?: string;
    referenceImages?: readonly string[];
  }) => Promise<{ imageUrl: string }>;
  /** Configured image generation model tiers to display in the AI tab. */
  resolvedImageTiers?: readonly ResolvedTier[];
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
  // The drawer owns the player's size: Theater widens the drawer while the
  // same player keeps playing.
  const [playerSizeMode, setPlayerSizeMode] = useState<YouTubePlayerSizeMode>("compact");
  useEffect(() => {
    setPlayerSizeMode("compact");
  }, [details?.id, open]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={locale === "ar" ? "left" : "right"}
        dir={locale === "ar" ? "rtl" : "ltr"}
        className={playerSizeMode === "theater"
          ? "w-full sm:max-w-[min(96vw,1200px)] overflow-y-auto"
          : "w-full sm:max-w-xl lg:max-w-2xl overflow-y-auto"}
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
              onRequestPackagingScore={onRequestPackagingScore}
              disabledReason={disabledReason}
              playerSizeMode={playerSizeMode}
              onPlayerSizeModeChange={setPlayerSizeMode}
            />
            <YouTubeThumbnailChange
              key={`thumbnail:${details.id}`}
              capability={thumbnailCapability ?? null}
              candidates={thumbnailCandidates ?? []}
              candidatesLoading={thumbnailCandidatesLoading ?? false}
              candidatesError={thumbnailCandidatesError ?? null}
              onRetryCandidates={onRetryThumbnailCandidates}
              onSetThumbnail={onSetThumbnail}
              currentThumbnailUrl={currentThumbnailUrl ?? details.thumbnail_url}
              onUploadImage={onUploadThumbnailImage}
              onGenerateAiImage={onGenerateThumbnailImage}
              resolvedImageTiers={resolvedImageTiers}
            />
            <YouTubeCaptionsSection
              key={`captions:${details.id}`}
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
