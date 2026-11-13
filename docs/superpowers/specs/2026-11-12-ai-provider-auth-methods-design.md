# Admin AI Provider Auth Methods (API key | Subscription OAuth) and Kimi

- **Date:** 2026-11-12
- **Owner request:** in `/admin/settings?tab=ai`, every provider dropdown gets a section with two
  options, API key and Auth. Add the missing providers. Use the same pi package for every auth
  pathway. Providers named: OpenAI, Anthropic, Grok, MiniMax, Kimi, OpenRouter, xAI.
- **Required reading for implementers:** `ARCHITECTURE.md` §3–4 (feature structure, dependency
  direction), §11 (Supabase frontend rules), §12–16 (edge function shape, auth, Zod validation,
  sanitized errors), §17 (logging), §23 (migrations), §24 (service role), §26 (external HTTP),
  §33 (testing), §37 (OAuth/token security), §39 (admin authorization), §40 (shared code).

## 1. Conflict with an earlier owner decision (must be read first)

`docs/superpowers/specs/2026-09-05-ai-provider-account-auth-routing-design.md` §1 and §4 put
"any admin subscription used as a platform backend" **permanently out of scope**. The stated
reasons were that Anthropic's terms forbid intermediating subscription usage, and that OpenAI's
terms do not cover a hosted SaaS driving a ChatGPT session server-side.

This request reverses that decision. This design therefore:

- builds the subscription OAuth pathway completely, behind the flag `feature_ai_provider_oauth`
  (a `system_settings` row; absent or `false` means off). The flag defaults to **off**.
- does **not** turn the flag on in production. Enabling it is an owner decision that accepts the
  account and terms-of-service risk: the platform would use one admin's Claude Pro/Max or ChatGPT
  seat to serve every Postora user's traffic, through pi's public CLI client IDs.

The API-key pathway, the provider additions and the Kimi provider ship enabled.

## 2. Facts this design rests on (verified 2026-11-12)

### 2.1 `@mariozechner/pi-ai@0.73.1`

- It loads under Deno 2.9 through `npm:@mariozechner/pi-ai@0.73.1`. `getProviders()`,
  `getModels()` and the `./oauth` subpath all resolve.
- `getOAuthProviders()` returns exactly `anthropic`, `github-copilot` and `openai-codex`. No other
  provider named by the owner has a subscription login: xAI/Grok, MiniMax, Kimi and OpenRouter are
  API key only.
  - Changed later: OpenRouter gained a sign-in through our own `pkce_callback` flow (no pi-ai
    login), and the admin UI groups it with the other subscriptions. xAI/Grok, MiniMax and Kimi stay
    API key only.
- The OAuth `login*` functions are whole CLI flows. They bind a Node `http.createServer` callback
  on localhost and await the user in the same process, so an edge function cannot run them across
  two HTTP requests. The authorize and token-exchange helpers are not exported. Only the
  `refresh*Token` functions, `getOAuthApiKey` and the providers' `getApiKey` are exported.
- Refresh tokens **rotate** for both providers: every refresh returns a new `refresh_token`.
- For an Anthropic OAuth token (`sk-ant-oat…`), `complete()` sends Bearer auth with
  `anthropic-beta: claude-code-20250219,oauth-2025-04-20` and **prepends the system block
  "You are Claude Code, Anthropic's official CLI for Claude."** before our system prompt.
- `openai-codex` calls `https://chatgpt.com/backend-api` (Responses API), sets the
  `chatgpt-account-id` header from the token's JWT claim and sends `originator: pi`.
