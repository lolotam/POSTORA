import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { OAUTH_CALLBACKS, buildReturnUrl } from "@/lib/oauthRedirects";

export function useThreadsOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleThreadsConnect = async (profileId: string) => {
    if (!user) throw new Error("Not authenticated");
    if (typeof window !== "undefined" && window.location.protocol !== "https:") {
      toast({
        title: "Threads requires HTTPS",
        description:
          "Meta blocks Threads OAuth from insecure origins. Please test from https://postora.lovable.app/profiles or https://postora.cloud/profiles.",
        variant: "destructive",
      });
      setConnectingPlatform(null);
      setConnectingProfile(null);
      return;
    }
    const { data, error } = await supabase.functions.invoke("threads-oauth", {
      body: {
        action: "authorize",
        social_profile_id: profileId,
        return_to: buildReturnUrl("threads"),
      },
    });
    if (error) throw error;
    if (data?.url) { window.location.href = data.url; } else { throw new Error("No authorization URL received"); }
  };

  // Legacy shim: only triggers when the provider still redirects to
  // /profiles?code=&state= (old base64 state). Removable once the
  // Threads developer console no longer lists the /profiles redirect URI.
  const handleThreadsCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("threads");
    try {
      const { data, error } = await supabase.functions.invoke("threads-oauth", {
        body: {
          action: "callback",
          code,
          redirect_uri: OAUTH_CALLBACKS.threads,
          user_id: user?.id,
          social_profile_id: profileId,
        },
      });
      if (error) throw error;
      if (data?.success) {
        const dedupeKey = `oauth_toast_shown:threads:${data.username ?? ""}:`;
        if (!sessionStorage.getItem(dedupeKey)) {
          sessionStorage.setItem(dedupeKey, String(Date.now()));
          setTimeout(() => sessionStorage.removeItem(dedupeKey), 10_000);
          toast({ title: "Threads connected!", description: data.username ? `Connected account: @${data.username}` : "Your Threads account has been connected successfully." });
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
        await queryClient.refetchQueries({ queryKey: ["social_accounts"] });
        await queryClient.refetchQueries({ queryKey: ["social_accounts_by_profile"] });
        await queryClient.refetchQueries({ queryKey: ["social_profiles"] });
        await queryClient.refetchQueries({ queryKey: ["all_social_accounts"] });
      } else {
        throw new Error(data?.error || "Failed to complete Threads connection");
      }
    } catch (error) {
      console.error("Threads callback error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect Threads", variant: "destructive" });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  return { handleThreadsConnect, handleThreadsCallback };
}
