import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

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

async function fetchPinterestUser(accessToken: string) {
  const userResponse = await fetch(
    "https://api.pinterest.com/v5/user_account",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const userData = await userResponse.json();
  if (!userResponse.ok) {
    throw new Error(userData.message || "Failed to get user info");
  }
  return userData;
}

function pinterestMetadata(userData: {
  account_type?: string;
}, grantedScopes: string) {
  const hasWriteAccess =
    grantedScopes.includes("pins:write") ||
    grantedScopes.includes("boards:write");
  return {
    business_type: userData.account_type,
    has_write_access: hasWriteAccess,
    access_level: hasWriteAccess ? "standard" : "trial",
    granted_scopes: grantedScopes,
  };
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
  const userData = await fetchPinterestUser(access_token);
  const username = userData.username || userData.id;
  const grantedScopes = tokenData.scope || tokenData.scopes || "";
  const tokenExpiresAt = new Date(
    Date.now() + (expires_in ?? 2592000) * 1000,
  ).toISOString();
  const avatarUrl = await cacheAvatarToCloudinary(
    userData.profile_image,
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
      account_metadata: pinterestMetadata(userData, grantedScopes),
    },
    { onConflict: "user_id,platform,platform_user_id" },
  );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save Pinterest account");
  }

  return { username };
}

/**
 * Reconnect mode: update the existing social_accounts row IN PLACE.
 * - Verifies ownership and platform.
 * - Rejects if Pinterest returns a different platform_user_id (no silent
 *   identity swap).
 * - Resets all health/expiry fields so the red "Connection Expired" banner
 *   clears immediately.
 */
async function reconnectPinterestAccount(
  supabase: SupabaseClient,
  social_account_id: string,
  expected_user_id: string,
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

  const { data: row, error: fetchError } = await supabase
    .from("social_accounts")
    .select(
      "id, user_id, platform, platform_user_id, social_profile_id, account_metadata",
    )
    .eq("id", social_account_id)
    .maybeSingle();

  if (fetchError || !row) throw new Error("RECONNECT_ACCOUNT_NOT_FOUND");
  if (row.user_id !== expected_user_id) throw new Error("RECONNECT_FORBIDDEN");
  if (row.platform !== "pinterest") {
    throw new Error("RECONNECT_PLATFORM_MISMATCH");
  }

  const { access_token, refresh_token, expires_in } = tokenData;
  const userData = await fetchPinterestUser(access_token);

  if (String(userData.id) !== String(row.platform_user_id)) {
    throw new Error("RECONNECT_ACCOUNT_MISMATCH");
  }

  const username = userData.username || userData.id;
  const grantedScopes = tokenData.scope || tokenData.scopes || "";
  const tokenExpiresAt = new Date(
    Date.now() + (expires_in ?? 2592000) * 1000,
  ).toISOString();
  const avatarUrl = await cacheAvatarToCloudinary(
    userData.profile_image,
    expected_user_id,
    "pinterest",
    userData.id,
  );

  const merged = {
    ...((row.account_metadata as Record<string, unknown> | null) ?? {}),
    ...pinterestMetadata(userData, grantedScopes),
  };

  const { error: updateError } = await supabase
    .from("social_accounts")
    .update({
      platform_username: username,
      access_token,
      refresh_token,
      token_expires_at: tokenExpiresAt,
      avatar_url: avatarUrl,
      is_active: true,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      updated_at: new Date().toISOString(),
      account_metadata: merged,
    })
    .eq("id", row.id)
    .eq("user_id", expected_user_id);

  if (updateError) {
    console.error("Database error (reconnect):", updateError);
    throw new Error("Failed to update Pinterest account");
  }

  return { username };
}

function reconnectErrorParam(message: string): string {
  if (message === "RECONNECT_ACCOUNT_NOT_FOUND") return "reconnect_account_not_found";
  if (message === "RECONNECT_FORBIDDEN") return "reconnect_forbidden";
  if (message === "RECONNECT_PLATFORM_MISMATCH") return "reconnect_platform_mismatch";
  if (message === "RECONNECT_ACCOUNT_MISMATCH") return "reconnect_account_mismatch";
  return "pinterest_callback_failed";
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
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
      const mode = (payload as Record<string, unknown>).mode as
        | string
        | undefined;
      const socialAccountId = (payload as Record<string, unknown>)
        .social_account_id as string | undefined;

      const tokenData = await exchangeCodeForToken(code, PINTEREST_REDIRECT_URI);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      const isReconnect = mode === "reconnect" && !!socialAccountId;
      if (isReconnect) {
        await reconnectPinterestAccount(
          supabase,
          socialAccountId!,
          payload.user_id,
          tokenData,
        );
      } else {
        await savePinterestAccount(
          supabase,
          payload.user_id,
          payload.profile_id ?? null,
          tokenData,
        );
      }

      const ret = new URL(payload.return_to ?? RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "pinterest");
      if (isReconnect) ret.searchParams.set("reconnected", "1");
      if (payload.profile_id) ret.searchParams.set("profile_id", payload.profile_id);
      return Response.redirect(ret.toString(), 302);
    } catch (err) {
      console.error("Pinterest GET callback error:", err);
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "pinterest");
      ret.searchParams.set(
        "error",
        reconnectErrorParam(err instanceof Error ? err.message : ""),
      );
      return Response.redirect(ret.toString(), 302);
    }
  }

  // ============================================================
  // POST API: authorize + legacy callback + refresh
  // ============================================================
  try {
    const body = await req.json().catch(() => ({}));
    const {
      action,
      code,
      redirect_uri,
      social_profile_id,
      return_to,
      mode,
      social_account_id,
    } = body;

    console.log("Pinterest OAuth action:", action);

    if (action === "authorize") {
      if (!PINTEREST_APP_ID) throw new Error("PINTEREST_APP_ID not configured");

      const { userId: user_id } = await authenticateCaller(req, body.user_id);
      const effectiveRedirect = PINTEREST_REDIRECT_URI;

      const isReconnect = mode === "reconnect" && !!social_account_id;
      const extra: Record<string, unknown> = {};
      if (isReconnect) {
        extra.mode = "reconnect";
        extra.social_account_id = social_account_id;
      }

      const state = await createOAuthState({
        platform: "pinterest",
        user_id,
        profile_id: social_profile_id ?? null,
        return_to: return_to ?? RETURN_URL_DEFAULT,
        extra,
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

      if (mode === "reconnect" && social_account_id) {
        const { username } = await reconnectPinterestAccount(
          supabase,
          social_account_id,
          user_id,
          tokenData,
        );
        return new Response(
          JSON.stringify({ success: true, username, reconnected: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

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
