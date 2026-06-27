import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { refetchSocialQueries } from "./oauthUtils";

export function useLinkedInOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleLinkedInConnect = async (profileId: string) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("linkedin");
    setConnectingProfile(profileId);
    try {
      // Single unified pathway: backend always requests the full member +
      // organization scope set. The user picks where to publish later from
      // inside the app.
      const { data, error } = await supabase.functions.invoke("linkedin-oauth", {
        body: {
          action: "authorize",
          user_id: user.id,
          social_profile_id: profileId,
          return_to: `${window.location.origin}/profiles`,
        },
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data?.error || "No authorization URL received");
      }
    } catch (error) {
      setConnectingPlatform(null);
      setConnectingProfile(null);
      console.error("LinkedIn connect error:", error);
      toast({
        title: "LinkedIn connection failed",
        description: error instanceof Error ? error.message : "Failed to start LinkedIn authorization",
        variant: "destructive",
      });
      throw error;
    }
  };

  // Legacy POST-callback shim (kept for any in-flight client sessions).
  const handleLinkedInCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("linkedin");
    try {
      const { data, error } = await supabase.functions.invoke("linkedin-oauth", {
        body: { action: "callback", code, user_id: user?.id, social_profile_id: profileId },
      });
      if (error) throw error;
      if (data?.success) {
        toast({
          title: "LinkedIn connected!",
          description: data.username
            ? `Connected account: ${data.username}`
            : "Your LinkedIn account has been connected successfully.",
        });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete LinkedIn connection");
      }
    } catch (error) {
      console.error("LinkedIn callback error:", error);
      toast({
        title: "Connection failed",
        description: error instanceof Error ? error.message : "Failed to connect LinkedIn",
        variant: "destructive",
      });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  return {
    handleLinkedInConnect,
    handleLinkedInCallback,
  };
}
