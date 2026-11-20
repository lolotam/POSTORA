import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { recordGrantedScopes } from "../_shared/youtubeGrantedScopes.ts";
import {
  createYouTubeOAuthHandler,
  NoYouTubeChannelError,
  type YouTubeOAuthPorts,
} from "./handler.ts";
import { revokeGoogleToken } from "./revoke.ts";
import { buildRefusalLogRow } from "./refusalLog.ts";

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
    revoke: (token) => revokeGoogleToken(fetch, token),
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
    load: async ({ accountId, userId }) => {
      const { data, error } = await admin
        .from("social_accounts")
        .select("id, user_id, access_token, refresh_token, is_active, auth_provider, account_metadata, updated_at")
        .eq("id", accountId)
        .eq("user_id", userId)
        .eq("platform", "youtube")
        .maybeSingle();
      if (error) throw rpcFailure(error);
      if (!data || data.auth_provider === "composio") return null;
      const metadata = data.account_metadata;
      return {
        id: data.id as string,
        userId: data.user_id as string,
        accessToken: (data.access_token as string | null) ?? null,
        refreshToken: (data.refresh_token as string | null) ?? null,
        isActive: Boolean(data.is_active),
        accountMetadata: metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : null,
        updatedAt: (data.updated_at as string | null) ?? null,
      };
    },
    // Revoking at Google ends the whole authorization of that Google account, and two
    // channels connected separately hold different refresh token strings for the same
    // authorization, and a native channel may have no refresh token at all. Matching on
    // the token would miss a sibling and break it, so any other active native channel of
    // this user blocks the revoke (null auth_provider counts as native).
    countOtherActiveNativeAccounts: async ({ userId, excludeAccountId }) => {
      const { count, error } = await admin
        .from("social_accounts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("platform", "youtube")
        .eq("is_active", true)
        .or("auth_provider.is.null,auth_provider.neq.composio")
        .neq("id", excludeAccountId);
      if (error || count === null) throw rpcFailure(error ?? {});
      return count;
    },
    clearCredentials: async ({ accountId, userId, updatedAt, expectedUpdatedAt, accountMetadata }) => {
      let update = admin
        .from("social_accounts")
        .update({
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          is_active: false,
          needs_reauth: false,
          failure_count: 0,
          last_refresh_error: null,
          account_metadata: accountMetadata,
          updated_at: updatedAt,
        })
        .eq("id", accountId)
        .eq("user_id", userId)
        .eq("platform", "youtube");
      // Conditional on the snapshot this disconnect decided on: a reconnect that wrote
      // newer credentials in the meantime changes updated_at and matches no row.
      update = expectedUpdatedAt === null ? update.is("updated_at", null) : update.eq("updated_at", expectedUpdatedAt);
      const { data, error } = await update.select("id").maybeSingle();
      if (error) throw rpcFailure(error);
      if (!data) {
        const conflict = new Error("account_changed") as Error & { code?: string };
        conflict.code = "account_changed";
        throw conflict;
      }
    },
  },
  clock: { now: () => new Date() },
  log: {
    refusal: async ({ action, reason, userId }) => {
      const { error } = await admin
        .from("system_logs")
        .insert(buildRefusalLogRow({ action, reason, userId }));
      // The throw lets refuse()'s catch run, but that catch only logs the
      // refusal's action/reason, not why the insert failed — so the database
      // error itself is logged here (code/message are not secrets; no row
      // content).
      if (error) {
        console.warn({
          event: "youtube_oauth_refusal_insert_failed",
          code: error.code,
          message: error.message,
        });
        throw rpcFailure(error);
      }
    },
  },
};

Deno.serve(createYouTubeOAuthHandler(ports, {
  clientId: GOOGLE_CLIENT_ID,
  redirectUri: YOUTUBE_REDIRECT_URI,
  trustedAppOrigin: Deno.env.get("PUBLIC_APP_ORIGIN"),
}));
