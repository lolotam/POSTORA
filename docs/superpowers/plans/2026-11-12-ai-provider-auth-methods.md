# Admin AI Provider Auth Methods + Kimi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every admin provider dropdown on `/admin/settings?tab=ai` offers an **API key** group
and an **Auth (subscription)** group. Subscription OAuth for Anthropic and OpenAI-Codex goes
through `@mariozechner/pi-ai`, behind a flag that stays off. Kimi (Moonshot) is added as a
provider.

**Architecture:**
- A new Vault-backed table plus SECURITY DEFINER RPCs hold one platform OAuth credential per pi-ai
  OAuth provider.
- `_shared/aiOAuth/*` owns login (paste-the-redirect-URL), single-flight refresh using pi-ai's
  `refresh*Token`, and the call adapter using pi-ai's `complete`.
- `callAiChain` gains an `authMethod: 'oauth'` tier branch. The API-key path is unchanged.
- A new admin-only edge function `ai-provider-auth` serves the UI.

**Tech Stack:** Deno edge functions, Zod, Supabase Postgres + Vault, React 18 + TanStack Query +
shadcn `Select`, Vitest, Deno test, `npm:@mariozechner/pi-ai@0.73.1`.

**Spec:** `docs/superpowers/specs/2026-11-12-ai-provider-auth-methods-design.md`. Read it fully;
§1 explains why the flag stays off.

## Global Constraints

- Read `ARCHITECTURE.md` §3–4, §11, §12–17, §23–24, §26, §33, §37, §39–40 before writing code.
- The pi-ai import specifier is exactly `npm:@mariozechner/pi-ai@0.73.1` (root) and
  `npm:@mariozechner/pi-ai@0.73.1/oauth`. Never use an unpinned version.
- The flag key is `feature_ai_provider_oauth` in `system_settings`. `value` `true` means on;
  anything else is off. The migration seeds `false`.
- OAuth provider ids are exactly `anthropic` and `openai-codex`. The provider code map is
  `{ anthropic: 'claude', 'openai-codex': 'openai' }`.
- OAuth categories are exactly `chat` and `agent_triage`.
- Saved tier value: `{ provider_code, model_id, auth_method? }`. `auth_method` is written only when
  it equals `'oauth'`.
