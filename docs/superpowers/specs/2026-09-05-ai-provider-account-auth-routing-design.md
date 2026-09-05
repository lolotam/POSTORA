# AI Provider Connections and Capability Routing

**Status:** Revised implementation-ready design  
**Date:** 2026-09-05  
**Scope:** V1 BYOK API connections; Codex is a policy-gated phase 2; Claude Code is excluded

## 1. Decision Summary

POSTORA will let a user connect an OpenAI or Anthropic API account and choose whether supported AI work uses that connection before POSTORA's platform credentials. Administrators can create the same connection types for platform traffic and bind an exact connection to each configured model tier.

V1 reuses the existing provider catalog, `ai_model_preferences`, connector Vault pattern, feature-flag system, AI fallback chain, and inbound-media vision pipeline. It does not introduce duplicate provider codes, a parallel preference table, a parallel media-analysis function, a generic runtime service, or Claude Code subscription authentication.

Codex account authentication is phase 2. It remains disabled until OpenAI gives written confirmation that both user-scoped and administrator/shared use are permitted for POSTORA's multi-tenant, webhook-driven, non-coding workload. Claude Code has no implementation scope until a signed Anthropic agreement explicitly permits this deployment shape.

## 2. Goals

1. Users can connect and validate their own OpenAI or Anthropic API key without exposing it to the browser after submission.
2. Users can choose `postora_only`, `prefer_own`, or `own_only` per AI category, with optional social-account overrides.
3. A valid user-owned connection takes priority when requested and is attributed as user-funded usage.
4. If user-owned execution is unavailable and the mode allows fallback, POSTORA uses the existing user override and admin model chain.
5. Administrators can create platform connections, control whether they are admin-only or shared, and select the exact connection for a model tier.
6. Existing routing is compatible while the new routing flags are off.
7. V1 routes chat, agent replies, captions, hashtags, and the existing inbound vision pipeline. Additional capabilities are added only after adapter-specific tests.
8. Credentials use the existing Supabase Vault lifecycle pattern and never appear in status APIs, logs, or RLS-visible rows.

## 3. Non-goals

- Treating a ChatGPT, Claude, or other consumer subscription as a general-purpose API entitlement.
- Claude Code authentication, provider rows, cards, feature flags, adapters, or tests.
- Codex execution in V1.
- Adding `anthropic` or `google` provider rows.
- Replacing the working Higgsfield flow during the first routing rollout.
- Creating `analyze-media` or another vision pipeline beside the existing inbound-media pipeline.
- Moving every AI modality in one release.
- Removing current `system_settings`, `provider_api_keys`, or fallback code before parity and rollback gates pass.

## 4. Confirmed Current State

### 4.1 Provider catalog

Migration `20260323193759_617e4e0d-f514-41d3-a039-9c20c451e71d.sql` already defines these identities:

| Provider code | Current meaning | V1 action |
|---|---|---|
| `openai` | OpenAI Platform API | Keep code; enable through tested API connections |
| `claude` | Anthropic API | Keep code; display as “Anthropic API” |
| `gemini` | Google Gemini API | Keep code; do not add `google` |
| `openrouter` | OpenRouter API | Keep unchanged |
| `higgsfield` | Higgsfield OAuth/MCP | Keep unchanged in V1 |

`openai` and `claude` were seeded inactive. `ai-agent-reply` currently handles `openai`, `openrouter`, `google`, and `gemini`, but not `claude`. Anthropic chat, vision-content mapping, and agent tool-call normalization are new work.

### 4.2 Existing preferences and overrides

- `ai_model_preferences` already stores `(user_id, model_id, feature)` and is written by `set-user-preference` in `ai-config`.
- `get_active_ai_model_config` reads `ai_model_preferences`.
- `_shared/ai-fallback.ts` does not read `ai_model_preferences`.
- `resolveChatModelConfig` gives a live, non-expired `user_ai_model_overrides` row precedence over the admin chat primary/fallback chain.

V1 extends `ai_model_preferences`; it does not create `user_ai_routing_preferences`. Existing preference rows remain valid and default to `postora_only`.

### 4.3 Existing credential storage

Connector credentials already use Supabase Vault through:

- `upsert_connector_credential_secret`
- `get_connector_credential`
- connector secret deletion/reclaim logic

AI connections reuse this pattern through AI-specific RPCs and ownership checks. Existing `provider_api_keys.api_key` and `higgsfield_connections.access_token` columns are plaintext security debt and need a controlled dual-read/backfill/scrub migration before those paths are declared fully migrated.

### 4.4 Feature flags and rollout allowlist