- pi-ai model ids: `moonshotai` has `kimi-k2-0905-preview`, `kimi-k2-turbo-preview`,
  `kimi-k2-thinking`, `kimi-k2.5` and `kimi-k2.6` at `https://api.moonshot.ai/v1`. `openai-codex`
  has `gpt-5.1-codex-mini`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.4` and more.

### 2.2 The repository

- **Dropdowns.** `TierSelector` (`src/components/admin/DefaultModelSelector.tsx:276`) renders the
  provider `<Select>` (lines 326-340) for default / fallback / fallback 2 of each category.
  `AiCategoryCards.tsx` and `AdminAiAgentSection.tsx` use it.
- **Saved value.** `system_settings` keys `default_ai_model_<cat>[_fallback|_fallback_2]` hold
  `{ provider_code, model_id }` (`src/hooks/useAIConfiguration.ts:103-146`).
- **Readers of that value:**
  - `fetchCategoryAiSettings` and `resolveChatModelConfig` in `supabase/functions/_shared/ai-fallback.ts`.
  - `loadGlobalModelChain` in `supabase/functions/ai-agent-reply/index.ts`.
  - `useAIConfiguration` on the frontend.
- **Chain caller.** `callAiChain` (`_shared/ai-fallback.ts:390`) takes `AiTier[]` and dispatches to
  `callAnthropic` or an OpenAI-compatible `fetch`. The result is always an OpenAI-shaped `Response`.
- **`auth_type`.** `ai_providers.auth_type` exists. The only reader is `isOAuthProvider` in
  `src/components/admin/settings/ai/AiProvidersCard.tsx:26-28`, which routes a provider to the
  Higgsfield branch and hides the key input. **This design does not set `auth_type='oauth'` on
  `claude` or `openai`.**
- **Platform keys.** Saved in `provider_api_keys` (plaintext, admin RLS) through
  `ai-config` `set-service-key`.
- **Existing OAuth precedent.** `oauth_states` (deny-all RLS) and the `higgsfield-oauth` edge
  function. Higgsfield's refresh does **not** lock, so it is not copied for rotation-sensitive tokens.
- **Vault precedent.** `supabase/migrations/20260906120000_byok_provider_keys_and_routing.sql`
  stores user BYOK secrets through `vault.create_secret` behind SECURITY DEFINER RPCs.
- **Providers present.** `ai_providers` already has `claude`, `openai`, `xai` (Grok), `minimax`
  and `openrouter`. Kimi/Moonshot is missing. "Grok" and "xAI" are the same `xai` row, so no
  second row is created.

## 3. Goals

1. Each `TierSelector` provider dropdown shows two groups: **API key** and **Auth (subscription)**.
   An Auth entry is listed only for a provider that has an OAuth provider in pi-ai and a connected
   admin account. When the flag is off, the Auth group is hidden.
2. The admin connects or disconnects the Claude Pro/Max subscription (`anthropic`) and the ChatGPT
   subscription (`openai-codex`) from `AiProvidersCard`.
3. A tier saved with `auth_method: 'oauth'` is served through pi-ai with the stored OAuth
   credential, and is refreshed server-side with single-flight locking.
4. Kimi is added as provider `moonshot` with seeded models. It works through the existing
   OpenAI-compatible path and in the agent picker.
5. pi-ai is the single library for: OAuth refresh, OAuth-credential calls, and the provider/model
   capability registry that decides which providers offer Auth.

## 4. Non-goals (PR 1)

- Migrating existing API-key calls from `callAiChain`'s own fetch to pi-ai. That is a later
  flagged slice; changing a working path for every category is a regression risk with no user gain
  today.
- OAuth tiers for requests that carry `tools`. A tool-calling request on an OAuth tier is skipped
  with reason `oauth_tools_unsupported` and falls over to the next tier. This makes the Auth group
  hidden for the `agent` category. It stays visible for `agent_triage`, which carries no tools.
- OAuth for image, video, TTS, STT, search, vision and embedding categories. The Auth group appears
  only for the text categories in `ModelCategory` (`src/hooks/ai-config/types.ts:39`), which are
  `chat` and `agent_triage`. Captions and hashtags resolve through `chat`.
- User BYOK (`user_ai_provider_keys`), `UserAiModelOverrides`, and GitHub Copilot OAuth.
- Turning `feature_ai_provider_oauth` on in production (see §1).

## 5. Data model

Migration `supabase/migrations/20261112120000_ai_provider_oauth.sql`.

### 5.1 `public.ai_provider_oauth_connections`

| column | type | notes |
|---|---|---|
| `oauth_provider` | text PK | CHECK `IN ('anthropic','openai-codex')`; pi-ai ids |
| `provider_code` | text NOT NULL | FK `ai_providers(provider_code)`; `claude` or `openai` |
| `credentials_secret_id` | uuid NULL | `vault.secrets.id`; JSON `{access, refresh, expires, accountId?}` |
| `status` | text NOT NULL DEFAULT `'connected'` | CHECK `IN ('connected','reauth_required')` |
| `account_label` | text NULL | non-secret display (email or account id prefix) |
| `expires_at` | timestamptz NULL | copy of `expires` for display |
| `refresh_lock_until` | timestamptz NULL | single-flight lease |
| `last_refresh_error` | text NULL | sanitized, never contains a token |
| `connected_by` | uuid NULL | FK `auth.users(id)` ON DELETE SET NULL |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

RLS is enabled, with a deny-all policy for `anon` and `authenticated`. There are no grants to
`authenticated`. Only the service role reads the table, through the edge function.

### 5.2 SECURITY DEFINER RPCs

All use `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, and
`GRANT EXECUTE … TO service_role`.

