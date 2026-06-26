import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { getPlatformName } from "@/components/PlatformIcon";
import { facebookLogin, FacebookLoginFailureReason } from "@/lib/facebookSdk";
import { refetchSocialQueries, linkAccountToProfile } from "./oauthUtils";

export interface FacebookPage {
  id: string;
  name: string;
  has_instagram?: boolean;
  picture_url?: string;
}

export interface StandaloneInstagram {
  id: string;
  username: string;
  profile_picture_url?: string;
}

export interface PageSelectionData {
  pages: FacebookPage[];
  standaloneInstagram: StandaloneInstagram[];
  profileId: string;
  providerToken: string | null;
  selectionId: string | null;
  platform: Platform;
}


export function useFacebookOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pageSelectionData, setPageSelectionData] = useState<PageSelectionData | null>(null);
  const [selectingPage, setSelectingPage] = useState<string | null>(null);

  const storeFacebookOAuthDebug = (reason: FacebookLoginFailureReason, diagnostics: Record<string, unknown>) => {
    try {
      const entry = { reason, ...diagnostics };
      const stored = sessionStorage.getItem("oauth_errors");
      const errors = stored ? JSON.parse(stored) : [];
      errors.unshift({ platform: "facebook", error: reason, timestamp: new Date().toISOString(), details: JSON.stringify(entry) });
      sessionStorage.setItem("oauth_errors", JSON.stringify(errors.slice(0, 10)));
      sessionStorage.setItem("fb_last_oauth_debug", JSON.stringify(entry));
    } catch { /* ignore */ }
  };

  const handleFacebookConnect = async (targetPlatform: Platform, profileId: string) => {
    if (!user) throw new Error("Not authenticated");

    const scopes = [
      "email", "public_profile", "pages_show_list", "pages_read_engagement",
      "pages_manage_posts", "pages_manage_engagement", "pages_read_user_content", "business_management",
      "pages_manage_metadata", "pages_messaging", "read_insights",
      "instagram_basic", "instagram_content_publish", "instagram_manage_comments",
      "instagram_manage_messages",
      "whatsapp_business_messaging", "whatsapp_business_management",
      "ads_read", "ads_management",
      "leads_retrieval", "pages_manage_ads",
    ];

    const loginResult = await facebookLogin(scopes);

    if (!loginResult.success) {
      const reason = loginResult.failureReason || "unknown";
      storeFacebookOAuthDebug(reason, loginResult.diagnostics);

      switch (reason) {
        case "user_cancelled":
          throw new Error("You closed the Facebook login window. Please try again and complete the authorization.");
        case "not_authorized":
          throw new Error("Facebook returned 'Not Authorized'. This usually means the app permissions are restricted. Please check that the Meta app is in Live mode and all required permissions have Advanced Access.");
        case "sdk_load_failed":
        case "sdk_timeout":
          throw new Error("The Facebook SDK failed to load. This can be caused by an ad-blocker, network issue, or browser privacy settings. Please disable your ad-blocker for this site and try again.");
        case "popup_blocked":
          throw new Error("Your browser blocked the Facebook login popup. Please allow popups for this site and try again.");
        case "feature_unavailable":
          throw new Error("Facebook returned 'Feature Unavailable'. This means the app is missing required configuration. Please verify: 1) App is in Live mode, 2) All permissions have Advanced Access, 3) This domain is added to App Domains and JavaScript SDK allowed domains in the Meta Developer Portal.");
        default:
          throw new Error(`Facebook login failed (${reason}). Check the Connection Troubleshooter for diagnostic details.`);
      }
    }

    const providerToken = loginResult.response.authResponse!.accessToken;

    const { data, error } = await supabase.functions.invoke("facebook-oauth", {
      body: { action: "store_account", user_id: user.id, provider_token: providerToken, platform: targetPlatform, social_profile_id: profileId },
    });

    if (error) throw error;

    if (data?.success) {
      if (data.needs_page_selection && data.pages && data.pages.length > 1) {
        setPageSelectionData({ pages: data.pages, standaloneInstagram: data.standalone_instagram || [], profileId, providerToken, selectionId: null, platform: targetPlatform });
        return;
      }

      await linkAccountToProfile(user.id, targetPlatform, profileId);

      if (data.warning) {
        toast({ title: "Facebook connected with limitations", description: data.warning, variant: "destructive", duration: 10000 });
        if (data.help) console.log("Facebook connection help:", data.help);
        refetchSocialQueries(queryClient);
      } else {
        const description = data.page_name
          ? `Connected Facebook Page: ${data.page_name}${data.has_instagram ? " (with Instagram)" : ""}`
          : `Your ${getPlatformName(targetPlatform)} account has been connected successfully.`;
        toast({ title: "Connected!", description });
        refetchSocialQueries(queryClient);
      }
    } else {
      throw new Error(data?.error || "Failed to store account");
    }
  };

  const handleSelectPage = async (pageId: string) => {
    if (!pageSelectionData || !user) return;
    setSelectingPage(pageId);
    try {
      const storeBody: Record<string, unknown> = {
        action: "store_page", user_id: user.id, page_id: pageId, social_profile_id: pageSelectionData.profileId,
      };
      if (pageSelectionData.selectionId) storeBody.selection_id = pageSelectionData.selectionId;
      else if (pageSelectionData.providerToken) storeBody.provider_token = pageSelectionData.providerToken;
      const { data, error } = await supabase.functions.invoke("facebook-oauth", { body: storeBody });

      if (error) throw error;
      if (data?.success) {
        await linkAccountToProfile(user.id, pageSelectionData.platform, pageSelectionData.profileId);
        toast({ title: "Facebook Page connected!", description: `Connected: ${data.page_name}${data.has_instagram ? " (with Instagram)" : ""}` });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to store page");
      }
    } catch (error) {
      console.error("Page selection error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect page", variant: "destructive" });
    } finally {
      setSelectingPage(null);
      setPageSelectionData(null);
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  const handleSelectStandaloneInstagram = async (igAccount: StandaloneInstagram) => {
    if (!pageSelectionData || !user) return;
    setSelectingPage(igAccount.id);
    try {
      const storeBody: Record<string, unknown> = {
        action: "store_instagram", user_id: user.id,
        instagram_account_id: igAccount.id, instagram_username: igAccount.username,
        instagram_profile_picture: igAccount.profile_picture_url, social_profile_id: pageSelectionData.profileId,
      };
      if (pageSelectionData.selectionId) storeBody.selection_id = pageSelectionData.selectionId;
      else if (pageSelectionData.providerToken) storeBody.provider_token = pageSelectionData.providerToken;
      const { data, error } = await supabase.functions.invoke("facebook-oauth", { body: storeBody });

      if (error) throw error;
      if (data?.success) {
        await linkAccountToProfile(user.id, "instagram", pageSelectionData.profileId);
        toast({ title: "Instagram connected!", description: `Connected standalone account: @${data.instagram_username}` });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to store Instagram account");
      }
    } catch (error) {
      console.error("Standalone Instagram selection error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect Instagram", variant: "destructive" });
    } finally {
      setSelectingPage(null);
      setPageSelectionData(null);
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  const clearPageSelection = () => {
    setPageSelectionData(null);
    setConnectingPlatform(null);
    setConnectingProfile(null);
  };

  // New unified backend callback path. Opens Meta authorize URL minted by the
  // edge function; Facebook redirects to the backend, which 302s back with
  // `?connected=facebook&select=<id>` so we can hydrate the page picker.
  const handleFacebookConnectBackend = async (targetPlatform: Platform, profileId: string) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform(targetPlatform);
    setConnectingProfile(profileId);
    const { data, error } = await supabase.functions.invoke("facebook-oauth", {
      body: {
        action: "authorize",
        target_platform: targetPlatform === "instagram" ? "instagram" : "facebook",
        social_profile_id: profileId,
        return_to: `${window.location.origin}/profiles`,
      },
    });
    if (error || !data?.url) {
      setConnectingPlatform(null);
      setConnectingProfile(null);
      throw error || new Error("Failed to start Facebook authorization");
    }
    window.location.assign(data.url);
  };

  // Called after the GET callback redirects back with ?connected=facebook&select=<id>.
  const loadPendingFacebookSelection = async (selectionId: string) => {
    if (!user) return;
    const { data, error } = await supabase.functions.invoke("facebook-oauth", {
      body: { action: "get_pending_selection", user_id: user.id, selection_id: selectionId },
    });
    if (error || !data?.success) {
      // Distinguish "expired/not found" (404) from transport/server errors so
      // the user is not falsely told their link expired when the function is
      // down. supabase-js surfaces the HTTP status on FunctionsHttpError.
      const status = (error as { context?: { status?: number } } | null)?.context?.status;
      const isExpired = status === 404 || /not found|expired/i.test(String(data?.error ?? ""));
      toast({
        title: isExpired ? "Connection expired" : "Connection failed",
        description: isExpired
          ? "The Facebook selection link expired. Please reconnect."
          : (error instanceof Error ? error.message : "Could not load your Facebook selection. Please try again."),
        variant: "destructive",
      });
      return;
    }
    const platform: Platform = data.target_platform === "instagram" ? "instagram" : "facebook";
    setPageSelectionData({
      pages: data.pages || [],
      standaloneInstagram: data.standalone_instagram || [],
      profileId: data.social_profile_id,
      providerToken: null,
      selectionId,
      platform,
    });
    setConnectingPlatform(platform);
    setConnectingProfile(data.social_profile_id);
  };

  return {
    pageSelectionData, selectingPage,
    handleFacebookConnect, handleFacebookConnectBackend,
    handleSelectPage, handleSelectStandaloneInstagram,
    clearPageSelection, loadPendingFacebookSelection,
  };
}