Feature flags are `app_settings` rows, but the frontend only reads keys listed in the hardcoded `FLAG_KEYS`/mapping/defaults in `src/hooks/useFeatureFlags.tsx`. Per-user rollout already exists through `user_feature_overrides`, including expiry.

V1 adds rows and updates the hardcoded frontend list. It reuses `user_feature_overrides`; no new rollout allowlist table is permitted.

### 4.5 Existing vision path

`_shared/inboundMediaUnderstanding.ts`, `inboundMediaPipeline.ts`, and `mediaUnderstandingMode.ts` already process inbound image/document media and accept caller-resolved provider tiers. V1 feeds the new routing and credential result into that tier list. It does not create another Edge Function for media analysis.

### 4.6 Deployment and time limit

The root `docker-compose.yml` runs the frontend nginx service only. Supabase Edge Functions run inside the Dokploy Supabase stack and have an effective 60-second worker ceiling; a killed worker may not write a final log row.

V1 stays inside existing Edge Functions. A phase-2 Codex runtime, if approved, is a separate Dokploy Compose project attached to the Supabase stack's external Docker network. It is never added to the repository frontend compose or the Supabase compose.

## 5. Provider and Authentication Identity

Provider identity describes the protocol/model catalog. Authentication method describes how one connection obtains credentials. They are separate.

### 5.1 V1 identities

| Catalog code | Display name | Auth method | Scope |
|---|---|---|---|
| `openai` | OpenAI API | `api_key` | user or platform |
| `claude` | Anthropic API | `api_key` | user or platform |
| `gemini` | Google Gemini | existing API method | platform, unchanged initially |
| `higgsfield` | Higgsfield | existing OAuth method | user or platform, unchanged initially |

There must be no `anthropic`, `google`, or `claude_code` catalog seed. Display names may change with `UPDATE ... WHERE provider_code = ...`; codes must not.

### 5.2 Phase-2 Codex identity

`codex` may be added only after the policy gate in section 16 passes. It is distinct because its runtime/protocol and capability contract differ from the OpenAI Platform API. The existence of ChatGPT sign-in, device-code login, or App Server embedding does not decide whether POSTORA may drive a user's subscription in this deployment shape.

## 6. Connection and Traffic Policy

### 6.1 Connection scope

- `user`: owned by exactly one authenticated user; usable only for that user's work.
- `platform`: managed by an administrator; may be admin-only or explicitly shared.

### 6.2 Traffic policy

| Scope | Allowed policy | Meaning |
|---|---|---|
| user | `own_user` | only the owner may use it |
| user | `disabled` | no execution |
| platform | `admin_only` | admin test/manual execution only |
| platform | `platform_shared` | may serve eligible end-user traffic |
| platform | `disabled` | no execution |

The database constraint is mandatory:

```sql
CHECK (
  (scope_kind = 'user'
    AND owner_user_id IS NOT NULL
    AND traffic_policy IN ('own_user', 'disabled'))
  OR
  (scope_kind = 'platform'
    AND owner_user_id IS NULL
    AND traffic_policy IN ('admin_only', 'platform_shared', 'disabled'))
)
```

All create/update RPCs repeat this validation. A user connection can never be promoted to shared traffic by changing one column.

## 7. Data Model

### 7.1 `ai_provider_auth_methods`

Metadata only; no secrets.

```text
provider_id             uuid FK ai_providers(id)
auth_method             text
supports_user_scope     boolean
supports_platform_scope boolean
status                  active | policy_blocked | disabled
capabilities            text[]
PRIMARY KEY (provider_id, auth_method)
```

V1 seeds `api_key` for the existing `openai` and `claude` rows. Higgsfield may be represented as metadata after parity tests; it is not re-seeded as another provider.

### 7.2 `ai_provider_connections`

```text
id                    uuid PK
provider_id           uuid FK ai_providers(id)
auth_method           text
scope_kind            user | platform
owner_user_id         uuid NULL FK auth.users ON DELETE CASCADE
label                 text
account_hint          text NULL
vault_secret_id       uuid NULL
status                pending | active | expired | revoked | error | disabled
traffic_policy        own_user | admin_only | platform_shared | disabled
last_validated_at     timestamptz NULL
last_error_code       text NULL
created_by            uuid NULL FK auth.users ON DELETE SET NULL
created_at            timestamptz
updated_at            timestamptz
```

Requirements:

- Composite FK from `(provider_id, auth_method)` to `ai_provider_auth_methods`.
- Scope/owner/traffic `CHECK` from section 6.2.
- No token, key, refresh token, or decrypted Vault value is client-readable.
- Browser reads a status-only security-invoker view.
- User RLS permits status select for owned user connections only; disconnect is RPC-only.
- Platform rows are admin-only; service-role reads still include intended user/scope predicates.