- `save_ai_oauth_credentials(p_oauth_provider text, p_provider_code text, p_credentials jsonb, p_account_label text, p_expires_at timestamptz, p_user uuid) RETURNS void`
  - Creates or updates the Vault secret: `vault.update_secret` when one exists, otherwise
    `vault.create_secret`.
  - Upserts the row with `status='connected'`, `refresh_lock_until=NULL`, `last_refresh_error=NULL`.
- `get_ai_oauth_credentials(p_oauth_provider text) RETURNS jsonb`
  - Reads `vault.decrypted_secrets` for the row's secret, then returns `credentials || jsonb_build_object('status', status)`.
  - Returns NULL when there is no row or no secret.
- `begin_ai_oauth_refresh(p_oauth_provider text, p_lease_seconds int) RETURNS boolean`
  - Runs `UPDATE … SET refresh_lock_until = now() + make_interval(secs => p_lease_seconds) WHERE oauth_provider = p_oauth_provider AND (refresh_lock_until IS NULL OR refresh_lock_until < now()) RETURNING true`.
  - Returns `false` when no row was updated.
- `fail_ai_oauth_refresh(p_oauth_provider text, p_error text, p_reauth boolean) RETURNS void`
  - Clears the lock and sets `last_refresh_error`.
  - Sets `status='reauth_required'` when `p_reauth` is true.
- `delete_ai_oauth_connection(p_oauth_provider text) RETURNS void`
  - Deletes the Vault secret, then the row.

`save_ai_oauth_credentials` also serves as the refresh "complete" step, because it clears the lock.

### 5.3 Seeds and flag (same migration)

- **Kimi provider.** `INSERT INTO ai_providers (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active, auth_type) VALUES ('moonshot','Kimi (Moonshot)','https://api.moonshot.ai/v1','MOONSHOT_API_KEY','openai',true,false,'api_key') ON CONFLICT DO NOTHING;`
- **Kimi models.** `ai_models` rows for `moonshot`, `capabilities ARRAY['chat']`, `is_active true`,
  in the shape of `20260323201022_bfe033a1-…sql`:
  - `kimi-k2.6` / "Kimi K2.6", 256000
  - `kimi-k2.5` / "Kimi K2.5", 256000
  - `kimi-k2-turbo-preview` / "Kimi K2 Turbo", 256000
  - `kimi-k2-thinking` / "Kimi K2 Thinking", 256000

  Costs NULL unless the column is NOT NULL; in that case use 0 and leave a SQL comment saying it
  must be filled in.
