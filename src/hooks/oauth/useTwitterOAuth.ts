import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Platform } from "@/lib/types";
import { refetchSocialQueries } from "./oauthUtils";

export function useTwitterOAuth(
  setConnectingPlatform: (p: Platform | null) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleTwitterConnect = async (
    profileId: string,
    options: { mode?: "connect" | "reconnect"; socialAccountId?: string } = {},
  ) => {
    if (!user) throw new Error("Not authenticated");
    const isReconnect = options.mode === "reconnect" && !!options.socialAccountId;
    const { data, error } = await supabase.functions.invoke("twitter-oauth", {
      body: {
        action: "authorize",
        user_id: user.id,
        social_profile_id: profileId,
        return_to: `${window.location.origin}/profiles`,
        ...(isReconnect
          ? { mode: "reconnect", social_account_id: options.socialAccountId }
          : {}),
      },
    });
    if (error) throw error;
    if (data?.url) { window.location.href = data.url; } else { throw new Error("No authorization URL received"); }
  };

  const handleTwitterCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("twitter");
    try {
      const { data, error } = await supabase.functions.invoke("twitter-oauth", {
        body: { action: "callback", code, user_id: user?.id, social_profile_id: profileId },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "Twitter/X connected!", description: data.username ? `Connected account: @${data.username}` : "Your Twitter/X account has been connected successfully." });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete Twitter connection");
      }
    } catch (error) {
      console.error("Twitter callback error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect Twitter/X", variant: "destructive" });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  return { handleTwitterConnect, handleTwitterCallback };
}
