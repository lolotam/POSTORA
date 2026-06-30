import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { OAUTH_CALLBACKS, buildReturnUrl } from "@/lib/oauthRedirects";
import { refetchSocialQueries } from "./oauthUtils";

export function useTikTokOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleTikTokConnect = async (
    profileId: string,
    options: { mode?: "connect" | "reconnect"; socialAccountId?: string } = {},
  ) => {
    const isReconnect = options.mode === "reconnect" && !!options.socialAccountId;
    // Unified backend callback. profile_id + return_to travel in the signed
    // state, not in the registered redirect URI.
    sessionStorage.setItem("tiktok_profile_id", profileId);

    const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
      body: {
        action: "authorize",
        social_profile_id: profileId,
        return_to: buildReturnUrl("tiktok"),
        ...(isReconnect
          ? { mode: "reconnect", social_account_id: options.socialAccountId }
          : {}),
      },
    });

    if (error) throw error;
    if (data?.error) {
      throw new Error(data.error);
    }
    if (data?.url) {
      window.location.href = data.url;
    } else {
      throw new Error("No authorization URL received");
    }
  };

  // Legacy callback handler kept for the old /tiktok-callback page until the
  // provider console fully cuts over to the backend redirect URI.
  const handleTikTokCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("tiktok");
    try {
      const redirectUri = OAUTH_CALLBACKS.tiktok;
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: {
          action: "callback",
          code,
          redirect_uri: redirectUri,
          user_id: user?.id,
          social_profile_id: profileId,
        },
      });
      if (error) throw error;
      if (data?.success) {
        toast({
          title: "TikTok connected!",
          description: "Your TikTok account has been connected successfully.",
        });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete TikTok connection");
      }
    } catch (error) {
      console.error("TikTok callback error:", error);
      toast({
        title: "Connection failed",
        description:
          error instanceof Error ? error.message : "Failed to connect TikTok",
        variant: "destructive",
      });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  return { handleTikTokConnect, handleTikTokCallback };
}
