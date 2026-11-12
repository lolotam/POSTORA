import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOAuthProvider, refreshAnthropicToken, refreshOpenAICodexToken } from "npm:@mariozechner/pi-ai@0.73.1/oauth";
import { AiOAuthError, type AiOAuthErrorCode } from "./errors.ts";
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
      const refreshed = provider === "anthropic"
        ? await refreshAnthropicToken(refreshToken)
        : await refreshOpenAICodexToken(refreshToken);
      return refreshed as { access: string; refresh: string; expires: number; [k: string]: unknown };
    },
    getApiKey(provider, creds) {
      const oauthProvider = getOAuthProvider(provider);
      if (!oauthProvider) throw new AiOAuthError("oauth_unsupported_provider", provider);
      return oauthProvider.getApiKey(creds as never);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** pi-ai throws an Error whose message carries the HTTP status of the token URL. */
export function isReauthRefreshError(message: string): boolean {
  return /\b(400|401)\b|invalid_grant/i.test(message);
}

const LEASE_SECONDS = 30;
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

async function readCredentials(
  deps: CredentialDeps,
  provider: OAuthProviderId,
): Promise<StoredCredentials | null> {
  const { data, error } = await deps.admin.rpc("get_ai_oauth_credentials", { p_oauth_provider: provider });
  if (error) throw new AiOAuthError("refresh_failed", `could not read the stored credential: ${error.message}`);
  if (!data || typeof data !== "object") return null;
  return data as StoredCredentials;
}

async function throwAfterFail(
  deps: CredentialDeps,
  provider: OAuthProviderId,
  code: AiOAuthErrorCode,
  message: string,
  reauth: boolean,
): Promise<never> {
  await deps.admin.rpc("fail_ai_oauth_refresh", {
    p_oauth_provider: provider,
    p_error: message,
    p_reauth: reauth,
  });
  throw new AiOAuthError(code, message);
}

/**
 * Returns an apiKey derived from the admin's stored subscription credential,
 * refreshing (single-flight, via the RPC lease) when it is within a minute of
 * expiring. Never logs, returns or embeds the token itself in an error.
 */
export async function getFreshOAuthCredential(
  deps: CredentialDeps,
  provider: OAuthProviderId,
): Promise<{ apiKey: string }> {
  const credentials = await readCredentials(deps, provider);
  if (!credentials) throw new AiOAuthError("not_connected", provider);
  if (credentials.status === "reauth_required") {
    throw new AiOAuthError("reauth_required", provider);
  }
  if (isFresh(credentials, deps.now())) {
    return { apiKey: deps.getApiKey(provider, credentials) };
  }

  const { data: wonLease, error: leaseError } = await deps.admin.rpc("begin_ai_oauth_refresh", {
    p_oauth_provider: provider,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (leaseError) throw new AiOAuthError("refresh_failed", `lease rpc failed: ${leaseError.message}`);

  if (wonLease === true) {
    if (!credentials.refresh) {
      // Nothing to rotate: only a fresh browser login can fix this row.
      await throwAfterFail(deps, provider, "reauth_required", "stored credential carries no refresh token", true);
    }
    try {
      const rotated = await deps.refresh(provider, credentials.refresh);
      const { error } = await deps.admin.rpc("save_ai_oauth_credentials", {
        p_oauth_provider: provider,
        p_provider_code: provider === "anthropic" ? "claude" : "openai",
        p_credentials: rotated,
        p_account_label: null,
        p_expires_at: new Date(rotated.expires).toISOString(),
        p_user: null,
      });
      if (error) throw new AiOAuthError("refresh_failed", `could not save rotated credentials: ${error.message}`);
      return { apiKey: deps.getApiKey(provider, rotated) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "refresh failed";
      if (isReauthRefreshError(message)) {
        await throwAfterFail(deps, provider, "reauth_required", "refresh token was rejected by the provider", true);
      }
      await throwAfterFail(deps, provider, "refresh_failed", message, false);
    }
  }

  // Lost the lease: a concurrent caller is refreshing. Wait, re-read, repeat.
  for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
    await deps.sleep(WAIT_MS);
    const reRead = await readCredentials(deps, provider);
    if (!reRead) throw new AiOAuthError("not_connected", provider);
    if (reRead.status === "reauth_required") throw new AiOAuthError("reauth_required", provider);
    if (isFresh(reRead, deps.now())) return { apiKey: deps.getApiKey(provider, reRead) };
  }
  throw new AiOAuthError("refresh_failed", "another refresh is still in flight");
}
