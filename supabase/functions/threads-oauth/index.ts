import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";
import {
  reconnectErrorParam,
  reconnectSocialAccountInPlace,
} from "../_shared/socialAccountReconnect.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const THREADS_APP_ID = Deno.env.get("THREADS_APP_ID")!;
const THREADS_APP_SECRET = Deno.env.get("THREADS_APP_SECRET")!;
const SUPABASE_FUNCTIONS_BASE_URL =
  (SUPABASE_URL ?? "https://api.postora.cloud").replace(/\/+$/, "");

// Unified backend callback URL. Provider console MUST register exactly this.
const THREADS_REDIRECT_URI =
  Deno.env.get("THREADS_REDIRECT_URI") ??
  `${SUPABASE_FUNCTIONS_BASE_URL}/functions/v1/threads-oauth`;

const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

// Threads OAuth scopes — request ALL granular permissions the app supports.
// IMPORTANT: Each scope here MUST also be added in the Meta App Dashboard under
// "Threads API > Permissions and Features" — Meta silently drops scopes that
// aren't enabled at the app level.
const THREADS_SCOPE_LIST = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_insights",
  "threads_profile_discovery",
  "threads_keyword_search",
  "threads_location_tagging",
  "threads_share_to_instagram",
  "threads_delete",
  "threads_manage_mentions",
  "threads_read_replies",
  "threads_manage_replies",
];
const THREADS_SCOPES = THREADS_SCOPE_LIST.join(",");

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

interface ThreadsTokenExchangeResult {
  access_token: string;
  expires_in: number;
  tokenGrantedScopes: string[];
}

/**
 * Reconnect mode targets the row the user clicked "Reconnect" on. Threads user
 * ids are app-scoped, so after a Meta app change the same account comes back
 * with a new id and the upsert below would insert a duplicate instead of
 * renewing the expired row.
 */
