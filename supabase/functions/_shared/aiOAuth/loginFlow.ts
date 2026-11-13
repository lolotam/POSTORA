import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AiOAuthError } from "./errors.ts";
import {
  OAUTH_CLIENTS,
  OAUTH_PROVIDER_CODE,
  type OAuthClient,
  type OAuthProviderId,
} from "./clients.ts";
import { generatePkce } from "./pkce.ts";
import { redactProviderError } from "../ai-routing-errors.ts";

export interface LoginDeps {
  admin: SupabaseClient;
  fetch: typeof fetch;
  now: () => number;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;
// Bounds the whole exchange, response body included. The authorization code is
// single use, so a timed-out exchange is reported, never retried.
const EXCHANGE_TIMEOUT_MS = 15_000;

/** One bounded POST to the token endpoint; the signal also cuts a stalled body read. */
async function exchangeCode(
  deps: LoginDeps,
  request: { url: string; init: RequestInit },
): Promise<unknown> {
  try {
    const response = await deps.fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AiOAuthError(
        "exchange_failed",
        redactProviderError(`token exchange failed with status ${response.status}: ${body}`, ""),
      );
    }
    return (await response.json()) as unknown;
  } catch (cause) {
    if (cause instanceof AiOAuthError) throw cause;
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new AiOAuthError(
      "exchange_failed",
      timedOut ? "token exchange timed out" : "token exchange request failed",
    );
  }
}

/**
 * Parses what the admin pasted after approving in the browser. Accepts, in
 * pi-ai's order: a full redirect URL, `code#state`, a bare
 * `code=…&state=…` querystring, or a bare code.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
      };
    } catch {
      return {};
    }
  }

  const hashAt = trimmed.indexOf("#");
  if (hashAt > 0) {
    return { code: trimmed.slice(0, hashAt), state: trimmed.slice(hashAt + 1) };
  }

  if (trimmed.startsWith("code=") || trimmed.includes("&") || trimmed.includes("?")) {
    const params = new URLSearchParams(trimmed.replace(/^[?&]+/, ""));
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: trimmed };
}

export async function startLogin(
  deps: LoginDeps,
  provider: OAuthProviderId,
  userId: string,
): Promise<{ authorizeUrl: string }> {
  const client: OAuthClient = OAUTH_CLIENTS[provider];
  const { verifier, challenge } = await generatePkce();
  const state = client.createState(verifier);

  const { error } = await deps.admin.from("oauth_states").insert({
    state,
    provider_code: provider,
    code_verifier: verifier,
    redirect_uri: client.redirectUri(),
    scope_kind: "platform",
    user_id: userId,
    expires_at: new Date(deps.now() + LOGIN_TTL_MS).toISOString(),
  });
  if (error) {
    throw new AiOAuthError("invalid_state", `could not persist the login state: ${error.message}`);
  }

  return { authorizeUrl: client.authorizeUrl(challenge, state) };
}

export async function finishLogin(
  deps: LoginDeps,
  provider: OAuthProviderId,
  pasted: string,
  userId: string,
): Promise<{ accountLabel: string | null }> {
  const client: OAuthClient = OAUTH_CLIENTS[provider];
  const parsed = parseAuthorizationInput(pasted);
  if (!parsed.code) {
    throw new AiOAuthError("invalid_code", "the pasted text contains no authorization code");
  }
  // A bare code is not accepted: the state binds the paste to the stored verifier.
  if (!parsed.state) {
    throw new AiOAuthError("invalid_state", "the pasted text contains no state parameter");
  }

  // Consume the row atomically: single use, scope and admin bound, expiry
  // checked in SQL. Binding the admin stops a state minted by one admin from
  // being completed by another, e.g. through a forwarded callback link.
  const consumed = await deps.admin
    .from("oauth_states")
    .delete()
    .eq("state", parsed.state)
    .eq("provider_code", provider)
    .eq("scope_kind", "platform")
    .eq("user_id", userId)
    .gt("expires_at", new Date(deps.now()).toISOString())
    .select("*")
    .maybeSingle();
  if (consumed.error || !consumed.data) {
    throw new AiOAuthError("invalid_state", "login state is unknown, expired or already used");
  }
  const stored = consumed.data as { code_verifier: string };

  const token = await exchangeCode(deps, client.exchangeRequest(parsed.code, parsed.state, stored.code_verifier));
  // Every provider answers with its own token shape, so the client reads it.
  const { credentials, expiresAt, accountLabel } = client.credentialsFromToken(token, deps.now());

  const { error } = await deps.admin.rpc("save_ai_oauth_credentials", {
    p_oauth_provider: provider,
    p_provider_code: OAUTH_PROVIDER_CODE[provider],
    p_credentials: credentials,
    p_account_label: accountLabel,
    p_expires_at: expiresAt,
    p_user: userId,
  });
  if (error) {
    throw new AiOAuthError("exchange_failed", `could not store credentials: ${error.message}`);
  }

  return { accountLabel };
}
