# User BYOK AI Provider Keys, Anthropic in the Agent Loop, and the Codex Waitlist

**Date:** 2026-09-06 (supersedes the 2026-09-05 draft)
**Status:** Proposed
**Owners:** Full-stack / Platform / Security
**Product:** POSTORA

## 1. Summary

POSTORA runs every AI workload on platform-managed API credentials, except Higgsfield, which
already supports a user-owned OAuth connection. This design adds three bounded things:

1. **User BYOK API keys.** A user can store their own OpenAI, Anthropic, Google Gemini, or
   OpenRouter API key, encrypted in Supabase Vault through the existing connector-credential
   functions, and choose how POSTORA routes AI calls: `postora_only` (default), `user_first`
   (own key first, platform fallback with explicit consent), or `user_only`.
2. **Anthropic as a first-class provider.** The `openai` and `claude` catalog rows are
   activated, the admin model selectors show them as separate provider groups, and the Anthropic
   Messages API is integrated into the caption/hashtag chain and the `ai-agent-reply` tool loop
   through a shared adapter that keeps the OpenAI request/response shape at every call site.
3. **Demand signal.** A "Connect ChatGPT / Codex subscription (beta waitlist)" card records
   interest. Nothing else about Codex ships.

Out of scope, permanently for this design: any admin subscription used as a platform backend,
any Claude Code or Codex runtime, any long-running service. The 2026-09-05 draft's runtime
architecture was reviewed and rejected: Anthropic's legal page forbids intermediating
subscription usage on users' behalf, OpenAI's pages do not cover a hosted SaaS driving a
user's ChatGPT session server-side, and a consumer seat cannot serve subscriber traffic.

## 2. Current state (verified against the repository on 2026-09-06)

- `ai_providers.provider_code` names Anthropic `claude` and Google `gemini`. Both `openai` and
  `claude` rows are seeded `is_active = false` (migration `20260323193759`). These codes are
  kept; only display names change.
- `_shared/ai-fallback.ts` → `getAiEndpoint(provider)` knows `openrouter` and otherwise
  returns the Google endpoint. Selecting `openai` or `claude` in an admin chain today sends
  the request to Google with the Google key.
- `resolveChatModelConfig` returns three tiers: admin primary → admin fallback → last resort;
  when an unexpired `user_ai_model_overrides` row exists it becomes the primary and the admin
  primary/fallback shift into the remaining two slots. `callAiWithFallback` takes seven
  positional arguments, reads platform keys from environment variables only, and clears its
  per-tier timeout before reading the response body. `generate-caption` calls it from three
  branches (brand intelligence, YouTube generation, ordinary captions); `generate-hashtags`
  from one. AI call logs are rows in `system_logs` with a `metadata` JSON column.
- `ai-agent-reply/index.ts` has its own `PROVIDER_ENDPOINTS` (`openai`, `openrouter`,
  `google`, `gemini`), `chatCompletion(provider, payload, timeoutMs)` which parses JSON and
  throws a plain `Error` that discards the HTTP status, a 25 s per-model timeout, a
  request-wide budget (`modelBudgetRemaining`, which reserves time for delivery and logging)
  re-checked before every model on every tool iteration, and an OpenAI-format tool loop that
  parses `toolCall.function.arguments` as a JSON string. `logic.ts` `parseModelRef` rewrites
  any unknown provider prefix to `openai`. `AdminAiAgentSection.tsx` offers
  `AGENT_PROVIDER_CODES = ["openai","openrouter","gemini"]`.
- `DefaultModelSelector` lists every active provider and model immediately; it is not
  behind any flag. Activating `openai` or `claude` before the adapters are deployed would
  let an admin select a chain entry that today routes to Google.
- Platform keys entered in the admin card (`set-service-key`) land in `provider_api_keys`;
  `ai-fallback.ts` and `ai-agent-reply` never read that table.
