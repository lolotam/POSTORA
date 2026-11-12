// Login constants copied from @mariozechner/pi-ai@0.73.1 dist/utils/oauth/{anthropic,openai-codex}.js — pi-ai does not export them. Re-check on every pi-ai bump.

export type OAuthProviderId = 'anthropic' | 'openai-codex';

export const OAUTH_PROVIDER_CODE: Record<OAuthProviderId, 'claude' | 'openai'> = {
  anthropic: 'claude',
  'openai-codex': 'openai',
};

export function oauthProviderForCode(providerCode: string): OAuthProviderId | null {
  if (providerCode === 'claude') return 'anthropic';
  if (providerCode === 'openai') return 'openai-codex';
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

export interface OAuthClient {
  id: OAuthProviderId;
  authorizeUrl(challenge: string, state: string): string;
  redirectUri: string;
  createState(verifier: string): string;
  exchangeRequest(code: string, state: string, verifier: string): { url: string; init: RequestInit };
  accountLabel(access: string): string | null;
  accountId(access: string): string | null;
}

const ANTHROPIC_CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');

const anthropicClient: OAuthClient = {
  id: 'anthropic',
  redirectUri: 'http://localhost:53692/callback',
  createState: (verifier) => verifier,
  authorizeUrl(challenge, state) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: 'code',
      redirect_uri: this.redirectUri,
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
          redirect_uri: this.redirectUri,
          code_verifier: verifier,
        }),
      },
    };
  },
  accountLabel: () => null,
  accountId: () => null,
};

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const openaiCodexClient: OAuthClient = {
  id: 'openai-codex',
  redirectUri: 'http://localhost:1455/auth/callback',
  createState: () => hexRandom(),
  authorizeUrl(challenge, state) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: this.redirectUri,
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
      redirect_uri: this.redirectUri,
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
  accountId(access) {
    const payload = decodeJwtPayload(access);
    const auth = payload?.['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined;
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
  },
  accountLabel(access) {
    const payload = decodeJwtPayload(access);
    if (typeof payload?.email === 'string' && payload.email.length > 0) return payload.email;
    const accountId = openaiCodexClient.accountId(access);
    return accountId ? `acc_${accountId.slice(0, 6)}` : null;
  },
};

export const OAUTH_CLIENTS: Record<OAuthProviderId, OAuthClient> = {
  anthropic: anthropicClient,
  'openai-codex': openaiCodexClient,
};
