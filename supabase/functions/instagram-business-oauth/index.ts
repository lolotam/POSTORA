/**
 * instagram-business-oauth
 * ------------------------
 * Connect Instagram via Facebook Business / Pages.
 *
 * Lifecycle:
 *   - POST action="authorize"            → returns Meta authorization URL with signed state
 *   - GET  ?code&state                   → callback; exchanges code, lists IG candidates,
 *                                          stashes them, 302 → return_to with ?select=<id>
 *   - POST action="get_pending_selection" → load candidates for the picker UI
 *   - POST action="store_ig_account"      → persist one selected IG account
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
// Public origin used to derive the OAuth redirect URI registered with Meta.
// On self-hosted Supabase, SUPABASE_URL points at the internal Kong gateway
// (http://kong:8000), which is unreachable from the provider — never derive
// the redirect_uri from it.
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const INSTAGRAM_BUSINESS_REDIRECT_URI =
  Deno.env.get("INSTAGRAM_BUSINESS_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/instagram-business-oauth`;
const GRAPH_VERSION = Deno.env.get("FACEBOOK_GRAPH_API_VERSION") ?? "v22.0";
const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_messaging",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
  "instagram_manage_messages",
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

interface IgCandidate {
  ig_user_id: string;
  ig_username: string;
  ig_profile_picture_url: string | null;
  facebook_page_id: string;
  facebook_page_name: string;
  page_access_token: string;
}

async function exchangeAndListIg(
  code: string,
): Promise<
  | { kind: "ok"; candidates: IgCandidate[]; long_lived_token: string; expires_in: number; granted_scopes: string[] }
  | { kind: "no_instagram"; granted_scopes: string[] }
  | { kind: "error"; message: string }
> {
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
    // keep short-lived
  }

  // Fetch the user's *granted* permission set so we can persist it on each
  // social_account. Used by the messaging/comments UI to detect when a scope
  // (e.g. `instagram_manage_messages`) was declined and prompt for reconnect.
  let grantedScopes: string[] = [];
  try {
    const permUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(longLivedToken)}`;
    const permResp = await fetch(permUrl);
    const permData = await permResp.json();
    if (Array.isArray(permData?.data)) {
      grantedScopes = permData.data
        .filter((p: { status?: string }) => p?.status === "granted")
        .map((p: { permission: string }) => p.permission);
    }
  } catch (_err) {
    // best-effort; leave empty so UI assumes nothing about granted scopes
  }

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

  const candidates: IgCandidate[] = pages
    .filter((p) => p.instagram_business_account?.id)
    .map((p) => {
      const ig = p.instagram_business_account!;
      return {
        ig_user_id: ig.id,
        ig_username: ig.username || `ig_${ig.id}`,
        ig_profile_picture_url: ig.profile_picture_url ?? null,
        facebook_page_id: p.id,
        facebook_page_name: p.name,
        page_access_token: p.access_token,
      };
    });

  if (candidates.length === 0) return { kind: "no_instagram", granted_scopes: grantedScopes };
  return { kind: "ok", candidates, long_lived_token: longLivedToken, expires_in: expiresIn, granted_scopes: grantedScopes };
}

async function persistOneIgAccount(
  supabase: ReturnType<typeof createClient>,
  user_id: string,
  social_profile_id: string | null,
  candidate: IgCandidate,
  expires_in: number,
  granted_scopes: string[] = [],
): Promise<{ success: boolean; error?: string }> {
  const avatarUrl = await cacheAvatarToCloudinary(
    candidate.ig_profile_picture_url ?? undefined,
    user_id,
    "instagram",
    candidate.ig_user_id,
  );

  const accountData = {
    user_id,
    platform: "instagram",
    platform_user_id: candidate.ig_user_id,
    platform_username: candidate.ig_username,
    avatar_url: avatarUrl,
    access_token: candidate.page_access_token,
    token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
    is_active: true,
    social_profile_id,
    ig_auth_type: "facebook_business",
    account_metadata: {
      ig_user_id: candidate.ig_user_id,
      ig_username: candidate.ig_username,
      flow: "facebook_business",
      source: "facebook_business",
      facebook_page_id: candidate.facebook_page_id,
      facebook_page_name: candidate.facebook_page_name,
      page_access_token: candidate.page_access_token,
      ig_business_account_id: candidate.ig_user_id,
      token_type: "page_token",
      granted_scopes,
      scopes_checked_at: new Date().toISOString(),
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
    return { success: false, error: error.message };
  }
  return { success: true };
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
      const result = await exchangeAndListIg(code);
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

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: stashRow, error: stashError } = await supabase
        .from("oauth_pending_instagram_selections")
        .insert({
          user_id: payload.user_id,
          social_profile_id: (payload.profile_id as string | null) ?? null,
          ig_candidates_json: result.candidates,
          long_lived_token: result.long_lived_token,
          expires_in: result.expires_in,
        })
        .select("id")
        .single();

      if (stashError || !stashRow?.id) {
        console.error("instagram-business-oauth stash error:", stashError?.message);
        return Response.redirect(appendQuery(returnTo, { error: "connect_failed" }), 302);
      }

      return Response.redirect(
        appendQuery(returnTo, {
          connected: "instagram_business",
          select: stashRow.id,
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

  let user_id: string;
  try {
    const auth = await authenticateCaller(req, body.user_id as string | undefined);
    user_id = auth.userId;
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // ---------------- get_pending_selection: load candidates for picker ----------
  if (action === "get_pending_selection") {
    const selection_id = body.selection_id as string | undefined;
    if (!selection_id) return jsonResponse({ error: "Missing selection_id" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: row, error } = await supabase
      .from("oauth_pending_instagram_selections")
      .select("id, user_id, social_profile_id, ig_candidates_json, expires_at")
      .eq("id", selection_id)
      .maybeSingle();

    if (error || !row) {
      return jsonResponse({ success: false, error: "Selection not found or expired" }, 404);
    }
    if (row.user_id !== user_id) {
      return jsonResponse({ success: false, error: "Forbidden" }, 403);
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return jsonResponse({ success: false, error: "Selection expired" }, 404);
    }

    const candidates = (row.ig_candidates_json as IgCandidate[] | null) ?? [];
    return jsonResponse({
      success: true,
      social_profile_id: row.social_profile_id,
      ig_accounts: candidates.map((c) => ({
        ig_user_id: c.ig_user_id,
        ig_username: c.ig_username,
        ig_profile_picture_url: c.ig_profile_picture_url,
        facebook_page_name: c.facebook_page_name,
      })),
    });
  }

  // ---------------- store_ig_account: persist one selected IG account ----------
  if (action === "store_ig_account") {
    const selection_id = body.selection_id as string | undefined;
    const ig_user_id = body.ig_user_id as string | undefined;
    const override_profile_id =
      (body.social_profile_id as string | null | undefined) ?? null;
    if (!selection_id || !ig_user_id) {
      return jsonResponse({ error: "Missing selection_id or ig_user_id" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: row, error } = await supabase
      .from("oauth_pending_instagram_selections")
      .select("id, user_id, social_profile_id, ig_candidates_json, expires_in, expires_at, long_lived_token")
      .eq("id", selection_id)
      .maybeSingle();

    if (error || !row) {
      return jsonResponse({ success: false, error: "Selection not found or expired" }, 404);
    }
    if (row.user_id !== user_id) {
      return jsonResponse({ success: false, error: "Forbidden" }, 403);
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return jsonResponse({ success: false, error: "Selection expired" }, 404);
    }

    const candidates = (row.ig_candidates_json as IgCandidate[] | null) ?? [];
    const candidate = candidates.find((c) => c.ig_user_id === ig_user_id);
    if (!candidate) {
      return jsonResponse({ success: false, error: "Account not in selection" }, 404);
    }

    // Fetch the user's currently-granted scopes from Meta so we can persist the
    // actual permission set (used by messaging/comments UI to detect missing
    // scopes such as `instagram_manage_messages`).
    let grantedScopes: string[] = [];
    try {
      const llt = row.long_lived_token as string | undefined;
      if (llt) {
        const permUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(llt)}`;
        const permResp = await fetch(permUrl);
        const permData = await permResp.json();
        if (Array.isArray(permData?.data)) {
          grantedScopes = permData.data
            .filter((p: { status?: string }) => p?.status === "granted")
            .map((p: { permission: string }) => p.permission);
        }
      }
    } catch (_err) { /* best-effort */ }

    const result = await persistOneIgAccount(
      supabase,
      user_id,
      override_profile_id ?? row.social_profile_id ?? null,
      candidate,
      row.expires_in ?? 5184000,
      grantedScopes,
    );
    if (!result.success) {
      return jsonResponse({ success: false, error: result.error ?? "Save failed" }, 200);
    }

    return jsonResponse({
      success: true,
      ig_username: candidate.ig_username,
      facebook_page_name: candidate.facebook_page_name,
    });
  }

  // ---------------- clear_pending_selection: delete the stash row --------------
  if (action === "clear_pending_selection") {
    const selection_id = body.selection_id as string | undefined;
    if (!selection_id) return jsonResponse({ error: "Missing selection_id" }, 400);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase
      .from("oauth_pending_instagram_selections")
      .delete()
      .eq("id", selection_id)
      .eq("user_id", user_id);
    return jsonResponse({ success: true });
  }

  if (action !== "authorize") {
    return jsonResponse({ error: "Invalid request body" }, 400);
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