- **Flag.** `INSERT INTO system_settings (key, value) VALUES ('feature_ai_provider_oauth', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;`
- **Last line.** `NOTIFY pgrst, 'reload schema';`
- **Types.** Regenerate `src/integrations/supabase/types.ts` (§23). The table is not exposed to the
  browser, so only the RPC signatures matter.

### 5.4 Saved tier value

`system_settings.value` becomes `{ provider_code, model_id, auth_method? }`. `auth_method` is
`'api_key' | 'oauth'`, and an absent value means `'api_key'`. Every reader in §2.2 must parse it.
Old rows keep working unchanged.

## 6. Backend

### 6.1 `supabase/functions/_shared/aiOAuth/` (new, one file per concern)

- **`clients.ts`**
  - Per-provider login constants, copied verbatim from pi-ai 0.73.1 `dist/utils/oauth/*.js`.
    They are not exported, so the copy is the one documented exception to "use pi-ai for
    everything". Keep a comment naming the source file and version.
  - `anthropic`:
    - client id: base64-decode `OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`
    - authorize URL: `https://claude.ai/oauth/authorize`
    - token URL: `https://platform.claude.com/v1/oauth/token`
    - redirect: `http://localhost:53692/callback`
    - scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
    - extra params: `code=true`, `state = verifier`
    - token body: JSON `{grant_type:'authorization_code', client_id, code, state, redirect_uri, code_verifier}`
  - `openai-codex`:
    - client id: `app_EMoamEEZ73f0CkXaXp7hrann`
    - authorize URL: `https://auth.openai.com/oauth/authorize`
    - token URL: `https://auth.openai.com/oauth/token`
    - redirect: `http://localhost:1455/auth/callback`
    - scope: `openid profile email offline_access`
    - extra params: `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=pi`
    - state: 16 random bytes as hex
    - token body: form-encoded `{grant_type, client_id, code, code_verifier, redirect_uri}`
    - account id: `decodeJwt(access)["https://api.openai.com/auth"].chatgpt_account_id`
- **`pkce.ts`**: S256 PKCE over Web Crypto. It mirrors pi-ai's `generatePKCE`, which is not exported.
- **`loginFlow.ts`**
  - `startLogin(admin, oauthProvider, userId)` inserts into `oauth_states` with
    `provider_code = oauthProvider`, `scope_kind='platform'`, the redirect above, and a 10 minute
    expiry. It returns `{ authorizeUrl }`.
  - `finishLogin(admin, oauthProvider, pastedInput, userId)`:
    - Parses the pasted input exactly like pi-ai's `parseAuthorizationInput`: a full URL, `code#state`, `code=…&state=…`, or a bare code.
    - Consumes the matching `oauth_states` row, which is single use and checked for expiry.
    - Exchanges the code, then calls `save_ai_oauth_credentials`.
    - `expires` = `now + expires_in*1000 - 5 min`, which matches pi-ai.
- **`credentials.ts`**: `getFreshOAuthCredential(admin, oauthProvider)` returns
  `{ apiKey, credentials }`, or throws `AiOAuthError` with code `not_connected`, `reauth_required`
  or `refresh_failed`.
  1. Read the row through `get_ai_oauth_credentials`. Missing → `not_connected`. `status='reauth_required'` → that code.
  2. If `expires - 60s > now`, return `provider.getApiKey(creds)` through pi-ai's
     `getOAuthProvider(id).getApiKey`.
  3. Otherwise call `begin_ai_oauth_refresh(id, 30)`.
     - Won the lease: call pi-ai `refreshAnthropicToken(creds.refresh)` or `refreshOpenAICodexToken(creds.refresh)`.
       On success, `save_ai_oauth_credentials`. On an `invalid_grant`-like failure (HTTP 400/401 from the token URL),
       `fail_ai_oauth_refresh(…, reauth=true)`; on any other failure, `fail_ai_oauth_refresh(…, reauth=false)`.
     - Lost the lease: wait 750 ms, re-read, and retry up to 4 times, then throw `refresh_failed`.
  4. Never log a token. Errors pass through the existing `redactProviderError`.
