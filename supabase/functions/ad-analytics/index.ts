import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  appSettingReadResult,
  configurationClientError,
  createAppSettingLookup,
  loadFacebookCredentialSettings,
} from "../_shared/facebookCredentialMode.ts";
import {
  CredentialStoreError,
  createFacebookUserCredentialStore,
  createInstagramAccountCapabilityStore,
  createServiceRpcCaller,
  credentialReadClientError,
  type RpcCapableClient,
} from "../_shared/facebookUserCredentialStore.ts";
import {
  resolveProtectedUserToken,
  type ProtectedCredentialDeps,
} from "../_shared/protectedFacebookCredentials.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * The protected Facebook User token for one owned account.
 *
 * In protected mode the token comes from the owner-scoped protected authority
 * and from nowhere else: not from `account_metadata.user_token`, not from the
 * Page token, and not from a username-shaped lookup. A missing protected
 * credential is a typed failure, never a silent fallback to a Page-token guess
 * that `me/adaccounts` would reject.
 */
async function resolveAdAccountToken(
  supabase: RpcCapableClient,
  userId: string,
  socialAccountId: string,
): Promise<
  | { token: string }
  | { error: string; status: number; error_code: string }
> {
  const rpc = createServiceRpcCaller(supabase);
  const deps: ProtectedCredentialDeps = {
    credentials: createFacebookUserCredentialStore(rpc),
    capabilities: createInstagramAccountCapabilityStore(rpc),
  };

  try {
    const resolved = await resolveProtectedUserToken(deps, {
      userId,
      socialAccountId,
    });
    return { token: resolved.token };
  } catch (error) {
    if (error instanceof CredentialStoreError) {
      const clientError = credentialReadClientError(error);
      console.error("[ad-analytics] protected credential unavailable", {
        event: "protected_credential_unavailable",
        error_code: clientError.error_code,
        account_id: socialAccountId,
      });
      return { error: clientError.error, status: clientError.status, error_code: clientError.error_code };
    }
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action, social_account_id } = body;

    // Server-controlled credential mode. Resolved BEFORE any protected-schema
    // access, so legacy mode never touches the protected authority and never
    // changes where the User token comes from.
    const { credentialMode } = await loadFacebookCredentialSettings(
      createAppSettingLookup(async (key) => {
        const { data, error } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", key)
          .maybeSingle();
        return appSettingReadResult(data, error);
      }),
    );

    // Get access token and account metadata
    const { data: account, error: accountError } = await supabase
      .from("social_accounts")
      .select("access_token, platform_user_id, platform, account_metadata")
      .eq("id", social_account_id)
      .eq("user_id", userId)
      .single();

    if (accountError) {
      console.error("[ad-analytics] account read failed", { event: "account_read_failed" });
      return new Response(JSON.stringify({
        error_code: "ACCOUNT_READ_FAILED",
        error: "The social account could not be read.",
      }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!account?.access_token) {
      return new Response(JSON.stringify({ error: "Social account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { access_token: accessToken, platform_user_id: platformUserId } = account;
    // User-level token for ad account queries (me/adaccounts requires user token, not page token).
    // Protected mode never reads it from account metadata: the protected
    // authority is the only source there.
    const userToken = credentialMode === "protected"
      ? undefined
      : (account.account_metadata as Record<string, unknown>)?.user_token as string | undefined;
    let result: unknown;

    switch (action) {
      case "get_ad_accounts": {
        // me/adaccounts requires a user-level token, not a page token
        let adToken = userToken;
        if (credentialMode === "protected") {
          // The User token comes from the owner-scoped protected authority and
          // from nowhere else. There is no fallback to the Page token: a Page
          // token is not a User token, and a guess that happens to work is a
          // credential bug, not a fallback.
          const protectedToken = await resolveAdAccountToken(supabase, userId, social_account_id);
          if ("error" in protectedToken) {
            return new Response(JSON.stringify({
              error_code: protectedToken.error_code,
              error: protectedToken.error,
            }), {
              status: protectedToken.status,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          adToken = protectedToken.token;
        } else if (!adToken) {
          console.warn("No user_token found in account_metadata, falling back to page token (may fail)");
          adToken = accessToken;
        }
        const url = `${GRAPH_API_BASE}/me/adaccounts?fields=id,name,account_status,currency,balance,amount_spent&access_token=${adToken}`;
        const res = await fetch(url);
        result = await res.json();
        break;
      }

      case "get_campaigns": {
        const { ad_account_id, date_preset = "last_30d" } = body;
        if (!ad_account_id) {
          return new Response(JSON.stringify({ error: "ad_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${GRAPH_API_BASE}/${ad_account_id}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,insights.date_preset(${date_preset}){impressions,reach,clicks,spend,cpc,cpm,ctr,actions}&limit=50&access_token=${accessToken}`;
        const res = await fetch(url);
        result = await res.json();
        break;
      }

      case "get_adsets": {
        const { campaign_id, date_preset = "last_30d" } = body;
        if (!campaign_id) {
          return new Response(JSON.stringify({ error: "campaign_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${GRAPH_API_BASE}/${campaign_id}/adsets?fields=id,name,status,targeting,daily_budget,lifetime_budget,insights.date_preset(${date_preset}){impressions,reach,clicks,spend,cpc,cpm,ctr,actions}&limit=50&access_token=${accessToken}`;
        const res = await fetch(url);
        result = await res.json();
        break;
      }

      case "get_ads": {
        const { adset_id, date_preset = "last_30d" } = body;
        if (!adset_id) {
          return new Response(JSON.stringify({ error: "adset_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${GRAPH_API_BASE}/${adset_id}/ads?fields=id,name,status,creative{title,body,image_url,thumbnail_url},insights.date_preset(${date_preset}){impressions,reach,clicks,spend,cpc,cpm,ctr,actions}&limit=50&access_token=${accessToken}`;
        const res = await fetch(url);
        result = await res.json();
        break;
      }

      case "get_account_insights": {
        const { ad_account_id, date_preset = "last_30d", time_increment = 1 } = body;
        if (!ad_account_id) {
          return new Response(JSON.stringify({ error: "ad_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${GRAPH_API_BASE}/${ad_account_id}/insights?fields=impressions,reach,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type&date_preset=${date_preset}&time_increment=${time_increment}&access_token=${accessToken}`;
        const res = await fetch(url);
        result = await res.json();
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const config = configurationClientError(error);
    if (config) {
      console.error("[ad-analytics] credential configuration refused", { event: config.error_code });
      return new Response(JSON.stringify({ error_code: config.error_code, error: config.error }), {
        status: config.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (error instanceof CredentialStoreError) {
      const clientError = credentialReadClientError(error);
      console.error("[ad-analytics] protected credential unavailable", { event: clientError.error_code });
      return new Response(JSON.stringify({
        error_code: clientError.error_code,
        error: clientError.error,
      }), {
        status: clientError.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("Ad Analytics API error:", error instanceof Error ? error.name : "unknown");
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