- Vault: `upsert_connector_credential_secret(p_secret_id, p_secret jsonb)` and
  `delete_connector_credential_secret(p_secret_id)` are generic and reusable.
  `get_connector_credential(p_user_id, p_tool_id)` joins `ai_agent_tools` and cannot read a
  BYOK key. `reclaim_ai_agent_tool_secret()` is the AFTER DELETE trigger pattern.
- Feature flags are `app_settings` rows read through `src/hooks/useFeatureFlags.tsx`, which
  needs five coordinated edits per flag: `FeatureFlags` interface, `FLAG_KEYS`, `FLAG_KEY_MAP`,
  `DEFAULT_FLAGS`/`baseFromDb`, and `ALL_FLAGS_ENABLED`. Admins receive every flag as `true`
  except those listed in `VISIBILITY_FLAG_KEYS`, which keep their stored value. The SELECT
  policy (`20260709090000`, latest recreation) admits any `feature\_%` key. Per-user overrides
  live in `user_feature_overrides`.
- `scripts/db-harness.sh` refuses to run when a `supabase/tests/*.sql` file is not listed in
  its `SUITES` array, and requires no-plan suites to end with an `ALL CHECKS PASSED` line.
- There is no shared rate-limit helper; `n8n-api/requestGuards.ts` validates UUIDs and IPs.
- `ai_model_preferences` (user, feature → model) exists and is written by `ai-config`
  `set-user-preference`, but nothing in the execution path reads it. It stays untouched here
  and retires in a later cleanup PR.
- `higgsfield_connections` is the reference pattern for a secret-bearing user table: table
  revoked from `anon`/`authenticated`, column-level SELECT grant on non-secret columns, and a
  `security_invoker` status view filtered by `auth.uid()`.
- Edge workers are killed at 60 s. Three tiers at the current 15 s per tier already use 45 s.

## 3. Goals

1. A user can save, test, and delete one API key per supported provider without the key ever
   reaching the browser after save.
2. A user can pick `postora_only`, `user_first`, or `user_only`, globally and per capability
   (`chat`, `agent`), and a preferred provider and model for the user tier.
3. A user-owned execution never runs on a platform key, and a platform fallback after a
   user-key failure happens only when the stored preference says `user_first`.
4. The `openai` and `claude` providers are usable as platform providers with keys from
   `provider_api_keys` or the environment.
5. Anthropic models work in caption, hashtag, and agent-reply flows with tool calls.
6. Every AI call log records whether the credential was `user` or `platform`.
7. The Codex waitlist records one row per user per provider.
8. Everything new is behind `feature_byok_providers`; with it off, routing is unchanged.

## 4. Non-goals

- Admin-scoped BYOK, any subscription or OAuth login for OpenAI or Anthropic.
- Changing quota or credit accounting. User-owned calls still pass the existing plan checks
  and per-plan rate limits in `generate-caption`; only cost attribution is recorded.
- Image, video, TTS, STT, search, and embedding routing. Those keep platform keys.
- Removing `user_ai_model_overrides` or `ai_model_preferences`.
- Migrating `higgsfield_connections` or `provider_api_keys` into Vault.

## 5. Data model

All DDL is additive and idempotent. Migrations land in production before any code that names
them. The migration runs as `supabase_admin`.

### 5.1 `user_ai_provider_keys`

```sql
CREATE TABLE public.user_ai_provider_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_code text NOT NULL REFERENCES public.ai_providers(provider_code)
    CHECK (provider_code IN ('openai', 'claude', 'gemini', 'openrouter')),
  credentials_secret_id uuid,            -- vault.secrets id; never client-readable
  key_hint text,                         -- last 4 characters, for display only
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalid')),
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_code)
);
```

Protection, copied from `higgsfield_connections`:

- `ENABLE ROW LEVEL SECURITY`; owner SELECT policy on `auth.uid() = user_id`.
- `REVOKE ALL ... FROM anon, authenticated`; then
  `GRANT SELECT (id, user_id, provider_code, key_hint, status, last_verified_at, updated_at)`
  to `authenticated`. No client INSERT, UPDATE, or DELETE. All writes go through the Edge
  Function under the service role.
