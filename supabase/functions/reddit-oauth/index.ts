import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REDDIT_CLIENT_ID = Deno.env.get("REDDIT_CLIENT_ID")!;
const REDDIT_CLIENT_SECRET = Deno.env.get("REDDIT_CLIENT_SECRET")!;
const SUPABASE_FUNCTIONS_BASE_URL =
  (SUPABASE_URL ?? "https://api.postora.cloud").replace(/\/+$/, "");

// Unified backend callback URL. Provider console MUST register exactly this.
const REDDIT_REDIRECT_URI =
  Deno.env.get("REDDIT_REDIRECT_URI") ??
  `${SUPABASE_FUNCTIONS_BASE_URL}/functions/v1/reddit-oauth`;

const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

interface RedditTokenData {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function exchangeCodeForToken(code: string): Promise<RedditTokenData> {
  const credentials = btoa(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`);
  const tokenResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Postora/1.0",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDDIT_REDIRECT_URI,
    }),
  });
  return await tokenResponse.json();
}

async function saveRedditAccount(
  supabase: ReturnType<typeof createClient>,
  user_id: string,
  social_profile_id: string | null,
  tokenData: RedditTokenData,
): Promise<{ username: string }> {
  if (tokenData.error || !tokenData.access_token) {
    throw new Error(`Reddit OAuth error: ${tokenData.error ?? "missing_access_token"}`);
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token ?? null;
  const expiresIn = tokenData.expires_in ?? 3600;

  const profileResponse = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "Postora/1.0",
    },
  });
  const profileData = await profileResponse.json();

  const username = profileData.name as string;
  const platformUserId = profileData.id as string;
  const rawAvatarUrl = profileData.icon_img?.split("?")[0];
  const avatarUrl = await cacheAvatarToCloudinary(
    rawAvatarUrl,
    user_id,
    "reddit",
    platformUserId,
  );

  const { error: dbError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id,
        platform: "reddit",
        platform_user_id: platformUserId,
        platform_username: username,
        avatar_url: avatarUrl,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        is_active: true,
        social_profile_id,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_metadata: {
          karma: profileData.total_karma,
          is_mod: profileData.is_mod,
        },
        needs_reauth: false,
        failure_count: 0,
        last_refresh_error: null,
      },
      { onConflict: "user_id,platform,platform_user_id" },
    );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save Reddit account");
  }

  return { username };
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Provider callback: GET /functions/v1/reddit-oauth?code=...&state=...
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
      if (error) {
        const ret = new URL(RETURN_URL_DEFAULT);
        ret.searchParams.set("connected", "reddit");
        ret.searchParams.set("error", error);
        return Response.redirect(ret.toString(), 302);
      }
      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }

      const payload = await verifyOAuthState(state, { expectedPlatform: "reddit" });
      const tokenData = await exchangeCodeForToken(code);
      await saveRedditAccount(
        supabase,
        payload.user_id,
        payload.profile_id ?? null,
        tokenData,
      );

      const ret = new URL(payload.return_to ?? RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "reddit");
      if (payload.profile_id) ret.searchParams.set("profile_id", payload.profile_id);
      return Response.redirect(ret.toString(), 302);
    } catch (err) {
      console.error("Reddit GET callback error:", err);
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "reddit");
      ret.searchParams.set("error", "reddit_callback_failed");
      return Response.redirect(ret.toString(), 302);
    }
  }

  // POST API: authorize + legacy callback (kept for backward compatibility
  // until the provider console is fully cut over to the GET callback URL).
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, code, redirect_uri, social_profile_id, return_to } = body;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let user_id: string;
    try {
      const auth = await authenticateCaller(req, body.user_id);
      user_id = auth.userId;
    } catch {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "authorize") {
      if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
        console.error("Reddit OAuth not configured: missing REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET");
        return new Response(
          JSON.stringify({
            error_code: "missing_config",
            error: "Reddit isn't set up correctly on the server yet. Please contact support.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const scopes = "identity submit read";

      // Signed state carries profile_id + return_to. NEVER pass them as
      // separate query params on the registered redirect URI.
      const state = await createOAuthState({
        platform: "reddit",
        user_id,
        profile_id: social_profile_id ?? null,
        return_to: return_to ?? RETURN_URL_DEFAULT,
      });

      const authUrl = new URL("https://www.reddit.com/api/v1/authorize");
      authUrl.searchParams.set("client_id", REDDIT_CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("redirect_uri", REDDIT_REDIRECT_URI);
      authUrl.searchParams.set("duration", "permanent");
      authUrl.searchParams.set("scope", scopes);

      console.log("Reddit OAuth authorization URL generated");

      return new Response(
        JSON.stringify({ url: authUrl.toString(), redirect_uri: REDDIT_REDIRECT_URI }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "callback") {
      // LEGACY path used by the old frontend /profiles?code=... shim.
      // Safe to remove once the provider console only points at the GET URL.
      // For the legacy path the redirect_uri arg is whatever the frontend
      // shim was registered as; Reddit requires exact match.
      const credentials = btoa(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`);
      const tokenResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Postora/1.0",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri,
        }),
      });
      const tokenData = await tokenResponse.json();
      const { username } = await saveRedditAccount(
        supabase,
        user_id,
        social_profile_id ?? null,
        tokenData,
      );
      return new Response(JSON.stringify({ success: true, username }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    console.error("Reddit OAuth error:", error);
    return new Response(
      JSON.stringify({ error: "Authentication failed. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
