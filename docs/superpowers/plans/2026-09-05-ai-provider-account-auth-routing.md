# AI Provider Connections and Capability Routing — Revised Implementation Plan

**Depends on:** `docs/superpowers/specs/2026-09-05-ai-provider-account-auth-routing-design.md`  
**Delivery:** Seven V1 pull requests plus a separately approved Codex phase 2  
**Excluded:** Claude Code subscription authentication

## 1. Outcome

V1 gives users and administrators Vault-backed OpenAI and Anthropic API-key connections, deterministic connection-aware model chains, and user routing choices. It preserves the current chat override/fallback route while flags are off and integrates with the existing inbound vision and AI-agent paths.

The work is intentionally smaller than the first plan:

- no duplicate provider identities;
- no second user-preference table;
- no generic `ai-execute` function;
- no parallel media-analysis function;
- no Node runtime in V1;
- no Claude Code code surface;
- Codex begins only after two written policy approvals.

## 2. Safety Invariants

Every PR must preserve these invariants:

1. Canonical provider codes remain `openai`, `claude`, and `gemini`.
2. A user connection is usable only for its owner and can never have `platform_shared` or `admin_only` policy.
3. A platform chain either names an exact `connection_id` or uses only the legacy platform credential path.
4. Flags off call the existing resolvers and preserve `user_ai_model_overrides` precedence.
5. A credential is stored in Vault before a connection becomes active and is never returned.
6. `own_only` has no platform-billed fallback.
7. Provider-call logging starts before dispatch and one total deadline covers planning plus all attempts.
8. Unknown providers fail closed; they never default to OpenAI.
9. Browser roles cannot mutate `ai_connection_models` or read secret-bearing tables.
10. New Deno modules pass `deno check`; `deno test --no-check` is not an acceptable type gate.

## 3. Delivery Map

| PR | Scope | Production behavior |
|---|---|---|
| A | Schema, Vault contract, RLS, flags, compatibility tests | none; flags off |
| B | Connection API and server-side validation | connection management for allowlisted users |
| C | Preference resolver, planner, exact admin chain references | shadow planning only |
| D | User/admin full-stack settings UI | configuration UI behind flags |
| E | OpenAI/Anthropic adapters and agent tool normalization | adapters testable, not broadly routed |
| F | Existing caller migrations: chat, captions, hashtags, vision, agent | cohort routing |
| G | Observability, rollout, legacy secret migration, cleanup gates | controlled GA |
| Phase 2 | Codex approval, runtime, auth, jobs, UI | separate project and rollout |

## 4. Proposed Files

Create or modify only as slices require.

```text
supabase/migrations/<timestamp>_ai_provider_connections.sql
supabase/migrations/<timestamp>_ai_connection_vault.sql
supabase/migrations/<timestamp>_ai_provider_call_attempts.sql
supabase/migrations/<timestamp>_ai_routing_flags.sql
supabase/migrations/<timestamp>_ai_legacy_secret_migration.sql

supabase/functions/ai-provider-connections/index.ts
supabase/functions/_shared/ai-routing/types.ts
supabase/functions/_shared/ai-routing/preferences.ts
supabase/functions/_shared/ai-routing/planner.ts
supabase/functions/_shared/ai-routing/credentials.ts
supabase/functions/_shared/ai-routing/deadline.ts
supabase/functions/_shared/ai-routing/audit.ts
supabase/functions/_shared/ai-providers/openai.ts
supabase/functions/_shared/ai-providers/anthropic.ts
supabase/functions/_shared/ai-providers/normalize.ts

src/features/ai-connections/domain/types.ts
src/features/ai-connections/infrastructure/aiConnectionsApi.ts
src/features/ai-connections/ui/AiConnectionCard.tsx
src/features/ai-connections/ui/AiRoutingPreferences.tsx
src/components/settings/AiSettingsSection.tsx
src/components/admin/settings/ai/AiProvidersCard.tsx
src/components/admin/settings/ai/AiCategoryCards.tsx
src/hooks/useFeatureFlags.tsx
src/hooks/useAIConfiguration.ts
src/hooks/ai-config/types.ts
```

