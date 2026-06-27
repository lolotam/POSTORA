import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// IMPORTANT: Google requires an EXACT string match for redirect_uri against the
// value registered in Google Cloud Console. On self-hosted Supabase, SUPABASE_URL
// points at the internal Kong gateway (http://kong:8000), which is neither
// reachable from Google nor registered — using it as a redirect_uri produces
// Google "Error 400: invalid_request" (redirect_uri_mismatch). Derive the public
// redirect_uri only from explicitly-public configuration.
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const YOUTUBE_REDIRECT_URI =
  Deno.env.get("YOUTUBE_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/youtube-oauth`;

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
  if (!GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET not configured");
  const raw = JSON.stringify(payload);
  const sig = await hmacSha256Base64Url(raw, GOOGLE_CLIENT_SECRET);
  return `${base64UrlEncode(raw)}.${sig}`;
}

async function verifyAndParseState(state: string) {
  if (!GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET not configured");

  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw new Error("Invalid state format");

  const raw = base64UrlDecode(encoded);
  const expected = await hmacSha256Base64Url(raw, GOOGLE_CLIENT_SECRET);
  if (expected !== sig) throw new Error("Invalid state signature");

  return JSON.parse(raw) as {
    user_id: string;
    social_profile_id: string | null;
    return_to: string;
  };
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const redirectUri = YOUTUBE_REDIRECT_URI;

  try {
    // OAuth callback from Google: GET /functions/v1/youtube-oauth?code=...&state=...
    if (req.method === "GET") {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

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
      returnUrl.searchParams.set("connected", "youtube");
      if (social_profile_id) returnUrl.searchParams.set("profile_id", social_profile_id);
      returnUrl.searchParams.set("channel", result.channelTitle);

      return Response.redirect(returnUrl.toString(), 302);
    }

    // POST-based API (called from the app)
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    console.log("YouTube OAuth action:", action);

    // Generate authorization URL
    if (action === "authorize") {
      if (!GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID not configured");
      if (!GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET not configured");

      const auth = await authenticateCaller(req, body?.user_id);
      const userId = auth.userId;
      const socialProfileId = (body?.social_profile_id as string | null | undefined) ?? null;
      const returnTo = body?.return_to as string | undefined;

      if (!returnTo) throw new Error("Missing return_to");

      // Narrow scopes matching what Google has approved for this app.
      // Broad `auth/youtube` is a restricted scope that triggers extra verification.
      const scopes = [
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.upload",
      ].join(" ");

      const state = await buildSignedState({
        user_id: userId,
        social_profile_id: socialProfileId,
        return_to: returnTo,
      });

      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      console.log("Generated YouTube auth URL (redirect_uri)", redirectUri);

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

      return new Response(JSON.stringify({ success: true, username: result.channelTitle }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Refresh token
    if (action === "refresh") {
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        throw new Error("Google credentials not configured");
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
          throw new Error("No refresh token available. Please reconnect your YouTube account.");
        }
      }

      console.log("Refreshing YouTube token for account:", accountId);

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: currentRefreshToken,
          grant_type: "refresh_token",
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
          token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", accountId);

      if (updateError) {
        console.error("Failed to update token:", updateError);
        throw new Error("Failed to save refreshed token");
      }

      console.log("YouTube token refreshed successfully");
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("YouTube OAuth error:", error);
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
          returnUrl.searchParams.set("error", "youtube_oauth_failed");
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
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Google credentials not configured");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials not configured");
  }

  console.log("Exchanging code for access token");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: params.redirect_uri,
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

  const channelResponse = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    },
  );

  const channelData = await channelResponse.json();
  console.log("Channel info response status:", channelResponse.status);

  if (channelData.error) {
    console.error("Channel error:", channelData);
    throw new Error(channelData.error.message || "Failed to get channel info");
  }

  const channel = channelData.items?.[0];
  if (!channel) throw new Error("No YouTube channel found for this account");

  const channelId = channel.id as string;
  const channelTitle = (channel.snippet?.title as string | undefined) ?? "YouTube";
  const rawAvatarUrl = (channel.snippet?.thumbnails?.default?.url as string | undefined) ?? null;

  console.log("Channel found:", channelTitle);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // YouTube access tokens expire in ~1 hour, but refresh tokens are long-lived
  // We'll set expiry based on actual expires_in but tokens auto-refresh
  const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  // Cache avatar to Cloudinary for permanent storage
  const avatarUrl = await cacheAvatarToCloudinary(rawAvatarUrl, params.user_id, "youtube", channelId);

  const { error: dbError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id: params.user_id,
        platform: "youtube",
        platform_user_id: channelId,
        platform_username: channelTitle,
        access_token,
        refresh_token: refresh_token ?? null,
        token_expires_at: tokenExpiresAt,
        avatar_url: avatarUrl,
        is_active: true,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        social_profile_id: params.social_profile_id || null,
        // Reset health tracking on successful reconnection
        needs_reauth: false,
        failure_count: 0,
        last_refresh_error: null,
      },
      {
        onConflict: "user_id,platform,platform_user_id",
      },
    );

  if (dbError) {
    console.error("Database error:", dbError);
    throw new Error("Failed to save account");
  }

  console.log("YouTube account saved successfully");
  return { channelTitle };
}
