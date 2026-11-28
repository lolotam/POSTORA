import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { YouTubeResourceErrorCode, YouTubeVideoListItem } from "../domain/types";
import { YouTubeResourceError } from "../domain/errors";
import { thumbnailOutcomeFromErrorCode, type YouTubeThumbnailOutcome } from "../domain/thumbnail";
import { captionOutcomeFromErrorCode } from "../domain/captions";
import type { YouTubeAccountOption } from "../domain/accountOptions";
import { useYouTubeCapabilities } from "../application/useYouTubeCapabilities";
import { useYouTubeChannel } from "../application/useYouTubeChannel";
import { trimVideosToFirstPage, useYouTubeVideos } from "../application/useYouTubeVideos";
import { useYouTubeThumbnailMedia } from "../application/useYouTubeThumbnailMedia";
import { youtubeResourceKey } from "../application/queryKeys";
import { useAuth } from "@/hooks/useAuth";
import { useResolvedImageModels } from "@/hooks/useResolvedImageModels";
import { useYouTubeVideo } from "../application/useYouTubeVideo";
import type {
  YouTubePackagingScoreGateway,
  YouTubeResourcesGateway,
  YouTubeThumbnailAiGateway,
  YouTubeThumbnailMediaGateway,
} from "../application/ports";
import { requestYouTubePackagingScore } from "@/lib/youtubePackagingScoreClient";
import { defaultYouTubeResourcesGateway } from "../infrastructure/supabaseYouTubeResourcesGateway";
import { defaultYouTubeThumbnailMediaGateway } from "../infrastructure/supabaseYouTubeThumbnailMediaGateway";
import { defaultYouTubeThumbnailAiGateway } from "../infrastructure/supabaseYouTubeThumbnailAiGateway";
import { YouTubeResourceNotice } from "./YouTubeResourceNotice";
import { YouTubeAccountPicker } from "./YouTubeAccountPicker";
import { YouTubeChannelSummary } from "./YouTubeChannelSummary";
import { YouTubeVideoLibrary } from "./YouTubeVideoLibrary";
import { YouTubeVideoDrawer } from "./YouTubeVideoDrawer";

const defaultYouTubePackagingScoreGateway: YouTubePackagingScoreGateway = {
  scorePackaging: (params) => requestYouTubePackagingScore(params),
};

export interface YouTubeManagementScreenProps {
  accounts: readonly YouTubeAccountOption[];
  accountsLoading: boolean;
  gateway?: YouTubeResourcesGateway;
  /** The creator's own media library, used to offer a thumbnail image. */
  mediaGateway?: YouTubeThumbnailMediaGateway;
  /** The app's image generator, used to create a thumbnail from a prompt. */
  aiGateway?: YouTubeThumbnailAiGateway;
  /** Scores draft title and thumbnail synergy without touching YouTube. */
  packagingScoreGateway?: YouTubePackagingScoreGateway;
  // The page's connected-accounts query can fail; the screen then offers a
  // retry instead of pretending no channel is connected.
  accountsError?: unknown;
  onRetryAccounts?: () => void;
}