- Never log, return or toast a token. Pass provider error text through `redactProviderError`.
- No `git stash`. Commit with explicit paths: `git commit -- <paths>`. Never commit
  `graphify-out/`, `.env*`, logs.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not change `isOAuthProvider` in `AiProvidersCard.tsx`. Do not set `ai_providers.auth_type` on
  `claude` or `openai`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20261112120000_ai_provider_oauth.sql` | create | table, RPCs, Kimi seed, flag |
| `supabase/tests/ai_provider_oauth.sql` | create | SQL proof |
| `scripts/db-harness.sh` | modify | register suite in `SUITES` |
| `supabase/functions/_shared/aiOAuth/clients.ts` | create | per-provider login constants (copied from pi-ai) |
| `supabase/functions/_shared/aiOAuth/pkce.ts` | create | S256 PKCE |
| `supabase/functions/_shared/aiOAuth/loginFlow.ts` | create | `startLogin`, `finishLogin`, `parseAuthorizationInput` |
| `supabase/functions/_shared/aiOAuth/credentials.ts` | create | `getFreshOAuthCredential` (single-flight refresh) |
| `supabase/functions/_shared/aiOAuth/piCall.ts` | create | `callPiOAuth` OpenAI-shape adapter over pi `complete` |
| `supabase/functions/_shared/aiOAuth/errors.ts` | create | `AiOAuthError` |
| `supabase/functions/_shared/aiOAuth/flag.ts` | create | `isAiProviderOAuthEnabled(admin)` |
| `supabase/functions/_shared/aiOAuth/*.test.ts` | create | Deno tests |
| `supabase/functions/_shared/ai-fallback.ts` | modify | `AiTier.authMethod`, OAuth branch, readers pass `auth_method` |
| `supabase/functions/_shared/ai-fallback-chain.test.ts` | modify | OAuth tier cases |
| `supabase/functions/ai-agent-reply/index.ts` | modify | `loadGlobalModelChain` passes `auth_method` |
| `supabase/functions/ai-agent-reply/logic.ts` | modify | `KNOWN_MODEL_PROVIDERS` += `moonshot` |
| `supabase/functions/ai-provider-auth/index.ts` | create | thin adapter |
| `supabase/functions/ai-provider-auth/handler.ts` | create | actions |
| `supabase/functions/ai-provider-auth/handler.test.ts` | create | Deno tests |
| `src/features/ai-providers/infrastructure/aiProviderAuthGateway.ts` | create | invoke wrapper |
| `src/hooks/ai-config/useAiProviderAuth.ts` | create | query + mutations |
| `src/hooks/ai-config/types.ts` | modify | `auth_method` on selection type |
| `src/hooks/useAIConfiguration.ts` | modify | setters accept `auth_method` |
| `src/components/admin/DefaultModelSelector.tsx` | modify | grouped dropdown |
| `src/components/admin/settings/ai/AiCategoryCards.tsx` | modify | pass `authMethod` |
| `src/components/admin/AdminAiAgentSection.tsx` | modify | pass `authMethod`; `AGENT_PROVIDER_CODES` += `moonshot` |
| `src/components/admin/settings/ai/AiProvidersCard.tsx` | modify | subscription login section |
| `src/components/admin/settings/ai/SubscriptionLoginSection.tsx` | create | connect/test/disconnect UI |
| `src/components/admin/settings/settingsCatalog.ts` | modify | keywords |
| `src/integrations/supabase/types.ts` | modify | regenerated RPC types |
| Vitest files next to the components | create | UI tests |

---

### Task 1: Migration, SQL proof, types

**Files:**
- Create: `supabase/migrations/20261112120000_ai_provider_oauth.sql`
- Create: `supabase/tests/ai_provider_oauth.sql`
- Modify: `scripts/db-harness.sh` (append `ai_provider_oauth.sql` to the `SUITES=(` array at line ~107)
- Modify: `src/integrations/supabase/types.ts`

**Interfaces — Produces:**
- RPCs `save_ai_oauth_credentials(p_oauth_provider text, p_provider_code text, p_credentials jsonb, p_account_label text, p_expires_at timestamptz, p_user uuid) → void`
- `get_ai_oauth_credentials(p_oauth_provider text) → jsonb`
- `begin_ai_oauth_refresh(p_oauth_provider text, p_lease_seconds int) → boolean`
- `fail_ai_oauth_refresh(p_oauth_provider text, p_error text, p_reauth boolean) → void`
- `delete_ai_oauth_connection(p_oauth_provider text) → void`
- `get_ai_oauth_statuses() → TABLE(oauth_provider text, provider_code text, status text, account_label text, expires_at timestamptz)`

- [ ] **Step 1: Write the SQL proof first** (`supabase/tests/ai_provider_oauth.sql`). Copy the
  header, transaction and assert style from an existing suite in `supabase/tests/` that uses Vault
  (search `grep -l vault supabase/tests/*.sql`). The suite must assert:
  1. `SET ROLE authenticated;` → `SELECT * FROM ai_provider_oauth_connections` returns 0 rows, and
     `SELECT get_ai_oauth_credentials('anthropic')` raises `insufficient_privilege`. Then `RESET ROLE`.
  2. As service role: `save_ai_oauth_credentials('anthropic','claude','{"access":"a","refresh":"r","expires":1}'::jsonb,'me',now(),NULL)`,
     then `get_ai_oauth_credentials('anthropic')->>'refresh' = 'r'` and `->>'status' = 'connected'`.
  3. `begin_ai_oauth_refresh('anthropic',30)` is `true`; a second call is `false`.
     `UPDATE … SET refresh_lock_until = now() - interval '1 second'`; a third call is `true`.
  4. `fail_ai_oauth_refresh('anthropic','x',true)` → status `reauth_required`, lock NULL.
  5. Saving again → status `connected`.
  6. `delete_ai_oauth_connection('anthropic')` → no row, and the old `credentials_secret_id` is
     absent from `vault.secrets`.
  7. `SELECT 1 FROM ai_providers WHERE provider_code='moonshot'` exists, and 4 `ai_models` rows join to it.
  8. `SELECT value FROM system_settings WHERE key='feature_ai_provider_oauth'` = `'false'::jsonb`.
  9. `INSERT` with `oauth_provider='github-copilot'` violates the CHECK.

- [ ] **Step 2: Run it and confirm it fails.** Run `bash scripts/db-harness.sh` (see its header for
  the local DB requirements). Expected: FAIL — relation `ai_provider_oauth_connections` does not exist.

- [ ] **Step 3: Write the migration.**

```sql
-- Admin subscription OAuth credentials for AI providers (spec 2026-11-12-ai-provider-auth-methods-design.md).
-- Tokens live only in Vault; the browser never reads this table.
CREATE TABLE IF NOT EXISTS public.ai_provider_oauth_connections (
  oauth_provider text PRIMARY KEY CHECK (oauth_provider IN ('anthropic','openai-codex')),
  provider_code text NOT NULL REFERENCES public.ai_providers(provider_code),
  credentials_secret_id uuid,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','reauth_required')),
  account_label text,
  expires_at timestamptz,
  refresh_lock_until timestamptz,
  last_refresh_error text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_provider_oauth_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_provider_oauth_connections_deny ON public.ai_provider_oauth_connections;
CREATE POLICY ai_provider_oauth_connections_deny ON public.ai_provider_oauth_connections
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.ai_provider_oauth_connections FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.save_ai_oauth_credentials(
  p_oauth_provider text, p_provider_code text, p_credentials jsonb,
  p_account_label text, p_expires_at timestamptz, p_user uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_secret uuid;
BEGIN
  SELECT credentials_secret_id INTO v_secret FROM public.ai_provider_oauth_connections
    WHERE oauth_provider = p_oauth_provider FOR UPDATE;
  IF v_secret IS NULL THEN
    v_secret := vault.create_secret(p_credentials::text, 'ai_oauth_' || p_oauth_provider);
  ELSE
    PERFORM vault.update_secret(v_secret, p_credentials::text);
  END IF;
  INSERT INTO public.ai_provider_oauth_connections AS c
    (oauth_provider, provider_code, credentials_secret_id, status, account_label, expires_at,
     refresh_lock_until, last_refresh_error, connected_by, updated_at)
  VALUES (p_oauth_provider, p_provider_code, v_secret, 'connected', p_account_label, p_expires_at,
     NULL, NULL, p_user, now())
  ON CONFLICT (oauth_provider) DO UPDATE SET
    provider_code = EXCLUDED.provider_code, credentials_secret_id = EXCLUDED.credentials_secret_id,
    status = 'connected', account_label = COALESCE(EXCLUDED.account_label, c.account_label),
    expires_at = EXCLUDED.expires_at, refresh_lock_until = NULL, last_refresh_error = NULL,
    connected_by = COALESCE(EXCLUDED.connected_by, c.connected_by), updated_at = now();
END $fn$;

CREATE OR REPLACE FUNCTION public.get_ai_oauth_credentials(p_oauth_provider text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT ds.decrypted_secret::jsonb || jsonb_build_object('status', c.status)
  FROM public.ai_provider_oauth_connections c
  JOIN vault.decrypted_secrets ds ON ds.id = c.credentials_secret_id
  WHERE c.oauth_provider = p_oauth_provider
$fn$;

CREATE OR REPLACE FUNCTION public.begin_ai_oauth_refresh(p_oauth_provider text, p_lease_seconds int)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH won AS (
    UPDATE public.ai_provider_oauth_connections
       SET refresh_lock_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
     WHERE oauth_provider = p_oauth_provider
       AND (refresh_lock_until IS NULL OR refresh_lock_until < now())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM won)
$fn$;

CREATE OR REPLACE FUNCTION public.fail_ai_oauth_refresh(p_oauth_provider text, p_error text, p_reauth boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.ai_provider_oauth_connections
     SET refresh_lock_until = NULL, last_refresh_error = left(p_error, 500),
         status = CASE WHEN p_reauth THEN 'reauth_required' ELSE status END, updated_at = now()
   WHERE oauth_provider = p_oauth_provider
$fn$;

CREATE OR REPLACE FUNCTION public.delete_ai_oauth_connection(p_oauth_provider text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_secret uuid;
BEGIN
  DELETE FROM public.ai_provider_oauth_connections WHERE oauth_provider = p_oauth_provider
    RETURNING credentials_secret_id INTO v_secret;
  IF v_secret IS NOT NULL THEN DELETE FROM vault.secrets WHERE id = v_secret; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.get_ai_oauth_statuses()
RETURNS TABLE(oauth_provider text, provider_code text, status text, account_label text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT oauth_provider, provider_code, status, account_label, expires_at FROM public.ai_provider_oauth_connections
$fn$;

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'save_ai_oauth_credentials(text,text,jsonb,text,timestamptz,uuid)',
    'get_ai_oauth_credentials(text)', 'begin_ai_oauth_refresh(text,int)',
    'fail_ai_oauth_refresh(text,text,boolean)', 'delete_ai_oauth_connection(text)',
    'get_ai_oauth_statuses()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $grants$;

-- Kimi (Moonshot): OpenAI-compatible, API key only (pi-ai 0.73.1 has no Moonshot OAuth).
INSERT INTO public.ai_providers (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active, auth_type)
VALUES ('moonshot', 'Kimi (Moonshot)', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY', 'openai', true, false, 'api_key')
ON CONFLICT DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, is_active)
SELECT p.id, m.model_id, m.name, m.description, ARRAY['chat'], 256000, true
FROM public.ai_providers p
CROSS JOIN (VALUES
  ('kimi-k2.6', 'Kimi K2.6', 'Moonshot flagship model'),
  ('kimi-k2.5', 'Kimi K2.5', 'Moonshot general model'),
  ('kimi-k2-turbo-preview', 'Kimi K2 Turbo', 'Fast Kimi K2'),
  ('kimi-k2-thinking', 'Kimi K2 Thinking', 'Kimi K2 with extended reasoning')
) AS m(model_id, name, description)
WHERE p.provider_code = 'moonshot'
ON CONFLICT DO NOTHING;

INSERT INTO public.system_settings (key, value) VALUES ('feature_ai_provider_oauth', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
```

  Before running, check `ai_models` for NOT NULL cost columns:
  `grep -n "cost_per_1m" supabase/migrations/*ai_models*.sql`. If they are NOT NULL, add them to
  the column list with value `0` and add the comment `-- TODO(owner): Moonshot pricing`. Also check
  for a unique constraint on `(provider_id, model_id)`. If there is none, replace
  `ON CONFLICT DO NOTHING` with `WHERE NOT EXISTS (SELECT 1 FROM ai_models x WHERE x.provider_id = p.id AND x.model_id = m.model_id)`.

- [ ] **Step 4: Run the proof and confirm it passes.** Run `bash scripts/db-harness.sh`.
  Expected: `ai_provider_oauth.sql` PASS.

- [ ] **Step 5: Regenerate types.** Add the six RPC signatures under `Functions` in
  `src/integrations/supabase/types.ts`, matching the existing entries' shape (for example search
  `save_user_ai_provider_key`). Then run `npx tsc -b --noEmit`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ai): store admin AI subscription credentials in Vault and add Kimi" -- supabase/migrations/20261112120000_ai_provider_oauth.sql supabase/tests/ai_provider_oauth.sql scripts/db-harness.sh src/integrations/supabase/types.ts
```

---

### Task 2: Login flow (`clients.ts`, `pkce.ts`, `errors.ts`, `loginFlow.ts`)

**Files:**
- Create: `supabase/functions/_shared/aiOAuth/clients.ts`, `pkce.ts`, `errors.ts`, `loginFlow.ts`
- Test: `supabase/functions/_shared/aiOAuth/loginFlow.test.ts`

**Interfaces — Produces:**
```ts
// errors.ts
export type AiOAuthErrorCode = 'not_connected' | 'reauth_required' | 'refresh_failed' | 'oauth_disabled'
  | 'invalid_state' | 'invalid_code' | 'exchange_failed' | 'oauth_unsupported_provider';
export class AiOAuthError extends Error { constructor(readonly code: AiOAuthErrorCode, message?: string) }
// clients.ts
export type OAuthProviderId = 'anthropic' | 'openai-codex';
export const OAUTH_PROVIDER_CODE: Record<OAuthProviderId, 'claude' | 'openai'>;
export function oauthProviderForCode(providerCode: string): OAuthProviderId | null;
export interface OAuthClient { id: OAuthProviderId; authorizeUrl(challenge: string, state: string): string;
  redirectUri: string; createState(verifier: string): string;
  exchangeRequest(code: string, state: string, verifier: string): { url: string; init: RequestInit };
  accountLabel(access: string): string | null; accountId(access: string): string | null; }
export const OAUTH_CLIENTS: Record<OAuthProviderId, OAuthClient>;
// pkce.ts
export async function generatePkce(): Promise<{ verifier: string; challenge: string }>;
// loginFlow.ts
export interface LoginDeps { admin: SupabaseClient; fetch: typeof fetch; now: () => number }
export function parseAuthorizationInput(input: string): { code?: string; state?: string };
export async function startLogin(deps: LoginDeps, provider: OAuthProviderId, userId: string): Promise<{ authorizeUrl: string }>;
export async function finishLogin(deps: LoginDeps, provider: OAuthProviderId, pasted: string, userId: string): Promise<{ accountLabel: string | null }>;
```

- [ ] **Step 1: Write failing tests** in `loginFlow.test.ts` using `Deno.test` and
  `jsr:@std/assert` (or match the assert import other `_shared/*.test.ts` files use). Inject a
  fake `admin` that records `.from('oauth_states')` inserts and selects, and `.rpc()` calls. Inject
  a stub `fetch` that returns a token JSON.
  - `startLogin anthropic builds claude.ai authorize URL with S256 challenge and state equal to verifier`:
    - the host is `claude.ai`
    - `client_id` = `atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')`
    - `redirect_uri` = `http://localhost:53692/callback`
    - `code=true`, `code_challenge_method=S256`
    - the inserted state row has `scope_kind:'platform'` and `provider_code:'anthropic'`
  - `startLogin openai-codex adds originator and codex flags`: host `auth.openai.com`,
    `originator=pi`, `codex_cli_simplified_flow=true`, `id_token_add_organizations=true`.
  - `parseAuthorizationInput accepts url, code#state, querystring and bare code` (one table-driven test).
  - `finishLogin rejects unknown or expired state` → throws `AiOAuthError` with code `invalid_state`; `fetch` is never called.
  - `finishLogin anthropic posts JSON body and saves credentials through rpc`:
    - the stub `fetch` receives `https://platform.claude.com/v1/oauth/token` with JSON
      `grant_type=authorization_code`, `code`, `state`, `code_verifier`.
    - the `rpc('save_ai_oauth_credentials', …)` args contain `p_credentials.refresh` and
      `p_provider_code:'claude'`.
    - `expires` = `now + expires_in*1000 - 300000`.
  - `finishLogin openai-codex posts form body and stores accountId from JWT claim`. Build the access
    token as `header.<base64url(JSON {"https://api.openai.com/auth":{"chatgpt_account_id":"acc_1"}})>.sig`.

- [ ] **Step 2: Run and confirm failure.**
  `deno test --allow-env supabase/functions/_shared/aiOAuth/loginFlow.test.ts`.
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Constants are copied verbatim from pi-ai 0.73.1. Put this header in
  `clients.ts`: `// Login constants copied from @mariozechner/pi-ai@0.73.1 dist/utils/oauth/{anthropic,openai-codex}.js — pi-ai does not export them. Re-check on every pi-ai bump.`
  - **anthropic:**
    - `CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")`
    - `AUTHORIZE = "https://claude.ai/oauth/authorize"`
    - `TOKEN = "https://platform.claude.com/v1/oauth/token"`
    - `REDIRECT = "http://localhost:53692/callback"`
    - `SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"`
    - authorize params, in order: `code=true, client_id, response_type=code, redirect_uri, scope, code_challenge, code_challenge_method=S256, state`
    - `createState(verifier)` returns `verifier`
    - exchange: `POST TOKEN`, `content-type: application/json`, body `{grant_type:'authorization_code', client_id, code, state, redirect_uri, code_verifier}`
    - `accountLabel` → `null`
  - **openai-codex:**
    - `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`
    - `AUTHORIZE = "https://auth.openai.com/oauth/authorize"`
    - `TOKEN = "https://auth.openai.com/oauth/token"`
    - `REDIRECT = "http://localhost:1455/auth/callback"`
    - `SCOPE = "openid profile email offline_access"`
    - authorize params: `response_type=code, client_id, redirect_uri, scope, code_challenge, code_challenge_method=S256, state, id_token_add_organizations=true, codex_cli_simplified_flow=true, originator=pi`
    - `createState()` returns 16 random bytes as hex
    - exchange: `POST TOKEN`, `content-type: application/x-www-form-urlencoded`, body `grant_type=authorization_code&client_id&code&code_verifier&redirect_uri`
    - `accountId(access)` = decoded JWT payload `["https://api.openai.com/auth"].chatgpt_account_id`
    - `accountLabel(access)` = the decoded payload's `email` if present, else `acc_` + the first 6 characters of the account id
  - **`pkce.ts`:** 32 random bytes as base64url = verifier; `SHA-256(verifier)` as base64url = challenge.
  - **`finishLogin`:**
    1. Parse the input; no code → `invalid_code`.
    2. Require `parsed.state`; a missing state → `invalid_state`. A bare code is not accepted,
       because the state binds the paste to the stored verifier. Select the `oauth_states` row
       with `state = parsed.state`, `provider_code = provider`, `scope_kind='platform'` and
       `expires_at > now()`. Delete it (single use). If no row matches → `invalid_state`.
    3. Fetch the exchange. Non-2xx → `exchange_failed`, with the message passed through
       `redactProviderError` from `../ai-fallback.ts` if exported. Otherwise strip anything that
       looks like a token.
    4. `credentials = { access, refresh, expires: now + expires_in*1000 - 300000, accountId? }`.
    5. `rpc('save_ai_oauth_credentials', { p_oauth_provider, p_provider_code: OAUTH_PROVIDER_CODE[provider], p_credentials: credentials, p_account_label, p_expires_at: new Date(expires).toISOString(), p_user: userId })`.
    6. The `openai-codex` exchange must yield an `accountId`; if not → `exchange_failed`.

- [ ] **Step 4: Run and confirm pass.** Same command. Expected: all PASS. Also run
  `deno check supabase/functions/_shared/aiOAuth/*.ts`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): paste-the-redirect OAuth login for admin AI subscriptions" -- supabase/functions/_shared/aiOAuth/clients.ts supabase/functions/_shared/aiOAuth/pkce.ts supabase/functions/_shared/aiOAuth/errors.ts supabase/functions/_shared/aiOAuth/loginFlow.ts supabase/functions/_shared/aiOAuth/loginFlow.test.ts
```

---

### Task 3: Single-flight credential refresh (`credentials.ts`, `flag.ts`)

**Files:**
- Create: `supabase/functions/_shared/aiOAuth/credentials.ts`, `flag.ts`
- Test: `supabase/functions/_shared/aiOAuth/credentials.test.ts`

**Interfaces:**
- **Consumes:** `AiOAuthError`, `OAuthProviderId`, `OAUTH_PROVIDER_CODE` (Task 2); the RPCs (Task 1).
- **Produces:**
```ts
export interface CredentialDeps {
  admin: SupabaseClient;
  refresh: (provider: OAuthProviderId, refreshToken: string) => Promise<{ access: string; refresh: string; expires: number; [k: string]: unknown }>;
  getApiKey: (provider: OAuthProviderId, creds: Record<string, unknown>) => string;
  now: () => number; sleep: (ms: number) => Promise<void>;
}
export function defaultCredentialDeps(admin: SupabaseClient): CredentialDeps; // wires pi-ai
export async function getFreshOAuthCredential(deps: CredentialDeps, provider: OAuthProviderId): Promise<{ apiKey: string }>;
// flag.ts
export async function isAiProviderOAuthEnabled(admin: SupabaseClient): Promise<boolean>; // system_settings value === true
```

- [ ] **Step 1: Write failing tests.** The fake `admin.rpc` is backed by an in-memory row so a
  second caller sees a saved refresh.
  - `fresh credential returns api key without refresh` (`expires = now + 10min`).
  - `expired credential with lease won refreshes once and saves rotated refresh token`: assert
    `save_ai_oauth_credentials` was called with the new refresh.
  - `expired credential with lease lost waits and returns the token saved by the winner`:
    - `begin` returns false.
    - The first re-read is still expired.
    - The second re-read is fresh because the test mutates the in-memory row in `sleep`.
    - `refresh` is never called.
  - `lease never released throws refresh_failed after 4 re-reads`.
  - `refresh 400 marks reauth_required`: `fail_ai_oauth_refresh` is called with `p_reauth:true`, and the function throws `reauth_required`.
  - `missing row throws not_connected`; `status reauth_required throws reauth_required without refresh`.
  - `isAiProviderOAuthEnabled is true only for jsonb true` (table: `true`, `'true'` string, `false`, missing row).

- [ ] **Step 2: Run and confirm failure.**
  `deno test --allow-env supabase/functions/_shared/aiOAuth/credentials.test.ts`.

- [ ] **Step 3: Implement.**
  - **`defaultCredentialDeps`:**
    - `refresh` uses `import { refreshAnthropicToken, refreshOpenAICodexToken, getOAuthProvider } from "npm:@mariozechner/pi-ai@0.73.1/oauth";`
    - `getApiKey(p, c) = getOAuthProvider(p)!.getApiKey(c as never)`
    - `sleep = (ms) => new Promise(r => setTimeout(r, ms))`
  - **The 400/401 refresh error.** pi-ai throws an `Error` whose message contains the HTTP status.
    Treat a message matching `/\b(400|401)\b|invalid_grant/i` as reauth. Keep this in one named
    function, `isReauthRefreshError(message)`, and test it.
  - **Loop:** fresh check uses `expires - 60_000 > now`; lease 30 s; `sleep(750)` × up to 4.
  - **Logging:** `console.warn` only `{ provider, code }`, never credentials.

- [ ] **Step 4: Run and confirm pass.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): single-flight refresh for admin AI subscription tokens via pi-ai" -- supabase/functions/_shared/aiOAuth/credentials.ts supabase/functions/_shared/aiOAuth/flag.ts supabase/functions/_shared/aiOAuth/credentials.test.ts
```

---

### Task 4: pi-ai call adapter (`piCall.ts`)

**Files:**
- Create: `supabase/functions/_shared/aiOAuth/piCall.ts`
- Test: `supabase/functions/_shared/aiOAuth/piCall.test.ts`

**Interfaces — Produces:**
```ts
export interface PiCallDeps {
  getModel: (provider: string, modelId: string) => unknown | undefined;           // pi-ai getModel
  complete: (model: unknown, context: unknown, options: { apiKey: string; signal: AbortSignal; temperature?: number; maxTokens?: number }) => Promise<PiAssistant>;
}
export interface PiAssistant { content: Array<{ type: string; text?: string }>; stopReason: string; errorMessage?: string;
  usage?: { input: number; output: number; totalTokens: number } }
export function defaultPiCallDeps(): PiCallDeps;
export async function callPiOAuth(deps: PiCallDeps, provider: OAuthProviderId, modelId: string,
  openAiBody: Record<string, unknown>, apiKey: string, timeoutMs: number): Promise<Response>;
```

- [ ] **Step 1: Write failing tests.**
  - `maps system and chat turns into pi context`:
    - Input `messages: [{role:'system',content:'S'},{role:'user',content:'U1'},{role:'assistant',content:'A1'},{role:'user',content:'U2'}]`.
    - The captured context is `systemPrompt:'S'` with 3 messages. The user content is the string.
    - The assistant entry has `content:[{type:'text',text:'A1'}]`, `stopReason:'stop'` and zero usage.
    - Multiple system messages are joined with `\n\n`.
    - Array-form OpenAI content parts `[{type:'text',text}]` are joined into text.
  - `returns OpenAI-shaped response`: `json.choices[0].message.content === 'hi'` and
    `usage.prompt_tokens/completion_tokens/total_tokens` are mapped.
  - `body with tools returns 422 without calling complete`.
  - `unknown model returns 424 without calling complete`.
  - `stopReason error returns 502 with redacted error text` (the error text contains the api key and must not appear in the body).
  - `passes temperature and max_tokens as temperature/maxTokens`.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement.**
  - `defaultPiCallDeps` uses `import { getModel, complete } from "npm:@mariozechner/pi-ai@0.73.1";`.
  - The `timestamp` for every message is `Date.now()`.
  - The abort timeout uses `AbortSignal.timeout(timeoutMs)`.
  - On a thrown error (abort, network), return a 504 for `TimeoutError` and a 502 otherwise, with
    redacted text. Never throw out of `callPiOAuth`.

- [ ] **Step 4: Run and confirm pass.** Also add one **opt-in live smoke**: the file
  `piCall.live.test.ts`, skipped unless `PI_LIVE=1` is set, which calls `getModel('openai','gpt-4o-mini')`
  with `OPENAI_API_KEY`. It is not run in CI. It proves the npm import loads in Deno.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): OpenAI-shaped adapter over pi-ai complete for OAuth tiers" -- supabase/functions/_shared/aiOAuth/piCall.ts supabase/functions/_shared/aiOAuth/piCall.test.ts supabase/functions/_shared/aiOAuth/piCall.live.test.ts
```

---

### Task 5: Chain integration (`ai-fallback.ts`, agent chain)

**Files:**
- Modify: `supabase/functions/_shared/ai-fallback.ts` (the `AiTier` type at line 7; `callAiChain` at ~390; `callChatCompletion` at ~370; `fetchCategoryAiSettings` at ~182; `resolveChatModelConfig` at ~280)
- Modify: `supabase/functions/ai-agent-reply/index.ts` (`loadGlobalModelChain` ~493 and the chain composition ~1319-1340)
- Modify: `supabase/functions/ai-agent-reply/logic.ts:147` (`KNOWN_MODEL_PROVIDERS` += `'moonshot'`)
- Test: `supabase/functions/_shared/ai-fallback-chain.test.ts`

**Interfaces:**
- **Consumes:** `getFreshOAuthCredential`, `defaultCredentialDeps`, `isAiProviderOAuthEnabled` (Task 3); `callPiOAuth`, `defaultPiCallDeps` (Task 4); `oauthProviderForCode` (Task 2).
- **Produces:**
  - `AiTier` platform branch: `{ provider; model; credentialSource:'platform'; apiKey?; authMethod?: 'api_key' | 'oauth' }`.
  - `AiTierResult.authMethod?: 'api_key' | 'oauth'`.
  - `callAiChain(admin, body, candidates, oauthDeps?)`, where `oauthDeps?: { credentials?: CredentialDeps; pi?: PiCallDeps; enabled?: () => Promise<boolean> }` is an optional test seam that defaults to the real deps.

- [ ] **Step 1: Write failing tests** in `ai-fallback-chain.test.ts`, following that file's existing
  stub style:
  - `oauth tier with flag off records oauth_disabled and falls to api-key tier 2`.
  - `oauth tier with flag on answers through pi and records authMethod oauth`: the stub pi returns
    'ok', and the result has `tierUsed:'primary'` and `providerUsed:'claude'`.
  - `oauth tier with tools records oauth_tools_unsupported`.
  - `oauth tier on provider without pi oauth records oauth_unsupported_provider` (for example `xai`).
  - `oauth credential reauth_required records the code and falls over`.
  - Existing API-key tests stay green without modification. Do not edit their expectations.

- [ ] **Step 2: Run and confirm failure.**
  `deno test --allow-env supabase/functions/_shared/ai-fallback-chain.test.ts`.

- [ ] **Step 3: Implement.**
  - **In the `callAiChain` loop**, before resolving `apiKey`:

    ```ts
    if (tier.credentialSource === 'platform' && tier.authMethod === 'oauth') {
      attempt.authMethod = 'oauth';
      const outcome = await callOAuthTier(admin, tier, body /* chatRequestForTier result */, oauth);
      // outcome: { response?: Response; error?: string }
    }
    ```

  - Put the OAuth path in a small private function `callOAuthTier` in a new file,
    `_shared/aiOAuth/chainTier.ts`, so `ai-fallback.ts` grows by a few lines only (ARCHITECTURE
    §40). It returns `{ response }` or `{ error: AiOAuthErrorCode | 'oauth_tools_unsupported' }`.
    Map a 422 to `oauth_tools_unsupported`.
  - Keep `attempt.status` and the success return identical to the API-key branch.
  - **`callChatCompletion`:** route `authMethod==='oauth'` through the same `callOAuthTier`.
  - **Readers:** wherever a `system_settings` value `{provider_code, model_id}` becomes an `AiTier`,
    add `authMethod: value.auth_method === 'oauth' ? 'oauth' : undefined`. In
    `ai-agent-reply/index.ts`, `loadGlobalModelChain` must carry it into the tiers it builds.
    `grep -n "model_id" supabase/functions/ai-agent-reply/index.ts` lists every site.
  - `KNOWN_MODEL_PROVIDERS` += `'moonshot'`.

- [ ] **Step 4: Run and confirm pass.** Also run
  `deno test --allow-env supabase/functions/ai-agent-reply/` and
  `deno check supabase/functions/ai-agent-reply/index.ts supabase/functions/_shared/ai-fallback.ts`.
  Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): route oauth tiers through pi-ai in the AI fallback chain" -- supabase/functions/_shared/ai-fallback.ts supabase/functions/_shared/aiOAuth/chainTier.ts supabase/functions/_shared/ai-fallback-chain.test.ts supabase/functions/ai-agent-reply/index.ts supabase/functions/ai-agent-reply/logic.ts
```

