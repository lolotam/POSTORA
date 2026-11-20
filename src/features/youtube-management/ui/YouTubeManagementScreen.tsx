import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { YouTubeResourceErrorCode } from "../domain/types";
import { YouTubeResourceError } from "../domain/errors";
import type { YouTubeAccountOption } from "../domain/accountOptions";
import { useYouTubeCapabilities } from "../application/useYouTubeCapabilities";
import { useYouTubeChannel } from "../application/useYouTubeChannel";
import { useYouTubeVideos } from "../application/useYouTubeVideos";
import { useYouTubeVideo } from "../application/useYouTubeVideo";
import type { YouTubeResourcesGateway } from "../application/ports";
import { defaultYouTubeResourcesGateway } from "../infrastructure/supabaseYouTubeResourcesGateway";
import { YouTubeResourceNotice } from "./YouTubeResourceNotice";
import { YouTubeAccountPicker } from "./YouTubeAccountPicker";
import { YouTubeChannelSummary } from "./YouTubeChannelSummary";
import { YouTubeVideoLibrary } from "./YouTubeVideoLibrary";
import { YouTubeVideoDetail } from "./YouTubeVideoDetail";

export interface YouTubeManagementScreenProps {
  accounts: readonly YouTubeAccountOption[];
  accountsLoading: boolean;
  gateway?: YouTubeResourcesGateway;
}

// The composition root of the feature: the only ui/ file allowed to import
// infrastructure (for the default gateway), which every test replaces.
export function YouTubeManagementScreen(props: YouTubeManagementScreenProps): JSX.Element {
  const { accounts, accountsLoading, gateway = defaultYouTubeResourcesGateway } = props;
  const { t } = useTranslation("accounts");

  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  const activeAccountId = pickedAccountId !== null && accounts.some((account) => account.id === pickedAccountId)
    ? pickedAccountId
    : accounts[0]?.id ?? null;
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);

  const capabilities = useYouTubeCapabilities({ gateway, accountId: activeAccountId });
  const browse = capabilities.data?.data.capabilities.browse;
  const canBrowse = browse !== undefined && browse.state !== "unavailable";

  const channel = useYouTubeChannel({ gateway, accountId: activeAccountId, enabled: canBrowse });
  const videos = useYouTubeVideos({ gateway, accountId: activeAccountId, enabled: canBrowse });
  const video = useYouTubeVideo({ gateway, accountId: activeAccountId, videoId: selectedVideoId, enabled: canBrowse && selectedVideoId !== null });

  const errorCode = (error: unknown): YouTubeResourceErrorCode =>
    error instanceof YouTubeResourceError ? error.code : "upstream_unavailable";
  const retryHint = (error: unknown): number | null =>
    error instanceof YouTubeResourceError ? error.retryAfterSeconds : null;

  const videoItems = videos.data?.pages.flatMap((page) => page.data.items) ?? [];

  const refresh = () => {
    void channel.refetch();
    void videos.refetch();
  };

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
                setSelectedVideoId(null);
              }}
            />
            <Button size="sm" variant="outline" onClick={refresh}>
              {t("youtubeManagement.refresh", "Refresh")}
            </Button>
          </div>

          {capabilities.isError ? (
            <YouTubeResourceNotice
              code={errorCode(capabilities.error)}
              retryAfterSeconds={retryHint(capabilities.error)}
              onRetry={() => void capabilities.refetch()}
            />
          ) : browse?.state === "unavailable" ? (
            <YouTubeResourceNotice
              code={browse.reason}
              retryAfterSeconds={null}
              onRetry={() => void capabilities.refetch()}
            />
          ) : (
            <div className="space-y-4">
              {channel.isError ? (
                <YouTubeResourceNotice
                  code={errorCode(channel.error)}
                  retryAfterSeconds={retryHint(channel.error)}
                  onRetry={() => void channel.refetch()}
                />
              ) : channel.data ? (
                <YouTubeChannelSummary channel={channel.data.data} fetchedAt={channel.data.freshness.fetched_at} />
              ) : null}

              {videos.isError ? (
                <YouTubeResourceNotice
                  code={errorCode(videos.error)}
                  retryAfterSeconds={retryHint(videos.error)}
                  onRetry={() => void videos.refetch()}
                />
              ) : videos.data ? (
                <YouTubeVideoLibrary
                  videos={videoItems}
                  selectedVideoId={selectedVideoId}
                  onSelect={setSelectedVideoId}
                  hasMore={videos.hasNextPage}
                  isLoadingMore={videos.isFetchingNextPage}
                  onLoadMore={() => void videos.fetchNextPage()}
                />
              ) : null}

              {video.isError ? (
                <YouTubeResourceNotice
                  code={errorCode(video.error)}
                  retryAfterSeconds={retryHint(video.error)}
                  onRetry={() => void video.refetch()}
                />
              ) : video.data ? (
                <YouTubeVideoDetail video={video.data.data} fetchedAt={video.data.freshness.fetched_at} />
              ) : selectedVideoId === null ? (
                <p className="text-sm text-muted-foreground">
                  {t("youtubeManagement.detail.select", "Select a video to see its details.")}
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
