import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const TWITTER_CLIENT_ID = Deno.env.get("TWITTER_CLIENT_ID");
const TWITTER_CLIENT_SECRET = Deno.env.get("TWITTER_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Twitter OAuth 2.0 redirect URI - must match exactly what's configured in Twitter Developer Portal
const TWITTER_REDIRECT_URI = "https://api.postora.cloud/functions/v1/twitter-oauth";

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
  if (!TWITTER_CLIENT_SECRET) throw new Error("TWITTER_CLIENT_SECRET not configured");
  const raw = JSON.stringify(payload);
  const sig = await hmacSha256Base64Url(raw, TWITTER_CLIENT_SECRET);
  return `${base64UrlEncode(raw)}.${sig}`;
}

async function verifyAndParseState(state: string) {
  if (!TWITTER_CLIENT_SECRET) throw new Error("TWITTER_CLIENT_SECRET not configured");

  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw new Error("Invalid state format");

  const raw = base64UrlDecode(encoded);
  const expected = await hmacSha256Base64Url(raw, TWITTER_CLIENT_SECRET);
  if (expected !== sig) throw new Error("Invalid state signature");

  return JSON.parse(raw) as {
    user_id: string;
    social_profile_id: string | null;
    return_to: string;
    code_verifier: string;
    mode?: string;
    social_account_id?: string;
  };
}