### 7.3 `ai_connection_models`

```text
connection_id         uuid FK ai_provider_connections(id) ON DELETE CASCADE
model_id              uuid FK ai_models(id) ON DELETE CASCADE
availability          available | unavailable | unknown
capabilities          text[]
last_checked_at       timestamptz
PRIMARY KEY (connection_id, model_id)
```

RLS is mandatory:

- owner may select rows for their user connection;
- admin may select platform rows;
- browser roles have no insert/update/delete grants;
- writes occur through authenticated Edge Functions/service role;
- a status view exposes model metadata but no secrets.

### 7.4 Extend `ai_model_preferences`

Do not create an overlapping table. Add:

```text
routing_mode            postora_only | prefer_own | own_only
social_account_id       uuid NULL FK social_accounts(id) ON DELETE CASCADE
preferred_connection_id uuid NULL
```

The existing `model_id uuid` becomes nullable. Add a real composite FK:

```sql
FOREIGN KEY (preferred_connection_id, model_id)
  REFERENCES ai_connection_models(connection_id, model_id)
  ON DELETE RESTRICT
```

Own-connection modes require both connection and model. `postora_only` requires a null connection but may retain a model as the legacy platform-model preference. Disconnect first clears dependent routing choices transactionally, then deletes the connection. Stale connection/model pairs are not accepted.

Replace the old `(user_id, feature)` unique constraint with partial unique indexes:

- `(user_id, feature)` where `social_account_id IS NULL`
- `(user_id, social_account_id, feature)` where `social_account_id IS NOT NULL`

Backfill existing rows with `routing_mode = 'postora_only'`. Existing `set-user-preference` remains compatible. Add `set-routing-preference` rather than changing the old action's required body.

Keep user-facing preference reads owner-scoped, but revoke direct browser mutation after the Edge/RPC write path is live. This is required because connection ownership and social-account ownership cannot be guaranteed by the composite model FK alone.

### 7.5 Call audit and jobs

V1 creates `ai_provider_call_attempts`, a non-secret synchronous-attempt table. It contains:

```text
id                    uuid PK
request_id            uuid NOT NULL
user_id               uuid NULL FK auth.users ON DELETE SET NULL
category              text NOT NULL
provider_code         text NOT NULL
model_id              text NOT NULL
connection_id         uuid NULL FK ai_provider_connections ON DELETE SET NULL
credential_source     user_connection | platform_connection | legacy_platform
status                started | succeeded | failed | timed_out | skipped
fallback_level        integer NOT NULL
provider_request_id   text NULL
error_code            text NULL
latency_ms            integer NULL
started_at            timestamptz NOT NULL
finished_at           timestamptz NULL
```

RLS is enabled. Browser roles have no write access; admin gets non-secret read access and service role writes. `ON DELETE SET NULL` permits account/connection deletion while preserving aggregate operational evidence.

Insert the attempt row before provider dispatch and update it after completion. Never log credentials, raw provider bodies, prompts, or token caches by default.

V1 does not create a second generic media job table. Existing image/video work continues to use `ai_generation_jobs` and its reserve/release quota flow.

If phase 2 needs generic jobs:

- `ai_execution_jobs.user_id` references `auth.users(id) ON DELETE CASCADE`;
- add nullable `ai_generation_jobs.execution_job_id` referencing the parent job `ON DELETE SET NULL`;
- existing generation rows remain valid with a null parent;
- the migration and worker contract define which table owns status and retries.

## 8. Exact Admin Chain Reference

Existing `system_settings.default_ai_model_<category>`, `_fallback`, and `_fallback_2` values remain the chain source. Extend their JSON shape without invalidating old rows:

```json
{
  "provider_code": "openai",
  "model_id": "gpt-4.1",
  "connection_id": "optional-platform-connection-uuid"
}
```

Derivation is deterministic:

1. With `connection_id`, resolve exactly that active platform connection.
2. Verify provider, selected model, model availability, capability, and traffic policy.
3. Never substitute another connection with the same provider code.
4. Without `connection_id`, use only the legacy platform API credential path. Absence never means “pick any connected account”.
5. Existing settings retain current behavior until an administrator explicitly selects a connection.

Admin writes validate the complete reference transactionally. Model cards display provider, auth method, connection label, scope, and traffic policy.

Because the reference lives in JSON and cannot have a relational FK, disconnecting a platform connection must fail with `connection_in_use` while any `default_ai_model_*` setting names its ID. The admin must reassign or clear every reported tier first; the disconnect RPC rechecks under a transaction before deleting the secret/row.

