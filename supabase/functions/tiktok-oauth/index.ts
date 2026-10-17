import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";
import { revokeTikTokAccess } from "../_shared/tiktokRevoke.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const TIKTOK_CLIENT_KEY = Deno.env.get("TIKTOK_CLIENT_KEY");
const TIKTOK_CLIENT_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Unified backend callback URL. Provider console MUST register exactly this.
const TIKTOK_REDIRECT_URI =
  Deno.env.get("TIKTOK_REDIRECT_URI") ??
  `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/tiktok-oauth`;

const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

const TIKTOK_SCOPES =
  "user.info.basic,user.info.profile,user.info.stats,video.list,video.upload,video.publish";

interface TikTokTokenData {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  open_id?: string;
  error?: string;
  error_description?: string;
  message?: string;
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
): Promise<TikTokTokenData> {
  const tokenResponse = await fetch(
    "https://open.tiktokapis.com/v2/oauth/token/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY!,
        client_secret: TIKTOK_CLIENT_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    },
  );
  return await tokenResponse.json();
}

async function saveTikTokAccount(
  supabase: SupabaseClient,
  user_id: string,
  social_profile_id: string | null,
  tokenData: TikTokTokenData,
): Promise<{ username: string }> {
  if (tokenData.error || !tokenData.access_token || !tokenData.open_id) {
    throw new Error(
      tokenData.message ||
        tokenData.error_description ||
        tokenData.error ||
        "TikTok token exchange failed",
    );
  }

  const { access_token, refresh_token, expires_in, open_id } = tokenData;

  // Fetch user info (display_name + username handle)
  const userResponse = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username",
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  const userData = await userResponse.json();

  let tiktokUsername: string | undefined;
  let displayName: string | undefined;
  let rawAvatarUrl: string | undefined;

  if (userData.error?.code === "scope_not_authorized") {
    const { data: existingAccount } = await supabase
      .from("social_accounts")
      .select("platform_username, avatar_url, account_metadata")
      .eq("user_id", user_id)
      .eq("platform", "tiktok")
      .eq("platform_user_id", open_id)
      .maybeSingle();

    if (existingAccount) {
      displayName =
        existingAccount.platform_username ||
        existingAccount.account_metadata?.display_name;
      tiktokUsername = existingAccount.account_metadata?.tiktok_username;
      rawAvatarUrl = existingAccount.avatar_url;
    }
  } else {
    tiktokUsername = userData.data?.user?.username;
    displayName = userData.data?.user?.display_name;
    rawAvatarUrl = userData.data?.user?.avatar_url;
  }

  const usernameForDisplay = displayName || tiktokUsername || open_id;
  const avatarUrl = rawAvatarUrl
    ? await cacheAvatarToCdn(rawAvatarUrl, user_id, "tiktok", open_id)
    : null;

  const tokenExpiresAt = new Date(
    Date.now() + (expires_in ?? 86400) * 1000,
  ).toISOString();

  const { error: dbError } = await supabase.from("social_accounts").upsert(
    {
      user_id,
      platform: "tiktok",
      platform_user_id: open_id,
      platform_username: usernameForDisplay,
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
        tiktok_username: tiktokUsername,
        display_name: displayName,
        open_id,
      },
    },
    { onConflict: "user_id,platform,platform_user_id" },
  );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save TikTok account");
  }

  return { username: usernameForDisplay };
}

/**
 * Reconnect mode: update the existing social_accounts row IN PLACE.
 * Verifies ownership + platform, rejects if open_id changes (no silent
 * identity swap), resets health/expiry fields so the red banner clears.
 */
