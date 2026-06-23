import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { refetchSocialQueries } from "./oauthUtils";

export function useInstagramOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
  handleFacebookConnect: (targetPlatform: Platform, profileId: string) => Promise<void>,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleInstagramBusinessLogin = async (profileId: string) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("instagram");
    setConnectingProfile(profileId);

    const fixedRedirectUri = "https://postora.cloud/profiles";

    try {
      const { data, error } = await supabase.functions.invoke("instagram-oauth", {
        body: { action: "authorize", user_id: user.id, social_profile_id: profileId, redirect_uri: fixedRedirectUri },
      });
      if (error) throw error;
      if (data?.url) { window.location.href = data.url; } else { throw new Error("No authorization URL received"); }
    } catch (error) {
      console.error("Instagram Business Login error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to start Instagram connection", variant: "destructive" });
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  const handleInstagramBusinessCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("instagram");
    const fixedRedirectUri = "https://postora.cloud/profiles";

    try {
      const { data, error } = await supabase.functions.invoke("instagram-oauth", {
        body: { action: "callback", code, redirect_uri: fixedRedirectUri, user_id: user?.id, social_profile_id: profileId },
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
          toast({ title: "Personal Account Detected", description: "Your Instagram account is Personal. Personal accounts must be connected through a Facebook Page. Redirecting to Facebook connection..." });
          setTimeout(() => { handleFacebookConnect("instagram" as Platform, profileId); }, 1500);
        } else {
          toast({
            title: "Personal Account Not Supported",
            description: "Your Instagram account is a Personal account. Please switch to a Business or Creator account in Instagram Settings → Account → Switch to Professional Account, then try again.",
            variant: "destructive",
          });
        }
        return;
      }

      if (data?.success) {
        toast({ title: "Instagram connected!", description: data.username ? `Connected account: @${data.username} (Direct)` : "Your Instagram account has been connected successfully." });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete Instagram connection");
      }
    } catch (error) {
      console.error("Instagram Business callback error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect Instagram", variant: "destructive" });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  /**
   * Unified Instagram connect entry point. Routes to the appropriate flow:
   * - "direct": Direct Instagram Business Login (instagram-oauth)
   * - "facebook_business": Connect via Facebook Pages (instagram-business-oauth)
   */
  const handleInstagramConnect = async (
    profileId: string,
    flow: "direct" | "facebook_business",
  ) => {
    if (flow === "facebook_business") {
      if (!user) throw new Error("Not authenticated");
      setConnectingPlatform("instagram");
      setConnectingProfile(profileId);
      try {
        const { data, error } = await supabase.functions.invoke(
          "instagram-business-oauth",
          {
            body: {
              action: "authorize",
              user_id: user.id,
              social_profile_id: profileId,
              flow: "facebook_business",
              return_to: `${window.location.origin}/profiles`,
            },
          },
        );
        if (error) throw error;
        if (data?.url) {
          window.location.href = data.url;
        } else {
          // Backend may not be deployed yet — fall back to existing Facebook flow.
          await handleFacebookConnect("instagram" as Platform, profileId);
        }
      } catch (err) {
        console.error("Instagram (Facebook Business) error:", err);
        // Safe fallback to existing Pages flow.
        await handleFacebookConnect("instagram" as Platform, profileId);
      }
      return;
    }
    await handleInstagramBusinessLogin(profileId);
  };

  return { handleInstagramBusinessLogin, handleInstagramBusinessCallback, handleInstagramConnect };
}
