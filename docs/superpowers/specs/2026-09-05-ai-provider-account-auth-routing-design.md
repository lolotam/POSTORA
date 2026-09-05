# AI Provider Account Authentication and Capability Routing

**Date:** 2026-09-05  
**Status:** Proposed  
**Owners:** Full-stack / Platform / Security  
**Product:** POSTORA

## 1. Summary

POSTORA currently uses platform-managed API credentials for most AI workloads and a dual-scope OAuth implementation for Higgsfield. Higgsfield can run with either a platform connection or the signed-in user's own connection. This design generalizes that pattern into a capability-aware AI provider connection and routing system.

The new system lets:

1. A user connect an eligible personal provider account or API key and select how each AI capability should be executed.
2. An administrator continue configuring platform API credentials and, where provider terms permit it, connect a platform account through an account-auth flow.
3. The execution layer choose a compatible provider, model, authentication source, and runtime without leaking credentials or silently moving cost between the user and POSTORA.
4. OpenAI API and Codex appear as distinct providers; Anthropic API and Claude Code appear as distinct providers.

The design does **not** treat a consumer subscription as a general-purpose API key. Subscription-backed products run through their supported first-party runtime:

- Codex through Codex App Server.
- Claude Code only through the unmodified Claude Code runtime and only where Anthropic's terms and commercial approval permit the requested scope.

## 2. Problem

The current provider model is insufficient for account-auth providers:

- `ai_providers.auth_type` models one authentication method per provider.
- platform model selection lives in `system_settings.default_ai_model_<category>`.
- `user_ai_model_overrides` selects a model for a user but does not attach a user-owned credential and is controlled by administrators.
- `_shared/ai-fallback.ts`, `ai-agent-reply`, and media functions contain separate provider-dispatch logic.
- Higgsfield maintains a separate `higgsfield_connections` table and custom resolution path.
- the production container serves a static Vite build through nginx; Supabase Edge Functions cannot safely host long-running Codex App Server or Claude Code processes.

As a result, adding a "Codex" or "Claude Code" OAuth button directly to the existing API provider card would create incorrect billing expectations, fragmented routing, and unsafe credential/runtime ownership.

## 3. Goals

1. Support both user-scoped and platform-scoped provider connections.
2. Preserve existing API-key providers.
3. Add `codex` and `claude_code` as provider identities separate from `openai` and `anthropic`.
4. Let users choose one of three routing modes globally and per capability:
   - `postora_only`
   - `user_first`
   - `user_only`
5. Let administrators manage platform API credentials and eligible account-auth connections from Admin Settings.
6. Discover and show only models that are available to the selected connection and compatible with the capability.
7. Attribute each execution to the correct credential source and cost owner.
8. Fail closed on tenancy, credential, policy, and unsupported-capability errors.
9. Migrate existing Higgsfield behavior without service interruption.
10. Keep rollout reversible through feature flags and additive migrations.

## 4. Non-goals

1. Turning Codex or Claude Code subscriptions into generic OpenAI or Anthropic API credentials.
2. Claiming that one connected model supports chat, vision, image generation, video, speech, and embeddings.
3. Allowing a personal administrator subscription to serve all subscriber traffic without explicit provider approval.
4. Removing POSTORA subscription entitlements, abuse limits, runtime limits, storage limits, or service-level quotas.
5. Replacing the existing Admin default-model chain in the first release.
6. Exposing provider access tokens, refresh tokens, CLI session files, or runtime sockets to the browser.
7. Depending on experimental Codex dynamic tools for the first production slice.

## 5. Current POSTORA Constraints

### 5.1 Existing reusable patterns

- `higgsfield-oauth` supports `scope_kind = platform | user`.
- `resolveHiggsfieldCredential` checks the user connection before the platform connection.
- `ai_generation_jobs.credential_source` records `platform | byo`.
- the connector work already establishes workspace ownership, server-side telemetry, and fail-closed authorization patterns.
- `ai_models.capabilities` is already used by the administrator model picker.

### 5.2 Constraints that shape this design

- service-role clients bypass RLS; every query must explicitly scope `user_id`, `workspace_id`, or `social_account_id`.
- migrations must land before frontend code that references new columns.
- OAuth tokens must remain backend-only and must not appear in logs or client responses.
- `ai-agent-reply` is time-bound by the Edge gateway and currently uses a platform-global model chain.
- POSTORA's agent configuration is account-scoped; provider preference may be user-global with an optional social-account override.
- the current nginx-only container has no long-lived Node/Rust agent runtime.

