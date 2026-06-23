import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { refetchSocialQueries } from "./oauthUtils";

export function useRedditOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleRedditConnect = async (profileId: string) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("reddit");
    setConnectingProfile(profileId);
    try {
      const { data, error } = await supabase.functions.invoke("reddit-oauth", {
        body: {
          action: "authorize",
          social_profile_id: profileId,
          return_to: `${window.location.origin}/profiles`,
        },
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No authorization URL received");
      }
    } catch (err) {
      setConnectingPlatform(null);
      setConnectingProfile(null);
      throw err;
    }
  };

  const handleRedditCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("reddit");
    try {
      const { data, error } = await supabase.functions.invoke("reddit-oauth", {
        body: { action: "callback", code, social_profile_id: profileId },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "Reddit connected!", description: data.username ? `Connected account: u/${data.username}` : "Your Reddit account has been connected successfully." });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete Reddit connection");
      }
    } catch (error) {
      console.error("Reddit callback error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect Reddit", variant: "destructive" });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  return { handleRedditConnect, handleRedditCallback };
}