async function reconnectTikTokAccount(
  supabase: SupabaseClient,
  social_account_id: string,
  expected_user_id: string,
  tokenData: TikTokTokenData,
): Promise<{ username: string }> {
  if (tokenData.error || !tokenData.access_token || !tokenData.open_id) {
    throw new Error(
      tokenData.message ||
        tokenData.error_description ||
        tokenData.error ||
        "TikTok token exchange failed",
    );
  }

  const { data: row, error: fetchError } = await supabase
    .from("social_accounts")
    .select(
      "id, user_id, platform, platform_user_id, platform_username, avatar_url, account_metadata",
    )
    .eq("id", social_account_id)
    .maybeSingle();

  if (fetchError || !row) throw new Error("RECONNECT_ACCOUNT_NOT_FOUND");
  if (row.user_id !== expected_user_id) throw new Error("RECONNECT_FORBIDDEN");
  if (row.platform !== "tiktok") throw new Error("RECONNECT_PLATFORM_MISMATCH");

  const { access_token, refresh_token, expires_in, open_id } = tokenData;
  if (String(open_id) !== String(row.platform_user_id)) {
    throw new Error("RECONNECT_ACCOUNT_MISMATCH");
  }

  // Fetch fresh user info (tolerate scope_not_authorized like initial connect).
  const userResponse = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username",
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  const userData = await userResponse.json();

  let tiktokUsername: string | undefined;
  let displayName: string | undefined;
  let rawAvatarUrl: string | undefined;

  if (userData.error?.code === "scope_not_authorized") {
    const meta = (row.account_metadata as Record<string, unknown> | null) ?? {};
    displayName = row.platform_username ||
      (meta.display_name as string | undefined);
    tiktokUsername = meta.tiktok_username as string | undefined;
    rawAvatarUrl = row.avatar_url as string | undefined;
  } else {
    tiktokUsername = userData.data?.user?.username;
    displayName = userData.data?.user?.display_name;
    rawAvatarUrl = userData.data?.user?.avatar_url;
  }

  const usernameForDisplay = displayName || tiktokUsername || open_id;
  const avatarUrl = rawAvatarUrl
    ? await cacheAvatarToCdn(rawAvatarUrl, expected_user_id, "tiktok", open_id)
    : row.avatar_url ?? null;
  const tokenExpiresAt = new Date(
    Date.now() + (expires_in ?? 86400) * 1000,
  ).toISOString();

  const merged = {
    ...((row.account_metadata as Record<string, unknown> | null) ?? {}),
    tiktok_username: tiktokUsername,
    display_name: displayName,
    open_id,
  };

  const { error: updateError } = await supabase
    .from("social_accounts")
    .update({
      platform_username: usernameForDisplay,
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
    throw new Error("Failed to update TikTok account");
  }

  return { username: usernameForDisplay };
}

function reconnectErrorParam(message: string): string {
  if (message === "RECONNECT_ACCOUNT_NOT_FOUND") return "reconnect_account_not_found";
  if (message === "RECONNECT_FORBIDDEN") return "reconnect_forbidden";
  if (message === "RECONNECT_PLATFORM_MISMATCH") return "reconnect_platform_mismatch";
  if (message === "RECONNECT_ACCOUNT_MISMATCH") return "reconnect_account_mismatch";
  return "tiktok_callback_failed";
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ============================================================
  // Provider callback: GET /functions/v1/tiktok-oauth?code=...&state=...
  // ============================================================
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    try {
      if (errorParam) {
        const ret = new URL(RETURN_URL_DEFAULT);
        ret.searchParams.set("connected", "tiktok");
        ret.searchParams.set("error", errorParam);
        return Response.redirect(ret.toString(), 302);
      }
      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }
      if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
        return new Response("TikTok credentials not configured", { status: 500 });
      }

      const payload = await verifyOAuthState(state, {
        expectedPlatform: "tiktok",
      });
      const stateMode = (payload as Record<string, unknown>).mode as
        | string
        | undefined;
      const stateAccountId = (payload as Record<string, unknown>)
        .social_account_id as string | undefined;

      const tokenData = await exchangeCodeForToken(code, TIKTOK_REDIRECT_URI);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      const isReconnect = stateMode === "reconnect" && !!stateAccountId;
      if (isReconnect) {
        await reconnectTikTokAccount(
          supabase,
          stateAccountId!,
          payload.user_id,
          tokenData,
        );
      } else {
        await saveTikTokAccount(
          supabase,
          payload.user_id,
          payload.profile_id ?? null,
          tokenData,
        );
      }

      const ret = new URL(payload.return_to ?? RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "tiktok");
      if (isReconnect) ret.searchParams.set("reconnected", "1");
      if (payload.profile_id) ret.searchParams.set("profile_id", payload.profile_id);
      return Response.redirect(ret.toString(), 302);
    } catch (err) {
      console.error("TikTok GET callback error:", err);
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "tiktok");
      ret.searchParams.set(
        "error",
        reconnectErrorParam(err instanceof Error ? err.message : ""),
      );
      return Response.redirect(ret.toString(), 302);
    }
  }

  // ============================================================
  // POST API: authorize + creator_info + refresh + legacy callback
  // ============================================================
  try {
    const body = await req.json().catch(() => ({}));
    const {
      action,
      code,
      redirect_uri,
      social_profile_id,
      account_id: rawAccountId,
      social_account_id,
      return_to,
      mode,
    } = body;
    const account_id = rawAccountId || social_account_id;

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] TikTok OAuth - Action: ${action}`);

    // ---------- authorize: returns auth URL with signed state ----------
    if (action === "authorize") {
      if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
        console.error("TikTok OAuth not configured: missing TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET");
        return new Response(
          JSON.stringify({
            error_code: "missing_config",
            error: "TikTok isn't set up correctly on the server yet. Please contact support.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { userId: user_id } = await authenticateCaller(req, body.user_id);

      // Sandbox-mode debug flag (kept for parity with previous response shape).
      let isSandboxMode = false;
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { data: sandboxSetting } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "tiktok_sandbox_mode")
          .maybeSingle();
        if (sandboxSetting) {
          const v = sandboxSetting.value;
          isSandboxMode =
            v === true ||
            v === "true" ||
            (typeof v === "string" && JSON.parse(v) === true);
        }
      } catch {
        /* ignore */
      }

      // Backend-controlled redirect URI. Frontend-supplied value is ignored
      // for security/consistency: must match provider console exactly.
      const effectiveRedirect = TIKTOK_REDIRECT_URI;

      const isReconnect = mode === "reconnect" && !!social_account_id;
      const extra: Record<string, unknown> = {};
      if (isReconnect) {
        extra.mode = "reconnect";
        extra.social_account_id = social_account_id;
      }

      const state = await createOAuthState({
        platform: "tiktok",
        user_id,
        profile_id: social_profile_id ?? null,
        return_to: return_to ?? RETURN_URL_DEFAULT,
        extra,
      });

      const authUrl =
        `https://www.tiktok.com/v2/auth/authorize/?client_key=${TIKTOK_CLIENT_KEY}` +
        `&scope=${TIKTOK_SCOPES}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(effectiveRedirect)}` +
        `&state=${encodeURIComponent(state)}` +
        // Always show TikTok's permission screen, even when the user already approved this app before.
        `&disable_auto_auth=1`;

      return new Response(
        JSON.stringify({
          url: authUrl,
          redirect_uri: effectiveRedirect,
          debug: {
            sandbox_mode: isSandboxMode,
            scope: TIKTOK_SCOPES,
            redirect_uri: effectiveRedirect,
            client_key_prefix: TIKTOK_CLIENT_KEY.substring(0, 4) + "...",
            // Indicates frontend-supplied value (now ignored).
            requested_redirect_uri: redirect_uri ?? null,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---------- legacy POST callback (used by /tiktok-callback shim) ----------
    if (action === "callback") {
      if (!code) throw new Error("Missing code");
      if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
        throw new Error("TikTok credentials not configured");
      }

      const { userId: user_id } = await authenticateCaller(req, body.user_id);
      // Legacy path: caller supplies redirect_uri (must match what was used
      // at /authorize). Reject empty values defensively.
      if (!redirect_uri) throw new Error("Missing redirect_uri");

      const tokenData = await exchangeCodeForToken(code, redirect_uri);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      if (mode === "reconnect" && social_account_id) {
        const { username } = await reconnectTikTokAccount(
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

      const { username } = await saveTikTokAccount(
        supabase,
        user_id,
        social_profile_id ?? null,
        tokenData,
      );
      return new Response(JSON.stringify({ success: true, username }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- creator_info (UX compliance, unchanged) ----------
    if (action === "creator_info") {
      if (!account_id) throw new Error("Missing account_id for creator_info");
      const caller = await authenticateCaller(req, body.user_id);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      let accountQuery = supabase
        .from("social_accounts")
        .select("access_token, platform_username, avatar_url")
        .eq("id", account_id);
      if (!caller.isServiceRole) accountQuery = accountQuery.eq("user_id", caller.userId);
      const { data: account, error: fetchError } = await accountQuery.maybeSingle();
      if (fetchError) throw new Error("Account lookup failed");
      if (!account) {
        return new Response(JSON.stringify({ error: "Account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const creatorInfoResponse = await fetch(
        "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${account.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      const creatorData = await creatorInfoResponse.json();

      let creatorPostingBlocked = false;
      let postingBlockedReason = "";
      if (creatorData.error && creatorData.error.code !== "ok") {
        const errorCode = creatorData.error.code;
        const errorMessage = creatorData.error.message || "Failed to get creator info";
        if (
          errorCode === "spam_risk_too_many_posts" ||
          errorCode === "spam_risk_user_banned_from_posting" ||
          errorCode === "user_posting_banned" ||
          errorMessage.toLowerCase().includes("posting limit") ||
          errorMessage.toLowerCase().includes("too many posts") ||
          errorMessage.toLowerCase().includes("cannot post")
        ) {
          creatorPostingBlocked = true;
          postingBlockedReason = `You've reached your TikTok daily posting limit. Please try again later.`;
        } else {
          throw new Error(errorMessage);
        }
      }

      let creatorNickname: string | null = null;
      let creatorAvatarUrl = account.avatar_url;
      try {
        const userInfoResponse = await fetch(
          "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name",
          { headers: { Authorization: `Bearer ${account.access_token}` } },
        );
        const userData = await userInfoResponse.json();
        if (userData.data?.user) {
          creatorNickname = userData.data.user.display_name;
          creatorAvatarUrl = userData.data.user.avatar_url || account.avatar_url;
        }
      } catch (e) {
        console.warn("Failed to fetch user info for nickname:", e);
      }

      const creatorInfoData = creatorData.data || creatorData;
      return new Response(
        JSON.stringify({
          success: true,
          creator_info: {
            ...creatorInfoData,
            creator_nickname: creatorNickname,
            creator_avatar_url: creatorAvatarUrl,
            creator_username: account.platform_username,
            creator_posting_blocked: creatorPostingBlocked,
            posting_blocked_reason: postingBlockedReason,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---------- refresh (unchanged) ----------
    if (action === "refresh") {
      if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
        throw new Error("TikTok credentials not configured");
      }
      if (!account_id) throw new Error("Missing account_id for token refresh");

      const caller = await authenticateCaller(req, body.user_id);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      let accountQuery = supabase
        .from("social_accounts")
        .select("refresh_token, platform_username")
        .eq("id", account_id);
      if (!caller.isServiceRole) accountQuery = accountQuery.eq("user_id", caller.userId);
      const { data: account, error: fetchError } = await accountQuery.maybeSingle();
      if (fetchError) throw new Error("Account lookup failed");
      if (!account) {
        return new Response(JSON.stringify({ error: "Account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!account.refresh_token) {
        throw new Error("No refresh token available for this account");
      }

      const tokenResponse = await fetch(
        "https://open.tiktokapis.com/v2/oauth/token/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: TIKTOK_CLIENT_KEY,
            client_secret: TIKTOK_CLIENT_SECRET,
            refresh_token: account.refresh_token,
            grant_type: "refresh_token",
          }),
        },
      );
      const tokenData = await tokenResponse.json();
      if (tokenData.error) {
        throw new Error(
          tokenData.error.message ||
            tokenData.error_description ||
            "Failed to refresh token",
        );
      }

      const newExpiresAt = new Date(
        Date.now() + tokenData.expires_in * 1000,
      ).toISOString();
      let tokenUpdate = supabase
        .from("social_accounts")
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_expires_at: newExpiresAt,
          // A successful refresh means the credentials are healthy again; clearing these
          // keeps the UI from showing a red Reconnect button over a working token.
          needs_reauth: false,
          failure_count: 0,
          last_refresh_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account_id);
      if (!caller.isServiceRole) tokenUpdate = tokenUpdate.eq("user_id", caller.userId);
      const { error: updateError } = await tokenUpdate;
      if (updateError) throw new Error("Failed to save refreshed token");

      return new Response(
        JSON.stringify({ success: true, expires_at: newExpiresAt }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---------- disconnect: revoke the app in TikTok, then deactivate the account ----------
    if (action === "disconnect") {
      if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
        throw new Error("TikTok credentials not configured");
      }
      if (!account_id) throw new Error("Missing account_id for disconnect");

      const caller = await authenticateCaller(req, body.user_id);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      let accountQuery = supabase
        .from("social_accounts")
        .select("access_token")
        .eq("id", account_id)
        .eq("platform", "tiktok");
      if (!caller.isServiceRole) accountQuery = accountQuery.eq("user_id", caller.userId);
      const { data: account, error: fetchError } = await accountQuery.maybeSingle();
      if (fetchError) throw new Error("Account lookup failed");
      if (!account) {
        return new Response(JSON.stringify({ error: "Account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Best effort: the account is disconnected in Postora even if TikTok cannot be reached.
      const revoked = account.access_token
        ? await revokeTikTokAccess(fetch, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, account.access_token)
        : false;
      if (!revoked) console.warn(`[${timestamp}] TikTok revoke did not succeed for account ${account_id}`);

      let deactivate = supabase
        .from("social_accounts")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", account_id);
      if (!caller.isServiceRole) deactivate = deactivate.eq("user_id", caller.userId);
      const { error: updateError } = await deactivate;
      if (updateError) throw new Error("Failed to disconnect account");

      return new Response(
        JSON.stringify({ success: true, revoked }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] TikTok OAuth error:`, error);
    return new Response(
      JSON.stringify({ error: "Authentication failed. Please try again." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