---

### Task 6: Edge function `ai-provider-auth`

**Files:**
- Create: `supabase/functions/ai-provider-auth/index.ts`, `handler.ts`
- Test: `supabase/functions/ai-provider-auth/handler.test.ts`
- Read for shape: `supabase/functions/higgsfield-oauth/index.ts` (auth + `isAdmin`), `supabase/functions/user-ai-providers/handler.ts` (deps-seam handler), `_shared/cors.ts`, `_shared/auth-helper.ts`

**Interfaces — Produces** (the HTTP contract, POST JSON):

```ts
type Req =
  | { action: 'capabilities' }
  | { action: 'start'; oauth_provider: 'anthropic' | 'openai-codex' }
  | { action: 'finish'; oauth_provider: 'anthropic' | 'openai-codex'; pasted: string /* 1..4096 */ }
  | { action: 'disconnect'; oauth_provider: 'anthropic' | 'openai-codex' }
  | { action: 'test'; oauth_provider: 'anthropic' | 'openai-codex'; model_id: string /* 1..120 */ };
// capabilities → { enabled, providers: Array<{ provider_code: 'claude'|'openai'; oauth_provider; name; status: 'not_connected'|'connected'|'reauth_required'; account_label: string|null; expires_at: string|null; models: string[] }> }
// start → { authorize_url }   finish → { status: 'connected', account_label }
// disconnect → { status: 'not_connected' }   test → { ok: boolean, latency_ms: number, error?: string }
```