Tests live beside the module or in the repository's existing test location. Do not introduce a new test framework.

## 5. PR A — Schema, Vault, RLS, Flags, and Compatibility

PR A fixes the schema and current-state defects before behavior changes.

### A1. Pin current behavior with tests

Add tests before migrations or routing code:

- `resolveChatModelConfig` returns active `user_ai_model_overrides` first;
- admin primary/fallback/fallback-2 behavior remains unchanged;
- invalid configured last resort still uses the validated hardcoded floor;
- `ai-config` old `set-user-preference` body remains accepted;
- existing `ai_model_preferences` rows resolve through `get_active_ai_model_config`;
- `understandInboundMedia` uses caller-supplied tiers and one ladder deadline.

Suggested files:

- `supabase/functions/_shared/aiFallbackSettings.test.ts`
- `supabase/functions/_shared/ai-fallback.test.ts` if needed
- `supabase/functions/_shared/inboundMediaUnderstanding.test.ts`
- `supabase/functions/ai-config/index.test.ts` or the current function harness

### A2. Keep existing provider codes

Migration rules:

```sql
UPDATE public.ai_providers
SET name = 'Anthropic API'
WHERE provider_code = 'claude';

UPDATE public.ai_providers
SET name = 'Google Gemini'
WHERE provider_code = 'gemini';
```

Do not insert `anthropic`, `google`, or `claude_code`. Add a migration assertion/test that fails if those codes appear.

Seed `api_key` auth-method rows by joining the existing `openai` and `claude` provider rows. `ON CONFLICT` targets `(provider_id, auth_method)`, not a new provider code.

### A3. Create connections with a scope/policy constraint

Create `ai_provider_auth_methods` and `ai_provider_connections` exactly as specified. The migration must include:

- composite provider/auth-method FK;
- `owner_user_id ... ON DELETE CASCADE`;
- `created_by ... ON DELETE SET NULL`;
- database `CHECK` coupling scope, owner, and allowed traffic policy;
- indexes for owner/status and platform/status;
- updated-at trigger;
- no raw credential columns.

SQL tests must prove these inserts fail:

- user + `platform_shared`;
- user + `admin_only`;
- platform + `own_user`;
- user with null owner;
- platform with non-null owner.

Also prove valid user/platform combinations succeed.

### A4. Create connection models with RLS

Create `ai_connection_models` with `(connection_id, model_id)` primary key and FKs to connections and `ai_models`.

Enable RLS and define/grant explicitly:

- owner select for user connections;
- admin select for platform connections;
- service-role write path;
- revoke insert/update/delete from `anon` and `authenticated`;
- status-only security-invoker view if frontend access is needed.

Test cross-user selection, anonymous access, user platform-row access, and browser mutation denial.

### A5. Extend `ai_model_preferences`; do not duplicate it

Migration sequence:

1. Add nullable `social_account_id`.
2. Add `routing_mode` with a temporary/default value of `postora_only`.
3. Add nullable `preferred_connection_id`.
4. Make existing `model_id` nullable.
5. Drop the current `(user_id, feature)` unique constraint by its discovered name.
6. Add the two partial unique indexes from the spec.
7. Add routing-mode shape checks.
8. Add the composite FK from `(preferred_connection_id, model_id)` to `ai_connection_models` with `ON DELETE RESTRICT`.
9. Backfill/validate all existing rows.

Required checks:

- `prefer_own`/`own_only` require connection and model;
- `postora_only` requires no preferred connection but may retain the legacy model;
- the preferred connection belongs to the row's `user_id`, enforced in the write RPC because a plain FK cannot express owner equality;
- social account belongs to the same user, enforced by RPC and RLS.

Add a disconnect RPC that clears dependent own-routing rows and deletes connection/Vault secret in one controlled operation. Direct browser delete must not bypass it.

After the Edge/RPC mutation path is available, keep owner-scoped preference reads but revoke direct browser insert/update/delete. All writes validate connection and social-account ownership server-side.