- View `public.user_ai_provider_key_status` (`security_invoker = on`) exposing exactly those
  columns `WHERE user_id = auth.uid()`. `credentials_secret_id` and `last_error_code` never
  appear in the view.
- AFTER DELETE trigger `user_ai_provider_keys_reclaim_secret` cloned from
  `reclaim_ai_agent_tool_secret()`, so a cascade delete of the user reclaims the Vault row.

### 5.2 Vault functions

Reused unchanged: `upsert_connector_credential_secret(p_secret_id, '{"api_key": "..."}')`
and `delete_connector_credential_secret(p_secret_id)`. The Vault name label they write reads
`ai_agent_tool:credentials:<uuid>`; that label is for humans only and is accepted as-is
rather than adding a parameter, because a new parameter list on an existing function adds an
overload.

New, plpgsql (the harness baseline has no vault extension, so a `LANGUAGE sql` body fails at
create time):

```sql
CREATE FUNCTION public.get_user_ai_provider_key(
  p_user_id uuid, p_provider_code text, p_include_invalid boolean DEFAULT false)
RETURNS text  -- the api_key field, or NULL
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public ...
-- SELECT (decrypted.decrypted_secret::jsonb ->> 'api_key')
--   FROM public.user_ai_provider_keys k
--   JOIN vault.decrypted_secrets decrypted ON decrypted.id = k.credentials_secret_id
--  WHERE k.user_id = p_user_id AND k.provider_code = p_provider_code
--    AND (p_include_invalid OR k.status = 'active');
REVOKE EXECUTE ON FUNCTION public.get_user_ai_provider_key(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_ai_provider_key(uuid, text, boolean) TO service_role;
```

Execution paths call it with the default (`active` only); `test_key` passes `true` so an
`invalid` key can be re-tested and healed. The `anon`/`authenticated` revoke is explicit
because this stack grants EXECUTE on new functions to both by default privilege; the same
revoke applies to the reclaim trigger function.

### 5.3 `user_ai_routing_preferences`

```sql
CREATE TABLE public.user_ai_routing_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN ('*', 'chat', 'agent')),
  mode text NOT NULL CHECK (mode IN ('postora_only', 'user_first', 'user_only')),
  preferred_provider_code text
    CHECK (preferred_provider_code IN ('openai', 'claude', 'gemini', 'openrouter')),
  preferred_model_id text,
  allow_platform_fallback boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability),
  CHECK (
    (mode = 'user_first'   AND allow_platform_fallback = true) OR
    (mode <> 'user_first'  AND allow_platform_fallback = false)
  ),
  CHECK (mode = 'postora_only' OR (preferred_provider_code IS NOT NULL AND preferred_model_id IS NOT NULL))
);
```

RLS: owner policies for SELECT, INSERT, UPDATE, DELETE, each `auth.uid() = user_id` (WITH
CHECK on writes). The browser writes this table directly. `preferred_provider_code` is
deliberately not a foreign key to the keys table: the resolver treats a missing or `invalid`
key as "no user candidate".

### 5.4 `ai_provider_waitlist`

```sql
CREATE TABLE public.ai_provider_waitlist (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_code text NOT NULL CHECK (provider_code IN ('codex')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_code)
);
```

RLS: owner SELECT and INSERT only. Admin reads use the service role.

### 5.5 Catalog and flags

- Rename only: `UPDATE public.ai_providers SET name = 'OpenAI API' WHERE provider_code =
  'openai'` and `name = 'Anthropic API'` for `claude`. **The migration does not activate
  them.** `DefaultModelSelector` exposes active providers immediately and the deployed
  `getAiEndpoint` still routes them to Google, so activation is a separate step after the
  edge functions are deployed and verified: the admin toggles both providers on in the
  existing provider card (or `UPDATE ... SET is_active = true` at that point).
