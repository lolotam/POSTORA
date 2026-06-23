import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { refetchSocialQueries } from "./oauthUtils";

interface CallbackHandlers {
  handleTikTokCallback: (code: string, profileId: string) => Promise<void>;
  handleYouTubeCallback: (code: string, profileId: string) => Promise<void>;
  handleLinkedInCallback: (code: string, profileId: string) => Promise<void>;
  handleTwitterCallback: (code: string, profileId: string) => Promise<void>;
  handleThreadsCallback: (code: string, profileId: string) => Promise<void>;
  handleRedditCallback: (code: string, profileId: string) => Promise<void>;
  handleInstagramBusinessCallback: (code: string, profileId: string) => Promise<void>;
  handleBlueskyOAuthCallback: (code: string, state: string, profileId: string) => Promise<void>;
  loadPendingFacebookSelection?: (selectionId: string) => Promise<void>;
}


export function useOAuthRedirectHandler(handlers: CallbackHandlers) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Handle OAuth errors from URL params
  useEffect(() => {
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");
    const errorReason = searchParams.get("error_reason");
    const errorType = searchParams.get("error_type");

    if (error) {
      let errorMessage = "Failed to connect account";
      if (error === "access_denied" || errorReason === "user_denied") {
        errorMessage = "You denied the required permissions. Please try again and accept all permissions to connect your account.";
      } else if (error === "invalid_scope") {
        errorMessage = `Invalid scope requested. ${errorType ? `Type: ${errorType}` : ""} This usually means the app doesn't have permission for video.upload/video.publish scopes.`;
      } else if (errorDescription) {
        errorMessage = decodeURIComponent(errorDescription.replace(/\+/g, " "));
      }

      const fullError = `${error}${errorType ? ` (${errorType})` : ""}${errorDescription ? `: ${decodeURIComponent(errorDescription)}` : ""}`;
      sessionStorage.setItem("tiktok_last_error", fullError);
      sessionStorage.setItem("tiktok_last_error_timestamp", new Date().toISOString());

      toast({ title: "Connection cancelled", description: errorMessage, variant: "destructive" });
      setSearchParams({});
    }
  }, [searchParams, toast, setSearchParams]);

  // Handle OAuth code callbacks
  useEffect(() => {
    const code = searchParams.get("code");
    const platform = searchParams.get("platform");
    const profileId = searchParams.get("profile_id");

    if (code && platform === "tiktok" && user && profileId) { handlers.handleTikTokCallback(code, profileId); setSearchParams({}); return; }
    if (code && platform === "youtube" && user && profileId) { handlers.handleYouTubeCallback(code, profileId); setSearchParams({}); return; }
    if (code && platform === "linkedin" && user && profileId) { handlers.handleLinkedInCallback(code, profileId); setSearchParams({}); return; }
    if (code && platform === "twitter" && user && profileId) { handlers.handleTwitterCallback(code, profileId); setSearchParams({}); return; }
    if (code && platform === "threads" && user && profileId) { handlers.handleThreadsCallback(code, profileId); setSearchParams({}); return; }
    if (code && platform === "reddit" && user && profileId) { handlers.handleRedditCallback(code, profileId); setSearchParams({}); return; }
    if (code && platform === "instagram_business" && user && profileId) { handlers.handleInstagramBusinessCallback(code, profileId); setSearchParams({}); return; }

    // Handle state-based OAuth callbacks
    const oauthState = searchParams.get("state");
    if (code && !platform && oauthState && user) {
      try {
        const stateData = JSON.parse(atob(oauthState));
        if (stateData.platform === "instagram_business" && stateData.social_profile_id) {
          handlers.handleInstagramBusinessCallback(code, stateData.social_profile_id);
          setSearchParams({});
          return;
        }
        if (stateData.social_profile_id && stateData.return_to && !stateData.platform && !stateData.handle) {
          handlers.handleThreadsCallback(code, stateData.social_profile_id).finally(() => setSearchParams({}));
          return;
        }
      } catch { /* Not valid state */ }
    }

    // Handle Bluesky OAuth callback
    const blueskyState = searchParams.get("state");
    const blueskyCode = searchParams.get("code");
    if (blueskyCode && blueskyState && user) {
      try {
        const stateJson = atob(blueskyState.replace(/-/g, "+").replace(/_/g, "/"));
        const stateData = JSON.parse(stateJson);
        if (stateData.handle && stateData.social_profile_id) {
          handlers.handleBlueskyOAuthCallback(blueskyCode, blueskyState, stateData.social_profile_id);
          setSearchParams({});
          return;
        }
      } catch { /* Not Bluesky */ }
    }
  }, [searchParams, user]);

  // Handle successful server-side OAuth redirects
  useEffect(() => {
    const connected = searchParams.get("connected");
    const channel = searchParams.get("channel");
    const accountName = searchParams.get("account_name");
    const selectionId = searchParams.get("select");

    if (!connected) return;

    // Facebook backend-callback page selection handoff.
    if (connected === "facebook" && selectionId && handlers.loadPendingFacebookSelection && user) {
      handlers.loadPendingFacebookSelection(selectionId);
      const next = new URLSearchParams(searchParams);
      next.delete("connected");
      next.delete("select");
      setSearchParams(next);
      return;
    }


    const platformMessages: Record<string, { title: string; description: string }> = {
      youtube: { title: "YouTube connected!", description: channel ? `Connected channel: ${channel}` : "Your YouTube channel has been connected successfully." },
      pinterest: { title: "Pinterest connected!", description: "Your Pinterest account has been connected successfully." },
      linkedin: { title: "LinkedIn connected!", description: accountName ? `Connected account: ${accountName}` : "Your LinkedIn account has been connected successfully." },
      twitter: { title: "Twitter/X connected!", description: accountName ? `Connected account: @${accountName}` : "Your Twitter/X account has been connected successfully." },
      bluesky: { title: "Bluesky connected!", description: accountName ? `Connected account: @${accountName}` : "Your Bluesky account has been connected successfully via OAuth." },
      threads: { title: "Threads connected!", description: accountName ? `Connected account: @${accountName}` : "Your Threads account has been connected successfully." },
      reddit: { title: "Reddit connected!", description: accountName ? `Connected account: u/${accountName}` : "Your Reddit account has been connected successfully." },
    };

    const msg = platformMessages[connected];
    if (msg) {
      toast(msg);
      refetchSocialQueries(queryClient);
      setSearchParams({});
    }
  }, [searchParams, toast, setSearchParams]);

  // Cleanup localStorage on mount
  useEffect(() => {
    localStorage.removeItem("fb_oauth_profile_id");
    localStorage.removeItem("fb_oauth_platform");
  }, []);
}