- **`piCall.ts`**: `callPiOAuth(oauthProvider, modelId, openAiBody, apiKey, timeoutMs): Promise<Response>`.
  - Converts the OpenAI-shaped body (`messages` system/user/assistant, `temperature`, `max_tokens`)
    into a pi-ai `Context`.
  - Gets the model with `getModel(oauthProvider, modelId)`. An unknown model returns a 424 Response.
  - Calls pi-ai `complete(model, context, { apiKey, signal })`.
  - Returns an OpenAI-shaped `Response`: `{choices:[{message:{role:'assistant',content}}], usage}`.
    This mirrors how `callAnthropic` keeps the shape at every call site.
  - A request body containing `tools` returns `new Response(null, {status: 422})` without calling pi.

### 6.2 `callAiChain` / `AiTier`

- Add an optional `authMethod?: 'api_key' | 'oauth'` to the platform branch of `AiTier`.
- In the loop, a platform tier with `authMethod === 'oauth'` takes the OAuth path:
  1. Map `provider` to `oauthProvider` with `claude → anthropic` and `openai → openai-codex`. An
     unknown provider records the attempt error `oauth_unsupported_provider` and continues.
  2. If `feature_ai_provider_oauth` is not `true`, record `oauth_disabled` and continue.
  3. `getFreshOAuthCredential`, then `callPiOAuth`. An `AiOAuthError` records its code and continues.
  4. A 422 from tools records `oauth_tools_unsupported`.
- Tier results gain `authMethod` so logs show which pathway answered.
- The API-key path is unchanged.
- `fetchCategoryAiSettings`, `resolveChatModelConfig` and `loadGlobalModelChain` pass `auth_method`
  through to `authMethod`.
- `callChatCompletion`, the single-tier triage path, gets the same OAuth branch.

### 6.3 Edge function `ai-provider-auth` (new; admin only)

- **Shape (§12–16).** `index.ts` is a thin adapter: restricted CORS, `authenticateCaller`, and an
  admin check through `has_role(uid,'admin')` as `higgsfield-oauth` does. It parses a Zod
  discriminated union on `action` and calls `handler.ts` with injected deps.
- **Actions:**
  - `capabilities` →
    `{ enabled: boolean, providers: [{ provider_code, oauth_provider, name, status: 'not_connected'|'connected'|'reauth_required', account_label, expires_at, models: string[] }] }`.
    - `providers` is derived from pi-ai `getOAuthProviders()` intersected with the map
      `{anthropic:'claude','openai-codex':'openai'}`.
    - `models` is the pi-ai `getModels(oauthProvider).map(m => m.id)`.
    - Added 2026-11-13: each provider also carries `has_api_key: boolean | null`, whether the
      provider has an API key of its own. `null` means the key status could not be read.
    - It never returns a token.
  - `start` `{ oauth_provider }` → `{ authorize_url }`.
  - `finish` `{ oauth_provider, pasted: string (1..4096) }` → `{ status: 'connected', account_label }`.
  - `disconnect` `{ oauth_provider }` → `{ status: 'not_connected' }`.
  - `test` `{ oauth_provider, model_id }` → `{ ok, latency_ms, error? }`. It runs one tiny
    `callPiOAuth` ("Reply with OK").
- `start`, `finish` and `test` refuse with 409 `oauth_disabled` when the flag is off.
  `capabilities` and `disconnect` work regardless.
- Every refusal writes a sanitized `system_logs` row.
- Errors are sanitized; raw provider bodies are never returned.
- Add a `config.toml` entry only if siblings that authenticate in-handler have one.

## 7. Frontend

### 7.1 Infrastructure / hooks

- `src/features/ai-providers/infrastructure/aiProviderAuthGateway.ts` wraps
  `supabase.functions.invoke('ai-provider-auth', …)` for the five actions (§11: no raw invoke in
  components).
