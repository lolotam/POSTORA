import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { refetchSocialQueries, linkAccountToProfile } from "./oauthUtils";

export interface FacebookPage {
  id: string;
  name: string;
  has_instagram?: boolean;
  picture_url?: string;
  /**
   * The opaque authority of a protected candidate. The protected store action
   * accepts the attempt id plus this key, never a page name or a username.
   */
  selection_key?: string;
}

export interface StandaloneInstagram {
  id: string;
  username: string;
  profile_picture_url?: string;
  selection_key?: string;
}

export interface PageSelectionData {
  pages: FacebookPage[];
  standaloneInstagram: StandaloneInstagram[];
  profileId: string;
  providerToken: string | null;
  selectionId: string | null;
  platform: Platform;
  /** The captured attempt that owns a protected selection. */
  attemptId?: string | null;
  /** The selection keys this attempt has already committed. */
  committedSelectionKeys?: string[];
}

/**
 * The explicit intent of a connection request.
 *
 * The options are carried from the caller, through the Instagram flow choice
 * and into the backend authorization request, so the server captures the
 * intent before the provider is contacted. They are never inferred from the
 * provider result.
 */
export interface OAuthConnectOptions {
  mode?: "connect" | "reconnect";
  /** The owned account a reconnect targets. */
  socialAccountId?: string;
}


export function useFacebookOAuth(
  setConnectingPlatform: (p: Platform | null) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pageSelectionData, setPageSelectionData] = useState<PageSelectionData | null>(null);
  const [selectingPage, setSelectingPage] = useState<string | null>(null);
  const selectingRef = useRef<string | null>(null);

  /**
   * Starts the Meta authorization through the backend.
   *
   * The backend captures the explicit intent before it returns the
   * authorization URL, so the redirect only happens after the capture is
   * durable. The JavaScript-SDK provider-token path cannot carry that intent
   * and is refused by the server in protected mode.
   */
  const handleFacebookConnect = async (
    targetPlatform: Platform,
    profileId: string,
    options: OAuthConnectOptions = {},
  ) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform(targetPlatform);
    setConnectingProfile(profileId);

    try {
      const { data, error } = await supabase.functions.invoke("facebook-oauth", {
        body: {
          action: "authorize",
          target_platform: targetPlatform === "instagram" ? "instagram" : "facebook",
          social_profile_id: profileId,
          return_to: `${window.location.origin}/profiles`,
          ...(options.mode === "reconnect" && options.socialAccountId
            ? { intent: "reconnect", target_social_account_id: options.socialAccountId }
            : {}),
        },
      });
      if (error) throw error;
      if (!data?.url) throw new Error("Failed to start Facebook authorization");
      window.location.assign(data.url);
    } catch (err) {
      setConnectingPlatform(null);
      setConnectingProfile(null);
      throw err;
    }
  };

  const handleSelectPage = async (pageId: string, selectionKey?: string) => {
    if (!pageSelectionData || !user) return;
    if (selectingRef.current) return;
    const protectedAttempt = Boolean(pageSelectionData.attemptId && selectionKey);
    if (pageSelectionData.attemptId && !selectionKey) {
      toast({
        title: "Connection failed",
        description: "This page cannot be selected. Please reconnect.",
        variant: "destructive",
      });
      return;
    }
    selectingRef.current = pageId;
    setSelectingPage(pageId);
    try {
      const storeBody: Record<string, unknown> = {
        action: "store_page", user_id: user.id, social_profile_id: pageSelectionData.profileId,
      };
      if (protectedAttempt) {
        // The attempt id plus the opaque key is the only authority.
        storeBody.attempt_id = pageSelectionData.attemptId;
        storeBody.selection_key = selectionKey;
      } else {
        storeBody.page_id = pageId;
        if (pageSelectionData.selectionId) storeBody.selection_id = pageSelectionData.selectionId;
        else if (pageSelectionData.providerToken) storeBody.provider_token = pageSelectionData.providerToken;
      }
      const { data, error } = await supabase.functions.invoke("facebook-oauth", { body: storeBody });

      if (error) throw error;
      if (data?.success) {
        const subscriptionFailed = data.subscription?.status === "failed";
        const description = subscriptionFailed
          ? `Connected: ${data.page_name}${data.has_instagram ? " (with Instagram)" : ""}. The webhook subscription could not be confirmed.`
          : `Connected: ${data.page_name}${data.has_instagram ? " (with Instagram)" : ""}`;
        if (!protectedAttempt) {
          // The legacy writer still binds the account to the profile itself.
          // The protected writer binds the profile inside the SQL transaction.
          await linkAccountToProfile(user.id, pageSelectionData.platform, pageSelectionData.profileId);
        }
        toast({ title: "Facebook Page connected!", description });
        refetchSocialQueries(queryClient);
        if (protectedAttempt && selectionKey) {
          const committed = [...(pageSelectionData.committedSelectionKeys ?? []), selectionKey];
          const remaining = [...pageSelectionData.pages, ...pageSelectionData.standaloneInstagram]
            .some((choice) => choice.selection_key && !committed.includes(choice.selection_key));
          if (remaining) {
            setPageSelectionData({ ...pageSelectionData, committedSelectionKeys: committed });
          } else {
            setPageSelectionData(null);
          }
        } else {
          setPageSelectionData(null);
        }
      } else {
        throw new Error(data?.error || "Failed to store page");
      }
    } catch (error) {
      console.error("Page selection error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect page", variant: "destructive" });
      if (!protectedAttempt) setPageSelectionData(null);
    } finally {
      selectingRef.current = null;
      setSelectingPage(null);
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
      attemptId: data.attempt_id ?? null,
      committedSelectionKeys: data.committed_selection_keys || [],
    });
    setConnectingPlatform(platform);
    setConnectingProfile(data.social_profile_id);
  };

  return {
    pageSelectionData, selectingPage,
    handleFacebookConnect,
    handleSelectPage, handleSelectStandaloneInstagram,
    clearPageSelection, loadPendingFacebookSelection,
  };
}
