import { supabase } from "@/integrations/supabase/client";
import type { TikTokConnectionGateway } from "../application/connectionPort";
import { ReviewGatewayError } from "../application/ports";

/** Registered with TikTok; the callback page finishes the exchange and returns to Integrations. */
const TIKTOK_REDIRECT_URI = "https://postora.cloud/tiktok-callback";
/** Read by TikTokCallback to send the user back to the review shell's Integrations page. */
export const TIKTOK_RETURN_KEY = "tiktok_review_return";

export function createSupabaseConnectionGateway(): TikTokConnectionGateway {
  return {
    async authorizeUrl() {
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: { action: "authorize", redirect_uri: TIKTOK_REDIRECT_URI },
      });
      if (error) throw new ReviewGatewayError("INTERNAL", error.message || "Could not start the TikTok connection.", 502);
      const url = (data as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || !url) {
        throw new ReviewGatewayError("INTERNAL", "TikTok did not return an authorization link.", 502);
      }
      sessionStorage.setItem(TIKTOK_RETURN_KEY, "integrations");
      return url;
    },

    async disconnect(accountId) {
      const { error } = await supabase
        .from("social_accounts")
        .update({ is_active: false })
        .eq("id", accountId)
        .eq("platform", "tiktok");
      if (error) throw new ReviewGatewayError(error.code || "INTERNAL", error.message, 500);
    },
  };
}
