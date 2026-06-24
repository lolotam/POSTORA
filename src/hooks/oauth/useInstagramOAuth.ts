import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { buildReturnUrl } from "@/lib/oauthRedirects";
import { refetchSocialQueries } from "./oauthUtils";

export function useInstagramOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
  handleFacebookConnect: (targetPlatform: Platform, profileId: string) => Promise<void>,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // ---------- Direct Instagram (Business Login) ----------
  const handleInstagramBusinessLogin = async (profileId: string) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("instagram");
    setConnectingProfile(profileId);

    try {
      const { data, error } = await supabase.functions.invoke("instagram-oauth", {
        body: {
          action: "authorize",
          social_profile_id: profileId,
          return_to: buildReturnUrl("instagram"),
        },
      });
      if (error) throw error;
      if (data?.url) {
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
   * the new backend GET callback. Remove once the GET-302 path is verified
   * in production for 24–48h.
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
  const connectInstagramViaFacebookBusiness = async (profileId: string) => {
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
          },
        },
      );
      if (error) throw error;
      if (data?.error) {
        throw new Error(data.error);
      }
      if (data?.url) {
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

  const connectInstagramDirect = (profileId: string) =>
    handleInstagramBusinessLogin(profileId);

  /**
   * Unified Instagram connect entry point. Routes to the appropriate flow.
   */
  const handleInstagramConnect = async (
    profileId: string,
    flow: "direct" | "facebook_business",
  ) => {
    if (flow === "facebook_business") {
      await connectInstagramViaFacebookBusiness(profileId);
      return;
    }
    await connectInstagramDirect(profileId);
  };

  return {
    handleInstagramBusinessLogin,
    handleInstagramBusinessCallback,
    handleInstagramConnect,
    connectInstagramDirect,
    connectInstagramViaFacebookBusiness,
  };
}
