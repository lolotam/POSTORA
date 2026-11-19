import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { recordGrantedScopes } from "../_shared/youtubeGrantedScopes.ts";
import {
  createYouTubeOAuthHandler,
  NoYouTubeChannelError,
  type YouTubeOAuthPorts,
} from "./handler.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function rpcFailure(error: { code?: string; message?: string }): Error {
  const failure = new Error("rpc_failed") as Error & { code?: string };
  failure.code = error.code;
  return failure;
}

const ports: YouTubeOAuthPorts = {
  auth: {
    authenticate: async (req, bodyUserId) => {
      const auth = await authenticateCaller(req, bodyUserId);
      return { userId: auth.userId };
    },
  },
  attempts: {
    create: async ({ userId, socialProfileId, returnTo, ttlSeconds }) => {
      const { data, error } = await admin.rpc("create_youtube_oauth_attempt_v2", {
        p_user_id: userId,
        p_social_profile_id: socialProfileId,
        p_return_to: returnTo,
        p_ttl_seconds: ttlSeconds,
      });
      if (error || !data?.nonce) throw rpcFailure(error ?? {});
      return { nonce: data.nonce as string };
    },
    consume: async (nonce) => {
      const { data, error } = await admin.rpc("consume_youtube_oauth_attempt_by_nonce", {
        p_nonce: nonce,
      });
      if (error) throw rpcFailure(error);
      if (!data?.ok) return { ok: false, reason: String(data?.reason ?? "invalid_request") };
      return {
        ok: true,
        userId: data.user_id as string,
        socialProfileId: data.social_profile_id as string,
        returnTo: (data.return_to as string | null) ?? null,
      };
    },
  },
  google: {
    complete: async (code) => {
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        throw new Error("Google credentials not configured");
      }
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: YOUTUBE_REDIRECT_URI,
        }),
      });
      const tokenData = await tokenResponse.json();
      if (tokenData.error) throw new Error("google_token_exchange_failed");

      const channelResponse = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
      );
      const channelData = await channelResponse.json();
      if (channelData.error) throw new Error("google_channel_lookup_failed");
      const channel = channelData.items?.[0];
      if (!channel) throw new NoYouTubeChannelError();

      return {
        accessToken: tokenData.access_token as string,
        refreshToken: (tokenData.refresh_token as string | undefined) ?? undefined,
        expiresIn: tokenData.expires_in as number,
        scope: tokenData.scope as string | undefined,
        channel: {
          id: channel.id as string,
          title: (channel.snippet?.title as string | undefined) ?? "YouTube",
          avatarUrl: (channel.snippet?.thumbnails?.default?.url as string | undefined) ?? null,
        },
      };
    },
  },
  accounts: {
    findDefaultProfile: async (userId) => {
      const { data, error } = await admin
        .from("social_profiles")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw rpcFailure(error);
      return (data?.id as string | undefined) ?? null;
    },
    save: async (input) => {
      const avatarUrl = await cacheAvatarToCdn(input.avatarUrl, input.userId, "youtube", input.channelId);
      // Optional columns are omitted rather than nulled: on conflict the upsert only
      // touches the columns present, so a re-consent that returns no refresh_token
      // keeps the stored one and account_metadata is never overwritten.
      const { data, error } = await admin
        .from("social_accounts")
        .upsert(
          {
            user_id: input.userId,
            platform: "youtube",
            platform_user_id: input.channelId,
            platform_username: input.channelTitle,
            access_token: input.accessToken,
            ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
            token_expires_at: input.tokenExpiresAt,
            avatar_url: avatarUrl,
            is_active: true,
            connected_at: input.connectedAt,
            updated_at: input.updatedAt,
            social_profile_id: input.socialProfileId,
            needs_reauth: false,
            failure_count: 0,
            last_refresh_error: null,
          },
          { onConflict: "user_id,platform,platform_user_id" },
        )
        .select("id")
        .single();
      if (error || !data) throw rpcFailure(error ?? {});
      await recordGrantedScopes(admin, data.id, input.grantedScope);
    },
  },
  clock: { now: () => new Date() },
  log: {
    refusal: async ({ action, reason, userId }) => {
      await admin.from("system_logs").insert({
        level: "warn",
        category: "oauth",
        source: "youtube-oauth",
        message: "YouTube OAuth request refused",
        user_id: userId,
        metadata: { action, reason },
      });
    },
  },
};

Deno.serve(createYouTubeOAuthHandler(ports, {
  clientId: GOOGLE_CLIENT_ID,
  redirectUri: YOUTUBE_REDIRECT_URI,
  trustedAppOrigin: Deno.env.get("PUBLIC_APP_ORIGIN"),
}));
