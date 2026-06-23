import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { buildReturnUrl } from "@/lib/oauthRedirects";

export function usePinterestOAuth() {
  const { user } = useAuth();

  const handlePinterestConnect = async (profileId: string) => {
    if (!user) throw new Error("Not authenticated");

    // Unified backend callback. profile_id + return_to travel in the signed
    // state, generated server-side. The frontend no longer sends redirect_uri.
    const { data, error } = await supabase.functions.invoke("pinterest-oauth", {
      body: {
        action: "authorize",
        social_profile_id: profileId,
        return_to: buildReturnUrl("pinterest"),
      },
    });
    if (error) throw error;
    if (data?.url) {
      window.location.href = data.url;
    } else {
      throw new Error("No authorization URL received");
    }
  };

  return { handlePinterestConnect };
}
