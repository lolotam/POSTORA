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

  return {
    accessToken: null,
    refreshed: false,
    expiresAt: outcome.expiresAt,
    reason: outcome.reason,
    needsReauth: outcome.needsReauth,
  };
}