- [ ] **Step 1: Write failing tests** against `handler.ts` with injected deps (`isAdmin`, `admin`
  client fake, `oauthEnabled`, `login`, `credentials`, `pi`, `listOAuthProviders`, `listModels`):
  - `non-admin gets 403 and a refusal log row`.
  - `invalid body gets 400`.
  - `start with flag off returns 409 oauth_disabled`.
  - `capabilities lists only anthropic and openai-codex with mapped provider codes and never includes token fields`:
    - The fake `listOAuthProviders` returns `['anthropic','github-copilot','openai-codex']`.
    - Assert `github-copilot` is absent.
    - Assert `JSON.stringify(body)` matches neither `/refresh|access|sk-ant/`.
  - `finish maps AiOAuthError invalid_state to 400 with code`.
  - `disconnect calls delete_ai_oauth_connection`.
  - `test returns ok and latency when pi answers`.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement.**
  - **`index.ts`** mirrors `higgsfield-oauth/index.ts`:
    1. OPTIONS.
    2. `authenticateCaller` → 401.
    3. Service-role client.
    4. Build `defaultDeps` from:
       - `getOAuthProviders` from `npm:@mariozechner/pi-ai@0.73.1/oauth`
       - `getModels` from `npm:@mariozechner/pi-ai@0.73.1`
       - `startLogin` / `finishLogin`
       - `defaultCredentialDeps`
       - `defaultPiCallDeps`
    5. `return handle(req body, caller, deps)`.
    Use the restricted CORS helper that siblings use (`grep -l restrictedJsonResponse supabase/functions/*/index.ts`).
  - **`handler.ts`:**
    - Zod discriminated union.
    - The admin check runs first for every action.
    - `capabilities` reads statuses via `rpc('get_ai_oauth_statuses')`.
    - Provider `name` comes from `ai_providers.name` for the mapped code.
    - Refusals: `system_logs` insert `{ level:'warn', source:'ai-provider-auth', message:'refused', details:{ action, reason } }`.
      Check the `system_logs` columns with `grep -rn "from('system_logs').insert" supabase/functions | head -3` and copy that shape.
  - **`config.toml`:** add `[functions.ai-provider-auth] verify_jwt = false` only if `higgsfield-oauth` has the same entry (check `supabase/config.toml`).