- Anthropic models. The request named Claude 3.5 Sonnet / Haiku; those ids are retired. Seed
  the current catalog idempotently on `(provider_id, model_id)`, ids and prices confirmed on
  2026-09-06 from platform.claude.com/docs/en/models/overview: `claude-sonnet-5` ($2 / $10
  per MTok), `claude-haiku-4-5-20251001` ($1 / $5), `claude-opus-5` ($5 / $25), capabilities
  `{chat, agent}`, context 1,000,000 (Haiku 200,000); set `is_active = false` on the
  `claude-3-*` and `claude-sonnet-4-20250514` rows. Model rows may be active because the
  selector only shows models of active providers.
- `app_settings`: insert `feature_byok_providers = 'false'::jsonb` with `ON CONFLICT DO
  NOTHING`. The current SELECT policy (`"Authenticated can read public settings"`, migration
  `20260424154448`) admits every key matching `feature\_%`, so no policy change is needed.
  `FLAG_KEYS` in `useFeatureFlags.tsx` gains the same key.

## 6. Routing semantics

For a request `(user, capability)` where capability is `chat` (caption, hashtags) or `agent`:

1. If `feature_byok_providers` is off for the user, skip to step 5.
2. Preference row for the capability, else the `*` row, else `postora_only`.
3. `user_only` / `user_first`: fetch the key with `get_user_ai_provider_key`. If it is NULL
   the user candidate does not exist: `user_only` fails closed with `AI_CONNECTION_REQUIRED`
   (HTTP 409, no provider call); `user_first` proceeds with the platform chain and logs
   `fallback_reason = user_key_missing`. A failed preference read, flag read, or RPC call
   **throws**; it is never interpreted as `postora_only` or as a missing key.
4. Build the tier list. `user_only`: `[user]`. `user_first`: `[user, ...platform]`. A user
   tier carries its key by construction (`credentialSource: 'user'` requires a non-empty
   `apiKey`); platform-key resolution is never consulted for a user tier, and a user key is
   never handed to a platform tier.
5. `postora_only` and the platform tail: the existing chain from `resolveChatModelConfig`
   for `chat` (override-as-primary behaviour unchanged) or `loadGlobalModelChain` for
   `agent`, unchanged.
6. Cap the list at three tiers. For `chat` that bounds the call at three × 15 s. For `agent`
   the cap is not the budget protection: the existing request-wide `modelBudgetRemaining`
   check runs before every model on every tool iteration and keeps the delivery/logging
   reserve; a user tier is one more chain entry under that same budget. Response bodies are
   read under the tier's deadline, not after it is cleared. A user tier that fails on a
   `user_first` preference moves to the platform tier only because the stored consent says
   so; the log row records `credential_source` of the tier that answered and the fallback
   reason.

Errors surfaced to callers: `AI_CONNECTION_REQUIRED`, `AI_USER_KEY_INVALID` (provider
returned 401/403 on the user key), and the existing all-tiers-failed path. Marking a key
`invalid` after a 401/403 is version-conditional: `UPDATE ... WHERE user_id = $1 AND
provider_code = $2 AND updated_at <= $fetched_at`, where `fetched_at` is the time the key was
read for this request, so a key rotated during the request is not invalidated by the old
key's rejection.

## 7. Backend contracts

### 7.1 `_shared/ai-fallback.ts`

- `getAiEndpoint(provider, apiKey)` gains `openai` and `claude` (Anthropic) branches and
  keeps `gemini`/`google` and `openrouter`. A new `resolvePlatformApiKey(admin, provider)`
  reads `provider_api_keys.api_key` for the provider code, else the provider's environment
  variable; it is called only for platform tiers, once per call, and is shared by
  `ai-fallback.ts` and `ai-agent-reply`.