interface ReconnectTarget {
  social_account_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readReconnectTarget(source: Record<string, unknown>): ReconnectTarget | null {
  if (source.mode !== "reconnect") return null;
  const id = source.social_account_id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return { social_account_id: id };
}

async function exchangeThreadsCode(
  code: string,
  redirectUri: string,
): Promise<ThreadsTokenExchangeResult> {
  // Short-lived token exchange.
  const tokenResponse = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: THREADS_APP_ID,
      client_secret: THREADS_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  const tokenData = await tokenResponse.json();

  if (tokenData.error) {
    throw new Error(`Threads OAuth error: ${tokenData.error_message || tokenData.error}`);
  }

  const shortToken: string = tokenData.access_token;
  const tokenPermissionsRaw = tokenData.permissions;
  const tokenGrantedScopes: string[] = Array.isArray(tokenPermissionsRaw)
    ? tokenPermissionsRaw.map((s: unknown) => String(s).trim()).filter(Boolean)
    : typeof tokenPermissionsRaw === "string"
      ? tokenPermissionsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  console.log("Threads token-reported permissions:", JSON.stringify(tokenGrantedScopes));

  // Exchange for long-lived token (60-day).
  const longLivedResponse = await fetch(
    `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${THREADS_APP_SECRET}&access_token=${shortToken}`,
  );
  const longLivedData = await longLivedResponse.json();

  return {
    access_token: longLivedData.access_token || shortToken,
    expires_in: longLivedData.expires_in || 5184000,
    tokenGrantedScopes,
  };
}

async function saveThreadsAccount(
  supabase: SupabaseClient,
  user_id: string,
  exchange: ThreadsTokenExchangeResult,
  destination: { social_profile_id: string | null; reconnect: ReconnectTarget | null },
): Promise<{ username: string }> {
  const { social_profile_id, reconnect } = destination;
  const { access_token: finalAccessToken, expires_in: expiresIn, tokenGrantedScopes } = exchange;

  let permissionsFromApi: string[] = [];
  if (!tokenGrantedScopes.includes("threads_share_to_instagram")) {
    try {
      const permissionsResponse = await fetch(
        `https://graph.threads.net/v1.0/me/permissions?access_token=${encodeURIComponent(finalAccessToken)}`,
      );
      if (permissionsResponse.ok) {
        const permissionsPayload = await permissionsResponse.json();
        if (Array.isArray(permissionsPayload?.data)) {
          permissionsFromApi = permissionsPayload.data
            .filter((permission: { status?: unknown }) => permission.status === "granted")
            .map((permission: { permission?: unknown }) => String(permission.permission ?? "").trim())
            .filter(Boolean);
          console.log("Threads /me/permissions probe:", JSON.stringify(permissionsFromApi));
        }
      } else {
        console.warn(`Threads: /me/permissions probe failed (non-fatal): HTTP ${permissionsResponse.status}`);
      }
    } catch (e) {
      console.warn("Threads: /me/permissions probe failed (non-fatal):", (e as Error).message);
    }
  }
  const effectiveGrantedScopes = permissionsFromApi.length > 0
    ? permissionsFromApi
    : tokenGrantedScopes;

  // Get user profile
  const profileResponse = await fetch(
    `https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${finalAccessToken}`,
  );
  const profileData = await profileResponse.json();
  console.log("Threads profile:", JSON.stringify(profileData).slice(0, 200));

  const safeUserId = profileData.id;
  const username = profileData.username || `threads_${safeUserId}`;
  const rawAvatarUrl = profileData.threads_profile_picture_url;
  const avatarUrl = await cacheAvatarToCdn(rawAvatarUrl, user_id, "threads", safeUserId);

  // Probe granted permissions/capabilities so the UI can tell what this token can do.
  const grantedScopes: string[] = [];
  type ProbeOutcome = { ok: boolean; capability: boolean | null; code?: number; subcode?: number; message?: string };
  const capabilityProbe: Record<string, ProbeOutcome> = {};

  // deno-lint-ignore no-explicit-any
  function classifyProbe(j: any): ProbeOutcome {
    if (!j?.error) return { ok: true, capability: true };
    const code: number | undefined = j.error.code;
    const subcode: number | undefined = j.error.error_subcode;
    const message: string = (j.error.message || j.error.error_user_msg || "").toString();
    const lower = message.toLowerCase();
    if (code === 10 && (lower.includes("permission") || lower.includes("scope") || lower.includes("approved") || lower.includes("unapproved") || lower.includes("review"))) {
      return { ok: false, capability: false, code, subcode, message };
    }
    return { ok: false, capability: null, code, subcode, message };
  }

  try {
    const r = await fetch(`https://graph.threads.net/v1.0/${safeUserId}/threads_insights?metric=views&access_token=${finalAccessToken}`);
    capabilityProbe.insights = classifyProbe(await r.json());
    if (capabilityProbe.insights.capability === true) grantedScopes.push("threads_manage_insights");
  } catch (e) {
    capabilityProbe.insights = { ok: false, capability: null, message: (e as Error).message };
  }

  try {
    const r = await fetch(`https://graph.threads.net/v1.0/profile_posts?username=${encodeURIComponent(username)}&fields=id&limit=1&access_token=${finalAccessToken}`);
    capabilityProbe.discovery = classifyProbe(await r.json());
    if (capabilityProbe.discovery.capability === true) grantedScopes.push("threads_profile_discovery");
  } catch (e) {
    capabilityProbe.discovery = { ok: false, capability: null, message: (e as Error).message };
  }

  try {
    const r = await fetch(`https://graph.threads.net/v1.0/keyword_search?q=${encodeURIComponent(username)}&fields=id&limit=1&access_token=${finalAccessToken}`);
    capabilityProbe.keyword_search = classifyProbe(await r.json());
    if (capabilityProbe.keyword_search.capability === true) grantedScopes.push("threads_keyword_search");
  } catch (e) {
    capabilityProbe.keyword_search = { ok: false, capability: null, message: (e as Error).message };
  }

  try {
    const r = await fetch(
      `https://graph.threads.net/v1.0/location_search?q=coffee&fields=id,name,city,country,address&access_token=${finalAccessToken}`,
    );
    const probeJson = await r.json();
    capabilityProbe.location_tagging = classifyProbe(probeJson);
    if (capabilityProbe.location_tagging.capability === true) {
      const rows = Array.isArray(probeJson?.data) ? probeJson.data : [];
      const { isThreadsLocationSampleData } = await import("../_shared/threads-debug.ts");
      if (isThreadsLocationSampleData(rows, "coffee")) {
        capabilityProbe.location_tagging = {
          ok: false,
          capability: false,
          message: "Sample data only — awaiting Advanced Access approval for threads_location_tagging.",
        };
      } else {
        grantedScopes.push("threads_location_tagging");
      }
    }
  } catch (e) {
    capabilityProbe.location_tagging = { ok: false, capability: null, message: (e as Error).message };
  }

  capabilityProbe.share_to_instagram = { ok: true, capability: null, message: "Verified on first publish" };
  capabilityProbe.delete_posts = { ok: true, capability: null, message: "Verified on first delete attempt" };

  if (effectiveGrantedScopes.length > 0) {
    if (effectiveGrantedScopes.includes("threads_share_to_instagram")) {
      capabilityProbe.share_to_instagram = {
        ok: true,
        capability: true,
        message: "Granted at OAuth consent",
      };
      grantedScopes.push("threads_share_to_instagram");
    } else {
      capabilityProbe.share_to_instagram = {
        ok: false,
        capability: false,
        message: "Scope not granted by Meta — reconnect Threads or enable threads_share_to_instagram in Meta App Dashboard.",
      };
    }
  }

  try {
    const r = await fetch(
      `https://graph.threads.net/v1.0/me/mentions?fields=id&limit=1&access_token=${finalAccessToken}`,
    );
    capabilityProbe.mentions = classifyProbe(await r.json());
    if (capabilityProbe.mentions.capability === true) grantedScopes.push("threads_manage_mentions");
  } catch (e) {
    capabilityProbe.mentions = { ok: false, capability: null, message: (e as Error).message };
  }

  grantedScopes.push("threads_basic", "threads_content_publish");

  for (const s of effectiveGrantedScopes) {
    if (!grantedScopes.includes(s)) grantedScopes.push(s);
  }

  console.log("Threads capability probe:", JSON.stringify(capabilityProbe));

  const accountMetadata = {
    granted_scopes: Array.from(new Set(grantedScopes)),
    capability_probe: capabilityProbe,
    capabilities: {
      canPublish: true,
      canViewInsights: capabilityProbe.insights.capability,
      canUseDiscovery: capabilityProbe.discovery.capability,
      canUseKeywordSearch: capabilityProbe.keyword_search.capability,
      canUseLocationTagging: capabilityProbe.location_tagging.capability,
      locationTaggingReason:
        capabilityProbe.location_tagging.capability === false &&
        String(capabilityProbe.location_tagging.message || "").toLowerCase().includes("sample data")
          ? "awaiting_advanced_access"
          : null,
      canCrossShareToIg: capabilityProbe.share_to_instagram.capability,
      canDeleteThreadsPosts: capabilityProbe.delete_posts.capability,
      canManageMentions: capabilityProbe.mentions?.capability ?? null,
    },
    capability_probed_at: new Date().toISOString(),
  };

  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  if (reconnect) {
    // Same handle, possibly a new app-scoped id: renew the clicked row in place.
    const result = await reconnectSocialAccountInPlace(supabase, {
      socialAccountId: reconnect.social_account_id,
      userId: user_id,
      platform: "threads",
      identity: { platformUserId: String(safeUserId), platformUsername: username },
      identityPolicy: "username",
      patch: {
        access_token: finalAccessToken,
        token_expires_at: tokenExpiresAt,
        avatar_url: avatarUrl,
        account_metadata: accountMetadata,
      },
    });
    console.log(JSON.stringify({
      event: "threads_account_reconnected",
      user_id,
      social_account_id: reconnect.social_account_id,
      id_changed: result.previousPlatformUserId !== result.platformUserId,
      retired_duplicate: result.retiredSiblingId,
    }));
    return { username };
  }

  // Atomic upsert - prevents race conditions and ensures only 1 row per user/platform/account
  const { error: dbError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id,
        platform: "threads",
        platform_user_id: safeUserId,
        platform_username: username,
        avatar_url: avatarUrl,
        access_token: finalAccessToken,
        token_expires_at: tokenExpiresAt,
        is_active: true,
        social_profile_id,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_metadata: accountMetadata,
        needs_reauth: false,
        failure_count: 0,
        last_refresh_error: null,
      },
      { onConflict: "user_id,platform,platform_user_id" },
    );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save Threads account");
  }

  console.log("Threads account saved successfully via atomic upsert");
  return { username };
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ============================================================
  // GET callback: provider redirects user back here directly
  // ============================================================
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    try {
      if (errorParam) {
        const ret = new URL(RETURN_URL_DEFAULT);
        ret.searchParams.set("connected", "threads");
        ret.searchParams.set("error", errorParam);
        return Response.redirect(ret.toString(), 302);
      }
      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }
      if (!THREADS_APP_ID || !THREADS_APP_SECRET) {
        return new Response("Threads credentials not configured", { status: 500 });
      }

      const payload = await verifyOAuthState(state, { expectedPlatform: "threads" });
      // The target came from the signed state, so it is the one this user
      // asked to reconnect; ownership is re-checked against the row itself.
      const reconnect = readReconnectTarget(payload);
      const exchange = await exchangeThreadsCode(code, THREADS_REDIRECT_URI);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await saveThreadsAccount(supabase, payload.user_id, exchange, {
        social_profile_id: payload.profile_id ?? null,
        reconnect,
      });

      const ret = new URL(payload.return_to ?? RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "threads");
      if (reconnect) ret.searchParams.set("reconnected", "1");
      if (payload.profile_id) ret.searchParams.set("profile_id", payload.profile_id);
      return Response.redirect(ret.toString(), 302);
    } catch (err) {
      console.error("Threads GET callback error:", err);
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "threads");
      ret.searchParams.set("error", reconnectErrorParam(err, "threads_callback_failed"));
      return Response.redirect(ret.toString(), 302);
    }
  }

  // ============================================================
  // POST API: authorize + legacy callback shim
  // ============================================================
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, code, redirect_uri, social_profile_id, return_to } = body;
    const reconnect = readReconnectTarget(body);
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
      if (!THREADS_APP_ID || THREADS_APP_ID.trim() === "") {
        console.error(JSON.stringify({
          event: "threads_oauth_missing_app_id",
          user_id,
        }));
        return new Response(
          JSON.stringify({ error: "Threads app is not configured. Contact admin." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Backend-controlled redirect URI. Frontend-supplied value is ignored
      // for security/consistency: must match provider console exactly.
      const effectiveRedirect = THREADS_REDIRECT_URI;

      const state = await createOAuthState({
        platform: "threads",
        user_id,
        profile_id: social_profile_id ?? null,
        return_to: return_to ?? RETURN_URL_DEFAULT,
        extra: reconnect ? { mode: "reconnect", social_account_id: reconnect.social_account_id } : undefined,
      });

      // Build URL manually so commas in `scope` stay literal (Meta's docs use raw commas).
      const authUrl = `https://threads.net/oauth/authorize`
        + `?client_id=${encodeURIComponent(THREADS_APP_ID)}`
        + `&redirect_uri=${encodeURIComponent(effectiveRedirect)}`
        + `&scope=${THREADS_SCOPES}`
        + `&response_type=code`
        + `&state=${encodeURIComponent(state)}`;

      console.log(JSON.stringify({
        event: "threads_oauth_authorize_url_built",
        app_id_prefix: THREADS_APP_ID.slice(0, 6),
        redirect_uri: effectiveRedirect,
        scopes: THREADS_SCOPE_LIST,
        user_id,
      }));

      return new Response(
        JSON.stringify({
          url: authUrl,
          redirect_uri: effectiveRedirect,
          debug: {
            scopes: THREADS_SCOPE_LIST,
            redirect_uri: effectiveRedirect,
            // Indicates frontend-supplied value (now ignored).
            requested_redirect_uri: redirect_uri ?? null,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // LEGACY: removable after provider console fully cuts over to the GET callback.
    // Kept so in-flight sessions whose provider redirect still points at
    // https://postora.cloud/profiles can finish via the frontend POST shim.
    if (action === "callback") {
      if (!code) throw new Error("Missing code");
      if (!redirect_uri) throw new Error("Missing redirect_uri");
      if (!THREADS_APP_ID || !THREADS_APP_SECRET) {
        throw new Error("Threads credentials not configured");
      }

      console.log("Processing Threads OAuth legacy POST callback for user:", user_id);
      const exchange = await exchangeThreadsCode(code, redirect_uri);
      const { username } = await saveThreadsAccount(supabase, user_id, exchange, {
        social_profile_id: social_profile_id ?? null,
        reconnect,
      });

      return new Response(JSON.stringify({ success: true, username, reconnected: !!reconnect }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    console.error("Threads OAuth error:", error);
    return new Response(
      JSON.stringify({ error: "Authentication failed. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
