import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PINTEREST_APP_ID = Deno.env.get("PINTEREST_CLIENT_ID");
const PINTEREST_APP_SECRET = Deno.env.get("PINTEREST_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Unified backend redirect URI. Provider console MUST register exactly this.
const PINTEREST_REDIRECT_URI =
  Deno.env.get("PINTEREST_REDIRECT_URI") ??
  `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/pinterest-oauth`;

const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";
const PINTEREST_SCOPES =
  "pins:read,pins:write,boards:read,boards:write,user_accounts:read";

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

interface PinterestTokenData {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  scopes?: string;
  error?: string;
  error_description?: string;
  message?: string;
}

async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
): Promise<PinterestTokenData> {
  const tokenResponse = await fetch(
    "https://api.pinterest.com/v5/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(
          `${PINTEREST_APP_ID}:${PINTEREST_APP_SECRET}`,
        )}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    },
  );
  return await tokenResponse.json();
}

async function savePinterestAccount(
  supabase: SupabaseClient,
  user_id: string,
  social_profile_id: string | null,
  tokenData: PinterestTokenData,
): Promise<{ username: string }> {
  if (tokenData.error || !tokenData.access_token) {
    throw new Error(
      tokenData.message ||
        tokenData.error_description ||
        tokenData.error ||
        "Pinterest token exchange failed",
    );
  }

  const { access_token, refresh_token, expires_in } = tokenData;

  const userResponse = await fetch(
    "https://api.pinterest.com/v5/user_account",
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  const userData = await userResponse.json();
  if (!userResponse.ok) {
    throw new Error(userData.message || "Failed to get user info");
  }

  const username = userData.username || userData.id;
  const rawAvatarUrl = userData.profile_image;
  const grantedScopes = tokenData.scope || tokenData.scopes || "";
  const hasWriteAccess =
    grantedScopes.includes("pins:write") ||
    grantedScopes.includes("boards:write");
  const accessLevel = hasWriteAccess ? "standard" : "trial";

  const tokenExpiresAt = new Date(
    Date.now() + (expires_in ?? 2592000) * 1000,
  ).toISOString();
  const avatarUrl = await cacheAvatarToCloudinary(
    rawAvatarUrl,
    user_id,
    "pinterest",
    userData.id,
  );

  const { error: dbError } = await supabase.from("social_accounts").upsert(
    {
      user_id,
      platform: "pinterest",
      platform_user_id: userData.id,
      platform_username: username,
      access_token,
      refresh_token,
      token_expires_at: tokenExpiresAt,
      avatar_url: avatarUrl,
      is_active: true,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      social_profile_id: social_profile_id || null,
      account_metadata: {
        business_type: userData.account_type,
        has_write_access: hasWriteAccess,
        access_level: accessLevel,
        granted_scopes: grantedScopes,
      },
    },
    { onConflict: "user_id,platform,platform_user_id" },
  );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save Pinterest account");
  }

  return { username };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ============================================================
  // Provider callback: GET /functions/v1/pinterest-oauth?code=...&state=...
  // ============================================================
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    try {
      if (errorParam) {
        const ret = new URL(RETURN_URL_DEFAULT);
        ret.searchParams.set("connected", "pinterest");
        ret.searchParams.set("error", errorParam);
        return Response.redirect(ret.toString(), 302);
      }
      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }
      if (!PINTEREST_APP_ID || !PINTEREST_APP_SECRET) {
        return new Response("Pinterest credentials not configured", { status: 500 });
      }

      const payload = await verifyOAuthState(state, {
        expectedPlatform: "pinterest",
      });
      const tokenData = await exchangeCodeForToken(code, PINTEREST_REDIRECT_URI);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await savePinterestAccount(
        supabase,
        payload.user_id,
        payload.profile_id ?? null,
        tokenData,
      );

      const ret = new URL(payload.return_to ?? RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "pinterest");
      if (payload.profile_id) ret.searchParams.set("profile_id", payload.profile_id);
      return Response.redirect(ret.toString(), 302);
    } catch (err) {
      console.error("Pinterest GET callback error:", err);
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "pinterest");
      ret.searchParams.set("error", "pinterest_callback_failed");
      return Response.redirect(ret.toString(), 302);
    }
  }

  // ============================================================
  // POST API: authorize + legacy callback + refresh
  // ============================================================
  try {
    const body = await req.json().catch(() => ({}));
    const { action, code, redirect_uri, social_profile_id, return_to } = body;

    console.log("Pinterest OAuth action:", action);

    if (action === "authorize") {
      if (!PINTEREST_APP_ID) throw new Error("PINTEREST_APP_ID not configured");

      const { userId: user_id } = await authenticateCaller(req, body.user_id);
      const effectiveRedirect = PINTEREST_REDIRECT_URI;

      const state = await createOAuthState({
        platform: "pinterest",
        user_id,
        profile_id: social_profile_id ?? null,
        return_to: return_to ?? RETURN_URL_DEFAULT,
      });

      const authUrl =
        `https://www.pinterest.com/oauth/?client_id=${PINTEREST_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(effectiveRedirect)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(PINTEREST_SCOPES)}` +
        `&state=${encodeURIComponent(state)}`;

      return new Response(
        JSON.stringify({
          url: authUrl,
          redirect_uri: effectiveRedirect,
          // Frontend-supplied value retained in response for observability;
          // backend ignores it for the actual flow.
          requested_redirect_uri: redirect_uri ?? null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Legacy POST callback used by the old /oauth/pinterest/callback shim.
    if (action === "callback") {
      const { userId: user_id } = await authenticateCaller(req, body.user_id);
      if (!code) throw new Error("Missing code");
      if (!redirect_uri) throw new Error("Missing redirect_uri");
      if (!PINTEREST_APP_ID || !PINTEREST_APP_SECRET) {
        throw new Error("Pinterest credentials not configured");
      }

      const tokenData = await exchangeCodeForToken(code, redirect_uri);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { username } = await savePinterestAccount(
        supabase,
        user_id,
        social_profile_id ?? null,
        tokenData,
      );
      return new Response(JSON.stringify({ success: true, username }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "refresh") {
      if (!PINTEREST_APP_ID || !PINTEREST_APP_SECRET) {
        throw new Error("Pinterest credentials not configured");
      }
      const { refresh_token: currentRefreshToken, account_id } = body;
      if (!account_id) throw new Error("Missing account_id");

      const tokenResponse = await fetch(
        "https://api.pinterest.com/v5/oauth/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(
              `${PINTEREST_APP_ID}:${PINTEREST_APP_SECRET}`,
            )}`,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: currentRefreshToken,
          }),
        },
      );
      const tokenData = await tokenResponse.json();
      if (tokenData.error || !tokenResponse.ok) {
        throw new Error(
          tokenData.message || tokenData.error || "Failed to refresh token",
        );
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase
        .from("social_accounts")
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || currentRefreshToken,
          token_expires_at: new Date(
            Date.now() + tokenData.expires_in * 1000,
          ).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", account_id);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Pinterest OAuth error:", error);
    return new Response(
      JSON.stringify({ error: "Authentication failed. Please try again." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