- New `callAiChain(admin, requestBody, tiers: AiTier[])` where
  `AiTier = { provider, model, credentialSource: 'user', apiKey: string }
           | { provider, model, credentialSource: 'platform', apiKey?: string }`.
  A user tier with an empty key is rejected at runtime before any request. Each tier reads
  the response body within its own deadline. `callAiWithFallback` becomes a thin wrapper
  over it with the old signature so every existing caller compiles unchanged.
- `AiCallResult` gains `credentialSource` for the tier that answered, `fallbackReason?`, and
  per-tier `status`; `logAiCall` writes them into the existing `metadata` JSON on
  `system_logs`. No new column.
- Provider failures are typed: `class ProviderHttpError extends Error { status: number;
  provider: string; credentialSource }` so callers can distinguish 401/403 on a user tier
  from other failures. Its message never contains a key.

### 7.2 `_shared/anthropic-adapter.ts`

Pure functions, no I/O:

- `toAnthropicRequest(openAiBody)` → Messages API body: all system messages extracted and
  joined into `system`; `max_tokens` required (default 1024); `tools[].function` → Anthropic
  `tools` with `input_schema`; assistant `tool_calls` → `tool_use` content blocks with
  `input = JSON.parse(arguments)` (`{}` on parse failure); consecutive `role: "tool"`
  messages → a single `user` message of `tool_result` blocks, and any adjacent same-role
  messages are merged (the API rejects consecutive same-role turns); `tool_choice: "auto"`
  → `{type: "auto"}` only when tools are present; **`temperature` and `top_p` are dropped**
  (deprecated; models after Claude Opus 4.6 reject any value other than 1.0, which covers the
  whole seeded catalog); `response_format` is not used by any current caller and is rejected
  with a clear error if present.
- `fromAnthropicResponse(json)` → the frozen normalised shape:
  `{ id, choices: [{ index: 0, finish_reason, message: { role: "assistant", content: string,
  tool_calls?: [{ id, type: "function", function: { name, arguments: string } }] } }],
  usage: { prompt_tokens, completion_tokens, total_tokens } }`. `content` is the
  concatenation of text blocks (`""` when only tool_use blocks exist); `arguments` is
  `JSON.stringify(input)`; `tool_use.id` is preserved verbatim so the reply loop's
  `tool_call_id` round-trips; `finish_reason` maps `tool_use` → `tool_calls`, `end_turn` →
  `stop`, `max_tokens` → `length`.
- `callAnthropicJson(body, apiKey, timeoutMs)` posts to `https://api.anthropic.com/v1/messages`
  with `x-api-key`, `anthropic-version: 2023-06-01`, and returns `{ status, json }` where
  `json` is the normalised shape on 2xx and `{ error: { message } }` (key redacted) otherwise.
  `callAiChain` wraps that in a synthetic `Response` for the caption/hashtag callers;
  `chatCompletion` in the agent consumes `{ status, json }` directly and throws
  `ProviderHttpError` with the status.

### 7.3 `_shared/ai-user-routing.ts`

`resolveUserAiRoute(admin, userId, capability)` → `{ mode, userTier?: AiTier,
allowPlatformFallback, reason? }`, implementing §6 steps 1–3. Service-role reads filter on
`user_id` explicitly.

### 7.4 `ai-agent-reply`

- `PROVIDER_ENDPOINTS` gains `claude`; `chatCompletion(tier, payload, timeoutMs)` takes an
  `AiTier`: for `claude` it calls `callAnthropicJson`; for the others it posts with the
  tier's key, resolving platform keys through `resolvePlatformApiKey` (database row, then
  env). Non-2xx throws `ProviderHttpError` carrying the status instead of a plain `Error`.
  `KNOWN_MODEL_PROVIDERS` and `AGENT_PROVIDER_CODES` gain `claude`. Because `parseModelRef`
  maps unknown prefixes to `openai`, the Edge deploy must precede provider activation.
