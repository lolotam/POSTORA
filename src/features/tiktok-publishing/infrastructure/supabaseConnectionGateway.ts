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
        // return_to travels in the signed state: the edge function finishes the exchange and sends the user
        // back to Integrations (it adds ?connected=tiktok).
        body: {
          action: "authorize",
          redirect_uri: TIKTOK_REDIRECT_URI,
          return_to: `${window.location.origin}/integrations`,
        },
      });
      if (error) throw new ReviewGatewayError("INTERNAL", error.message || "Could not start the TikTok connection.", 502);
      const url = (data as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || !url) {
        throw new ReviewGatewayError("INTERNAL", "TikTok did not return an authorization link.", 502);
      }
      sessionStorage.setItem(TIKTOK_RETURN_KEY, "integrations");
      return withForcedConsent(url);
    },

    async disconnect(accountId) {
      // The function also revokes Postora in TikTok, so reconnecting shows TikTok's permission screen again.
      const { error } = await supabase.functions.invoke("tiktok-oauth", {
        body: { action: "disconnect", social_account_id: accountId },
      });
      if (!error) return;
      // The frontend can ship before the edge function is redeployed; an older function answers
      // "Invalid action". Deactivate the account directly then, as before (no TikTok revoke).
      if (!(await isInvalidAction(error))) {
        throw new ReviewGatewayError("INTERNAL", error.message || "Could not disconnect the TikTok account.", 502);
      }
      const { error: updateError } = await supabase
        .from("social_accounts")
        .update({ is_active: false })
        .eq("id", accountId)
        .eq("platform", "tiktok");
      if (updateError) throw new ReviewGatewayError(updateError.code || "INTERNAL", updateError.message, 500);
    },
  };
}

/**
 * TikTok skips its permission screen for a user who approved Postora before; `disable_auto_auth=1` makes it
 * appear on every connect. Added here as well as in the edge function so it holds whichever deploys first.
 */
function withForcedConsent(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("disable_auto_auth", "1");
  return parsed.toString();
}

async function isInvalidAction(error: { context?: unknown }): Promise<boolean> {
  if (!(error.context instanceof Response) || error.context.status !== 400) return false;
  const body = await error.context.clone().json().catch(() => null) as { error?: unknown } | null;
  return body?.error === "Invalid action";
}
