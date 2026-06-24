/**
 * instagram-business-oauth
 * ------------------------
 * Connect Instagram via Facebook Business / Pages.
 *
 * Unified backend-callback lifecycle:
 *   - POST action="authorize" → returns Meta authorization URL with signed state
 *   - GET  ?code&state         → callback; exchanges code, lists Pages and
 *                                attached Instagram Business accounts, persists
 *                                each, then 302 → return_to
 *
 * The classic Facebook-Pages-only flow (FB SDK + provider_token + list_pages /
 * store_page) continues to live in `facebook-oauth` and is intentionally NOT
 * modified here.
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
const FACEBOOK_APP_ID = Deno.env.get("FACEBOOK_APP_ID")!;
const FACEBOOK_APP_SECRET = Deno.env.get("FACEBOOK_APP_SECRET")!;
const INSTAGRAM_BUSINESS_REDIRECT_URI =
  Deno.env.get("INSTAGRAM_BUSINESS_REDIRECT_URI") ??
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/instagram-business-oauth` : "");
const GRAPH_VERSION = Deno.env.get("FACEBOOK_GRAPH_API_VERSION") ?? "v22.0";
const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
].join(",");

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
    !FACEBOOK_APP_ID ||
    !FACEBOOK_APP_SECRET ||
    !INSTAGRAM_BUSINESS_REDIRECT_URI
  );
}

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    profile_picture_url?: string;
  };
}

async function exchangeAndPersist(
  code: string,
  user_id: string,
  social_profile_id: string | null,
): Promise<
  | { kind: "ok"; count: number }
  | { kind: "no_instagram" }
  | { kind: "error"; message: string }
> {
  // Step 1: exchange code for user access token
  const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
  tokenUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
  tokenUrl.searchParams.set("redirect_uri", INSTAGRAM_BUSINESS_REDIRECT_URI);
  tokenUrl.searchParams.set("code", code);

  const tokenResp = await fetch(tokenUrl.toString());
  const tokenData = await tokenResp.json();
  if (tokenData.error) {
    return {
      kind: "error",
      message: `Facebook token exchange failed: ${tokenData.error.message ?? "unknown"}`,
    };
  }
  const userToken = tokenData.access_token as string;

  // Step 2: long-lived token (best-effort)
  let longLivedToken = userToken;
  let expiresIn = 5184000;
  try {
    const llUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    llUrl.searchParams.set("grant_type", "fb_exchange_token");
    llUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
    llUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
    llUrl.searchParams.set("fb_exchange_token", userToken);
    const llResp = await fetch(llUrl.toString());
    const llData = await llResp.json();
    if (llData.access_token) {
      longLivedToken = llData.access_token;
      expiresIn = llData.expires_in || expiresIn;
    }
  } catch (_err) {
    // Keep short-lived token if long-lived exchange fails
  }

  // Step 3: list Pages with linked IG Business accounts
  const pages: FbPage[] = [];
  let nextUrl: string | null =
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts` +
    `?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}` +
    `&limit=100&access_token=${encodeURIComponent(longLivedToken)}`;

  while (nextUrl) {
    const pageResp = await fetch(nextUrl);
    const pageData = await pageResp.json();
    if (pageData.error) {
      return {
        kind: "error",
        message: `Failed to list Pages: ${pageData.error.message ?? "unknown"}`,
      };
    }
    if (Array.isArray(pageData.data)) pages.push(...(pageData.data as FbPage[]));
    nextUrl = pageData.paging?.next ?? null;
  }

  const igPages = pages.filter((p) => p.instagram_business_account?.id);
  if (igPages.length === 0) return { kind: "no_instagram" };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let count = 0;

  for (const page of igPages) {
    const ig = page.instagram_business_account!;
    const igUserId = ig.id;
    const username = ig.username || `ig_${igUserId}`;
    const avatarUrl = await cacheAvatarToCloudinary(
      ig.profile_picture_url,
      user_id,
      "instagram",
      igUserId,
    );

    const accountData = {
      user_id,
      platform: "instagram",
      platform_user_id: igUserId,
      platform_username: username,
      avatar_url: avatarUrl,
      access_token: page.access_token,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      is_active: true,
      social_profile_id,
      ig_auth_type: "facebook_business",
      account_metadata: {
        ig_user_id: igUserId,
        ig_username: username,
        flow: "facebook_business",
        source: "facebook_business",
        facebook_page_id: page.id,
        facebook_page_name: page.name,
        page_access_token: page.access_token,
        ig_business_account_id: igUserId,
        token_type: "page_token",
      },
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
    };

    const { error } = await supabase
      .from("social_accounts")
      .upsert(accountData, { onConflict: "user_id,platform,platform_user_id" });
    if (error) {
      console.error("instagram-business-oauth save error:", error.message);
      continue;
    }
    count += 1;
  }

  if (count === 0) {
    return { kind: "error", message: "Failed to save any Instagram Business accounts" };
  }
  return { kind: "ok", count };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (configMissing()) {
    console.error("instagram-business-oauth configuration is incomplete");
    return jsonResponse({ error: "Service configuration error" }, 500);
  }

  // -------------------- GET: provider callback (unified path) -------------------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (!state) return jsonResponse({ error: "Missing state" }, 400);

    let payload;
    try {
      payload = await verifyOAuthState(state, { expectedPlatform: "instagram" });
    } catch (err) {
      console.warn(
        "instagram-business-oauth: invalid state",
        err instanceof Error ? err.message : "",
      );
      return jsonResponse({ error: "Invalid or expired state" }, 400);
    }
    if (payload.flow !== "facebook_business") {
      return jsonResponse({ error: "State flow mismatch" }, 400);
    }

    const returnTo =
      payload.return_to || `${RETURN_URL_DEFAULT}?connected=instagram_business`;

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
      if (result.kind === "no_instagram") {
        return Response.redirect(
          appendQuery(returnTo, { error: "no_instagram_business" }),
          302,
        );
      }
      if (result.kind === "error") {
        console.error("instagram-business-oauth callback error:", result.message);
        return Response.redirect(appendQuery(returnTo, { error: "connect_failed" }), 302);
      }
      return Response.redirect(
        appendQuery(returnTo, {
          connected: "instagram_business",
          count: String(result.count),
        }),
        302,
      );
    } catch (err) {
      console.error("instagram-business-oauth GET callback failed:", err);
      return Response.redirect(appendQuery(returnTo, { error: "internal_error" }), 302);
    }
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body.action as string | undefined;

  if (action !== "authorize") {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  let user_id: string;
  try {
    const auth = await authenticateCaller(req, body.user_id as string | undefined);
    user_id = auth.userId;
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    if (configMissing()) {
      console.error("Instagram Business OAuth not configured: missing FACEBOOK_APP_ID/SECRET or redirect URI");
      return jsonResponse({
        error_code: "missing_config",
        error: "Instagram Business isn't set up correctly on the server yet. Please contact support.",
      }, 200);
    }

    const social_profile_id = (body.social_profile_id as string | null | undefined) ?? null;
    const return_to =
      (body.return_to as string | undefined) ??
      `${RETURN_URL_DEFAULT}?connected=instagram_business`;

    const state = await createOAuthState({
      platform: "instagram",
      flow: "facebook_business",
      user_id,
      profile_id: social_profile_id,
      return_to,
    });

    const authUrl = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    authUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
    authUrl.searchParams.set("redirect_uri", INSTAGRAM_BUSINESS_REDIRECT_URI);
    authUrl.searchParams.set("scope", META_SCOPES);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", state);

    return jsonResponse({
      url: authUrl.toString(),
      flow: "facebook_business",
      requested_redirect_uri: body.redirect_uri ?? null,
      effective_redirect_uri: INSTAGRAM_BUSINESS_REDIRECT_URI,
    });
  } catch (err) {
    console.error("instagram-business-oauth POST failed:", err);
    return jsonResponse({ error: "Failed to start Instagram Business authorization" }, 500);
  }
});
