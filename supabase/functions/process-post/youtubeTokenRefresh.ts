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
    };
  }

  // A missing refresh token is not by itself a refused credential: the old
  // behaviour handed the stored token back and let the shared credential
  // policy decide. That behaviour is kept, because a token inside its refresh
  // window is still one the provider accepts — the publish path and the
  // continuation read the SAME rule from youtubeCredentialRefusalReason.
  // Expired credentials, invalid_grant and lease refusals keep returning
  // nothing.
  if (outcome.reason === "no_refresh_token" && account.accessToken) {
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
      };
    }
  }

  return {
    accessToken: null,
    refreshed: false,
    expiresAt: outcome.expiresAt,
    reason: outcome.reason,
    needsReauth: outcome.needsReauth,
  };
}