## 6. Provider Identity Model

Providers are separated by product and execution contract, not only by vendor.

| Provider code | Display name | Runtime | Initial auth methods | Platform scope | User scope |
|---|---|---|---|---|---|
| `openai` | OpenAI API | HTTP API | API key | Yes | Yes, BYOK |
| `codex` | Codex | Codex App Server | ChatGPT managed/device code; API key for diagnostics | Restricted | Yes |
| `anthropic` | Anthropic API | HTTP API | API key | Yes | Yes, BYOK |
| `claude_code` | Claude Code | unmodified Claude Code runtime | first-party account login or API key | Disabled by default | Conditional |
| `google` | Google AI | HTTP API | API key | Yes | Optional BYOK |
| `openrouter` | OpenRouter | HTTP API | API key | Yes | Optional BYOK |
| `higgsfield` | Higgsfield | MCP/OAuth | OAuth | Yes | Yes |

`openai` and `codex` must not share provider codes. `anthropic` and `claude_code` must not share provider codes. Their credentials, rate limits, capabilities, and terms are different.

## 7. Authentication and Traffic Policies

Each authentication method has a traffic policy:

| Policy | Meaning |
|---|---|
| `own_user` | The connection may execute only requests owned by the same user. |
| `admin_only` | The connection may execute administrator diagnostics and administrator-owned tasks only. |
| `platform_shared` | The connection may serve subscriber workloads as a platform credential. |
| `disabled` | Connection may be displayed or tested but cannot execute production traffic. |

### 7.1 Platform API credentials

Existing administrator API credentials remain eligible for `platform_shared`, subject to current provider and plan controls.

### 7.2 Codex account authentication

Codex App Server officially supports managed ChatGPT browser authentication and device-code authentication, reports account plan information, exposes rate-limit status, and can discover models and their input modalities.

Rules:

- a user Codex connection receives `own_user`.
- an administrator Codex subscription connection receives `admin_only` by default.
- `platform_shared` for an administrator Codex subscription is unavailable until a separately documented commercial/terms approval is recorded and the feature flag is enabled.
- POSTORA never converts or exports the Codex session as an OpenAI API key.
- browser/device-code authentication is managed by the Codex runtime, not by custom token scraping.

Official references:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth

### 7.3 Claude Code account authentication

Anthropic distinguishes using the unmodified Claude Code binary from embedding Claude through the Agent SDK. Their current documentation does not permit third-party products to offer Claude.ai login or route Free/Pro/Max credentials through the Agent SDK unless previously approved. It does permit an end user to sign in to an unmodified hosted Claude Code binary under stated conditions.

Rules:

- the normal production Anthropic provider uses an API key through `anthropic`.
- `claude_code` is implemented as a separate runtime adapter, never as an Anthropic API-key adapter.
- user Claude Code connection is feature-flagged and receives `own_user` only after legal/commercial acceptance criteria are satisfied.
- administrator Claude Code login may be shown as `admin_only` for diagnostics, but cannot become platform fallback by default.
- POSTORA must not collect, parse, copy, return, or intermediate Claude.ai session tokens.
- the Claude Code binary must remain unmodified and all first-party authentication options must remain available where the hosted-runtime path is enabled.

Official references:

- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/agent-sdk/overview

## 8. Capability Model

Add `vision` to the existing model categories. The canonical set becomes:

```text
chat | agent | vision | image | video | tts | stt | search | embedding
```

Initial provider eligibility:

| Provider | Chat | Agent | Vision input | Image generation | Video | TTS/STT | Search | Embedding |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| OpenAI API | Yes | Yes | Model-dependent | Model-dependent | Model-dependent | Model-dependent | Model-dependent | Model-dependent |
| Codex | Yes, gated | Yes | Model-dependent | No initial support | No | No | Runtime-dependent | No |
| Anthropic API | Yes | Yes | Model-dependent | No | No | No | Tool-dependent | No |
| Claude Code | Yes, gated | Yes, gated | Test-dependent | No | No | No | Runtime-dependent | No |
| Google AI | Model-dependent | Model-dependent | Model-dependent | Model-dependent | Model-dependent | Model-dependent | Model-dependent | Model-dependent |
| OpenRouter | Catalog-dependent | Catalog-dependent | Catalog-dependent | Catalog-dependent | Catalog-dependent | Catalog-dependent | Catalog-dependent | Catalog-dependent |
| Higgsfield | No | No | Reference-image input only | Yes | Yes | No | No | No |

