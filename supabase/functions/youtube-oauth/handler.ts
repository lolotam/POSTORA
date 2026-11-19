import { z } from "npm:zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { safeReturnTo } from "../_shared/oauthState.ts";
import type { GoogleRevokeResult } from "./revoke.ts";

export type { GoogleRevokeResult };

const DEFAULT_RETURN_TO = "https://postora.cloud/profiles";
const ATTEMPT_TTL_SECONDS = 600;
const GENERIC_ERROR = "Authentication failed. Please try again.";
const DISCONNECT_GENERIC_ERROR = "Failed to disconnect YouTube account. Please try again.";
const NO_CHANNEL_ERROR = "The Google account you selected has no YouTube channel. Please sign in with a Google account that has an active YouTube channel.";

export class NoYouTubeChannelError extends Error {
  constructor() {
    super(NO_CHANNEL_ERROR);
  }
}

export interface YouTubeOAuthAttempt {
  userId: string;
  socialProfileId: string;
  returnTo: string | null;
}

export interface YouTubeAccountSave {
  userId: string;
  socialProfileId: string;
  channelId: string;
  channelTitle: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: string;
  avatarUrl: string | null;
  connectedAt: string;
  updatedAt: string;
  grantedScope?: string;
}

export interface YouTubeDisconnectAccount {
  id: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  isActive: boolean;
  accountMetadata: Record<string, unknown> | null;
}

export interface YouTubeOAuthPorts {
  auth: {
    authenticate(req: Request, bodyUserId?: string): Promise<{ userId: string }>;
  };
  attempts: {
    create(input: {
      userId: string;
      socialProfileId: string;
      returnTo: string;
      ttlSeconds: number;
    }): Promise<{ nonce: string }>;
    consume(nonce: string): Promise<
      { ok: true } & YouTubeOAuthAttempt | { ok: false; reason: string }
    >;
  };
  google: {
    complete(code: string): Promise<{
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      scope?: string;
      channel: { id: string; title: string; avatarUrl: string | null };
    }>;
    revoke(token: string): Promise<GoogleRevokeResult>;
  };
  accounts: {
    findDefaultProfile(userId: string): Promise<string | null>;
    save(input: YouTubeAccountSave): Promise<void>;
    load(input: { accountId: string; userId: string }): Promise<YouTubeDisconnectAccount | null>;
    countOtherActiveNativeAccounts(input: {
      userId: string;
      excludeAccountId: string;
    }): Promise<number>;
    clearCredentials(input: {
      accountId: string;
      userId: string;
      updatedAt: string;
      accountMetadata: Record<string, unknown>;
    }): Promise<void>;
  };
  clock: { now(): Date };
  log: {
    refusal(input: { action: string; reason: string; userId: string | null }): Promise<void>;
  };
}

export interface YouTubeOAuthConfig {
  clientId: string;
  redirectUri: string;
  trustedAppOrigin?: string;
  defaultReturnTo?: string;
}

const AuthorizeSchema = z.object({
  action: z.literal("authorize"),
  social_profile_id: z.string().uuid().nullish(),
  return_to: z.string().min(1).max(2048),
});
const CallbackSchema = z.object({
  action: z.literal("callback"),
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256),
});
const DisconnectSchema = z.object({
  action: z.literal("disconnect"),
  account_id: z.string().uuid(),
});

function stripGrantMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const { granted_scopes: _removed, ...rest } = metadata;
  return rest;
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function redirect(returnTo: string, result: { channelTitle: string; profileId: string }): Response {
  const url = new URL(returnTo);
  url.searchParams.set("connected", "youtube");
  url.searchParams.set("profile_id", result.profileId);
  url.searchParams.set("channel", result.channelTitle);
  return Response.redirect(url.toString(), 302);
}

function redirectError(returnTo: string, noChannel: boolean): Response {
  const url = new URL(returnTo);
  url.searchParams.set("error", noChannel ? "NO_YOUTUBE_CHANNEL" : "youtube_oauth_failed");
  url.searchParams.set("error_description", noChannel ? NO_CHANNEL_ERROR : GENERIC_ERROR);
  return Response.redirect(url.toString(), 302);
}