// Generate PKCE code verifier and challenge
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(String.fromCharCode(...array));
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return base64UrlEncode(bin);
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const redirectUri = TWITTER_REDIRECT_URI;

  try {
    // OAuth callback from Twitter: GET /functions/v1/twitter-oauth?code=...&state=...
    if (req.method === "GET") {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        console.error("Twitter OAuth error:", error, errorDescription);
        // Try to redirect back with error
        if (state) {
          try {
            const parsed = await verifyAndParseState(state);
            const returnUrl = new URL(parsed.return_to);
            returnUrl.searchParams.set("error", "twitter_oauth_failed");
            returnUrl.searchParams.set("error_description", errorDescription || error);
            return Response.redirect(returnUrl.toString(), 302);
          } catch {
            // ignore state parsing errors
          }
        }
        return new Response(`Twitter OAuth error: ${errorDescription || error}`, { status: 400 });
      }

      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }

      const { user_id, social_profile_id, return_to, code_verifier } = await verifyAndParseState(state);

      const result = await completeOAuth({
        code,
        user_id,
        social_profile_id,
        redirect_uri: redirectUri,
        code_verifier,
      });

      // Redirect back to app
      const returnUrl = new URL(return_to);
      returnUrl.searchParams.set("connected", "twitter");
      if (social_profile_id) returnUrl.searchParams.set("profile_id", social_profile_id);
      returnUrl.searchParams.set("account_name", result.username);

      return Response.redirect(returnUrl.toString(), 302);
    }

    // POST-based API (called from the app)
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    console.log("Twitter OAuth action:", action);

    // Generate authorization URL
    if (action === "authorize") {
      if (!TWITTER_CLIENT_ID) throw new Error("TWITTER_CLIENT_ID not configured");
      if (!TWITTER_CLIENT_SECRET) throw new Error("TWITTER_CLIENT_SECRET not configured");

      const userId = body?.user_id as string | undefined;
      const socialProfileId = (body?.social_profile_id as string | null | undefined) ?? null;
      const returnTo = body?.return_to as string | undefined;

      if (!userId) throw new Error("Missing user_id");
      if (!returnTo) throw new Error("Missing return_to");

      // Twitter OAuth 2.0 scopes
      // tweet.read, tweet.write for posting
      // users.read for getting user info
      // offline.access for refresh tokens
      const scopes = [
        "tweet.read",
        "tweet.write",
        "users.read",
        "offline.access",
      ].join(" ");

      // Generate PKCE code verifier and challenge
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      const state = await buildSignedState({
        user_id: userId,
        social_profile_id: socialProfileId,
        return_to: returnTo,
        code_verifier: codeVerifier,
      });

      const params = new URLSearchParams({
        response_type: "code",
        client_id: TWITTER_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: scopes,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const authUrl = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
      console.log("Generated Twitter auth URL (redirect_uri)", redirectUri);

      return new Response(JSON.stringify({ url: authUrl, redirect_uri: redirectUri }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Refresh token
    if (action === "refresh") {
      if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
        throw new Error("Twitter credentials not configured");
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
          throw new Error("No refresh token available. Please reconnect your Twitter account.");
        }
      }

      console.log("Refreshing Twitter token for account:", accountId);

      // Twitter uses Basic auth for token refresh
      const basicAuth = btoa(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`);

      const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: currentRefreshToken,
          client_id: TWITTER_CLIENT_ID,
        }),
      });

      const tokenData = await tokenResponse.json();
      console.log("Token refresh response status:", tokenResponse.status);

      if (tokenData.error) {
        console.error("Token refresh error:", tokenData);
        throw new Error(tokenData.error_description || tokenData.error || "Failed to refresh token");
      }

      // Twitter tokens don't have a fixed expiration, but we set 2 hours (7200 seconds)
      const expiresIn = tokenData.expires_in || 7200;

      const { error: updateError } = await supabase
        .from("social_accounts")
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || currentRefreshToken,
          token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", accountId);

      if (updateError) {
        console.error("Failed to update token:", updateError);
        throw new Error("Failed to save refreshed token");
      }

      console.log("Twitter token refreshed successfully");
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Twitter OAuth error:", error);
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
          returnUrl.searchParams.set("error", "twitter_oauth_failed");
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
  code_verifier: string;
}) {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    throw new Error("Twitter credentials not configured");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials not configured");
  }

  console.log("Exchanging code for access token");

  // Twitter uses Basic auth for token exchange
  const basicAuth = btoa(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`);

  // Exchange authorization code for access token
  const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirect_uri,
      client_id: TWITTER_CLIENT_ID,
      code_verifier: params.code_verifier,
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
    expires_in?: number;
  };

  // Fetch user profile info
  const userInfoResponse = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url,username,name", {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  });

  const userInfoData = await userInfoResponse.json();
  console.log("User info response status:", userInfoResponse.status);
  console.log("User info response body:", JSON.stringify(userInfoData).slice(0, 300));

  // Handle non-200 responses (403 = Free tier restriction or missing scope)
  if (!userInfoResponse.ok) {
    const errMsg = userInfoData?.detail || userInfoData?.title || 
      userInfoData?.errors?.[0]?.message || 
      `Twitter API returned ${userInfoResponse.status}`;
    console.error("User info API error:", errMsg);
    throw new Error(`Failed to get user info: ${errMsg}`);
  }

  if (!userInfoData?.data) {
    throw new Error("Twitter API returned empty user data");
  }

  const userData = userInfoData.data;
  const twitterUserId = userData.id as string;
  const username = userData.username as string;
  const name = userData.name as string || username;
  const rawAvatarUrl = userData.profile_image_url as string | undefined;

  console.log("Twitter user found:", username);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // Twitter tokens expire in ~2 hours by default
  const expiresInSeconds = expires_in || 7200;
  const tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  // Cache avatar to Cloudinary for permanent storage
  const largerAvatarUrl = rawAvatarUrl?.replace("_normal", "_400x400") ?? null;
  const avatarUrl = await cacheAvatarToCloudinary(largerAvatarUrl, params.user_id, "twitter", twitterUserId);

  const { error: dbError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id: params.user_id,
        platform: "twitter",
        platform_user_id: twitterUserId,
        platform_username: username,
        access_token,
        refresh_token: refresh_token ?? null,
        token_expires_at: tokenExpiresAt,
        avatar_url: avatarUrl, // Cached in Cloudinary for permanent storage
        is_active: true,
        // Reset health tracking on successful reconnection
        needs_reauth: false,
        failure_count: 0,
        last_refresh_error: null,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        social_profile_id: params.social_profile_id || null,
        account_metadata: {
          twitter_id: twitterUserId,
          name: name,
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

  console.log("Twitter account saved successfully");
  return { username };
}