The matrix is a policy maximum. Actual eligibility is the intersection of:

1. provider policy;
2. connection traffic policy;
3. discovered model capability;
4. administrator enablement;
5. user entitlement;
6. feature rollout flag.

## 9. User Experience

### 9.1 Location

Add an `AI Accounts & Routing` section to `/settings?tab=integrations`. If the integrations tab becomes too dense, it may graduate to `/settings?tab=ai` without changing the backend contract.

### 9.2 Connection cards

Cards initially shown:

- Codex account
- Anthropic API key
- Claude Code account, marked Beta/Conditional
- OpenAI API key, optional BYOK
- Higgsfield account
- other user-enabled providers

Each card shows only non-secret fields:

- connected/disconnected/reconnect required;
- account label or masked email;
- plan type when the provider reports it;
- authentication method;
- supported capabilities;
- last successful health check;
- rate-limit status where supported;
- Connect, Reconnect, Test, Sync models, Disconnect.

### 9.3 Routing preferences

Global default:

- `Use POSTORA providers`
- `Use my accounts first, then POSTORA`
- `Use only my accounts`

Per-capability override:

- source mode;
- preferred connected provider;
- preferred model;
- whether platform fallback is allowed;
- optional social-account override.

When fallback could move cost to POSTORA, the UI must state this before save. A provider limit, expired authentication, or unsupported capability must never silently cause platform billing unless `user_first` and `allow_platform_fallback = true` are both stored.

## 10. Administrator Experience

### 10.1 Admin Settings layout

Extend Admin Settings → AI Providers with two sections:

1. `API Connections`
   - OpenAI API
   - Anthropic API
   - Google AI
   - OpenRouter
   - other current API providers

2. `Account Authentication`
   - Higgsfield OAuth
   - Codex account
   - Claude Code account

Codex and Claude Code appear as small cards adjacent to Higgsfield, as requested. Each card displays its permitted traffic policy. The UI must not imply that a successful administrator login automatically makes the subscription available to all users.

### 10.2 Admin actions

- Connect/reconnect/disconnect account.
- Test authentication without executing an end-user job.
- Synchronize available models and capabilities.
- View plan/rate-limit state where supported.
- Enable or disable the provider.
- Enable allowed capabilities.
- Select provider/model in Chat, Agent, Vision, and other compatible category cards.
- Select `Use as platform fallback` only when the connection has `platform_shared` policy.

If a model is visible but not eligible for platform traffic, the selector shows it disabled with a reason such as `Admin-only account`, `User-owned connections only`, `Commercial approval required`, or `Capability not supported`.

## 11. Data Model

### 11.1 Provider authentication methods

Add a normalized table instead of expanding the single `ai_providers.auth_type` string.

```sql
CREATE TABLE public.ai_provider_auth_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
  method_code text NOT NULL,
  runtime_kind text NOT NULL,
  allowed_scope_kinds text[] NOT NULL,
  default_traffic_policy text NOT NULL,
  requires_commercial_approval boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, method_code)
);
```

Allowed `runtime_kind` values:

```text
http_api | codex_app_server | claude_code | mcp
```

### 11.2 Provider connections

```sql
CREATE TABLE public.ai_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.ai_providers(id),
  auth_method_id uuid NOT NULL REFERENCES public.ai_provider_auth_methods(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'user')),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN (
    'pending', 'connected', 'reconnect_required', 'disabled', 'revoked', 'error'
  )),
  traffic_policy text NOT NULL CHECK (traffic_policy IN (
    'own_user', 'admin_only', 'platform_shared', 'disabled'
  )),
  secret_ref uuid,
  runtime_profile_ref text,
  external_account_id text,
  account_label text,
  plan_type text,
  expires_at timestamptz,
  last_health_at timestamptz,
  last_error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope_kind = 'platform' AND user_id IS NULL) OR
    (scope_kind = 'user' AND user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX ai_provider_connections_user_method_uq
  ON public.ai_provider_connections(provider_id, auth_method_id, user_id)
  WHERE scope_kind = 'user';

CREATE UNIQUE INDEX ai_provider_connections_platform_method_uq
  ON public.ai_provider_connections(provider_id, auth_method_id)
  WHERE scope_kind = 'platform';

CREATE UNIQUE INDEX ai_provider_connections_id_user_uq
  ON public.ai_provider_connections(id, user_id);
```

