import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { buildReturnUrl } from "@/lib/oauthRedirects";
import { refetchSocialQueries } from "./oauthUtils";
import type { OAuthConnectOptions } from "./useFacebookOAuth";
import type { IgAccountCard } from "@/components/profiles/InstagramSelectionDialog";

export interface IgSelectionData {
  selectionId: string;
  profileId: string | null;
  accounts: IgAccountCard[];
  /** The captured attempt that owns a protected selection. */
  attemptId?: string | null;
  /** The selection keys this attempt has already committed. */
  committedSelectionKeys?: string[];
}

export function useInstagramOAuth(
  setConnectingPlatform: (p: Platform | null) => void,
  setConnectingProfile: (p: string | null) => void,
  handleFacebookConnect: (
    targetPlatform: Platform,
    profileId: string,
    options?: OAuthConnectOptions,
  ) => Promise<void>,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [igSelectionData, setIgSelectionData] = useState<IgSelectionData | null>(null);
  const [selectingIg, setSelectingIg] = useState<string | null>(null);
  const [connectedIgIds, setConnectedIgIds] = useState<string[]>([]);
  const selectingRef = useRef<string | null>(null);

  /**
   * The explicit intent of the request.
   *
   * The backend captures it before it returns the authorization URL, so a
   * reconnect names the owned account it targets instead of hoping the
   * provider returns the same identity.
   */
  function intentBody(options: OAuthConnectOptions): Record<string, unknown> {
    if (options.mode === "reconnect" && options.socialAccountId) {
      return { intent: "reconnect", target_social_account_id: options.socialAccountId };
    }
    return {};
  }

  // ---------- Direct Instagram (Business Login) ----------
  const handleInstagramBusinessLogin = async (
    profileId: string,
    options: OAuthConnectOptions = {},
  ) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("instagram");
    setConnectingProfile(profileId);

    try {
      const { data, error } = await supabase.functions.invoke("instagram-oauth", {
        body: {
          action: "authorize",
          social_profile_id: profileId,
          return_to: buildReturnUrl("instagram"),
          ...intentBody(options),
        },
      });
      if (error) throw error;
      if (data?.url) {
        // The redirect only happens after the backend captured the intent.
        window.location.href = data.url;
      } else {
        throw new Error("No authorization URL received");
      }
    } catch (err) {
      console.error("Instagram Business Login error:", err);
      toast({
        title: "Connection failed",
        description: err instanceof Error ? err.message : "Failed to start Instagram connection",
        variant: "destructive",
      });
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  /**
   * TEMP legacy shim — kept so `useOAuthRedirectHandler` can still process
   * in-flight sessions whose provider redirected to `/profiles` instead of
   * the new backend GET callback.
   */
  const handleInstagramBusinessCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("instagram");
    try {
      const { data, error } = await supabase.functions.invoke("instagram-oauth", {
        body: {
          action: "callback",
          code,
          user_id: user?.id,
          social_profile_id: profileId,
        },
      });
      if (error) throw error;

      if (data?.error === "personal_account") {
        const { data: flagData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "feature_instagram_via_facebook")
          .maybeSingle();

        const igViaFbEnabled = flagData?.value === true;

        if (igViaFbEnabled) {
          toast({
            title: "Personal Account Detected",
            description:
              "Your Instagram account is Personal. Personal accounts must be connected through a Facebook Page. Redirecting to Facebook connection...",
          });
          setTimeout(() => {
            handleFacebookConnect("instagram" as Platform, profileId);
          }, 1500);
        } else {
          toast({
            title: "Personal Account Not Supported",
            description:
              "Your Instagram account is a Personal account. Please switch to a Business or Creator account in Instagram Settings → Account → Switch to Professional Account, then try again.",
            variant: "destructive",
          });
        }
        return;
      }

      if (data?.success) {
        toast({
          title: "Instagram connected!",
          description: data.username
            ? `Connected account: @${data.username} (Direct)`
            : "Your Instagram account has been connected successfully.",
        });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete Instagram connection");
      }
    } catch (err) {
      console.error("Instagram Business callback error:", err);
      toast({
        title: "Connection failed",
        description: err instanceof Error ? err.message : "Failed to connect Instagram",
        variant: "destructive",
      });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  // ---------- Instagram via Facebook Business ----------
  const connectInstagramViaFacebookBusiness = async (
    profileId: string,
    options: OAuthConnectOptions = {},
  ) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("instagram");
    setConnectingProfile(profileId);

    try {
      const { data, error } = await supabase.functions.invoke(
        "instagram-business-oauth",
        {
          body: {
            action: "authorize",
            social_profile_id: profileId,
            return_to: buildReturnUrl("instagramBusiness"),
            ...intentBody(options),
          },
        },
      );
      if (error) throw error;
      if (data?.error) {
        throw new Error(data.error);
      }
      if (data?.url) {
        // The redirect only happens after the backend captured the intent.
        window.location.href = data.url;
      } else {
        throw new Error("No authorization URL received");
      }
    } catch (err) {
      console.error("Instagram (Facebook Business) error:", err);
      toast({
        title: "Connection failed",
        description:
          err instanceof Error
            ? err.message
            : "Failed to start Instagram Business connection",
        variant: "destructive",
      });
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  const connectInstagramDirect = (profileId: string, options: OAuthConnectOptions = {}) =>
    handleInstagramBusinessLogin(profileId, options);

  const handleInstagramConnect = async (
    profileId: string,
    flow: "direct" | "facebook_business",
    options: OAuthConnectOptions = {},
  ) => {
    if (flow === "facebook_business") {
      await connectInstagramViaFacebookBusiness(profileId, options);
      return;
    }
    await connectInstagramDirect(profileId, options);
  };

  // ---------- Card picker (Facebook Business candidates) ----------
  const loadPendingInstagramSelection = async (selectionId: string) => {
    if (!user) return;
    try {
      const { data, error } = await supabase.functions.invoke(
        "instagram-business-oauth",
        {
          body: {
            action: "get_pending_selection",
            user_id: user.id,
            selection_id: selectionId,
          },
        },
      );
      if (error || !data?.success) {
        const status = (error as { context?: { status?: number } } | null)?.context?.status;
        const isExpired = status === 404 || /not found|expired/i.test(String(data?.error ?? ""));
        toast({
          title: isExpired ? "Selection expired" : "Couldn't load Instagram accounts",
          description: isExpired
            ? "The Instagram selection link expired. Please reconnect."
            : (error instanceof Error ? error.message : "Please try connecting again."),
          variant: "destructive",
        });
        return;
      }
      setConnectedIgIds([]);
      setIgSelectionData({
        selectionId,
        profileId: data.social_profile_id ?? null,
        accounts: (data.ig_accounts ?? []) as IgAccountCard[],
        attemptId: data.attempt_id ?? null,
        committedSelectionKeys: data.committed_selection_keys || [],
      });
      setConnectingPlatform("instagram");
      setConnectingProfile(data.social_profile_id ?? null);
    } catch (err) {
      console.error("loadPendingInstagramSelection failed:", err);
    }
  };

  const handleSelectIgAccount = async (igUserId: string, selectionKey?: string) => {
    if (!igSelectionData || !user) return;
    if (selectingRef.current) return;
    const protectedAttempt = Boolean(igSelectionData.attemptId && selectionKey);
    if (igSelectionData.attemptId && !selectionKey) {
      toast({
        title: "Connection failed",
        description: "This account cannot be selected. Please reconnect.",
        variant: "destructive",
      });
      return;
    }
    selectingRef.current = igUserId;
    setSelectingIg(igUserId);
    try {
      const body: Record<string, unknown> = {
        action: "store_ig_account",
        user_id: user.id,
        social_profile_id: igSelectionData.profileId,
      };
      if (protectedAttempt) {
        // Canonical protected shape: attempt id plus the opaque key.
        body.attempt_id = igSelectionData.attemptId;
        body.selection_key = selectionKey;
      } else {
        body.selection_id = igSelectionData.selectionId;
        body.ig_user_id = igUserId;
      }
      const { data, error } = await supabase.functions.invoke(
        "instagram-business-oauth",
        { body },
      );
      if (error || !data?.success) {
        throw new Error(data?.error || (error instanceof Error ? error.message : "Failed to connect account"));
      }
      const subscriptionFailed = data.subscription?.status === "failed";
      const connected = data.ig_username
        ? `Connected @${data.ig_username}${data.facebook_page_name ? ` (via ${data.facebook_page_name})` : ""}`
        : "Account connected.";
      toast({
        title: "Instagram connected!",
        description: subscriptionFailed
          ? `${connected} The webhook subscription could not be confirmed.`
          : connected,
      });
      setConnectedIgIds((prev) => Array.from(new Set([...prev, igUserId])));
      refetchSocialQueries(queryClient);
      if (protectedAttempt && selectionKey) {
        const committed = [...(igSelectionData.committedSelectionKeys ?? []), selectionKey];
        const remaining = igSelectionData.accounts.some(
          (account) => account.selection_key && !committed.includes(account.selection_key),
        );
        if (remaining) {
          setIgSelectionData({ ...igSelectionData, committedSelectionKeys: committed });
        } else {
          setIgSelectionData(null);
          setConnectingPlatform(null);
          setConnectingProfile(null);
        }
      }
    } catch (err) {
      console.error("Instagram select error:", err);
      toast({
        title: "Connection failed",
        description: err instanceof Error ? err.message : "Failed to connect account",
        variant: "destructive",
      });
    } finally {
      selectingRef.current = null;
      setSelectingIg(null);
    }
  };

  const clearIgSelection = () => {
    const selectionId = igSelectionData?.selectionId;
    setIgSelectionData(null);
    setSelectingIg(null);
    setConnectedIgIds([]);
    setConnectingPlatform(null);
    setConnectingProfile(null);
    if (selectionId && user) {
      // Fire-and-forget cleanup. A protected selection is retained on the
      // server until it expires, and the server reports that truthfully. The
      // dialog closes either way and never claims a deletion.
      supabase.functions
        .invoke("instagram-business-oauth", {
          body: {
            action: "clear_pending_selection",
            user_id: user.id,
            selection_id: selectionId,
          },
        })
        .catch(() => undefined);
    }
  };

  return {
    handleInstagramBusinessLogin,
    handleInstagramBusinessCallback,
    handleInstagramConnect,
    connectInstagramDirect,
    connectInstagramViaFacebookBusiness,
    igSelectionData,
    selectingIg,
    connectedIgIds,
    loadPendingInstagramSelection,
    handleSelectIgAccount,
    clearIgSelection,
  };
}
