// Login constants copied from @mariozechner/pi-ai@0.73.1 dist/utils/oauth/{anthropic,openai-codex}.js — pi-ai does not export them. Re-check on every pi-ai bump.
// The OpenRouter client is ours: OpenRouter runs its own PKCE flow
// (https://openrouter.ai/docs/guides/overview/auth/oauth) and pi-ai 0.73.1 has
// no OAuth provider for it — only the plain API-key provider.

import { AiOAuthError } from "./errors.ts";

export type OAuthProviderId = 'anthropic' | 'openai-codex' | 'openrouter';

/**
 * How the admin hands the authorization result back to us.
 * - `pkce_paste`: the provider lands on a page that cannot load, so the admin
 *   copies the address and pastes it into the settings card.
 * - `pkce_callback`: the provider lands on our own route, which finishes the
 *   login by itself.
 */
export type OAuthFlow = 'pkce_paste' | 'pkce_callback';

export const OAUTH_PROVIDER_CODE: Record<OAuthProviderId, 'claude' | 'openai' | 'openrouter'> = {
  anthropic: 'claude',
  'openai-codex': 'openai',
  openrouter: 'openrouter',
};

export function oauthProviderForCode(providerCode: string): OAuthProviderId | null {
  if (providerCode === 'claude') return 'anthropic';
  if (providerCode === 'openai') return 'openai-codex';
  if (providerCode === 'openrouter') return 'openrouter';
  return null;
}

/** base64url-decode a JWT payload segment. Returns null on any malformed input. */
function decodeJwtPayload(access: string): Record<string, unknown> | null {
  const segments = access.split('.');
  if (segments.length < 2) return null;
  try {
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hexRandom(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// pi-ai's own expiry margin: refresh five minutes before the provider says so.
const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

/**
 * The credential as it is stored in Vault. `expires` is epoch milliseconds:
 * OpenRouter's key never expires, so it carries the largest value a timestamp
 * can hold and is therefore never refreshed.
 */
export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  /** The provider's own account id, when it carries one. */
  accountId?: string;
}

export interface OAuthClient {
  id: OAuthProviderId;
  flow: OAuthFlow;
  authorizeUrl(challenge: string, state: string): string;
  /** The address the provider redirects to. Resolved per call, not at import. */
  redirectUri(): string;
  createState(verifier: string): string;
  exchangeRequest(code: string, state: string, verifier: string): { url: string; init: RequestInit };
  /**
   * Reads the provider's token response into the credential we store. Every
   * provider answers with its own shape, so the parsing lives with the client
   * instead of in the shared login flow.
   */
  credentialsFromToken(body: unknown, now: number): {
    credentials: OAuthCredentials;
    /** The ISO timestamp stored next to the credential. */
    expiresAt: string;
    accountLabel: string | null;
  };
}

/** The token shape Anthropic and ChatGPT both answer with. */
interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/** The account a stored credential belongs to, when the provider names one. */
interface TokenAccount {
  id(access: string): string | null;
  label(access: string): string | null;
}

/** Anthropic's token names no account, so there is nothing to show or require. */
const NO_ACCOUNT: TokenAccount = { id: () => null, label: () => null };

function tokenCredentials(
  body: unknown,
  now: number,
  account: TokenAccount,
  requireAccountId: boolean,
): { credentials: OAuthCredentials; expiresAt: string; accountLabel: string | null } {
  const token = (body ?? {}) as OAuthTokenResponse;
  const access = typeof token.access_token === 'string' ? token.access_token : '';
  const refresh = typeof token.refresh_token === 'string' ? token.refresh_token : '';
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : undefined;
  if (!access || !refresh || expiresIn === undefined) {
    throw new AiOAuthError('exchange_failed', 'token response is missing required fields');
  }

  const accountId = account.id(access);
  if (requireAccountId && !accountId) {
    throw new AiOAuthError('exchange_failed', 'token response carries no ChatGPT account id');
  }

  const expires = now + expiresIn * 1000 - EXPIRY_SAFETY_MS;
  const credentials: OAuthCredentials = { access, refresh, expires };
  if (accountId) credentials.accountId = accountId;
  return {
    credentials,
    expiresAt: new Date(expires).toISOString(),
    accountLabel: account.label(access),
  };
}

const ANTHROPIC_CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');

const anthropicClient: OAuthClient = {
  id: 'anthropic',
  flow: 'pkce_paste',
  redirectUri: () => 'http://localhost:53692/callback',
  createState: (verifier) => verifier,
  authorizeUrl(challenge, state) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      scope:
        'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return `https://claude.ai/oauth/authorize?${params.toString()}`;
  },
  exchangeRequest(code, state, verifier) {
    return {
      url: 'https://platform.claude.com/v1/oauth/token',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: ANTHROPIC_CLIENT_ID,
          code,
          state,
          redirect_uri: this.redirectUri(),
          code_verifier: verifier,
        }),
      },
    };
  },
  // Anthropic's token carries no account claim, so there is no label to show.
  credentialsFromToken: (body, now) => tokenCredentials(body, now, NO_ACCOUNT, false),
};

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** The ChatGPT account the Codex token belongs to. */
function codexAccountId(access: string): string | null {
  const payload = decodeJwtPayload(access);
  const auth = payload?.['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined;
  return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
}

/** What the admin sees next to a connected Codex subscription. */
function codexAccountLabel(access: string): string | null {
  const payload = decodeJwtPayload(access);
  if (typeof payload?.email === 'string' && payload.email.length > 0) return payload.email;
  const accountId = codexAccountId(access);
  return accountId ? `acc_${accountId.slice(0, 6)}` : null;
}

const CODEX_ACCOUNT: TokenAccount = { id: codexAccountId, label: codexAccountLabel };

const openaiCodexClient: OAuthClient = {
  id: 'openai-codex',
  flow: 'pkce_paste',
  redirectUri: () => 'http://localhost:1455/auth/callback',
  createState: () => hexRandom(),
  authorizeUrl(challenge, state) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: this.redirectUri(),
      scope: 'openid profile email offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'pi',
    });
    return `https://auth.openai.com/oauth/authorize?${params.toString()}`;
  },
  exchangeRequest(code, _state, verifier) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri(),
    });
    return {
      url: 'https://auth.openai.com/oauth/token',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    };
  },
  // Codex only answers for a ChatGPT account, so the account id must be there.
  credentialsFromToken: (body, now) => tokenCredentials(body, now, CODEX_ACCOUNT, true),
};

