/**
 * The YouTube access token, refreshed when it is about to expire.
 *
 * YouTube tokens live for an hour. A worker that sends an expired credential
 * gets a refusal from the provider that looks like a broken upload, and an
 * upload that is half written cannot be retried with a new credential: the
 * provider session belongs to the credential that opened it.
 *
 * So the token is refreshed BEFORE the provider is contacted, and the rule is
 * ONE rule, shared by the two paths that talk to YouTube:
 *
 *   * the publishing path, which opens the upload;
 *   * the continuation, which carries an upload on.
 *
 * A token that expires within half an hour is refreshed. A token that cannot
 * be refreshed is used as it is, and the caller decides what to do about it:
 * the publishing path warns, and the continuation refuses the upload, because
 * a provider that refused a credential says nothing about the video.
 *
 * Nothing here logs a token, and the refresh token is never sent anywhere but
 * to the provider's own token endpoint.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { redactProviderText } from "./youtubeUploadPolicy.ts";

/**
 * How long before the expiry a token is refreshed.
 *
 * Half of the token's life: a worker that starts a publish has to reach the
 * provider with a credential that is still good, and a refresh that happens
 * too late is a refresh that fails mid-upload.
 */
export const YOUTUBE_TOKEN_REFRESH_WINDOW_MS = 30 * 60 * 1000;

/** How long the token endpoint may take. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** The account whose token is refreshed. */
export interface YoutubeTokenAccount {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

/** What the refresh ended as. */
export interface YoutubeTokenResult {
  /** The token to send to the provider. */
  accessToken: string | null;
  /** Whether the token was replaced by a fresh one. */
  refreshed: boolean;
  /** When the fresh token expires, when there is one. */
  expiresAt: string | null;
  /** Why no fresh token is available. */
  reason: string | null;
}

/**
 * Whether the token has to be refreshed.
 *
 * A token without an expiry is treated as expired: it is not known to be good,
 * and a token that is not known to be good is not used.
 */
export function youtubeTokenNeedsRefresh(
  tokenExpiresAt: string | null,
  nowMs: number,
): boolean {
  if (!tokenExpiresAt) return true;
  const expiresAt = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - nowMs <= YOUTUBE_TOKEN_REFRESH_WINDOW_MS;
}

/**
 * The token to send to YouTube, refreshed when it is about to expire.
 *
 * The new token is written to the account before it is returned, so the next
 * worker reads the same token instead of refreshing it again.
 */
export async function refreshYoutubeAccessToken(args: {
  supabase: SupabaseClient;
  account: YoutubeTokenAccount;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<YoutubeTokenResult> {
  const { supabase, account } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const nowMs = args.nowMs ?? Date.now();

  if (!youtubeTokenNeedsRefresh(account.tokenExpiresAt, nowMs)) {
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: null,
    };
  }

  if (!account.refreshToken) {
    // There is nothing to refresh with. The credential stays as it is, and the
    // caller decides: the provider will refuse it, and that refusal says
    // nothing about the video.
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "no_refresh_token",
    };
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "refresh_not_configured",
    };
  }

  let response: Response;
  try {
    response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: account.refreshToken,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // The provider's own words are redacted: the answer of a token endpoint
    // can carry the credential it was asked about.
    console.warn(
      `[youtube] the token of account ${account.id} could not be refreshed:`,
      redactProviderText(error),
    );
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "refresh_request_failed",
    };
  }

  if (!response.ok) {
    console.warn(
      `[youtube] the token of account ${account.id} was not refreshed: the provider answered ${response.status}`,
    );
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "refresh_refused",
    };
  }

  let payload: { access_token?: unknown; expires_in?: unknown };
  try {
    payload = await response.json();
  } catch (error) {
    console.warn(
      `[youtube] the refreshed token of account ${account.id} could not be read:`,
      redactProviderText(error),
    );
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "refresh_answer_unreadable",
    };
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const expiresInSeconds = typeof payload.expires_in === "number" ? payload.expires_in : null;
  if (!accessToken || !expiresInSeconds) {
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "refresh_answer_incomplete",
    };
  }

  const expiresAt = new Date(nowMs + expiresInSeconds * 1000).toISOString();
  const { error } = await supabase
    .from("social_accounts")
    .update({ access_token: accessToken, token_expires_at: expiresAt })
    .eq("id", account.id);
  if (error) {
    // The token was refreshed but not stored. It is still returned: the upload
    // may go on with it, and the next worker refreshes again.
    console.warn(
      `[youtube] the refreshed token of account ${account.id} could not be stored: ${error.message}`,
    );
  }

  return { accessToken, refreshed: true, expiresAt, reason: null };
}