- [ ] **Step 4: Run and confirm pass.** Also run `deno check supabase/functions/ai-provider-auth/*.ts`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): admin ai-provider-auth function for subscription login" -- supabase/functions/ai-provider-auth/ supabase/config.toml
```

  Drop `supabase/config.toml` from the path list if it was not changed.

---

### Task 7: Frontend gateway, hooks, setters

**Files:**
- Create: `src/features/ai-providers/infrastructure/aiProviderAuthGateway.ts`
- Create: `src/hooks/ai-config/useAiProviderAuth.ts`
- Modify: `src/hooks/ai-config/types.ts` (add `AiAuthMethod = 'api_key' | 'oauth'`; `auth_method?: AiAuthMethod` on the default/fallback selection type that mirrors `{provider_code, model_id}`)
- Modify: `src/hooks/useAIConfiguration.ts:103-146` (three setters)
- Test: `src/hooks/ai-config/useAiProviderAuth.test.tsx`, `src/hooks/useAIConfiguration.authMethod.test.tsx`

**Interfaces — Produces:**
```ts
export type OAuthProviderId = 'anthropic' | 'openai-codex';
export interface AiOAuthCapability { provider_code: 'claude' | 'openai'; oauth_provider: OAuthProviderId; name: string;
  status: 'not_connected' | 'connected' | 'reauth_required'; account_label: string | null; expires_at: string | null; models: string[] }
