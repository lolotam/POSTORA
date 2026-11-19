/**
 * The YouTube access token, refreshed under the DB refresh lease when it is
 * about to expire.
 *
 * Delegates to the shared leased refresh coordinator so publishing JIT and
 * resumable upload continuations share the exact same lease, fencing, reuse,
 * and invalid_grant handling as cron and comment refreshes.
 *
 * Nothing here logs a token, and the refresh token is never sent anywhere but
 * to the provider's own token endpoint.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  createSupabaseYouTubeRefreshStore,
  refreshYouTubeAccountToken,
  YOUTUBE_TOKEN_REFRESH_WINDOW_MS,
  youtubeTokenNeedsRefresh,
} from "../_shared/youtubeTokenRefresh.ts";
import { youtubeCredentialRefusalReason } from "./youtubeUploadPolicy.ts";

export { YOUTUBE_TOKEN_REFRESH_WINDOW_MS, youtubeTokenNeedsRefresh };

/** The account whose token is refreshed. */
export interface YoutubeTokenAccount {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  needsReauth?: boolean | null;
}

/** What the refresh ended as. */
export interface YoutubeTokenResult {
  /** The token to send to the provider. */
  accessToken: string | null;
  /** Whether the token was replaced by a fresh one by this worker. */
  refreshed: boolean;
  /** When the fresh token expires, when there is one. */
  expiresAt: string | null;
  /** Why no fresh token is available. */
  reason: string | null;
  /** True when the account requires user reconnection (e.g. invalid_grant). */
  needsReauth: boolean;
  /** True when the refusal is transient/retryable (e.g. lease contention, 5xx). */
  retryable: boolean;
}

/**
 * Whether the publish for this account must STOP.
 *
 * A reauthentication refusal (accessToken null + needsReauth) means the stored
 * grant is dead even when the cached access token still looks usable: the
 * provider would refuse it after the refresh recorded invalid_grant. The
 * initial publish applies the same rule the continuation path applies — a
 * credential the refresh could not confirm is not sent — so the caller clears
 * the in-memory credential and the shared admission check refuses the account
 * before the provider is contacted. Retryable refusals are NOT a dead grant
 * and never stop a publish on their own.
 */
export function youtubeJitRefusalStopsPublish(
  token: Pick<YoutubeTokenResult, "accessToken" | "needsReauth">,
): boolean {
  return token.accessToken === null && token.needsReauth;
}

export interface YoutubeJitRefusalLogContext {
  accountId: string;
  postId: string;
  postSource: string;
  userId: string;
}

export interface YoutubeJitRefusalLogRow {
  level: "error";
  category: "token";
  source: "process-post-jit";
  message: string;
  user_id: string;
  metadata: {
    event: "jit_refresh_failed";
    platform: "youtube";
    account_id: string;
    post_id: string;
    post_source: string;
    error: string;
  };
}

/**
 * Builds the error-level system_logs row for a non-retryable YouTube JIT
 * refresh failure, or returns null when the refusal is ordinary lease
 * contention / retryable (or there was no refusal).
 */
export function youtubeJitRefusalLogEntry(
  token: Pick<YoutubeTokenResult, "reason" | "retryable">,
  context: YoutubeJitRefusalLogContext,
): YoutubeJitRefusalLogRow | null {
  if (!token.reason || token.retryable) return null;
  return {
    level: "error",
    category: "token",
    source: "process-post-jit",
    message: `YouTube JIT token refresh failed (source: ${context.postSource})`,
    user_id: context.userId,
    metadata: {
      event: "jit_refresh_failed",
      platform: "youtube",
      account_id: context.accountId,
      post_id: context.postId,
      post_source: context.postSource,
      error: token.reason,
    },
  };
}

/**
 * The token to send to YouTube, refreshed under a DB lease when about to expire.
 */
export async function refreshYoutubeAccessToken(args: {
  supabase: SupabaseClient;
  account: YoutubeTokenAccount;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<YoutubeTokenResult> {
  const { supabase, account, fetchImpl } = args;
  const nowMs = args.nowMs !== undefined ? () => args.nowMs! : undefined;

  const outcome = await refreshYouTubeAccountToken({
    accountId: account.id,
    snapshot: {
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      token_expires_at: account.tokenExpiresAt,
      needs_reauth: account.needsReauth ?? false,
    },
    store: createSupabaseYouTubeRefreshStore(supabase),
    fetchImpl,
    nowMs,
  });

  if (outcome.ok) {
    return {
      accessToken: outcome.accessToken,
      refreshed: outcome.status === "refreshed",
      expiresAt: outcome.expiresAt,
      reason: null,
      needsReauth: false,
      retryable: false,
    };
  }

  // A retryable refusal (lease contention, transient provider/DB error), a
  // missing refresh token, or unconfigured OAuth client env is not by itself
  // a dead access token: when the stored token is still strictly in the future
  // inside the 30-minute refresh window, hand it back so initial publishes and
  // resumable upload continuations do not stall unnecessarily. Expired tokens,
  // invalid_grant, and reauthentication refusals keep returning null.
  const canUseStoredToken = !outcome.needsReauth &&
    (outcome.status === "retryable_refusal" ||
      outcome.reason === "no_refresh_token" ||
      outcome.reason === "refresh_not_configured");
  if (canUseStoredToken && account.accessToken) {
    const nowMsValue = args.nowMs ?? Date.now();
    const credentialRefusal = youtubeCredentialRefusalReason(
      account.accessToken,
      account.tokenExpiresAt,
      nowMsValue,
    );
    if (credentialRefusal === null) {
      return {
        accessToken: account.accessToken,
        refreshed: false,
        expiresAt: account.tokenExpiresAt,
        reason: outcome.reason,
        needsReauth: false,
        retryable: outcome.retryable,
      };
    }
  }

  return {
    accessToken: null,
    refreshed: false,
    expiresAt: outcome.expiresAt,
    reason: outcome.reason,
    needsReauth: outcome.needsReauth,
    retryable: outcome.retryable,
  };
}