- `modelChain` is built from `resolveUserAiRoute(admin, request.user_id, 'agent')` plus the
  global chain per §6, under the existing request-wide budget. A `ProviderHttpError` with
  status 401/403 on a user tier triggers the version-conditional invalidation of §6.
  `usedModel` logging gains `credential_source`.

### 7.5 `user-ai-providers` Edge Function (new)

Actions, all under the caller's verified JWT, `user_id` always derived from the token:

Clients: the caller's JWT is verified with an anon-key client; every read and write below
uses the **service-role** client with an explicit `.eq('user_id', verifiedUserId)`. The
`security_invoker` view is for the browser only; under the service role `auth.uid()` is NULL
and the view returns nothing.

- `list` → `SELECT id, provider_code, key_hint, status, last_verified_at, updated_at FROM
  user_ai_provider_keys WHERE user_id = verifiedUserId` (explicit safe-column projection).
- `save_key { provider_code, api_key }` → validate the key with an **authenticated** call to
  a fixed per-provider endpoint (never a caller-supplied URL): OpenAI `GET /v1/models`,
  Anthropic `GET /v1/models`, Gemini `GET /v1beta/models?key=`, OpenRouter `GET /api/v1/key`
  (the credential-introspection endpoint, not the public catalog). Classification: 401/403 →
  `AI_USER_KEY_INVALID` (400), nothing stored; 429, 5xx, timeout, network error →
  `AI_PROVIDER_UNREACHABLE` (503), nothing changed, an existing key is preserved. On 2xx:
  read the existing row; call `upsert_connector_credential_secret(existingSecretId ?? null,
  {api_key})`; upsert the row (`key_hint`, `status = 'active'`, `last_verified_at`,
  `last_error_code = null`). Compensation: if the row write fails **and no secret existed
  before** (a new id was returned), delete the new secret; an existing secret is never
  deleted by compensation because the upsert updated it in place. Saves for one
  (user, provider) are serialised with `pg_advisory_xact_lock(hashtext(user_id || provider))`
  inside a small SECURITY DEFINER wrapper, or, if that is judged too heavy, by re-reading the
  row after the write and deleting the newly created secret when the row now points at a
  different id (the losing race). The migration owner picks one and the suite proves it.
- `test_key { provider_code }` → key via `get_user_ai_provider_key(user, provider, true)`;
  NULL → `AI_CONNECTION_REQUIRED` (404); same classification as above; 2xx heals the row to
  `active` and sets `last_verified_at`; 401/403 marks `invalid`; unreachable leaves the row.
- `delete_key { provider_code }` → read the row (404 if none), `delete_connector_credential_secret`
  when it has a secret id, then delete the row; both errors surfaced.
- `join_waitlist { provider_code: 'codex' }` → insert into `ai_provider_waitlist`, idempotent.
- `save_key` and `test_key` are rate-limited at 10 per user per 10 minutes with a documented
  best-effort per-isolate in-memory guard (there is no shared helper).

Responses never contain the key, the secret id, the Gemini URL, or raw provider bodies.

## 8. Frontend

- New `src/features/ai-providers/` following `ARCHITECTURE.md` §4: `application/ports.ts`
  declares the `AiProvidersGateway` interface; `infrastructure/supabaseAiProvidersGateway.ts`
  is the only file that imports the Supabase client (Edge Function invoke, table reads and
  writes); `ui/` holds the cards and hooks; the composition root `ui/AiProvidersPanel.tsx` is
  the only `ui/` file that imports `infrastructure/`. The feature ships its own
  `tests/architecture.test.ts` copied from the WhatsApp inbox one, because that test is
  scoped to its own feature and would not catch a violation here.
- Cards, rendered above `DatabaseConnectorsManager` in `/settings?tab=integrations`, gated on
  `feature_byok_providers` with a loading state while flags and role resolve:
  - **Your AI keys**: one row per provider (OpenAI, Anthropic, Google Gemini, OpenRouter)
    with masked hint, status, last verified, Save / Test / Remove.
  - **Routing**: mode radio (`Use POSTORA providers`, `Use my keys first, then POSTORA`,
    `Use only my keys`), preferred provider and model (models from the active catalog for
    that provider), and, for `user_first`, a required consent checkbox whose copy states that
    a failed call on the user's key will run on POSTORA quota. Per-capability override for
    Chat and Agent.
  - **Codex waitlist**: one button, idempotent, shows "You're on the list" after joining.
