import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { ExtendedPlatform } from "@/lib/platformConstants";
import {
  useFacebookOAuth,
  useTikTokOAuth,
  useYouTubeOAuth,
  usePinterestOAuth,
  useLinkedInOAuth,
  useTwitterOAuth,
  useThreadsOAuth,
  useBlueskyOAuth,
  useRedditOAuth,
  useInstagramOAuth,
  useOAuthRedirectHandler,
} from "./oauth";

// Re-export types for backward compatibility
export type { FacebookPage, StandaloneInstagram, PageSelectionData } from "./oauth";

export interface InstagramConnectMethodData {
  profileId: string;
}

export function useProfileOAuth() {
  const [connectingProfile, setConnectingProfile] = useState<string | null>(null);
  const [connectingPlatform, setConnectingPlatform] = useState<Platform | null>(null);

  const { toast } = useToast();
  const { user } = useAuth();

  // Platform-specific hooks
  const { handleTikTokConnect, handleTikTokCallback } = useTikTokOAuth(setConnectingPlatform, setConnectingProfile);
  const { handleYouTubeConnect, handleYouTubeCallback } = useYouTubeOAuth(setConnectingPlatform, setConnectingProfile);
  const { handlePinterestConnect } = usePinterestOAuth();
  const { handleLinkedInConnect, handleLinkedInCallback } = useLinkedInOAuth(setConnectingPlatform, setConnectingProfile);
  const { handleTwitterConnect, handleTwitterCallback } = useTwitterOAuth(setConnectingPlatform, setConnectingProfile);
  const { handleThreadsConnect, handleThreadsCallback } = useThreadsOAuth(setConnectingPlatform, setConnectingProfile);
  const { blueskyDialogData, handleBlueskyOAuthConnect, handleBlueskyOAuthCallback, handleBlueskyConnect, clearBlueskyDialog } = useBlueskyOAuth(setConnectingPlatform, setConnectingProfile);
  const { handleRedditConnect, handleRedditCallback } = useRedditOAuth(setConnectingPlatform, setConnectingProfile);
  const { pageSelectionData, selectingPage, handleFacebookConnect, handleSelectPage, handleSelectStandaloneInstagram, clearPageSelection, loadPendingFacebookSelection } = useFacebookOAuth(setConnectingPlatform, setConnectingProfile);
  const {
    handleInstagramBusinessLogin,
    handleInstagramBusinessCallback,
    handleInstagramConnect,
    igSelectionData,
    selectingIg,
    connectedIgIds,
    loadPendingInstagramSelection,
    handleSelectIgAccount,
    clearIgSelection,
  } = useInstagramOAuth(setConnectingPlatform, setConnectingProfile, handleFacebookConnect);

  // Handle OAuth redirects from URL params
  const { instagramConfirmUsername, dismissInstagramConfirm } = useOAuthRedirectHandler({
    handleTikTokCallback,
    handleYouTubeCallback,
    handleLinkedInCallback,
    handleTwitterCallback,
    handleThreadsCallback,
    handleRedditCallback,
    handleInstagramBusinessCallback,
    handleBlueskyOAuthCallback,
    loadPendingFacebookSelection,
    loadPendingInstagramSelection,
  });

  const handleConnectPlatform = async (profileId: string, platform: Platform) => {
    return invokePlatform(profileId, platform);
  };

  /**
   * Reconnect mode: identical OAuth flow but passes the existing
   * social_account_id so the backend updates the row in place instead of
   * (re)inserting. Used by the dashboard expired-token banner and the
   * profile "Reconnect" button.
   */
  const handleReconnectPlatform = async (
    profileId: string,
    platform: Platform,
    socialAccountId: string,
  ) => {
    return invokePlatform(profileId, platform, {
      mode: "reconnect",
      socialAccountId,
    });
  };

  async function invokePlatform(
    profileId: string,
    platform: Platform,
    options: { mode?: "connect" | "reconnect"; socialAccountId?: string } = {},
  ) {
    if (!user) {
      toast({ title: "Not authenticated", description: "Please log in to connect accounts.", variant: "destructive" });
      return;
    }

    setConnectingProfile(profileId);
    setConnectingPlatform(platform);

    try {
      // `options` is only consumed by the platforms whose OAuth function implements an
      // explicit reconnect mode (TikTok, Pinterest, Twitter): they use social_account_id
      // to update that exact row after an ownership check. The others upsert on
      // (user_id, platform, platform_user_id), which already targets the existing row,
      // so there is nothing for them to do with it.
      if (platform === "tiktok") {
        await handleTikTokConnect(profileId, options);
      } else if (platform === "instagram") {
        // Instagram needs the user to choose between Business Login and the
        // Facebook-Business flow, and that picker lives on the Profiles page. Returning
        // silently here made the dashboard banner's Reconnect button look broken.
        setConnectingPlatform(null);
        setConnectingProfile(null);
        toast({
          title: "Reconnect Instagram from Profiles",
          description:
            "Instagram needs you to pick a login method. Open the Profiles page and use Reconnect there.",
        });
        return;
      } else if (platform === "facebook") {
        await handleFacebookConnect(platform, profileId);
      } else if ((platform as ExtendedPlatform) === "youtube") {
        await handleYouTubeConnect(profileId);
      } else if ((platform as ExtendedPlatform) === "pinterest") {
        await handlePinterestConnect(profileId, options);
      } else if (platform === "linkedin") {
        await handleLinkedInConnect(profileId);
      } else if (platform === "twitter") {
        await handleTwitterConnect(profileId, options);
      } else if (platform === "threads") {
        await handleThreadsConnect(profileId);
      } else if (platform === "bluesky") {
        await handleBlueskyConnect(profileId);
      } else if (platform === "reddit") {
        await handleRedditConnect(profileId);
      }
    } catch (error) {
      console.error("Connection error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect account", variant: "destructive" });
      setConnectingProfile(null);
      setConnectingPlatform(null);
    }
  }

  return {
    connectingProfile,
    connectingPlatform,
    pageSelectionData,
    selectingPage,
    blueskyDialogData,
    handleConnectPlatform,
    handleReconnectPlatform,
    handleSelectPage,
    handleSelectStandaloneInstagram,
    handleBlueskyConnect,
    handleBlueskyOAuthConnect,
    handleFacebookConnect,
    handleInstagramBusinessLogin,
    handleInstagramConnect,
    handleLinkedInConnect,
    clearPageSelection,
    clearBlueskyDialog,
    igSelectionData,
    selectingIg,
    connectedIgIds,
    handleSelectIgAccount,
    clearIgSelection,
    instagramConfirmUsername,
    dismissInstagramConfirm,
  };
}