### A6. Create durable call attempts

Create `ai_provider_call_attempts` with the exact columns/statuses from the spec. Required constraints and access:

- `user_id ... ON DELETE SET NULL`;
- `connection_id ... ON DELETE SET NULL`;
- allowed-value checks for credential source and status;
- index on `(request_id, fallback_level)` and on stale `started_at` rows;
- RLS enabled;
- no browser writes;
- admin non-secret select and service-role insert/update.

Test that deleting an account or connection does not fail and leaves an anonymized operational row.

### A7. Reuse the connector Vault lifecycle

Mirror the proven connector pattern with AI-specific RPCs:

- `upsert_ai_connection_secret`
- `get_ai_connection_credential`
- `delete_ai_connection_secret`
- orphan reclaim trigger/function where cascade behavior requires it

Requirements:

- Vault stores one JSON object per connection;
- read RPC checks intended user/scope and connection status;
- read/secret mutation is service-role only;
- merge semantics preserve configured fields;
- delete/cascade leaves no orphan Vault secret;
- SQL comments document any owner-run/manual migration requirement.

Add SQL tests copied/adapted from the connector secret migration harness.

### A8. Add exact feature flags

Insert false-valued `app_settings` rows:

- `feature_ai_provider_connections`
- `feature_ai_user_routing`
- `feature_ai_anthropic_adapter`

Update all hardcoded pieces in `src/hooks/useFeatureFlags.tsx`:

- `FLAG_KEYS`;
- TypeScript flag type/interface;
- `DEFAULT_FLAGS`;
- `FLAG_KEY_MAP` or equivalent mapping.

Do not create a cohort table. Confirm `user_feature_overrides` can enable each flag for one user and its expiry is honored.

### A9. PR A verification

```bash
deno check supabase/functions/_shared/ai-fallback.ts
deno check supabase/functions/_shared/inboundMediaUnderstanding.ts
deno test supabase/functions/_shared/aiFallbackSettings.test.ts
deno test supabase/functions/_shared/inboundMediaUnderstanding.test.ts
npm run test -- --run src/hooks/__tests__/useFeatureFlags.test.tsx
npm run typecheck
```

Run the repository migration/RLS harness. If its normal command uses `--no-check`, run `deno check` separately on every touched/new Deno module.

PR A exit gate: all flags false produces no route or UI behavior change.

## 6. PR B — Connection API and Validation

### B1. Implement one connection Edge surface

Add `supabase/functions/ai-provider-connections/index.ts` with actions:

- `list-status`
- `connect-api-key`
- `validate`
- `refresh-models`
- `disconnect`
- `set-traffic-policy` (admin only)

Do not add a generic execution function.

For every request:

1. validate JWT claims;
2. derive caller/user/admin role server-side;
3. parse an allowlisted provider code and action schema;
4. enforce requested scope before service-role access;
5. rate-limit connection and validation actions;
6. return only normalized status metadata.

### B2. Connect API keys transactionally

Flow:

1. Create/update connection metadata as `pending`.
2. Store key in Vault.
3. Validate against the allowlisted provider host with a bounded timeout.
4. Discover or validate allowed models.
5. Upsert `ai_connection_models` only for catalog models belonging to the same provider.
6. Mark connection `active` and write `last_validated_at`.
7. On definitive credential failure, mark `error` and delete/replace the invalid Vault secret according to the retry UX.

OpenAI and Anthropic validation functions are server-only and never echo provider bodies containing sensitive values.

When the OpenAI connection path is deployable behind false-default flags, update the existing `openai` row to active. Do not activate `claude` in this PR; its row is activated only after PR E's Anthropic contract suite passes.

### B3. Traffic-policy mutation

`set-traffic-policy` is admin-only and platform-scope-only. User-scope enable/disable uses a separate owner action constrained to `own_user`/`disabled`. Database checks remain the final defense.

### B4. Tests

Cover:

