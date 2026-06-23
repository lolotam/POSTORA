import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { refetchSocialQueries } from "./oauthUtils";

export type LinkedInFlow = "personal" | "organization";

export function useLinkedInOAuth(
  setConnectingPlatform: (p: any) => void,
  setConnectingProfile: (p: string | null) => void,
) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const handleLinkedInConnect = async (
    profileId: string,
    flow: LinkedInFlow = "personal",
  ) => {
    if (!user) throw new Error("Not authenticated");
    setConnectingPlatform("linkedin");
    setConnectingProfile(profileId);
    try {
      // Note: do not forward user_id or redirect_uri from the client.
      // The edge function derives identity from the JWT and forces the redirect URI
      // from LINKEDIN_REDIRECT_URI server-side.
      const { data, error } = await supabase.functions.invoke("linkedin-oauth", {
        body: {
          action: "authorize",
          social_profile_id: profileId,
          flow,
          return_to: `${window.location.origin}/profiles`,
        },
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No authorization URL received");
      }
    } catch (error) {
      setConnectingPlatform(null);
      setConnectingProfile(null);
      throw error;
    }
  };

  const connectLinkedInPersonal = (profileId: string) =>
    handleLinkedInConnect(profileId, "personal");
  const connectLinkedInOrganization = (profileId: string) =>
    handleLinkedInConnect(profileId, "organization");

  // Legacy POST-callback shim (kept for any in-flight client sessions).
  const handleLinkedInCallback = async (code: string, profileId: string) => {
    setConnectingPlatform("linkedin");
    try {
      const { data, error } = await supabase.functions.invoke("linkedin-oauth", {
        body: { action: "callback", code, user_id: user?.id, social_profile_id: profileId },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "LinkedIn connected!", description: data.username ? `Connected account: ${data.username}` : "Your LinkedIn account has been connected successfully." });
        refetchSocialQueries(queryClient);
      } else {
        throw new Error(data?.error || "Failed to complete LinkedIn connection");
      }
    } catch (error) {
      console.error("LinkedIn callback error:", error);
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Failed to connect LinkedIn", variant: "destructive" });
    } finally {
      setConnectingPlatform(null);
      setConnectingProfile(null);
    }
  };

  return {
    handleLinkedInConnect,
    connectLinkedInPersonal,
    connectLinkedInOrganization,
    handleLinkedInCallback,
  };
}