/**
 * The public origin the OpenRouter callback is built from. Only the server's
 * own configuration decides it: a request header must never, or the provider
 * would hand the authorization code to whoever asked. A malformed value falls
 * back to the default rather than producing a callback nobody can reach.
 */
const DEFAULT_APP_ORIGIN = 'https://postora.cloud';
// Plain http is only safe on the developer's own machine.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function appOrigin(): string {
  const configured = Deno.env.get('PUBLIC_APP_ORIGIN');
  if (!configured) return DEFAULT_APP_ORIGIN;
  try {
    const url = new URL(configured);
    const allowedProtocol = url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    if (!allowedProtocol || url.username || url.password) return DEFAULT_APP_ORIGIN;
    if (url.pathname !== '/' || url.search || url.hash) return DEFAULT_APP_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_APP_ORIGIN;
  }
}

/** The route the OpenRouter redirect lands on. */
export const OPENROUTER_CALLBACK_PATH = '/admin/settings/ai/oauth/openrouter/callback';

// OpenRouter's key is permanent: there is no refresh token and no expiry.
// The largest timestamp keeps it fresh forever, so it is never refreshed.
const OPENROUTER_KEY_EXPIRES = 8_640_000_000_000_000;
const OPENROUTER_KEY_EXPIRES_AT = '9999-12-31T00:00:00Z';

const openrouterClient: OAuthClient = {
  id: 'openrouter',
  flow: 'pkce_callback',
  redirectUri: () => `${appOrigin()}${OPENROUTER_CALLBACK_PATH}`,
  createState: () => hexRandom(),
  authorizeUrl(challenge, state) {
    const params = new URLSearchParams({
      // OpenRouter documents that it returns `state` unchanged on the callback.
      // The callback itself carries no query string: a provider that appends
      // `?code=` to it would otherwise produce an address with two `?`.
      callback_url: this.redirectUri(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return `https://openrouter.ai/auth?${params.toString()}`;
  },
  exchangeRequest(code, _state, verifier) {
    return {
      url: 'https://openrouter.ai/api/v1/auth/keys',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: verifier,
          code_challenge_method: 'S256',
        }),
      },
    };
  },
  credentialsFromToken(body) {
    const key = (body as { key?: unknown } | null | undefined)?.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new AiOAuthError('exchange_failed', 'the exchange response carries no API key');
    }
    return {
      credentials: { access: key, refresh: '', expires: OPENROUTER_KEY_EXPIRES },
      expiresAt: OPENROUTER_KEY_EXPIRES_AT,
      accountLabel: null,
    };
  },
};

export const OAUTH_CLIENTS: Record<OAuthProviderId, OAuthClient> = {
  anthropic: anthropicClient,
  'openai-codex': openaiCodexClient,
  openrouter: openrouterClient,
};