function bodyUserId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>).user_id;
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function createYouTubeOAuthHandler(
  ports: YouTubeOAuthPorts,
  config: YouTubeOAuthConfig,
): (req: Request) => Promise<Response> {
  async function refuse(
    req: Request,
    action: string,
    reason: string,
    userId: string | null,
    status: number,
  ): Promise<Response> {
    try {
      await ports.log.refusal({ action, reason, userId });
    } catch {
      console.warn({ event: "youtube_oauth_refusal_log_failed", action, reason });
    }
    const serverError = action === "disconnect" ? DISCONNECT_GENERIC_ERROR : GENERIC_ERROR;
    // Server-side failures never expose their internal reason to the caller.
    return json(req, { error: status >= 500 ? serverError : reason }, status);
  }

  async function handleDisconnect(
    req: Request,
    body: unknown,
    userId: string,
  ): Promise<Response> {
    const parsed = DisconnectSchema.safeParse(body);
    if (!parsed.success) return refuse(req, "disconnect", "invalid_request", userId, 400);
    const accountId = parsed.data.account_id;

    let account: YouTubeDisconnectAccount | null;
    try {
      account = await ports.accounts.load({ accountId, userId });
    } catch {
      return refuse(req, "disconnect", "account_read_failed", userId, 500);
    }
    if (!account || account.userId !== userId) {
      return refuse(req, "disconnect", "account_not_found", userId, 404);
    }

    let revoked = false;
    let reason: "missing_grant" | "grant_shared" | "already_invalid" | null = null;
    const refreshToken = account.refreshToken?.trim() || null;

    if (!refreshToken) {
      reason = "missing_grant";
    } else {
      let otherActiveCount: number;
      try {
        otherActiveCount = await ports.accounts.countOtherActiveNativeAccounts({
          userId,
          excludeAccountId: account.id,
        });
      } catch {
        return refuse(req, "disconnect", "grant_count_failed", userId, 500);
      }

      if (otherActiveCount > 0) {
        reason = "grant_shared";
      } else {
        let revokeResult: GoogleRevokeResult;
        try {
          revokeResult = await ports.google.revoke(refreshToken);
        } catch {
          return refuse(req, "disconnect", "google_revoke_failed", userId, 502);
        }
        if (!revokeResult.ok) {
          return refuse(req, "disconnect", revokeResult.reason, userId, 502);
        }
        revoked = true;
        reason = revokeResult.alreadyInvalid ? "already_invalid" : null;
      }
    }

    try {
      await ports.accounts.clearCredentials({
        accountId: account.id,
        userId,
        updatedAt: ports.clock.now().toISOString(),
        accountMetadata: stripGrantMetadata(account.accountMetadata),
      });
    } catch {
      return refuse(req, "disconnect", "account_clear_failed", userId, 500);
    }

    return json(req, { success: true, revoked, reason });
  }

  async function consume(
    req: Request,
    state: string,
  ): Promise<{ attempt: YouTubeOAuthAttempt } | { response: Response }> {
    let result: Awaited<ReturnType<YouTubeOAuthPorts["attempts"]["consume"]>>;
    try {
      result = await ports.attempts.consume(state);
    } catch {
      return { response: await refuse(req, "callback", "attempt_consume_failed", null, 500) };
    }
    if (!result.ok) return { response: await refuse(req, "callback", result.reason, null, 400) };
    return {
      attempt: {
        userId: result.userId,
        socialProfileId: result.socialProfileId,
        returnTo: result.returnTo,
      },
    };
  }

  async function complete(
    req: Request,
    code: string,
    attempt: YouTubeOAuthAttempt,
  ): Promise<{ channelTitle: string } | { response: Response }> {
    let google: Awaited<ReturnType<YouTubeOAuthPorts["google"]["complete"]>>;
    try {
      google = await ports.google.complete(code);
    } catch (error) {
      if (error instanceof NoYouTubeChannelError) {
        await ports.log.refusal({
          action: "callback",
          reason: "NO_YOUTUBE_CHANNEL",
          userId: attempt.userId,
        }).catch(() => console.warn({ event: "youtube_oauth_refusal_log_failed" }));
        if (req.method === "GET") {
          return {
            response: redirectError(attempt.returnTo ?? config.defaultReturnTo ?? DEFAULT_RETURN_TO, true),
          };
        }
        return { response: json(req, { error: NO_CHANNEL_ERROR, code: "NO_YOUTUBE_CHANNEL" }, 400) };
      }
      const response = await refuse(req, "callback", "google_oauth_failed", attempt.userId, 500);
      if (req.method === "GET") {
        return {
          response: redirectError(attempt.returnTo ?? config.defaultReturnTo ?? DEFAULT_RETURN_TO, false),
        };
      }
      return { response };
    }

    const now = ports.clock.now().toISOString();
    const save: YouTubeAccountSave = {
      userId: attempt.userId,
      socialProfileId: attempt.socialProfileId,
      channelId: google.channel.id,
      channelTitle: google.channel.title,
      accessToken: google.accessToken,
      tokenExpiresAt: new Date(ports.clock.now().getTime() + google.expiresIn * 1000).toISOString(),
      avatarUrl: google.channel.avatarUrl,
      connectedAt: now,
      updatedAt: now,
      grantedScope: google.scope,
      // Google omits refresh_token on many re-consents. Omitting the property
      // makes the account adapter preserve the credential already stored.
      ...(google.refreshToken ? { refreshToken: google.refreshToken } : {}),
    };
    try {
      await ports.accounts.save(save);
    } catch {
      const response = await refuse(req, "callback", "account_save_failed", attempt.userId, 500);
      if (req.method === "GET") {
        return {
          response: redirectError(attempt.returnTo ?? config.defaultReturnTo ?? DEFAULT_RETURN_TO, false),
        };
      }
      return { response };
    }
    return { channelTitle: google.channel.title };
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
    }

    if (req.method === "GET") {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return refuse(req, "callback", "invalid_request", null, 400);
      const consumed = await consume(req, state);
      if ("response" in consumed) return consumed.response;
      const result = await complete(req, code, consumed.attempt);
      if ("response" in result) return result.response;
      return redirect(consumed.attempt.returnTo ?? config.defaultReturnTo ?? DEFAULT_RETURN_TO, {
        channelTitle: result.channelTitle,
        profileId: consumed.attempt.socialProfileId,
      });
    }

    if (req.method !== "POST") return refuse(req, "request", "method_not_allowed", null, 405);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return refuse(req, "request", "invalid_json", null, 400);
    }
    const action = body && typeof body === "object"
      ? (body as Record<string, unknown>).action
      : undefined;
    if (action !== "authorize" && action !== "callback" && action !== "disconnect") {
      return refuse(req, "request", "Invalid action", null, 400);
    }

    let userId: string;
    try {
      userId = (await ports.auth.authenticate(req, bodyUserId(body))).userId;
    } catch {
      return refuse(req, action, "Unauthorized", null, 401);
    }

    if (action === "disconnect") {
      return handleDisconnect(req, body, userId);
    }

    if (action === "authorize") {
      const parsed = AuthorizeSchema.safeParse(body);
      if (!parsed.success) return refuse(req, action, "invalid_request", userId, 400);
      const returnTo = safeReturnTo(parsed.data.return_to, "", config.trustedAppOrigin);
      if (!returnTo) return refuse(req, action, "invalid_return_to", userId, 400);
      if (!config.clientId || !config.redirectUri) {
        return refuse(req, action, "service_not_configured", userId, 500);
      }

      let socialProfileId = parsed.data.social_profile_id ?? null;
      if (!socialProfileId) {
        try {
          socialProfileId = await ports.accounts.findDefaultProfile(userId);
        } catch {
          return refuse(req, action, "profile_lookup_failed", userId, 500);
        }
      }
      if (!socialProfileId) return refuse(req, action, "profile_required", userId, 400);

      let nonce: string;
      try {
        nonce = (await ports.attempts.create({
          userId,
          socialProfileId,
          returnTo,
          ttlSeconds: ATTEMPT_TTL_SECONDS,
        })).nonce;
      } catch (error) {
        if (errorCode(error) === "YOA02") {
          return refuse(req, action, "profile_not_owned", userId, 403);
        }
        return refuse(req, action, "attempt_create_failed", userId, 500);
      }

      const scopes = [
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.force-ssl",
      ].join(" ");
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: scopes,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: nonce,
      });
      return json(req, {
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        redirect_uri: config.redirectUri,
      });
    }

    const parsed = CallbackSchema.safeParse(body);
    if (!parsed.success) return refuse(req, action, "invalid_request", userId, 400);
    const consumed = await consume(req, parsed.data.state);
    if ("response" in consumed) return consumed.response;
    if (consumed.attempt.userId !== userId) {
      return refuse(req, action, "owner_mismatch", userId, 403);
    }
    const result = await complete(req, parsed.data.code, consumed.attempt);
    if ("response" in result) return result.response;
    return json(req, { success: true, username: result.channelTitle });
  };
}
