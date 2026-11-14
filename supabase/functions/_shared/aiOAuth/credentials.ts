import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOAuthProvider, refreshAnthropicToken, refreshOpenAICodexToken } from "npm:@mariozechner/pi-ai@0.73.1/oauth";
import { AiOAuthError, AiOAuthStorageError, type AiOAuthErrorCode } from "./errors.ts";
import type { OAuthProviderId } from "./clients.ts";

export interface CredentialDeps {
  admin: SupabaseClient;
  /** pi-ai refresh for the provider; returns the ROTATED credentials. */
  refresh: (
    provider: OAuthProviderId,
    refreshToken: string,
  ) => Promise<{ access: string; refresh: string; expires: number; [k: string]: unknown }>;
  /** pi-ai getApiKey: derives the request credential from stored OAuth credentials. */
  getApiKey: (provider: OAuthProviderId, creds: Record<string, unknown>) => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function defaultCredentialDeps(admin: SupabaseClient): CredentialDeps {
  return {
    admin,
    async refresh(provider, refreshToken) {
      // OpenRouter's credential is a permanent API key: there is nothing to
      // rotate, and the key's expiry keeps it out of this path entirely.
      if (provider === "openrouter") {
        throw new AiOAuthError("oauth_unsupported_provider", provider);
      }
      const refreshed = provider === "anthropic"
        ? await refreshAnthropicToken(refreshToken)
        : await refreshOpenAICodexToken(refreshToken);
      return refreshed as { access: string; refresh: string; expires: number; [k: string]: unknown };
    },
    getApiKey(provider, creds) {
      // pi-ai has no OAuth provider for OpenRouter: the stored key IS the
      // credential the request is sent with.
      if (provider === "openrouter") {
        const access = creds.access;
        if (typeof access !== "string" || access.length === 0) {
          throw new AiOAuthError("not_connected", provider);
        }
        return access;
      }
      const oauthProvider = getOAuthProvider(provider);
      if (!oauthProvider) throw new AiOAuthError("oauth_unsupported_provider", provider);
      return oauthProvider.getApiKey(creds as never);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * pi-ai 0.73.1 puts the token endpoint's HTTP status in a fixed position:
 * Anthropic "HTTP request failed. status=400; url=...; body=...", Codex
 * "OpenAI Codex token refresh failed (401): ...". Only that position is read:
 * the response body follows it and can quote any number, so a transient 503
 * whose body mentions 400 must stay a retryable failure. A 400/401 alone is
 * not enough either: RFC 6749 §5.2 also uses them for invalid_request and
 * invalid_client, which leave the refresh token valid. Only invalid_grant
 * means the token itself was revoked.
 */
export function isReauthRefreshError(message: string): boolean {
  const rejected = REJECTED_REFRESH.exec(message);
  return rejected !== null && oauthErrorCode(rejected[1]) === "invalid_grant";
}

/**
 * The RFC 6749 §5.2 `error` value of a token-endpoint body: the top-level
 * JSON field when the body is JSON (a nested `error` is not the response's
 * code), otherwise the whole plain-text body. Anthropic's wrapped message
 * appends "; stack=..." after the body, which is cut first.
 */
function oauthErrorCode(body: string): string {
  const text = body.replace(/; stack=[\s\S]*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const code = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  return typeof code === "string" ? code : "";
}

/**
 * Anchored to the start of the message so status-shaped text inside a body
 * can never match. refreshAnthropicToken wraps the HTTP error:
 * "Anthropic token refresh request failed. url=<TOKEN_URL>; details=Error: HTTP request failed. status=400; ...".
 */
const REJECTED_REFRESH =
  /^(?:(?:Anthropic token refresh request failed\. url=[^;\s]*; details=Error: )?HTTP request failed\. status=(?:400|401); url=[^;\s]*; body=|OpenAI Codex token refresh failed \((?:400|401)\): )([\s\S]*)$/;

/**
 * Longer than the edge worker can live (150 s wall clock), so the lease cannot
 * expire while this worker's refresh is still in flight: Anthropic's refresh
 * aborts at 30 s, Codex's has no timeout but dies with the worker. A caller
 * that gave up at its tier deadline therefore never hands the lease to a
 * second refresher mid-rotation.
 */
const LEASE_SECONDS = 180;
const FRESH_MARGIN_MS = 60_000;
const WAIT_MS = 750;
const MAX_WAIT_ROUNDS = 4;

interface StoredCredentials {
  status: string;
  expires: number;
  refresh: string;
  [k: string]: unknown;
}

function isFresh(credentials: StoredCredentials, nowMs: number): boolean {
  return credentials.expires - FRESH_MARGIN_MS > nowMs;
}

async function credentialRpc(deps: CredentialDeps, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    const query = deps.admin.rpc(name, args);
    const result = await (signal ? query.abortSignal(signal) : query);
    if (result.error) throw new AiOAuthStorageError();
    signal?.throwIfAborted();
    return { data: result.data };
  } catch {
    throw new AiOAuthStorageError();
  }
}

async function readCredentials(
  deps: CredentialDeps,
  provider: OAuthProviderId,
  signal?: AbortSignal,
): Promise<StoredCredentials | null> {
  const { data } = await credentialRpc(deps, "get_ai_oauth_credentials", { p_oauth_provider: provider }, signal);
  if (!data || typeof data !== "object") return null;
  return data as StoredCredentials;
}

interface Lease {
  provider: OAuthProviderId;
  token: string;
}

/** Records the failure on the row only while this caller still holds the lease. */
async function throwAfterFail(
  deps: CredentialDeps,
  lease: Lease,
  code: AiOAuthErrorCode,
  message: string,
  reauth: boolean,
): Promise<never> {
  const { data: recorded } = await credentialRpc(deps, "fail_ai_oauth_refresh", {
    p_oauth_provider: lease.provider,
    p_lease_token: lease.token,
    p_error: message,
    p_reauth: reauth,
  });
  // The row still says connected and holds the lease, so the requested
  // status transition did not happen: report that instead of claiming it.
  // false: a disconnect or reconnect replaced this lease, so the row never
  // took the requested status and must not be reported as if it had.
  if (recorded !== true) throw new AiOAuthError("lease_lost", "the connection changed while refreshing");
  throw new AiOAuthError(code, message);
}

/**
 * Rotates the stored refresh token under the lease. The save is fenced on the
 * lease token: a disconnect or reconnect while the provider call is in flight
 * clears the token, so this refresh writes nothing and is reported as failed.
 */
async function refreshUnderLease(
  deps: CredentialDeps,
  lease: Lease,
  current: StoredCredentials,
): Promise<{ apiKey: string }> {
  if (!current.refresh) {
    // Nothing to rotate: only a fresh browser login can fix this row.
    await throwAfterFail(deps, lease, "reauth_required", "stored credential carries no refresh token", true);
  }
  try {
    const rotated = await deps.refresh(lease.provider, current.refresh);
    const { data: saved } = await credentialRpc(deps, "complete_ai_oauth_refresh", {
      p_oauth_provider: lease.provider,
      p_lease_token: lease.token,
      p_credentials: rotated,
      p_expires_at: new Date(rotated.expires).toISOString(),
    });
    if (saved !== true) throw new AiOAuthError("lease_lost", "the connection changed while refreshing");
    return { apiKey: deps.getApiKey(lease.provider, rotated) };
  } catch (cause) {
    // Never clear the lease after an ambiguous save: the rotated token may have
    // committed. Keep the fence until expiry instead of rotating again.
    if (cause instanceof AiOAuthStorageError || cause instanceof AiOAuthError && cause.code === "lease_lost") throw cause;
    if (cause instanceof AiOAuthError) await throwAfterFail(deps, lease, cause.code, cause.message, false);
    // pi-ai's message can quote the token endpoint's response body, so only
    // a fixed sentence is stored and returned.
    const message = cause instanceof Error ? cause.message : "";
    if (isReauthRefreshError(message)) {
      await throwAfterFail(deps, lease, "reauth_required", "refresh token was rejected by the provider", true);
    }
    return await throwAfterFail(deps, lease, "refresh_failed", "the provider token endpoint refused the refresh", false);
  }
}

/** Before rotation no provider token has been spent, so cancellation can free the fence. */
async function releaseUnstartedRefresh(deps: CredentialDeps, provider: OAuthProviderId, token: string): Promise<void> {
  await credentialRpc(deps, "release_ai_oauth_refresh", {
    p_oauth_provider: provider, p_lease_token: token,
  }, AbortSignal.timeout(5_000));
}

/** A lost response can be retried with the same known token without taking a second lease. */
async function claimRefreshLease(deps: CredentialDeps, provider: OAuthProviderId): Promise<unknown> {
  const token = crypto.randomUUID();
  const claim = () => credentialRpc(deps, "claim_ai_oauth_refresh", {
    p_oauth_provider: provider, p_lease_seconds: LEASE_SECONDS, p_lease_token: token,
  }, AbortSignal.timeout(5_000));
  try {
    try { return (await claim()).data; }
    catch (error) {
      if (!(error instanceof AiOAuthStorageError)) throw error;
      return (await claim()).data;
    }
  } catch (error) {
    await releaseUnstartedRefresh(deps, provider, token);
    throw error;
  }
}

/**
 * Returns an apiKey derived from the admin's stored subscription credential,
 * refreshing (single-flight, via the RPC lease) when it is within a minute of
 * expiring. Never logs, returns or embeds the token itself in an error.
 */
export async function getFreshOAuthCredential(
  deps: CredentialDeps,
  provider: OAuthProviderId,
  signal?: AbortSignal,
): Promise<{ apiKey: string }> {
  const credentials = await readCredentials(deps, provider, signal);
  if (!credentials) throw new AiOAuthError("not_connected", provider);
  if (credentials.status === "reauth_required") {
    throw new AiOAuthError("reauth_required", provider);
  }
  if (isFresh(credentials, deps.now())) {
    return { apiKey: deps.getApiKey(provider, credentials) };
  }

  signal?.throwIfAborted();
  const leaseToken = await claimRefreshLease(deps, provider);

  if (typeof leaseToken === "string") {
    // Refresh tokens rotate: a worker that held the previous lease may already
    // have spent the token read above, so the refresh must use the stored one.
    let current: StoredCredentials;
    try {
      const stored = await readCredentials(deps, provider, AbortSignal.timeout(5_000));
      if (!stored) throw new AiOAuthError("not_connected", provider);
      if (stored.status === "reauth_required") throw new AiOAuthError("reauth_required", provider);
      signal?.throwIfAborted();
      current = stored;
    } catch (error) {
      await releaseUnstartedRefresh(deps, provider, leaseToken);
      throw error;
    }
    if (isFresh(current, deps.now())) {
      await releaseUnstartedRefresh(deps, provider, leaseToken);
      return { apiKey: deps.getApiKey(provider, current) };
    }
    // Once rotation starts it must settle under its lease, even if the health
    // caller stops waiting. Cancelling the save would discard a rotated token.
    return await refreshUnderLease(deps, { provider, token: leaseToken }, current);
  }

  // Lost the lease: a concurrent caller is refreshing. Wait, re-read, repeat.
  for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
    await deps.sleep(WAIT_MS);
    const reRead = await readCredentials(deps, provider, signal);
    if (!reRead) throw new AiOAuthError("not_connected", provider);
    if (reRead.status === "reauth_required") throw new AiOAuthError("reauth_required", provider);
    if (isFresh(reRead, deps.now())) return { apiKey: deps.getApiKey(provider, reRead) };
  }
  throw new AiOAuthError("refresh_failed", "another refresh is still in flight");
}