export interface AiOAuthCapabilities { enabled: boolean; providers: AiOAuthCapability[] }
// gateway
export const aiProviderAuthGateway: { capabilities(): Promise<AiOAuthCapabilities>; start(p: OAuthProviderId): Promise<{ authorize_url: string }>;
  finish(p: OAuthProviderId, pasted: string): Promise<{ status: 'connected'; account_label: string | null }>;
  disconnect(p: OAuthProviderId): Promise<void>; test(p: OAuthProviderId, modelId: string): Promise<{ ok: boolean; latency_ms: number; error?: string }> };
// hooks
export function useAiProviderAuthCapabilities(): UseQueryResult<AiOAuthCapabilities>;   // key ['ai-provider-auth']
export function useStartAiOAuth(); useFinishAiOAuth(); useDisconnectAiOAuth(); useTestAiOAuth();
// setters: mutationFn args gain `auth_method?: AiAuthMethod`
```

- [ ] **Step 1: Write failing tests.**
  - The gateway calls `supabase.functions.invoke('ai-provider-auth', { body: { action: 'start', oauth_provider: 'anthropic' } })`.
    Mock `@/integrations/supabase/client` the way neighbouring hook tests do.
  - The gateway throws the server `error` message when `invoke` returns `error`.
  - `useSetDefaultModel` with `auth_method:'oauth'` upserts `value: { provider_code, model_id, auth_method: 'oauth' }`.
  - `useSetDefaultModel` without `auth_method` upserts exactly `{ provider_code, model_id }`. Assert with `toEqual` so there is no extra key.

- [ ] **Step 2: Run and confirm failure.**
  `npx vitest run src/hooks/ai-config/useAiProviderAuth.test.tsx src/hooks/useAIConfiguration.authMethod.test.tsx`.

- [ ] **Step 3: Implement.** One private helper builds the value for all three setters:
  `settingValue(provider_code, model_id, auth_method) => auth_method === 'oauth' ? { provider_code, model_id, auth_method } : { provider_code, model_id }`.
  Mutations in `useAiProviderAuth.ts` invalidate `['ai-provider-auth']`. `useDisconnectAiOAuth`
  also invalidates `['ai-config']`.

- [ ] **Step 4: Run and confirm pass.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin-ai): gateway and hooks for AI subscription auth" -- src/features/ai-providers/infrastructure/aiProviderAuthGateway.ts src/hooks/ai-config/useAiProviderAuth.ts src/hooks/ai-config/types.ts src/hooks/useAIConfiguration.ts src/hooks/ai-config/useAiProviderAuth.test.tsx src/hooks/useAIConfiguration.authMethod.test.tsx
```