- missing/invalid JWT;
- non-admin platform creation/policy mutation;
- cross-user list/validate/disconnect;
- invalid provider code or redirect;
- invalid key redaction;
- Vault failure rollback;
- model/provider mismatch;
- rate limit;
- user disconnect dependency cleanup and secret reclaim;
- platform disconnect rejected while referenced by any admin chain tier.

## 7. PR C — Preference Resolution and Deterministic Planner

### C1. Define shared types

In `_shared/ai-routing/types.ts`, define:

- categories used in V1: `chat`, `agent`, `caption`, `hashtags`, `vision`;
- routing modes;
- scope/traffic policy;
- `ModelChainRef` with optional `connection_id`;
- credential source: `user_connection | platform_connection | legacy_platform`;
- candidate skip reasons and normalized terminal errors.

Frontend types mirror the wire contract but do not contain credential handles.

### C2. Resolve preference precedence

Implement a pure/testable resolver for:

1. social account + category;
2. social account + `*`;
3. user + category;
4. user + `*`;
5. implicit `postora_only`.

Tests must include the previously omitted social-account wildcard and prove exact rows win.

Add `set-routing-preference` and `delete-routing-preference` actions to `ai-config` or the connection function. Keep `set-user-preference` unchanged.

### C3. Parse exact admin chain references

Extend the existing `system_settings` parser:

```ts
type ModelChainRef = {
  provider_code: string;
  model_id: string;
  connection_id?: string;
};
```

Rules/tests:

- absent `connection_id` resolves legacy provider credential only;
- present ID resolves exactly that platform row;
- provider/model/connection mismatch is rejected;
- `admin_only` is rejected for end-user traffic;
- `platform_shared` is allowed only after normal quota checks;
- disabled, expired, or unavailable connections are skipped with a typed reason;
- no “first active connection for provider” query exists.

### C4. Preserve legacy chat precedence

Build the POSTORA chat candidates by adapting, not bypassing, `resolveChatModelConfig`:

1. non-expired `user_ai_model_overrides`;
2. admin primary;
3. admin fallback;
4. validated third tier/floor.

When `feature_ai_user_routing` is false, call the existing path directly. Add a golden test comparing old and new outputs across:

- user override present/expired/absent;
- primary/fallback missing;
- invalid fallback 2;
- provider aliases already supported by legacy code.

For categories currently using `get_active_ai_model_config`, preserve the existing `ai_model_preferences.model_id` as the first platform-model candidate. Do not introduce that preference into chat/agent, because `_shared/ai-fallback.ts` does not read it today. Encode this as an explicit category map and parity fixtures.

### C5. Planner without secret reads

Planner output contains candidate metadata and a credential reference, not a secret. It checks ownership, scope, policy, model FK, capability, status, and quota requirements before the execution layer resolves Vault.

Mode tests:

- `postora_only` includes current user override;
- `prefer_own` puts exact own connection first;
- `prefer_own` falls back only after normalized user-connection failure;
- `own_only` never contains platform candidates;
- no usable own connection produces a clear terminal error for `own_only`;
- user A can never plan user B's connection.

### C6. Shadow mode

Add structured shadow logs containing candidate identifiers and skip reasons only. Shadow mode must not read Vault, reserve quota, or call a provider.

## 8. PR D — User and Admin UI

### D1. Client API and query hooks

Create a typed client for the connection/status/preference actions. It must never model an API response field for a raw secret.

Add hooks for:

- list connections/status/models;
- connect/validate/disconnect;
- get/set routing preference;
- admin platform connection/policy changes.

Invalidate only relevant query keys after mutations.

### D2. User settings

Extend `src/components/settings/AiSettingsSection.tsx` with:

- OpenAI API card;
- Anthropic API card;
- masked key entry modal;
- connection status, last validation, and non-secret error;
- disconnect confirmation;
- category routing mode;
- connection/model selector required for own modes;
- clear cost labels: “Your provider account” versus “POSTORA provider”.

Do not show Codex or Claude Code in V1. Do not claim that an API key uses a consumer subscription.

### D3. Admin settings