// The composition root of the feature: the only ui/ file allowed to import
// infrastructure (for the default gateway), which every test replaces.
export function YouTubeManagementScreen(props: YouTubeManagementScreenProps): JSX.Element {
  const {
    accounts,
    accountsLoading,
    gateway = defaultYouTubeResourcesGateway,
    mediaGateway = defaultYouTubeThumbnailMediaGateway,
    aiGateway = defaultYouTubeThumbnailAiGateway,
    packagingScoreGateway = defaultYouTubePackagingScoreGateway,
    accountsError,
    onRetryAccounts,
  } = props;
  const { t, i18n } = useTranslation("accounts");
  const queryClient = useQueryClient();
  const userId = useAuth().user?.id ?? "anonymous";
  const { tiers: resolvedImageTiers } = useResolvedImageModels();
  const locale: "en" | "ar" = i18n.language.startsWith("ar") ? "ar" : "en";

  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  // The selection is bound to the account it was made under: when the active
  // account changes (picker or fallback), the old video id must not refire.
  const [pickedVideo, setPickedVideo] = useState<{ accountId: string; videoId: string } | null>(null);
  const videoOpenerRef = useRef<HTMLElement | null>(null);
  const activeAccountId = pickedAccountId !== null && accounts.some((account) => account.id === pickedAccountId)
    ? pickedAccountId
    : accounts[0]?.id ?? null;
  const selectedVideoId = pickedVideo !== null && pickedVideo.accountId === activeAccountId
    ? pickedVideo.videoId
    : null;

  const capabilities = useYouTubeCapabilities({ gateway, accountId: activeAccountId });
  const browse = capabilities.data?.data.capabilities.browse;
  const canBrowse = browse !== undefined && browse.state !== "unavailable";
  const editCapability = capabilities.data?.data.capabilities.edit_metadata;
  // The reason the editor is disabled comes from the server's own capability,
  // so the creator is told what to fix instead of a generic sentence.
  const editDisabledReason = editCapability?.state === "unavailable"
    ? editCapability.reason === "reconnect_required"
      ? t("youtubeManagement.detail.reconnectRequired", "This channel needs to be reconnected before editing is available.")
      : editCapability.reason === "missing_scope"
        ? t("youtubeManagement.detail.missingScope", "Reconnect this channel and grant YouTube edit permissions (force-ssl) to edit video details.")
        : t("youtubeManagement.detail.providerUnsupported", "Editing video details is not available for managed connections.")
    : t("youtubeManagement.detail.editUnavailable", "Editing video details is currently unavailable for this channel.");
  // Thumbnail replacement has its own capability: it is independent of the
  // published-edit capability and of the browse capability.
  const thumbnailCapability = capabilities.data?.data.capabilities.manage_thumbnail ?? null;
  const canChangeThumbnail = thumbnailCapability?.state === "available";
  // Caption management has its own capability too: it is independent of
  // the published-edit gate and of the browse capability.
  const captionsCapability = capabilities.data?.data.capabilities.manage_captions ?? null;

  const channel = useYouTubeChannel({ gateway, accountId: activeAccountId, enabled: canBrowse });
  const videos = useYouTubeVideos({ gateway, accountId: activeAccountId, enabled: canBrowse });
  const video = useYouTubeVideo({ gateway, accountId: activeAccountId, videoId: selectedVideoId, enabled: canBrowse && selectedVideoId !== null });
  const thumbnailMedia = useYouTubeThumbnailMedia({ gateway: mediaGateway, enabled: canChangeThumbnail });

  // The media gateway may not be able to store an image; the thumbnail dialog
  // then offers the library and the generator only.
  const uploadThumbnailImage = useMemo(() => {
    const upload = mediaGateway.uploadOwnedImage;
    if (!upload) return undefined;
    return async (params: { blob: Blob; fileName: string; mimeType: "image/jpeg" | "image/png" }) => {
      const created = await upload.call(mediaGateway, params);
      void thumbnailMedia.refetch();
      return created;
    };
  }, [mediaGateway, thumbnailMedia]);

  const generateThumbnailImage = useMemo(() => {
    if (!aiGateway) return undefined;
    return (params: { prompt: string; referenceImage?: string; referenceImages?: readonly string[] }) =>
      aiGateway.generate(params);
  }, [aiGateway]);

  const errorCode = (error: unknown): YouTubeResourceErrorCode =>
    error instanceof YouTubeResourceError ? error.code : "upstream_unavailable";
  const retryHint = (error: unknown): number | null =>
    error instanceof YouTubeResourceError ? error.retryAfterSeconds : null;

  // Flatten with the first occurrence kept: a video can appear on two pages.
  const seenVideoIds = new Set<string>();
  const videoItems: YouTubeVideoListItem[] = [];
  for (const page of videos.data?.pages ?? []) {
    for (const item of page.data.items) {
      if (!seenVideoIds.has(item.id)) {
        seenVideoIds.add(item.id);
        videoItems.push(item);
      }
    }
  }

  const browseUnavailable = browse?.state === "unavailable";
  const refreshBusy = capabilities.isFetching || channel.isFetching || videos.isFetching || video.isFetching;

  // A refused capability means every read is refused; Refresh must not spend
  // the user's quota by refetching against it.
  const refresh = () => {
    if (browseUnavailable) return;
    void capabilities.refetch();
    if (canBrowse) {
      void channel.refetch();
      trimVideosToFirstPage(queryClient, youtubeResourceKey(userId, activeAccountId, "videos"));
      void videos.refetch();
      if (selectedVideoId !== null) void video.refetch();
    }
  };

  const nextPageFailed = videos.isFetchNextPageError;
  const nextPageErrorCode = nextPageFailed ? errorCode(videos.error) : null;

  const selectVideo = (videoId: string) => {
    if (!activeAccountId) return;
    videoOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPickedVideo({ accountId: activeAccountId, videoId });
  };
  const closeVideo = () => {
    setPickedVideo(null);
    setTimeout(() => videoOpenerRef.current?.focus(), 0);
  };

  const loadingLine = (
    <p role="status" className="text-sm text-muted-foreground">
      {t("youtubeManagement.loading", "Loading…")}
    </p>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t("youtubeManagement.title", "YouTube channel")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("youtubeManagement.subtitle", "Browse your channel and its uploaded videos.")}
        </p>
      </div>

      {accountsLoading ? (
        <p className="text-sm text-muted-foreground">{t("youtubeManagement.loading", "Loading…")}</p>
      ) : accountsError !== undefined && accountsError !== null ? (
        <div className="space-y-2">
          <YouTubeResourceNotice
            code="upstream_unavailable"
            retryAfterSeconds={null}
            onRetry={() => onRetryAccounts?.()}
            message={t("youtubeManagement.accountsError", "Postora could not read your connected accounts. Nothing was changed.")}
          />
        </div>
      ) : accounts.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t("youtubeManagement.noAccounts", "No YouTube channel is connected yet.")}</p>
          <Button asChild size="sm" variant="outline">
            <Link to="/profiles">{t("youtubeManagement.goToProfiles", "Open Profiles")}</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <YouTubeAccountPicker
              accounts={accounts}
              selectedId={activeAccountId}
              onSelect={(accountId) => {
                setPickedAccountId(accountId);
                setPickedVideo(null);
              }}
            />
            <Button size="sm" variant="outline" disabled={browseUnavailable || refreshBusy} onClick={refresh}>
              {t("youtubeManagement.refresh", "Refresh")}
            </Button>
          </div>

          {capabilities.isError ? (
            <YouTubeResourceNotice
              code={errorCode(capabilities.error)}
              retryAfterSeconds={retryHint(capabilities.error)}
              onRetry={() => void capabilities.refetch()}
            />
          ) : browseUnavailable && browse ? (
            <YouTubeResourceNotice
              code={browse.reason}
              retryAfterSeconds={null}
              onRetry={() => void capabilities.refetch()}
            />
          ) : (
            <div className="space-y-4">
              {capabilities.isPending ? loadingLine : null}

              {channel.isError ? (
                <YouTubeResourceNotice
                  code={errorCode(channel.error)}
                  retryAfterSeconds={retryHint(channel.error)}
                  onRetry={() => void channel.refetch()}
                />
              ) : channel.data ? (
                <YouTubeChannelSummary channel={channel.data.data} fetchedAt={channel.data.freshness.fetched_at} />
              ) : channel.isPending ? loadingLine : null}

              {videos.data ? (
                <div className="space-y-3">
                  {nextPageFailed && nextPageErrorCode !== null ? (
                    <YouTubeResourceNotice
                      code={nextPageErrorCode}
                      retryAfterSeconds={retryHint(videos.error)}
                      onRetry={
                        nextPageErrorCode === "invalid_cursor"
                          ? () => {
                            trimVideosToFirstPage(queryClient, youtubeResourceKey(userId, activeAccountId, "videos"));
                            void videos.refetch();
                          }
                          : () => void videos.fetchNextPage()
                      }
                    />
                  ) : videos.isError ? (
                    <YouTubeResourceNotice
                      code={errorCode(videos.error)}
                      retryAfterSeconds={retryHint(videos.error)}
                      onRetry={() => void videos.refetch()}
                    />
                  ) : null}
                  <YouTubeVideoLibrary
                    key={activeAccountId ?? "none"}
                    videos={videoItems}
                    selectedVideoId={selectedVideoId}
                    onSelect={selectVideo}
                    hasMore={videos.hasNextPage}
                    isLoadingMore={videos.isFetching}
                    onLoadMore={() => {
                      if (!videos.isFetching) void videos.fetchNextPage();
                    }}
                  />
                </div>
              ) : videos.isError ? (
                <YouTubeResourceNotice
                  code={errorCode(videos.error)}
                  retryAfterSeconds={retryHint(videos.error)}
                  onRetry={() => void videos.refetch()}
                />
              ) : videos.isPending ? loadingLine : null}

            </div>
          )}
        </div>
      )}
      <YouTubeVideoDrawer
        open={selectedVideoId !== null}
        onOpenChange={(open) => {
          if (!open) closeVideo();
        }}
        locale={locale}
        video={video}
        canEdit={capabilities.data?.data.capabilities.edit_metadata?.state === "available"}
        accountId={activeAccountId}
        region={channel.data?.data.country ?? undefined}
        onSnapshot={async (videoId) => {
          if (!activeAccountId || !gateway.getEditSnapshot) return null;
          try {
            const result = await gateway.getEditSnapshot({ accountId: activeAccountId, videoId });
            return { revision: result.data.revision, values: result.data.values };
          } catch {
            return null;
          }
        }}
        onRequestPackagingScore={(params) => packagingScoreGateway.scorePackaging(params)}
        onSave={async ({ title, description, tags, categoryId, baseRevision }) => {
          if (!activeAccountId || !selectedVideoId || !gateway.updateVideo) return "outcome_unknown";
          try {
            const updated = await gateway.updateVideo({
              accountId: activeAccountId,
              videoId: selectedVideoId,
              baseRevision,
              changes: {
                title,
                description,
                tags,
                ...(categoryId ? { category_id: categoryId } : {}),
              },
            });
            // The saved answer is only a claim: the verified values live in the
            // video itself, so the drawer and the library read it again.
            await video.refetch();
            void videos.refetch();
            return { outcome: "saved", revision: updated.data.revision };
          } catch (error) {
            // The server's own code decides what the creator is told; anything
            // else is a write whose result is unknown.
            if (error instanceof YouTubeResourceError) {
              if (error.code === "edit_conflict") return "edit_conflict";
              if (error.code === "rate_limited" || error.code === "quota_exceeded") {
                return { outcome: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
              }
              if (
                error.code === "invalid_request"
                || error.code === "reconnect_required"
                || error.code === "missing_scope"
                || error.code === "provider_unsupported"
                || error.code === "write_not_enabled"
              ) {
                return "refused";
              }
            }
            return "outcome_unknown";
          }
        }}
        disabledReason={editDisabledReason}
        thumbnailCapability={thumbnailCapability}
        thumbnailCandidates={thumbnailMedia.data ?? []}
        thumbnailCandidatesLoading={thumbnailMedia.isPending}
        thumbnailCandidatesError={thumbnailMedia.error}
        onRetryThumbnailCandidates={() => void thumbnailMedia.refetch()}
        currentThumbnailUrl={video.data?.data.thumbnail_url ?? null}
        onUploadThumbnailImage={uploadThumbnailImage}
        onGenerateThumbnailImage={generateThumbnailImage}
        resolvedImageTiers={resolvedImageTiers}
        onSetThumbnail={gateway.setThumbnail ? async (mediaFileId) => {
          if (!activeAccountId || !selectedVideoId) return "outcome_unknown";
          let result: YouTubeThumbnailOutcome;
          try {
            await gateway.setThumbnail?.({ accountId: activeAccountId, videoId: selectedVideoId, mediaFileId });
            result = "applied";
          } catch (error) {
            const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
            result = thumbnailOutcomeFromErrorCode(code);
          }
          // An applied write and a lost answer both need a fresh read: only
          // the video's current thumbnail settles what viewers see.
          if (result === "applied" || result === "outcome_unknown") {
            await video.refetch();
            void videos.refetch();
          }
          return result;
        } : undefined}
        captionsCapability={captionsCapability}
        onListCaptions={gateway.listCaptions ? async (videoId) => {
          if (!activeAccountId) throw new YouTubeResourceError("upstream_unavailable");
          const result = await gateway.listCaptions({ accountId: activeAccountId, videoId });
          return result.data.items;
        } : undefined}
        onUploadCaption={gateway.uploadCaption ? async ({ videoId, language, name, format, content }) => {
          if (!activeAccountId) return { outcome: "refused", track: null };
          try {
            const result = await gateway.uploadCaption({ accountId: activeAccountId, videoId, language, name, format, content });
            return { outcome: "uploaded", track: result.data.track };
          } catch (error) {
            // A lost answer is not a refusal: the upload may already exist
            // on YouTube, and the creator has to refresh instead of retry.
            const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
            return { outcome: captionOutcomeFromErrorCode(code), track: null };
          }
        } : undefined}
      />
    </div>
  );
}