## 9. Routing Preference Precedence

For `(user, social account, category)`, resolve one row in this order:

1. social-account + exact category
2. social-account + `*`
3. user-wide + exact category (`social_account_id IS NULL`)
4. user-wide + `*`
5. implicit `postora_only`

Expired or disconnected choices do not silently mutate the saved preference. The planner records why a candidate was skipped.

## 10. Candidate Construction

### 10.1 POSTORA chain

For chat, POSTORA candidates preserve the current live tier:

1. active, non-expired `user_ai_model_overrides` row through the legacy platform credential path;
2. admin primary;
3. admin fallback;
4. admin fallback 2 / validated hardcoded floor.

For an entrypoint that already calls `get_active_ai_model_config`, a legacy `ai_model_preferences.model_id` remains the first platform-model candidate before admin primary, exactly as that RPC behaves today. Chat and agent fallback do not read this preference today, so V1 does not insert it into those POSTORA chains; they retain `user_ai_model_overrides` and admin tiers. This category mapping is covered by parity fixtures rather than inferred at runtime.

### 10.2 Mode behavior

| Mode | Ordered candidates |
|---|---|
| `postora_only` | current POSTORA chain, including live chat override |
| `prefer_own` | exact preferred user connection/model, then current POSTORA chain |
| `own_only` | exact preferred user connection/model only |

Rules:

- User connection must belong to the requester and have `own_user` policy.
- Platform connection must pass `admin_only`/`platform_shared` checks.
- Capability and model availability are checked before reading a secret.
- `own_only` never falls back to platform cost.
- In `prefer_own`, platform quota is reserved only when crossing into the POSTORA chain.
- With new routing flags off, callers invoke the existing resolver directly. This is the hard rollback path.

## 11. V1 Provider Adapters

### 11.1 OpenAI API

Use the existing OpenAI-compatible shape where valid. Validate keys server-side with a low-cost authenticated request, apply capability checks, and never infer subscription access from an API key.

### 11.2 Anthropic API (`claude`)

Anthropic is new execution work here. The adapter implements and tests:

- Messages API authentication and headers;
- system/message/content-block conversion;
- image content conversion for supported vision models;
- tool schema conversion;
- `tool_use` to the internal tool-call representation;
- internal tool results back to Anthropic `tool_result` blocks;
- stop reason, usage, rate-limit, timeout, and retry normalization;
- the existing agent loop with multiple tool rounds.

`ai-agent-reply` must not default an unknown provider to OpenAI. Unsupported providers fail closed with a typed error. Set `openai.is_active = true` only when the OpenAI connection path is deployable behind false-default flags; set `claude.is_active = true` only after the Anthropic adapter contract suite passes. Activation updates existing rows and never seed replacement identities.

## 12. Existing Vision Integration

The router returns authorized connection metadata and a server-only credential handle. The caller materializes authorized `ProviderTier` objects and passes them into `understandInboundMedia`.

Changes stay in the existing pipeline and tests:

- preserve `mediaUnderstandingMode`;
- preserve byte/mime validation and prompts;
- replace only tier construction/credential selection;
- keep one deadline across the ladder;
- add OpenAI/Anthropic vision only for proven models;
- do not create `analyze-media`.

## 13. Backend Surface

V1 adds one `ai-provider-connections` Edge Function, or equivalent actions inside `ai-config` if one surface is preferred. It provides:

- `list-status`
- `connect-api-key`
- `validate`
- `refresh-models`
- `disconnect`
- admin-only `set-traffic-policy`

Routing/execution stays in shared modules used by existing functions. V1 does not add generic `ai-execute`, auth-callback, or media-analysis Edge Functions.

Required shared modules: connection metadata repository, Vault resolver, preference resolver, candidate planner, OpenAI/Anthropic adapters, typed errors, and call logging.

## 14. Credential Security

1. Copy the connector Vault lifecycle with `upsert_ai_connection_secret`, `get_ai_connection_credential`, and `delete_ai_connection_secret`.
2. The read RPC accepts intended user and connection IDs, verifies ownership/scope, and is service-role only.
3. Status responses include only label, account hint, status/expiry, model availability, and normalized error.
4. Disconnect clears dependent preferences before deleting the Vault secret and row.
5. Logs redact authorization headers, keys, refresh tokens, OAuth codes, Vault payloads, and Codex caches.
6. Rate-limit validation and model refresh.
7. Allowlist provider hosts and reject unsafe redirects.
8. Service-role queries still require explicit intended owner/scope predicates.