In the existing AI provider/settings area next to Higgsfield:

- add OpenAI API and Anthropic API platform-connection cards;
- allow `admin_only`, `platform_shared`, or `disabled` only;
- show the connection label in category model selectors;
- write `connection_id` when an account-backed platform connection is chosen;
- write legacy JSON without a connection ID only for the legacy API credential option;
- return `connection_in_use` and list referenced tiers while any setting names the connection; require reassignment/clear before disconnect and recheck transactionally.

Display labels are connection-aware, for example `OpenAI API — Operations key`, not new catalog provider rows.

### D4. UI tests

Cover flags off, cohort overrides, role visibility, secret redaction, required model choice, social-account wildcard editing, exact admin connection binding, disconnect warnings, and RTL/Arabic layout.

## 9. PR E — OpenAI and Anthropic Provider Adapters

### E1. Normalized adapter contract

Define one internal request/result contract for chat/agent/vision V1 use. Keep provider-specific wire structures inside provider modules.

Required methods:

- `validateCredential`
- `listOrValidateModels`
- `completeChat`
- `completeWithTools`
- `understandImage` or provider content mapping used by the existing media layer

Each call accepts an absolute deadline/AbortSignal and emits normalized usage, request ID, retryability, and error code.

### E2. OpenAI adapter

Extract compatible behavior from existing callers without changing legacy behavior. Test auth, model mismatch, rate limits, timeout, malformed body, tool calls, and image content.

### E3. Anthropic adapter under code `claude`

Implement the full Messages API mapping listed in the spec. Do not simply add an endpoint URL to the OpenAI-compatible client.

Agent tests must cover:

- system prompt separation;
- multiple text/content blocks;
- tool definition conversion;
- one and multiple `tool_use` blocks;
- `tool_result` round trip;
- multi-round tool loop;
- stop reason mapping;
- vision block conversion;
- usage/rate-limit/timeout normalization.

### E4. Fail-closed dispatch

Replace the current unknown-provider-to-OpenAI fallback in migrated code with an explicit adapter lookup. Missing adapter/capability returns `provider_not_supported` before a credential read or quota reservation.

Keep `google`/`gemini` legacy aliases where current code requires them; do not create a `google` catalog row.

After the Anthropic contract, tool-loop, and vision tests pass, update the existing `claude` provider row to active. Routing remains protected by false-default flags and cohort rollout.

### E5. Type and contract gates

```bash
deno check supabase/functions/_shared/ai-providers/openai.ts
deno check supabase/functions/_shared/ai-providers/anthropic.ts
deno check supabase/functions/_shared/ai-providers/normalize.ts
deno test supabase/functions/_shared/ai-providers/openai.test.ts
deno test supabase/functions/_shared/ai-providers/anthropic.test.ts
```

Use mocked provider responses in CI; no real keys.

## 10. PR F — Integrate Existing AI Callers

Migrate by existing capability path, not by creating generic duplicate endpoints.

### F1. Shared total deadline and pre-dispatch log

Implement a request deadline helper:

- 50-second hard internal deadline from handler entry;
- planner/DB target at most 2 seconds;
- at least 5 seconds kept for logging/response/escalation;
- every attempt receives only remaining time;
- fallback never resets the clock.

Insert a durable attempt row before provider dispatch. Update on completion. A stale `started` row identifies likely worker death.

### F2. Captions and hashtags

Integrate planner/adapter selection into:

- `supabase/functions/generate-caption/index.ts`
- `supabase/functions/generate-hashtags/index.ts`

Gate each route; preserve old logic when off. Verify user-owned attribution and reserve platform quota only at the platform boundary.

### F3. Chat paths

Integrate where `resolveChatModelConfig` is currently used. Preserve active user override as the first POSTORA candidate and all existing hard floors.

### F4. Existing inbound vision

Modify tier construction feeding:

- `_shared/inboundMediaPipeline.ts`
- `_shared/inboundMediaUnderstanding.ts`