- Admin: `DefaultModelSelector` already groups by provider; with the rows active it shows
  `OpenAI API` and `Anthropic API` as separate groups. `AiCategoryCards` Agent card gets the
  `claude` provider. `AdminAiAgentSection` offers `claude`.

## 9. Security

1. Keys are written only through the Edge Function under the service role and read only
   through `get_user_ai_provider_key`, which is executable by `service_role` alone.
2. The browser sees `key_hint`, never the key or the secret id.
3. Validation calls go to fixed provider URLs; the user key is never logged. The adapter and
   `callAiChain` redact `Authorization` and `x-api-key` from any thrown error text.
4. A user key is used only for requests whose `user_id` equals the key owner. The resolver
   derives the user from the verified caller, and the RPC filters on both user and provider.
5. User-owned calls never touch platform environment keys; platform tiers never use a user key.

## 10. Feature flag and rollout

`feature_byok_providers` (global `app_settings`, per-user `user_feature_overrides`). Off:
resolver returns `postora_only` before any read, UI hides the cards. Frontend wiring in
`useFeatureFlags.tsx`: `FeatureFlags.byokProviders`, `FLAG_KEYS`, `FLAG_KEY_MAP`,
`DEFAULT_FLAGS` and `baseFromDb`, `ALL_FLAGS_ENABLED`, and **`VISIBILITY_FLAG_KEYS`** so an
admin sees the stored value rather than an unconditional `true` (that is what makes
"flag off" a rollback for the admin too, and what stops the panel mounting before the
migration is applied). Backend reads the global row and the caller's unexpired override.

Order of operations: migration → edge deploy → flag on for the admin by override → provider
activation → smoke → global flag decision. Rollback: set the flag false; rows remain.

## 11. Acceptance criteria

1. With the flag off, caption, hashtag, and agent-reply requests produce byte-identical tier
   selection to today (verified by the existing test suites, unmodified).
2. Saving a bad key returns `AI_USER_KEY_INVALID` and creates no row and no Vault secret.
3. After saving a valid key, `user_ai_provider_key_status` shows the hint and no other client
   path returns the key (RLS test, view column test, Edge response test).
4. `user_only` with no key returns 409 and makes no provider call.
5. `user_first` with a failing user key runs the platform chain and the log row carries
   `credential_source = platform` and `fallback_reason`.
6. `user_only` with a working key runs on the user key and the log row carries
   `credential_source = user`.
7. An agent reply on `claude/claude-sonnet-5` completes a tool call round trip in the sandbox.
8. Admin Chat and Agent selectors show OpenAI API and Anthropic API groups with active models.
9. The waitlist button inserts one row and is idempotent.
10. Migration replays cleanly on the PG17 harness and the registered harness suite asserts:
    RLS ownership, revoked grants for `anon`, the status view's column set, the mode/consent
    CHECK, the waitlist, the catalog rows, and that `get_user_ai_provider_key` and the reclaim
    function are not executable as `anon` or `authenticated`. Vault-backed positive reads and
    the reclaim trigger are asserted only when `supabase_vault` is installed (the harness
    baseline lacks it), with an explicit NOTICE when skipped.
11. A user tier is never built without a key, and a read failure in the resolver surfaces as
    an error, never as `postora_only` (unit tests for both).
12. Agent replies on the seeded Anthropic models send no `temperature` or `top_p`.

## 12. Open decisions

1. Anthropic model ids and pricing to seed (confirm at implementation time).
2. Whether `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are present in the Dokploy functions
   environment; if not, the admin enters them through the existing provider card.
