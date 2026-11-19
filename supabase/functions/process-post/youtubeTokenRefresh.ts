/**
 * The YouTube access token, refreshed when it is about to expire.
 *
 * YouTube access tokens expire. Publishing and continuation refresh before
 * sending provider requests. The continuation leaves the session pending
 * when it cannot obtain a usable credential, so a refresh failure does not
 * become an upload outcome.
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

  if (account.accessToken && !youtubeTokenNeedsRefresh(account.tokenExpiresAt, nowMs)) {
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

  let payload: unknown;
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

  const attributes = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const accessToken = typeof attributes.access_token === "string" ? attributes.access_token : null;
  const lifetime = typeof attributes.expires_in === "number" ? attributes.expires_in : 0;
  const expiry = new Date(nowMs + lifetime * 1000);
  if (!accessToken || lifetime <= 0 || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= nowMs) {
    return {
      accessToken: account.accessToken,
      refreshed: false,
      expiresAt: account.tokenExpiresAt,
      reason: "refresh_answer_incomplete",
    };
  }

  const expiresAt = expiry.toISOString();
  // THE CREDENTIALS TRAVEL IN THE BODY
  //
  // A PostgREST filter is a QUERY STRING, and a query string is written to
  // the access log of every hop between this worker and the database. The
  // compare-and-set therefore happens in the database, where the refresh
  // token and the access token travel in the body of a POST and never in a
  // URL. The rule it proves is the one the filters proved: the token is
  // stored only if the row still carries the credential the refresh was
  // asked with.
  const { data: stored, error } = await supabase.rpc("store_youtube_refreshed_token", {
    p_account_id: account.id,
    p_expected_refresh_token: account.refreshToken,
    p_expected_access_token: account.accessToken,
    p_expected_token_expires_at: account.tokenExpiresAt,
    p_new_access_token: accessToken,
    p_new_token_expires_at: expiresAt,
  });
  if (error || stored !== true) {
    if (error) console.warn("[youtube] token check-and-update failed:", redactProviderText(error));
    const { data: current } = await supabase.from("social_accounts")
      .select("access_token, token_expires_at").eq("id", account.id).maybeSingle();
    return {
      accessToken: current?.access_token ?? null,
      expiresAt: current?.token_expires_at ?? null,
      refreshed: false,
      reason: "refresh_not_stored",
    };
  }

  return { accessToken, refreshed: true, expiresAt, reason: null };
}