- `src/hooks/ai-config/useAiProviderAuth.ts` provides:
  - `useAiProviderAuthCapabilities()` (`useQuery`, key `['ai-provider-auth']`)
  - `useStartAiOAuth`, `useFinishAiOAuth`, `useDisconnectAiOAuth`, `useTestAiOAuth`. Each mutation
    invalidates `['ai-provider-auth']`.
- `useSetDefaultModel`, `useSetFallbackModel` and `useSetFallback2Model` accept an optional
  `auth_method` and write it into `value`. When it is `'api_key'` or undefined they omit it, which
  keeps old rows identical.
- `AIModelSelection` gains `auth_method?: 'api_key' | 'oauth'` in `src/hooks/ai-config/types.ts`.

### 7.2 `TierSelector` dropdown (the requested UI)

- The provider `<Select>` becomes grouped with `SelectGroup` / `SelectLabel`:
  - **"API key"**: the current `providers` list, minus any provider whose subscription is
    `connected` or `reauth_required` and whose `has_api_key` is `false` (changed 2026-11-13: such a
    provider has no key to call with, so it is listed only under "Auth"). A provider with
    `has_api_key: null` stays in this group. Item value: `api:<provider.id>`.
  - **"Auth (subscription)"**: rendered only when `capabilities.enabled` and the category is in the
    OAuth text set (§4). One item per capability provider whose `status === 'connected'`.
    - Item value: `oauth:<provider_code>`.
    - Label: `<name> — subscription`.
    - Badge: `oauth`.
  - Connected-but-`reauth_required` providers render disabled, with a "Reconnect" hint.
- When an `oauth:` item is selected, the model picker lists `capabilities.models` for that
  provider, not `ai_models`. `onSelect` is called as `(provider_code, model_id, 'oauth')`.
- The initial selection reads `currentModel.auth_method` to pick `api:` or `oauth:`.
- The `onSelect` signature in `DefaultModelSelector` and its callers in `AiCategoryCards.tsx` and
  `AdminAiAgentSection.tsx` becomes `(providerCode, modelId, authMethod?: 'api_key' | 'oauth')`.

### 7.3 `AiProvidersCard` connect UI

- In the dialog for `claude` and `openai`, add a **"Subscription login (Auth)"** section **below**
  the existing API key section. Keep the API key UI exactly as it is. Show the section only when
  `capabilities.enabled`.
- **Provider tile (changed 2026-11-13):** a provider with a subscription but no API key shows an
  `auth` badge instead of the missing-key mark. Its tile Test button opens the dialog instead of
  running the API key test, which has no key to use; the dialog's subscription test is the test.
  Saving an API key reloads the capabilities, so the provider returns to the "API key" group.
- **Status line:** Not connected / Connected as `<account_label>`, expires `<expires_at>` /
  Reconnect required.
- **Connect flow:**
  1. "Open login" calls `start` and opens `authorize_url` in a new tab.
  2. A textarea reads: "After approving, your browser lands on a localhost page that will not load.
     Copy the full address from the address bar and paste it here."
  3. "Finish" calls `finish`.
- **Test:** a model `<Select>` filled from the provider's catalogue rows (`ai_models`), the same list the
  provider dialog shows next to it, plus a button that runs `test`. Changed on 2026-11-13: the owner
  asked for one model list in the admin UI. The picker offers only the catalogue rows that
  `capabilities.models` also names, in catalogue order, because `test` refuses a model the
  subscription's registry does not know (424). When no catalogue row qualifies, the picker offers
  `capabilities.models`. A picked model that drops out of the list falls back to the first one.
  The tier picker above keeps `capabilities.models`.
- **Disconnect** calls `disconnect`, with a confirm dialog.
- For Anthropic, a warning note reads: "Calls through a Claude subscription are sent with Claude
  Code's identity prompt prepended."
- Do not change `isOAuthProvider`.

### 7.4 Kimi in the agent picker

- Add `'moonshot'` to `AGENT_PROVIDER_CODES` (`src/components/admin/AdminAiAgentSection.tsx:29`)
  and to `KNOWN_MODEL_PROVIDERS` (`supabase/functions/ai-agent-reply/logic.ts:147`). The comment
  there says the two must stay in sync.