Raw credentials are not stored in this table. `secret_ref` points to an encrypted server-side secret. CLI/runtime authentication state is owned by an isolated runtime profile referenced by `runtime_profile_ref`.

### 11.3 Connection-specific model availability

```sql
CREATE TABLE public.ai_connection_models (
  connection_id uuid NOT NULL REFERENCES public.ai_provider_connections(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  display_name text,
  capabilities text[] NOT NULL DEFAULT '{}',
  is_available boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (connection_id, model_id)
);
```

`ai_models` remains the administrator's canonical catalog. `ai_connection_models` records what a specific subscription/account can currently use.

### 11.4 User routing preferences

```sql
CREATE TABLE public.user_ai_routing_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_account_id uuid REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  capability text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('postora_only', 'user_first', 'user_only')),
  preferred_connection_id uuid,
  preferred_model_id text,
  allow_platform_fallback boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (preferred_connection_id, user_id)
    REFERENCES public.ai_provider_connections(id, user_id),
  UNIQUE NULLS NOT DISTINCT (user_id, social_account_id, capability)
);
```

Use `capability = '*'` for the user's global default. A social-account-specific row overrides the user-global capability row.

### 11.5 Execution jobs and audit

```sql
CREATE TABLE public.ai_execution_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  social_account_id uuid REFERENCES public.social_accounts(id),
  capability text NOT NULL,
  provider_code text,
  model_id text,
  connection_id uuid REFERENCES public.ai_provider_connections(id),
  credential_source text CHECK (credential_source IN ('user', 'platform')),
  cost_owner text CHECK (cost_owner IN ('user', 'platform')),
  status text NOT NULL,
  idempotency_key text NOT NULL,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
```

Prompt and response bodies do not belong in the audit row. Product content is stored only in its existing domain table when required.

## 12. Routing Semantics

### 12.1 Precedence

For a request `(user, social_account, capability)`:

1. exact social-account capability preference;
2. user-global capability preference;
3. user-global `*` preference;
4. default `postora_only`.

### 12.2 Candidate construction

`AiExecutionPlanner` returns an ordered list of candidates.

For `postora_only`:

1. administrator primary;
2. administrator fallback;
3. administrator fallback 2;
4. configured last resort where the category permits one.

For `user_first`:

1. selected user connection/model;
2. other user candidates only if explicitly configured later;
3. administrator chain only when `allow_platform_fallback = true`.

For `user_only`:

1. selected user connection/model;
2. no platform candidate.

### 12.3 Failure behavior

- `AUTH_EXPIRED`: mark reconnect required; fall back only with explicit permission.
- `RATE_LIMITED`: show provider reset information where available; fall back only with explicit permission.
- `CAPABILITY_UNSUPPORTED`: do not call the provider.
- `MODEL_UNAVAILABLE`: refresh catalog once, then fail/fallback.
- `PROVIDER_TIMEOUT`: retry only within the remaining request deadline.
- `POLICY_BLOCKED`: never fallback to another authentication scope silently.
- `RUNTIME_UNAVAILABLE`: retry boundedly; asynchronous workloads remain queued.
- `ALL_CANDIDATES_FAILED`: return a stable public error and store sanitized diagnostics.

## 13. Runtime Architecture

Add a private long-running service:

```text
services/agent-runtime/
```

Responsibilities:

- spawn and supervise Codex App Server processes;
- optionally supervise the unmodified Claude Code binary when enabled;
- own per-user/per-connection runtime profiles;
- execute login, logout, account status, model discovery, rate-limit reads, and turns;
- stream internal events or return bounded results;
- enforce concurrency, memory, disk, and execution deadlines;
- emit sanitized metrics and audit events.

The service is not internet-public. Supabase Edge Functions call it through a signed internal request. Prefer an internal Unix socket on one host or private HTTPS with mTLS/service JWT across hosts. Codex App Server should use stdio or an internal Unix socket; do not expose its experimental WebSocket transport publicly.

### 13.1 Runtime isolation

Each connection receives:

- opaque runtime profile id;
- separate encrypted persistent directory;
- separate process environment;
- separate session/thread namespace;
- no access to another user's files or credentials;
- restricted network policy;
- read-only or ephemeral workspace for non-coding POSTORA tasks.

Automated customer replies must not receive shell or filesystem tools. Agent tools are supplied only through explicitly allowlisted POSTORA adapters after tool-compatibility tests pass.

### 13.2 Synchronous and asynchronous execution

- short caption/chat/vision calls: synchronous with a strict deadline below the Edge gateway limit;
- long agent/media tasks: create `ai_execution_jobs`, enqueue, then stream/poll status;
- webhook auto-replies: bounded attempt, then human escalation rather than an unbounded runtime turn.

## 14. Backend Contracts

### 14.1 `ai-provider-connections` Edge Function

Actions:

```text
list
start_auth
complete_auth
status
test
sync_models
disconnect
save_user_api_key
set_traffic_policy   # admin only
```

Every action authenticates the caller before parsing mutable scope fields. Platform scope requires admin role. User scope derives `user_id` from the verified bearer token and ignores any client-supplied user id.

### 14.2 `ai-execute` Edge Function

Input:

```ts
type AiExecutionRequest = {
  capability: AiCapability;
  socialAccountId?: string;
  modelHint?: string;
  input: unknown;
  idempotencyKey: string;
  deadlineMs?: number;
};
```

Output:

```ts
type AiExecutionResponse = {
  executionId: string;
  status: 'succeeded' | 'queued';
  output?: unknown;
  provider: string;
  model: string;
  credentialSource: 'user' | 'platform';
  fallbackUsed: boolean;
};
```

The response never includes a provider token, secret reference, runtime profile path, or raw internal error.

### 14.3 Adapter interface

```ts
interface AiProviderAdapter {
  providerCode: string;
  runtimeKind: RuntimeKind;
  supports(capability: AiCapability, model: ConnectionModel): boolean;
  health(connection: ResolvedConnection): Promise<HealthResult>;
  listModels(connection: ResolvedConnection): Promise<DiscoveredModel[]>;
  execute(request: AdapterExecutionRequest): Promise<AdapterExecutionResult>;
}
```

Adapters:

```text
OpenAiApiAdapter
CodexAppServerAdapter
AnthropicApiAdapter
ClaudeCodeAdapter
GoogleAiAdapter
OpenRouterAdapter
HiggsfieldAdapter
```

## 15. Credential Security

1. API keys and OAuth refresh tokens are encrypted in a server-side secret store or Vault.
2. browsers receive only connection ids and masked metadata.
3. OAuth uses PKCE, one-time state, expiry, verified redirect allowlists, and caller ownership.
4. disconnect attempts provider revocation where supported, then destroys the local secret/runtime profile.
5. logs redact Authorization headers, tokens, device codes, callback codes, and filesystem paths.
6. runtime-profile identifiers are opaque and cannot contain a user email or account id.
7. secret rotation and reconnect do not change the public connection id.
8. service-role reads explicitly filter the connection owner.
9. admin test endpoints cannot accept arbitrary URLs, commands, or model endpoints.
10. migrate Higgsfield raw token storage to the canonical secret store after the generic path is stable.

## 16. Billing, Quota, and Cost Attribution

`credential_source` and `cost_owner` are separate concepts.

| Execution source | Provider cost owner | POSTORA AI-credit behavior |
|---|---|---|
| User API key/account | User | Do not debit platform AI-provider credits |
| Platform API key | Platform | Apply normal platform quota/credit rules |
| Approved platform account auth | Platform | Apply normal platform quota/credit rules |

User-owned execution may still require an eligible POSTORA plan and remains subject to abuse, concurrency, storage, and runtime limits. The UI must say `Uses your provider allowance` rather than `Free`.

Before platform fallback, quota is reserved atomically. Failed provider dispatch releases the reservation. A successful user-owned attempt never reserves platform AI-provider quota.

## 17. Observability

Metrics:

- executions by capability/provider/model;
- credential source and cost owner;
- fallback rate and reason;
- auth-expiry rate;
- provider latency/error rate;
- runtime queue depth and process restarts;
- model catalog age;
- rate-limit exhaustion by connection without exposing account identity.

Audit events:

```text
ai_provider_connection_started
ai_provider_connection_succeeded
ai_provider_connection_failed
ai_provider_connection_disconnected
ai_provider_models_synced
ai_routing_preference_changed
ai_platform_fallback_used
ai_execution_refused
```

Every policy refusal is recorded with a stable code. No prompt, response, API key, OAuth code, device code, or token is logged.

## 18. Feature Flags

```text
ai_provider_connections_enabled
ai_user_routing_enabled
ai_codex_user_auth_enabled
ai_codex_platform_shared_enabled
ai_claude_code_user_auth_enabled
ai_claude_code_platform_shared_enabled
ai_agent_runtime_enabled
ai_generic_higgsfield_adapter_enabled
```

All default to false except flags explicitly activated after their migration and deployment prerequisites are verified.

## 19. Rollout Strategy

1. Add schema and read-only admin visibility.
2. Add HTTP API-key adapters and router shadow evaluation.
3. Migrate Higgsfield behind the generic adapter while preserving its existing tables and endpoint.
4. Add user routing UI for Higgsfield and BYOK providers.
5. deploy `agent-runtime` with no external provider enabled.
6. enable Codex user auth for an internal cohort.
7. enable Codex chat/vision, then agent after tool and latency acceptance tests.
8. enable Claude Code user auth only after the policy gate is satisfied.
9. keep administrator subscription connections `admin_only` until explicit provider approval for shared traffic.
10. migrate remaining AI entry points one capability at a time.

Rollback is flag-based. Existing Admin `system_settings` and Higgsfield-specific routes remain valid until the new path has production evidence.

## 20. Acceptance Criteria

1. A user can connect Codex through the first-party managed flow without POSTORA receiving a raw ChatGPT token in the browser.
2. A user can select `postora_only`, `user_first`, or `user_only` globally and per capability.
3. A user-owned successful execution never debits platform AI-provider quota.
4. platform fallback occurs only with explicit stored permission.
5. an expired user connection in `user_only` mode fails with reconnect guidance and no platform call.
6. Admin Settings shows separate OpenAI/Codex and Anthropic/Claude Code providers.
7. Codex/Claude Code models cannot be selected for unsupported image/video/audio/embedding categories.
8. an administrator subscription connection cannot serve subscriber traffic while its traffic policy is `admin_only`.
9. every provider call records provider, model, credential source, cost owner, result, and sanitized failure code.
10. no credential is returned by RLS reads, Edge Function responses, logs, or runtime metrics.
11. current Higgsfield user and platform flows remain operational during migration.
12. disabling all new feature flags restores the current production routing behavior.

## 21. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Consumer subscription used as shared backend | traffic-policy gate; commercial approval flag; admin subscriptions default to `admin_only`. |
| Subscription limits produce unpredictable availability | expose rate-limit health; explicit fallback preference; stable reconnect/limit errors. |
| Cross-user credential/session leak | per-connection runtime isolation; composite ownership FK; explicit service-role tenancy. |
| Edge timeout on agent runtime | strict deadlines; async jobs; bounded auto-reply; human escalation. |
| Provider catalog changes | connection-scoped discovery; short cache TTL; one refresh on model-unavailable. |
| Unsupported capability shown in UI | intersection-based capability resolver; disabled options with reason. |
| Existing Higgsfield regression | adapter compatibility layer; feature flag; dual-read before cutover. |
| CLI agent can execute unintended tools | no shell/filesystem for autoresponders; allowlisted tools; sandbox and network restrictions. |
| Secrets remain in legacy tables | staged Vault migration and credential rotation. |

## 22. Open Decisions Before Production Enablement

1. Which POSTORA plans may connect user-owned providers?
2. Does user-owned execution bypass only AI credits or also feature-specific daily quotas?
3. Should preferences be user-global initially, or user-global plus social-account override in v1?
4. Which Codex workloads qualify for the first cohort: chat, vision, or an interactive agent workspace?
5. Has OpenAI approved/confirmed any intended administrator subscription shared-traffic use?
6. Has Anthropic approved the Claude Code hosting and authentication experience for POSTORA's intended use?
7. Which secret store is authoritative for new credentials and the Higgsfield migration?
8. What is the maximum synchronous deadline and concurrency per POSTORA plan?

Until decisions 5 and 6 are documented, administrator Codex and Claude Code account connections remain `admin_only` and cannot be selected as platform fallback for subscriber traffic.