## 15. Feature Flags and Rollout

V1 `app_settings` rows:

- `feature_ai_provider_connections`
- `feature_ai_user_routing`
- `feature_ai_anthropic_adapter`

The same keys are added to `FLAG_KEYS`, the key map, types, and defaults in `useFeatureFlags.tsx`. Defaults are false. `user_feature_overrides` is the only per-user cohort mechanism.

Rollout order:

1. schema/status APIs, flags off;
2. shadow planning without credential reads or route changes;
3. internal users through `user_feature_overrides`;
4. OpenAI user BYOK for chat/caption/hashtags;
5. Anthropic after contract/tool/vision tests;
6. existing inbound vision routing;
7. AI agent after end-to-end tool-loop tests;
8. gradual cohorts;
9. legacy plaintext credential backfill and scrub after dual-read verification.

## 16. Codex Phase-2 Policy Gate and Runtime

Official Codex documentation describes [App Server](https://developers.openai.com/codex/app-server) as an interface for embedding Codex and [documents ChatGPT browser/device-code authentication](https://developers.openai.com/codex/auth). It does not, by itself, settle whether a multi-tenant SaaS may use an individual ChatGPT subscription for POSTORA's automated non-coding traffic.

Before any Codex schema seed, UI card, flag, or production code is enabled, obtain written approval covering both:

1. user-scoped Codex authentication for the user's own POSTORA traffic; and
2. administrator-connected Codex authentication for shared or admin-only traffic.

If approved, the runtime is:

- a separate Dokploy Compose project;
- attached to the Supabase stack's external Docker network;
- internal HTTP protected by HMAC signature, timestamp, nonce, and replay cache;
- no host Unix socket;
- no addition to root `docker-compose.yml` or Supabase compose;
- one isolated runtime profile/auth store per connection;
- encrypted persistent storage and explicit logout/revocation;
- generic parent jobs from section 7.5 for work unsafe inside an Edge request.

Runtime flags remain absent or false until written approval and threat-model review are recorded.

## 17. Claude Code Decision

Claude Code subscription authentication is out of scope. Do not add a provider code, auth method, adapter, runtime profile, UI card, flag, or test suite for it. Reconsider only after a signed Anthropic agreement explicitly permits POSTORA to intermediate automated traffic. Anthropic API-key support under `claude` is independent and remains in V1.

## 18. Edge Deadline and Durable Logging

Every migrated synchronous Edge path uses one total budget measured from handler entry. The 60-second worker ceiling is not a provider timeout.

V1 target:

- hard internal deadline: 50 seconds total;
- planning/database target: at most 2 seconds;
- provider ladder bounded by remaining time;
- at least 5 seconds reserved for persistence/error response;
- call-attempt row inserted before provider dispatch;
- row updated after completion; a still-`started` row reveals worker death.

Planner and provider attempts share the deadline; fallback receives no fresh budget. Agent escalation must still have time to persist or hand off.

## 19. Acceptance Criteria

1. No new `anthropic`, `google`, or `claude_code` provider row exists.
2. `claude` and `gemini` remain canonical.
3. Database checks make invalid scope/traffic combinations impossible.
4. A tier with `connection_id` resolves exactly it; a tier without it uses only the legacy credential path.
5. Flags off preserve `user_ai_model_overrides` → admin primary → fallback.
6. Existing `ai_model_preferences` rows survive and remain usable.
7. Preference precedence includes social-account `*`.
8. Preferred connection/model pairs have a real FK; disconnect clears dependents.
9. `ai_connection_models` has explicit RLS and no browser mutation grants.
10. User connections cannot serve another user or platform traffic.
11. `own_only` never incurs platform-provider cost.
12. New keys are stored in Vault and never returned.
13. Anthropic agent execution passes tool-use normalization tests.
14. Existing inbound media understanding is routed; no parallel media function exists.
15. A call attempt is durable before dispatch and all retries share a sub-60-second budget.
16. `ai_generation_jobs` remains the V1 media job source of truth.
17. New Deno modules pass `deno check` and tests; CI cannot rely on `deno test --no-check` alone.
18. Claude Code has zero implementation surface.
19. Codex user and platform auth remain disabled until both written decisions pass.

## 20. Production Decisions Still Open

1. Written OpenAI approval for user-scoped Codex in this deployment shape.
2. Written OpenAI approval for administrator/shared Codex traffic, if desired.
3. First Anthropic model/capability allowlist after live contract tests.
4. Whether to migrate every legacy `provider_api_keys` row before the first cohort or during rollout.

These decisions do not block V1 BYOK API-key work except where tied to that provider or migration stage.