---

### Task 8: Grouped provider dropdown in `TierSelector`

**Files:**
- Modify: `src/components/admin/DefaultModelSelector.tsx` (`TierSelector` at ~276-345; the `onSelect` prop types; the three `TierSelector` usages at ~168-209)
- Modify: `src/components/admin/settings/ai/AiCategoryCards.tsx:113-135` and `src/components/admin/AdminAiAgentSection.tsx` (forward `authMethod` to the setters)
- Test: `src/components/admin/DefaultModelSelector.authGroups.test.tsx`

**Interfaces:**
- **Consumes:** `useAiProviderAuthCapabilities`, the `AiAuthMethod` type (Task 7).
- **Produces:**
  - `onSelect: (providerCode: string, modelId: string, authMethod?: AiAuthMethod) => void`.
  - `currentModel` may carry `auth_method`.
  - The exported constant `OAUTH_CATEGORIES = ['chat', 'agent_triage'] as const` in `DefaultModelSelector.tsx`.

- [ ] **Step 1: Write failing tests.** Render `DefaultModelSelector` with a mocked
  `useAiProviderAuthCapabilities` and the existing provider/model fixtures. Copy the setup from an
  existing `DefaultModelSelector` test if one exists (`ls src/components/admin/*.test.tsx`).
  - `flag off shows only the API key group` (no "Auth (subscription)" label).
  - `flag on and category chat shows connected subscription under Auth group`:
    - Items are `"Anthropic (Claude) — subscription"` for connected `claude`.
    - There is no item for `not_connected` `openai`.
  - `category image never shows Auth group even when enabled`.
  - `reauth_required provider renders a disabled item`.
  - `picking an Auth item then a model calls onSelect with oauth`:
    `onSelect('claude', 'claude-sonnet-4-5', 'oauth')`, with the models taken from `capabilities.models`.
  - `picking an API key item calls onSelect without oauth`: the third argument is `undefined` or `'api_key'`.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement.**
  - Selection value state becomes a string `api:<providerId>` or `oauth:<provider_code>`.
  - Derive `selectedProviderId` (the API branch) and `selectedOAuth` (the OAuth branch) from it.
  - The initial value: `currentModel?.auth_method === 'oauth'` → `oauth:${currentModel.provider_code}`; else `api:${initialProvider}`.
  - Render:

    ```tsx
    <SelectContent>
      <SelectGroup>
        <SelectLabel className="text-[10px]">API key</SelectLabel>
        {providers.map(p => <SelectItem key={p.id} value={`api:${p.id}`}>…existing content…</SelectItem>)}
      </SelectGroup>
      {showAuthGroup && (
        <SelectGroup>
          <SelectLabel className="text-[10px]">Auth (subscription)</SelectLabel>
          {oauthProviders.map(o => (
            <SelectItem key={o.oauth_provider} value={`oauth:${o.provider_code}`} disabled={o.status !== 'connected'}>
              <div className="flex items-center gap-1.5">
                <span className="text-xs">{o.name} — subscription</span>
                <Badge variant="outline" className="text-[9px] py-0">{o.status === 'connected' ? 'oauth' : 'reconnect'}</Badge>
              </div>
            </SelectItem>
          ))}
        </SelectGroup>
      )}
    </SelectContent>
    ```

  - `showAuthGroup = caps?.enabled && OAUTH_CATEGORIES.includes(category) && oauthProviders.length > 0`.
  - `oauthProviders` = providers whose status is `connected` or `reauth_required`; `not_connected` providers are hidden.
  - **Model picker in the OAuth branch:** reuse the existing model `<Select>` markup and feed it
    `selectedOAuthCap.models.map(id => ({ id, label: id }))`. On change, call
    `onSelect(provider_code, id, 'oauth')`. The OpenRouter combobox branch stays API-only.
  - Callers in `AiCategoryCards.tsx` / `AdminAiAgentSection.tsx` pass `authMethod` into
    `setDefault/setFallback/setFallback2.mutate({ …, auth_method: authMethod })`.
  - `AdminAiAgentSection` `AGENT_PROVIDER_CODES` += `'moonshot'` (keep the sync comment).

