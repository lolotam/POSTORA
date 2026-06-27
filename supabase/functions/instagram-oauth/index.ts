/**
 * instagram-oauth
 * ---------------
 * Direct Instagram Business Login.
 *
 * Unified backend-callback lifecycle:
 *   - POST action="authorize" → returns provider authorization URL with signed state
 *   - GET  ?code&state         → provider callback; exchanges code, saves account, 302 → return_to
 *   - POST action="callback"   → TEMPORARY legacy shim for in-flight sessions
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INSTAGRAM_APP_ID = Deno.env.get("INSTAGRAM_APP_ID")!;
const INSTAGRAM_APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET")!;
// Public origin used to derive the OAuth redirect URI registered with Instagram.
// On self-hosted Supabase, SUPABASE_URL points at the internal Kong gateway
// (http://kong:8000), which is unreachable from the provider — never derive
// the redirect_uri from it.
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const INSTAGRAM_REDIRECT_URI =
  Deno.env.get("INSTAGRAM_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/instagram-oauth`;
const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
].join(",");

function normalizeUsername(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/^@/, "").trim();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function configMissing(): boolean {
  return (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !INSTAGRAM_APP_ID ||
    !INSTAGRAM_APP_SECRET ||
    !INSTAGRAM_REDIRECT_URI
  );
}

interface InstagramProfile {
  id: string;
  username?: string;
  account_type?: string;
  profile_picture_url?: string;
}

async function exchangeAndPersist(
  code: string,
  user_id: string,
  social_profile_id: string | null,
): Promise<
  | { kind: "personal"; account_type: string }
  | { kind: "ok"; username: string }
  | { kind: "error"; message: string }
> {
  // Step 1: short-lived token
  const tokenResp = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: INSTAGRAM_REDIRECT_URI,
      code,
    }),
  });
  const tokenData = await tokenResp.json();
  if (tokenData.error_message || tokenData.error) {
    return {
      kind: "error",
      message: `Instagram OAuth error: ${tokenData.error_message ?? tokenData.error}`,
    };
  }

  const shortLivedToken = tokenData.access_token as string;
  const rawIgUserId = String(tokenData.user_id);

  // Step 2: long-lived token
  const longLivedResp = await fetch(
    `https://graph.instagram.com/v22.0/access_token?grant_type=ig_exchange_token&client_secret=${INSTAGRAM_APP_SECRET}&access_token=${shortLivedToken}`,
  );
  const longLivedData = await longLivedResp.json();
  const finalAccessToken = (longLivedData.access_token as string) || shortLivedToken;
  const expiresIn = (longLivedData.expires_in as number) || 5184000;

  let grantedScopes: string[] = [];
  try {
    const permResp = await fetch(
      `https://graph.instagram.com/v22.0/me/permissions?access_token=${encodeURIComponent(finalAccessToken)}`,
    );
    const permData = await permResp.json();
    if (Array.isArray(permData?.data)) {
      grantedScopes = permData.data
        .filter((p: { status?: string }) => p?.status === "granted")
        .map((p: { permission: string }) => p.permission);
    }
  } catch (_err) {
    // best-effort; account still saves even if Meta does not return permissions
  }

  // Step 3: profile
  const profileResp = await fetch(
    `https://graph.instagram.com/v22.0/me?fields=id,username,account_type,profile_picture_url&access_token=${finalAccessToken}`,
  );
  const profileData = (await profileResp.json()) as InstagramProfile & { error?: unknown };

  if (profileData.account_type === "PERSONAL") {
    return { kind: "personal", account_type: "PERSONAL" };
  }

  const igUserId = String(profileData.id || rawIgUserId);
  const username = profileData.username || `ig_${igUserId}`;
  const avatarUrl = await cacheAvatarToCloudinary(
    profileData.profile_picture_url,
    user_id,
    "instagram",
    igUserId,
  );

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const normalized = normalizeUsername(username);

  const { data: existing } = await supabase
    .from("social_accounts")
    .select("id, platform_username")
    .eq("user_id", user_id)
    .eq("platform", "instagram")
    .eq("is_active", true);

  let existingId: string | null = null;
  for (const acc of existing ?? []) {
    if (normalizeUsername(acc.platform_username) === normalized) {
      existingId = acc.id;
      break;
    }
  }

  const accountData = {
    user_id,
    platform: "instagram",
    platform_user_id: igUserId,
    platform_username: username,
    avatar_url: avatarUrl,
    access_token: finalAccessToken,
    token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    is_active: true,
    social_profile_id,
    ig_auth_type: "business_login",
    account_metadata: {
      ig_user_id: igUserId,
      ig_username: username,
      account_type: profileData.account_type || "business_login",
      token_type: "long_lived",
      flow: "direct",
      source: "instagram_business_login",
      granted_scopes: grantedScopes,
      scopes_checked_at: new Date().toISOString(),
    },
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
  };

  if (existingId) {
    const { error } = await supabase
      .from("social_accounts")
      .update(accountData)
      .eq("id", existingId);
    if (error) return { kind: "error", message: "Failed to save Instagram account" };
  } else {
    const { error } = await supabase
      .from("social_accounts")
      .upsert(accountData, { onConflict: "user_id,platform,platform_user_id" });
    if (error) return { kind: "error", message: "Failed to save Instagram account" };
  }

  return { kind: "ok", username };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (configMissing()) {
    console.error("instagram-oauth configuration is incomplete");
    return jsonResponse({ error: "Service configuration error" }, 500);
  }

  // -------------------- GET: provider callback (unified path) -------------------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (!state) {
      return jsonResponse({ error: "Missing state" }, 400);
    }

    let payload;
    try {
      payload = await verifyOAuthState(state, { expectedPlatform: "instagram" });
    } catch (err) {
      console.warn("instagram-oauth: invalid state", err instanceof Error ? err.message : "");
      return jsonResponse({ error: "Invalid or expired state" }, 400);
    }

    const returnTo = payload.return_to || `${RETURN_URL_DEFAULT}?connected=instagram`;

    if (providerError || !code) {
      return Response.redirect(
        appendQuery(returnTo, { error: providerError || "missing_code" }),
        302,
      );
    }

    try {
      const result = await exchangeAndPersist(
        code,
        payload.user_id,
        (payload.profile_id as string | null) ?? null,
      );

      if (result.kind === "personal") {
        return Response.redirect(
          appendQuery(returnTo, { error: "personal_account" }),
          302,
        );
      }
      if (result.kind === "error") {
        console.error("instagram-oauth callback error:", result.message);
        return Response.redirect(
          appendQuery(returnTo, { error: "connect_failed" }),
          302,
        );
      }
      return Response.redirect(
        appendQuery(returnTo, { connected: "instagram", username: result.username }),
        302,
      );
    } catch (err) {
      console.error("instagram-oauth GET callback failed:", err);
      return Response.redirect(appendQuery(returnTo, { error: "internal_error" }), 302);
    }
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body.action as string | undefined;

  if (!action || !["authorize", "callback"].includes(action)) {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  // Both POST actions require an authenticated caller
  let user_id: string;
  try {
    const auth = await authenticateCaller(req, body.user_id as string | undefined);
    user_id = auth.userId;
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    // -------------------- POST authorize -------------------------
    if (action === "authorize") {
      const social_profile_id = (body.social_profile_id as string | null | undefined) ?? null;
      const return_to =
        (body.return_to as string | undefined) ?? `${RETURN_URL_DEFAULT}?connected=instagram`;

      const state = await createOAuthState({
        platform: "instagram",
        flow: "direct",
        user_id,
        profile_id: social_profile_id,
        return_to,
      });

      const authUrl = new URL("https://www.instagram.com/oauth/authorize");
      authUrl.searchParams.set("client_id", INSTAGRAM_APP_ID);
      authUrl.searchParams.set("redirect_uri", INSTAGRAM_REDIRECT_URI);
      authUrl.searchParams.set("scope", IG_SCOPES);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("state", state);

      return jsonResponse({
        url: authUrl.toString(),
        requested_redirect_uri: body.redirect_uri ?? null,
        effective_redirect_uri: INSTAGRAM_REDIRECT_URI,
      });
    }

    // -------------------- POST callback (TEMP legacy shim) -------
    // TEMP: remove after 24-48h once the GET-302 path is verified in production.
    if (action === "callback") {
      const code = body.code as string | undefined;
      const social_profile_id = (body.social_profile_id as string | null | undefined) ?? null;
      if (!code) return jsonResponse({ error: "Missing code" }, 400);

      const result = await exchangeAndPersist(code, user_id, social_profile_id);
      if (result.kind === "personal") {
        return jsonResponse({
          error: "personal_account",
          account_type: "PERSONAL",
          requires_facebook: true,
          message:
            "Your Instagram account is a Personal account. Personal accounts cannot connect directly — they must be linked through a Facebook Page.",
        });
      }
      if (result.kind === "error") {
        return jsonResponse({ success: false, error: result.message }, 200);
      }
      return jsonResponse({ success: true, username: result.username });
    }

    return jsonResponse({ error: "Invalid action" }, 400);
  } catch (err) {
    console.error("instagram-oauth POST failed:", err);
    return jsonResponse({ error: "Authentication failed. Please try again." }, 500);
  }
});