- Add `moonshot` to `providerTestKind`'s fallthrough only if needed. `api_type='openai'` already
  routes to `testOpenAI`.
- Add the search keywords `kimi moonshot subscription oauth` to `settingsCatalog.ts:148`.

## 8. Security

- Tokens live only in Vault. They are decrypted only inside SECURITY DEFINER RPCs callable by
  `service_role`, never sent to the browser, and never logged.
- Admin-only edge function. Non-admin callers get 403 and a `system_logs` refusal row.
- `oauth_states` rows are single use, expire after 10 minutes, and the pasted `state` must match.
- Single-flight refresh through the lease. The lease is cleared on success or failure, and an
  expired lease is reclaimable.
- `finish` validates that the pasted input parses to a code. The state must match a live row for
  the same `oauth_provider` and `scope_kind='platform'`.

## 9. Tests

- **Deno**
  - `aiOAuth/loginFlow.test.ts`: authorize URL params per provider; parsing all four pasted
    formats; expired or mismatched state is refused; code exchange posts the right body. Mock
    `fetch` at the boundary.
  - `aiOAuth/credentials.test.ts`: fresh credentials return without refresh; expired credentials
    with a lease won refresh and save rotated tokens; with the lease lost, the function waits,
    re-reads and returns the other worker's token; `invalid_grant` leads to `reauth_required`.
  - `aiOAuth/piCall.test.ts`: OpenAI body → pi Context mapping; response → OpenAI shape; `tools`
    → 422 without a network call. pi `complete` is injected as a dep.
  - `ai-fallback-chain.test.ts`: an OAuth tier with the flag off records `oauth_disabled` and falls
    to tier 2; an OAuth tier with tools records `oauth_tools_unsupported`; API-key tiers behave
    exactly as before.
  - `ai-provider-auth/handler.test.ts`: non-admin → 403; flag off → `start` 409; `capabilities`
    never contains token fields.
- **SQL proof** `supabase/tests/ai_provider_oauth.sql`, registered in `scripts/db-harness.sh`:
  - `authenticated` cannot select the table or execute any of the RPCs.
  - save → get round trip.
  - `begin_ai_oauth_refresh` is won once; a second call returns false until the lease expires.
  - delete removes the Vault secret.
  - the Kimi provider row exists.
- **Vitest**
  - `TierSelector` shows the Auth group only when the flag is enabled and the category is a text
    category.
  - selecting an `oauth:` item writes `auth_method:'oauth'`.
  - an API-key selection writes no `auth_method` key.
  - the `AiProvidersCard` connect flow calls `start`, then `finish`.

## 10. Rollout

1. Apply the migration on prod before merge (runbook "Apply the migration before you merge"). The
   flag stays `false`.
2. Deploy edge functions `ai-provider-auth` and every function importing `_shared/ai-fallback.ts`
   or `ai-agent-reply` per `docs/runbooks/deploy-edge-function.md`.
3. Frontend deploys on merge. With the flag off, the visible change is Kimi in the lists only.
4. **Owner decision (§1):** to enable, set `system_settings.feature_ai_provider_oauth = true`, then
   connect from Admin → Settings → AI → Providers.

## 11. Acceptance criteria

- The flag is off. Every dropdown looks and saves exactly as before. Kimi appears, accepts a key
  through Save & Test, and answers a chat tier.
- The flag is on. The admin connects the Claude and ChatGPT subscriptions with the paste flow. The
  Auth group appears in text-category dropdowns, and a caption request on an OAuth tier is
  answered through pi-ai with `authMethod:'oauth'` in the tier log.
- Two concurrent requests with an expired token cause exactly one refresh, and both succeed.
- A revoked refresh token flips the status to `reauth_required`. The dropdown item is disabled, and
  the chain falls through to the next tier.
- No token appears in any response, log row or browser network payload.