- [ ] **Step 4: Run and confirm pass.** Also run `npx tsc -b --noEmit`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin-ai): API key and Auth groups in every provider dropdown" -- src/components/admin/DefaultModelSelector.tsx src/components/admin/settings/ai/AiCategoryCards.tsx src/components/admin/AdminAiAgentSection.tsx src/components/admin/DefaultModelSelector.authGroups.test.tsx
```

---

### Task 9: Subscription login section in `AiProvidersCard`

**Files:**
- Create: `src/components/admin/settings/ai/SubscriptionLoginSection.tsx`
- Modify: `src/components/admin/settings/ai/AiProvidersCard.tsx` (render the section inside the dialog **after** the API-key branch at ~245-273, only for `provider_code` `claude` or `openai`)
- Modify: `src/components/admin/settings/settingsCatalog.ts:148` (append keywords `kimi`, `moonshot`, `subscription`, `oauth`)
- Test: `src/components/admin/settings/ai/SubscriptionLoginSection.test.tsx`

**Interfaces:**
- **Consumes:** the Task 7 hooks.
- **Produces:** `export function SubscriptionLoginSection({ providerCode }: { providerCode: 'claude' | 'openai' })`.

- [ ] **Step 1: Write failing tests.**
  - `renders nothing when capabilities disabled`.
  - `not connected shows Open login; clicking calls start and window.open with authorize_url`.
    Spy on `window.open`.
  - `finish sends the pasted address and shows connected label`.
  - `connected shows account label, test model select and Disconnect; disconnect asks confirmation then calls disconnect`.
  - `claude shows the Claude Code identity note; openai does not`.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement.**
  - Use shadcn `Button`, `Textarea`, `Select`, `Badge`, `Alert` and `AlertDialog`, following the
    existing imports in `AiProvidersCard.tsx`.
  - The copy is in English, matching the card.
  - The helper text reads exactly: "After approving, your browser opens a localhost page that does
    not load. Copy the full address from the address bar and paste it here."
  - The Claude note reads exactly: "Calls through a Claude subscription are sent with Claude
    Code's identity prompt prepended."
  - On success, show toasts with `sonner` the same way the card does. On error, toast the server
    error message and never a token.

- [ ] **Step 4: Run and confirm pass.** Also run `npx tsc -b --noEmit` and `npx eslint <changed files>`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin-ai): connect Claude and ChatGPT subscriptions from the provider card" -- src/components/admin/settings/ai/SubscriptionLoginSection.tsx src/components/admin/settings/ai/AiProvidersCard.tsx src/components/admin/settings/settingsCatalog.ts src/components/admin/settings/ai/SubscriptionLoginSection.test.tsx
```

---

### Task 10: Full gates

- [ ] **Step 1:** `npx tsc -b --noEmit`. Expected: 0 errors.
- [ ] **Step 2:** `npx eslint` on every changed `src/` file. Expected: 0 errors.
- [ ] **Step 3:** `npx vitest run`. Expected: all pass. Report any pre-existing failure, with its
  name, as pre-existing; do not fix unrelated tests.
- [ ] **Step 4:**
  ```bash
  deno test --allow-env supabase/functions/_shared/aiOAuth/ supabase/functions/_shared/ai-fallback-chain.test.ts supabase/functions/ai-provider-auth/ supabase/functions/ai-agent-reply/
  ```
  Expected: all pass, with the live test skipped.
- [ ] **Step 5:** `bash scripts/db-harness.sh`, if a local DB is available. Otherwise state that it
  was not run.
- [ ] **Step 6:** `git status --short`. Only the files in the file map may be modified, plus
  `graphify-out/`, which is never committed.

## Out of scope (do not implement)

- Migrating API-key calls to pi-ai.
- OAuth for tool-calling requests or for the `agent` category.
- User BYOK and `UserAiModelOverrides`.
- GitHub Copilot.
- Turning the flag on.
- Deploying.
