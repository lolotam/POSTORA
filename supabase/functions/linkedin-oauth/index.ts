import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LINKEDIN_CLIENT_ID = Deno.env.get("LINKEDIN_CLIENT_ID");
const LINKEDIN_CLIENT_SECRET = Deno.env.get("LINKEDIN_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// LinkedIn OAuth 2.0 redirect URI - must match exactly what's configured in LinkedIn Developer Portal.
// Backend-forced: ignore any frontend-supplied redirect_uri. Env-driven with safe default.
const LINKEDIN_REDIRECT_URI =
  Deno.env.get("LINKEDIN_REDIRECT_URI") ??
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/linkedin-oauth` : "https://api.postora.cloud/functions/v1/linkedin-oauth");

function base64UrlEncode(input: string) {
  return btoa(input)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (base64.length % 4)) % 4;
  return atob(base64 + "=".repeat(padLength));
}

async function hmacSha256Base64Url(message: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );

  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return base64UrlEncode(bin);
}

async function buildSignedState(payload: Record<string, unknown>) {
  if (!LINKEDIN_CLIENT_SECRET) throw new Error("LINKEDIN_CLIENT_SECRET not configured");
  const raw = JSON.stringify(payload);
  const sig = await hmacSha256Base64Url(raw, LINKEDIN_CLIENT_SECRET);
  return `${base64UrlEncode(raw)}.${sig}`;
}

async function verifyAndParseState(state: string) {
  if (!LINKEDIN_CLIENT_SECRET) throw new Error("LINKEDIN_CLIENT_SECRET not configured");

  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw new Error("Invalid state format");

  const raw = base64UrlDecode(encoded);
  const expected = await hmacSha256Base64Url(raw, LINKEDIN_CLIENT_SECRET);
  if (expected !== sig) throw new Error("Invalid state signature");

  return JSON.parse(raw) as {
    user_id: string;
    social_profile_id: string | null;
    return_to: string;
    flow?: "personal" | "organization";
  };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const redirectUri = LINKEDIN_REDIRECT_URI;

  try {
    // OAuth callback from LinkedIn: GET /functions/v1/linkedin-oauth?code=...&state=...
    if (req.method === "GET") {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        console.error("LinkedIn OAuth error:", error, errorDescription);
        // Try to redirect back with error
        if (state) {
          try {
            const parsed = await verifyAndParseState(state);
            const returnUrl = new URL(parsed.return_to);
            returnUrl.searchParams.set("error", "linkedin_oauth_failed");
            returnUrl.searchParams.set("error_description", errorDescription || error);
            return Response.redirect(returnUrl.toString(), 302);
          } catch {
            // ignore state parsing errors
          }
        }
        return new Response(`LinkedIn OAuth error: ${errorDescription || error}`, { status: 400 });
      }

      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }

      const { user_id, social_profile_id, return_to } = await verifyAndParseState(state);

      const result = await completeOAuth({
        code,
        user_id,
        social_profile_id,
        redirect_uri: redirectUri,
      });

      // Redirect back to app
      const returnUrl = new URL(return_to);
      returnUrl.searchParams.set("connected", "linkedin");
      if (social_profile_id) returnUrl.searchParams.set("profile_id", social_profile_id);
      returnUrl.searchParams.set("account_name", result.name);

      return Response.redirect(returnUrl.toString(), 302);
    }

    // POST-based API (called from the app)
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    console.log("LinkedIn OAuth action:", action);

    // Generate authorization URL
    if (action === "authorize") {
      if (!LINKEDIN_CLIENT_ID) throw new Error("LINKEDIN_CLIENT_ID not configured");
      if (!LINKEDIN_CLIENT_SECRET) throw new Error("LINKEDIN_CLIENT_SECRET not configured");

      const userId = body?.user_id as string | undefined;
      const socialProfileId = (body?.social_profile_id as string | null | undefined) ?? null;
      const returnTo = body?.return_to as string | undefined;
      const rawFlow = (body?.flow as string | undefined) ?? "personal";
      const flow: "personal" | "organization" =
        rawFlow === "organization" ? "organization" : "personal";

      if (!userId) throw new Error("Missing user_id");
      if (!returnTo) throw new Error("Missing return_to");

      // LinkedIn OAuth 2.0 scopes — only the ones approved for this app
      // (Community Management API). "Sign In with OpenID Connect" is NOT enabled
      // on this app, so we must NOT request openid/profile/email.
      // Identity is fetched via /v2/me using r_basicprofile.
      //
      // Flow-aware scopes:
      //   personal      -> member-only scopes
      //   organization  -> member + organization/page scopes
      const explicitOrgFlag =
        body?.include_org_scopes !== undefined ? body.include_org_scopes !== false : null;
      const includeOrgScopes =
        explicitOrgFlag !== null ? explicitOrgFlag : flow === "organization";

      const memberScopes = [
        "r_basicprofile",
        "w_member_social",
        "w_member_social_feed",
        "r_member_postAnalytics",
        "r_member_profileAnalytics",
        "r_1st_connections_size",
      ];

      const orgScopes = [
        "rw_organization_admin",
        "r_organization_social",
        "w_organization_social",
        "r_organization_social_feed",
        "w_organization_social_feed",
        "r_organization_followers",
      ];

      const scopes = [
        ...memberScopes,
        ...(includeOrgScopes ? orgScopes : []),
      ].join(" ");

      const state = await buildSignedState({
        user_id: userId,
        social_profile_id: socialProfileId,
        return_to: returnTo,
        flow,
      });

      const params = new URLSearchParams({
        response_type: "code",
        client_id: LINKEDIN_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: scopes,
        state,
      });

      const authUrl = `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
      console.log("Generated LinkedIn auth URL (redirect_uri)", redirectUri);

      return new Response(JSON.stringify({ url: authUrl, redirect_uri: redirectUri }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Back-compat: allow app-driven callback (POST)
    if (action === "callback") {
      const auth = await authenticateCaller(req, body?.user_id);
      const code = body?.code as string | undefined;
      const social_profile_id = (body?.social_profile_id as string | null | undefined) ?? null;

      if (!code) throw new Error("Missing code");

      const result = await completeOAuth({
        code,
        user_id: auth.userId,
        social_profile_id,
        redirect_uri: redirectUri,
      });

      return new Response(JSON.stringify({ success: true, username: result.name }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Refresh token
    if (action === "refresh") {
      if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
        throw new Error("LinkedIn credentials not configured");
      }
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase credentials not configured");
      }

      const accountId = body?.account_id as string | undefined;
      let currentRefreshToken = body?.refresh_token as string | undefined;

      if (!accountId) throw new Error("Missing account_id");

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      // If refresh_token not provided, fetch it from the database
      if (!currentRefreshToken) {
        console.log("Fetching refresh token from database for account:", accountId);
        const { data: account, error: fetchError } = await supabase
          .from("social_accounts")
          .select("refresh_token")
          .eq("id", accountId)
          .single();

        if (fetchError || !account) {
          console.error("Failed to fetch account:", fetchError);
          throw new Error("Account not found");
        }

        currentRefreshToken = account.refresh_token;
        if (!currentRefreshToken) {
          throw new Error("No refresh token available. Please reconnect your LinkedIn account.");
        }
      }

      console.log("Refreshing LinkedIn token for account:", accountId);

      const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: currentRefreshToken,
          client_id: LINKEDIN_CLIENT_ID,
          client_secret: LINKEDIN_CLIENT_SECRET,
        }),
      });

      const tokenData = await tokenResponse.json();
      console.log("Token refresh response status:", tokenResponse.status);

      if (tokenData.error) {
        console.error("Token refresh error:", tokenData);
        throw new Error(tokenData.error_description || tokenData.error || "Failed to refresh token");
      }

      const { error: updateError } = await supabase
        .from("social_accounts")
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || currentRefreshToken,
          token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", accountId);

      if (updateError) {
        console.error("Failed to update token:", updateError);
        throw new Error("Failed to save refreshed token");
      }

      console.log("LinkedIn token refreshed successfully");
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("LinkedIn OAuth error:", error);
    // Sanitized error message to prevent schema leakage
    const safeMessage = "Authentication failed. Please try again.";

    // If this was a GET callback, redirect back with error so user doesn't get stuck on a blank page
    if (req.method === "GET") {
      const url = new URL(req.url);
      const state = url.searchParams.get("state");
      try {
        if (state) {
          const parsed = await verifyAndParseState(state);
          const returnUrl = new URL(parsed.return_to);
          returnUrl.searchParams.set("error", "linkedin_oauth_failed");
          returnUrl.searchParams.set("error_description", safeMessage);
          return Response.redirect(returnUrl.toString(), 302);
        }
      } catch {
        // ignore
      }
    }

    return new Response(JSON.stringify({ error: safeMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function completeOAuth(params: {
  code: string;
  user_id: string;
  social_profile_id: string | null;
  redirect_uri: string;
}) {
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
    throw new Error("LinkedIn credentials not configured");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials not configured");
  }

  console.log("Exchanging code for access token");

  // Exchange authorization code for access token
  const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirect_uri,
      client_id: LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
    }),
  });

  const tokenData = await tokenResponse.json();
  console.log("Token response status:", tokenResponse.status);

  if (tokenData.error) {
    console.error("Token error:", tokenData);
    throw new Error(tokenData.error_description || tokenData.error || "Failed to get access token");
  }

  const { access_token, refresh_token, expires_in } = tokenData as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Fetch user profile via /v2/me (requires r_basicprofile).
  // We do NOT use /v2/userinfo because the OpenID Connect product is not enabled on this app.
  const meResponse = await fetch(
    "https://api.linkedin.com/v2/me?projection=(id,localizedFirstName,localizedLastName,vanityName,profilePicture(displayImage~:playableStreams))",
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );

  const meInfo = await meResponse.json();
  console.log("LinkedIn /v2/me response status:", meResponse.status);

  if (!meResponse.ok || meInfo.error) {
    console.error("LinkedIn /v2/me error:", meInfo);
    throw new Error(meInfo.message || meInfo.error_description || meInfo.error || "Failed to get user info");
  }

  const linkedInUserId = meInfo.id as string;
  const firstName = (meInfo.localizedFirstName as string) || "";
  const lastName = (meInfo.localizedLastName as string) || "";
  const name = `${firstName} ${lastName}`.trim() || "LinkedIn User";
  const rawAvatarUrl: string | undefined =
    meInfo?.profilePicture?.["displayImage~"]?.elements?.slice(-1)?.[0]?.identifiers?.[0]?.identifier;
  const email: string | undefined = undefined;

  console.log("LinkedIn user found:", name);

  // Vanity name already obtained from /v2/me above
  const vanityName: string | null = (meInfo.vanityName as string | undefined) || null;

  // Fetch organization pages the user can admin
  let linkedinPages: Array<{ id: string; name: string; vanityName?: string; logoUrl?: string }> = [];
  try {
    // First get organization access control (organizations the user can post on behalf of)
    const orgAccessResponse = await fetch(
      "https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(id,localizedName,vanityName,logoV2(original~:playableStreams))))",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    if (orgAccessResponse.ok) {
      const orgData = await orgAccessResponse.json();
      console.log("Organization ACLs response:", JSON.stringify(orgData));

      if (orgData.elements && Array.isArray(orgData.elements)) {
        linkedinPages = orgData.elements
          .filter((el: any) => el["organization~"])
          .map((el: any) => {
            const org = el["organization~"];
            const orgId = org.id?.toString() || el.organization?.split(":").pop();
            return {
              id: orgId,
              name: org.localizedName || "Company Page",
              vanityName: org.vanityName,
              logoUrl: org["logoV2"]?.["original~"]?.elements?.[0]?.identifiers?.[0]?.identifier,
            };
          });
      }
    } else {
      console.log("Could not fetch organization ACLs (may not have permissions):", orgAccessResponse.status);
    }
  } catch (orgError) {
    console.log("Failed to fetch LinkedIn pages (non-critical):", orgError);
  }

  console.log("Found LinkedIn pages:", linkedinPages.length);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  // Cache avatar to Cloudinary for permanent storage
  const avatarUrl = await cacheAvatarToCloudinary(rawAvatarUrl, params.user_id, "linkedin", linkedInUserId);

  const { error: dbError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id: params.user_id,
        platform: "linkedin",
        platform_user_id: linkedInUserId,
        platform_username: name,
        access_token,
        refresh_token: refresh_token ?? null,
        token_expires_at: tokenExpiresAt,
        avatar_url: avatarUrl ?? null,
        is_active: true,
        // Reset health tracking on successful reconnection
        needs_reauth: false,
        failure_count: 0,
        last_refresh_error: null,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        social_profile_id: params.social_profile_id || null,
        account_metadata: {
          email: email,
          linkedin_id: linkedInUserId,
          vanity_name: vanityName,
          linkedin_pages: linkedinPages,
        },
      },
      {
        onConflict: "user_id,platform,platform_user_id",
      },
    );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save account");
  }

  console.log("LinkedIn account saved successfully");
  return { name };
}