Do not add `analyze-media`. Preserve `mediaUnderstandingMode`, MIME/byte checks, prompts, and the existing one-budget ladder. Add provider tiers only when the model capability is validated.

### F5. AI agent reply

Integrate the planner into `supabase/functions/ai-agent-reply/index.ts` behind flags.

Required tests:

- OpenAI and Anthropic tool loops use the same internal tool executor;
- user-owned connection is scoped to request user;
- `prefer_own` transitions to current POSTORA chain after a retryable own failure;
- `own_only` performs no platform fallback;
- platform quota is reserved only before a platform call;
- total planner/provider/tool-loop time remains within the Edge budget;
- model exhaustion still triggers existing escalation/outbox behavior;
- a call row exists even when the provider times out;
- unsupported provider fails closed.

### F6. Rollout order inside PR F

Enable per cohort in this order: captions/hashtags, chat, inbound vision, agent reply. Stop expansion on error-rate, latency, quota-attribution, or isolation regression.

## 11. PR G — Observability, Legacy Secrets, and GA

### G1. Metrics and admin visibility

Add aggregated, non-secret views for:

- calls by credential source/provider/category;
- own-to-platform fallback rate;
- error and timeout rate;
- p50/p95 latency;
- stale `started` attempts;
- platform quota reservations/releases;
- disabled/expired connection skips.

Do not expose prompts or user keys.

### G2. Legacy plaintext migration

`provider_api_keys.api_key` and `higgsfield_connections.access_token` are plaintext today. Migrate with a separate operational checklist:

1. add Vault secret references;
2. dual-write new/rotated credentials;
3. dual-read with Vault first and explicit legacy fallback telemetry;
4. backfill in a controlled owner-run migration;
5. verify row counts, decryptability, ownership, and active flows;
6. disable plaintext writes;
7. scrub plaintext only after rollback backup/approval;
8. remove legacy reads in a later cleanup PR.

Never run a destructive scrub automatically in the schema PR.

### G3. Security regression suite

Prove:

- cross-tenant status/model/preference access fails;
- service-role helpers require intended owner/scope;
- traffic policy cannot cross scopes even through RPCs;
- logs/responses contain no submitted sentinel secret;
- SSRF allowlist rejects unexpected hosts/redirects;
- disconnect/revocation reclaims Vault data;
- `own_only` cannot reserve or consume platform quota;
- admin-only connection cannot serve normal user traffic.

### G4. Rollout and rollback

Use existing `user_feature_overrides` cohorts. Record dashboards and thresholds before expansion.

Rollback is flag-first:

1. disable `feature_ai_user_routing`;
2. disable `feature_ai_anthropic_adapter` if provider-specific;
3. keep connection metadata/Vault rows intact;
4. existing callers return to legacy resolvers;
5. investigate without destroying user configuration.

Schema rollback must not be required for traffic rollback.

### G5. Cleanup gate

Only after at least one stable release window:

- remove shadow logging noise;
- remove legacy plaintext reads after verified scrub;
- decide whether `get_active_ai_model_config` becomes a thin wrapper over the new preference/planner path;
- keep old `set-user-preference` until all clients migrate;
- document operator runbooks and incident response.

## 12. Phase 2 — Codex (Blocked Until Written Approval)

Phase 2 is not part of V1 estimates or PRs. No implementation starts until written OpenAI approval separately covers:

- user-scoped Codex use for the user's own POSTORA workloads;
- administrator-connected Codex use for admin-only or shared workloads.

Official docs are implementation references, not the commercial permission decision:

- `https://developers.openai.com/codex/app-server`
- `https://developers.openai.com/codex/auth`

### P2.1. Architecture spike after approval

Prototype against Codex App Server with test accounts and synthetic workloads. Confirm capability, latency, cancellation, concurrency, token refresh, logout, and non-coding workload behavior. Do not route production traffic.

### P2.2. Separate runtime deployment

Create a separate Dokploy Compose project, not a service in root `docker-compose.yml` or the Supabase compose.

Deployment requirements:

- join the Supabase stack's external Docker network;
- internal HTTP endpoint;
- HMAC signature over method/path/body hash/timestamp/nonce;
- clock-skew limit and replay cache;
- firewall/no public ingress;
- per-connection isolated runtime profile;
- encrypted volume/secret lifecycle;
- bounded process and memory concurrency;
- health/readiness without account data.

Do not use a host Unix socket; Edge containers cannot reach it.

### P2.3. Jobs relationship

If execution cannot safely complete in the Edge budget, add `ai_execution_jobs` as a generic parent:

- `user_id ... ON DELETE CASCADE`;
- idempotency key and explicit retry state;
- `ai_generation_jobs.execution_job_id ... ON DELETE SET NULL`;
- existing generation jobs remain independent with null parent;
- one documented owner for status, quota, and retry transitions.

### P2.4. Codex connection and UI

Only after runtime/security gates pass:

- seed provider code `codex` and its approved auth methods;
- add user/admin connection cards for approved scopes only;
- use device/browser flow exactly as supported;
- add separate false-default feature flags to `app_settings`, `FLAG_KEYS`, maps, and defaults;
- use `user_feature_overrides` for cohorts;
- bind exact platform `connection_id` in model chains;
- never copy or expose auth cache contents through the browser/API.

### P2.5. Codex tests and rollout

Test tenant isolation, login completion/cancellation, refresh, logout, runtime restart, HMAC replay rejection, idempotency, deadline cancellation, policy flags, and user/platform cost attribution. Start with internal users and admin-only traffic.

## 13. Claude Code

There are no Claude Code tasks, flags, provider rows, adapters, UI cards, runtime profiles, or tests in this plan. Replanning requires a signed Anthropic agreement that explicitly covers the requested intermediation and workload.

## 14. Test Matrix

| Dimension | Required cases |
|---|---|
| Scope | own user, other user, admin platform, shared platform, anonymous |
| Policy | valid scope policies plus every invalid cross-scope combination |
| Mode | postora only, prefer own success/fallback, own only success/failure |
| Preference | social exact, social `*`, user exact, user `*`, default |
| Legacy chat | active/expired/no user override; valid/invalid admin tiers |
| Chain binding | exact connection, absent connection, mismatched provider/model, disabled connection |
| Secret | create, rotate, merge, read, revoke, cascade reclaim, redaction |
| Provider | OpenAI, Anthropic content/tool/vision, existing Gemini aliases |
| Capability | chat, caption, hashtags, inbound vision, agent tools |
| Budget | planner delay, provider timeout, fallback remaining time, stale-started log |
| Cost | own success, own retry, own-to-platform transition, own-only no platform reservation |
| RLS | status view, connection models, preferences, platform rows, browser mutations |
| Flags | global off/on, user override on/expired, immediate rollback |

## 15. CI Gates

For each PR:

1. migration/RLS SQL tests;
2. `deno fmt --check` for touched Deno files;
3. `deno lint` for touched Deno files;
4. `deno check` for every new/touched Edge/shared module;
5. `deno test` for Deno unit/contract tests;
6. frontend lint/typecheck/unit tests;
7. production build;
8. secret-sentinel scan of test logs and serialized API responses.

If the repository-wide Deno test command uses `--no-check`, keep it only for runtime test execution and add explicit `deno check` commands. A green no-check test is not sufficient.

## 16. Definition of Done

V1 is done only when:

- provider-code assertions prevent duplicate Anthropic/Google identities;
- invalid traffic policies are impossible in SQL and APIs;
- existing preference data is migrated in place;
- exact admin connection selection is persisted and verified;
- flags-off parity includes live user overrides;
- user/admin connection UI is secure and connection-aware;
- OpenAI and Anthropic adapters pass contract, vision, and agent-tool tests;
- existing inbound media pipeline is reused;
- all synchronous attempts share one sub-60-second deadline and pre-dispatch log;
- RLS/isolation and cost-attribution tests pass;
- rollback requires flags, not data deletion;
- Codex remains blocked pending both approvals;
- Claude Code has no implementation surface.
