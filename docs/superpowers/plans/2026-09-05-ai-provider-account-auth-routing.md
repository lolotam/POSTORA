# AI Provider Account Authentication and Capability Routing — Implementation Plan

**Date:** 2026-09-05  
**Status:** Proposed  
**Design:** `docs/superpowers/specs/2026-09-05-ai-provider-account-auth-routing-design.md`

## Goal

Implement a full-stack, capability-aware provider connection and routing system for POSTORA. Users can run eligible AI services from their own connected provider account or API key, while administrators keep the current platform API configuration and gain account-auth cards for Higgsfield, Codex, and Claude Code.

The delivery must preserve current production behavior until a feature flag enables each new slice.

## Final User Outcomes

1. Users can connect eligible personal AI providers.
2. Users can choose POSTORA only, own account first with explicit fallback, or own account only.
3. Users can choose provider/model per capability.
4. Admin Settings shows OpenAI API and Codex separately, and Anthropic API and Claude Code separately.
5. Admin account-auth cards appear alongside Higgsfield.
6. Models are selectable only where their capability and traffic policy permit execution.
7. Every call identifies whether the user or POSTORA owns the provider cost.

## Non-negotiable Safety Rules

1. Apply database migrations before deploying code that names new tables or columns.
2. Never expose API keys, OAuth tokens, device codes, auth callback codes, CLI session files, secret ids, or runtime paths to the browser.
3. Every service-role query includes explicit tenancy constraints.
4. No silent user-to-platform cost fallback.
5. Admin Codex and Claude Code subscriptions start as `admin_only`, not shared platform fallback.
6. Claude Code subscription support remains disabled until the design's policy gate is satisfied.
7. Codex App Server and Claude Code are never started inside a Supabase Edge Function.
8. Agent runtime transports are private; no public experimental app-server WebSocket.
9. Automated replies receive no shell/filesystem tools.
10. Existing Higgsfield behavior remains available behind a rollback flag throughout migration.

## Delivery Order

```text
Policy gates
  -> schema and RLS
  -> domain resolver
  -> HTTP API adapters
  -> Higgsfield compatibility
  -> connection API
  -> agent runtime
  -> Codex auth
  -> Claude Code conditional auth
  -> user UI
  -> admin UI
  -> workload migrations
  -> observability and rollout
```

## Proposed File Structure

```text
src/features/ai-provider-connections/
  domain/
    types.ts
    capabilityPolicy.ts
    routingPreference.ts
  application/
    buildExecutionPlan.ts
    connectionCommands.ts
    connectionQueries.ts
  infrastructure/
    supabaseConnectionsRepository.ts
    supabaseRoutingPreferencesRepository.ts
  ui/
    AiAccountsRoutingPanel.tsx
    AiProviderConnectionCard.tsx
    AiRoutingModeSelector.tsx
    CapabilityRoutingTable.tsx
    ProviderModelPicker.tsx
  index.ts

src/components/admin/settings/ai/
  AiAuthenticationCards.tsx
  PlatformProviderConnectionCard.tsx
  ProviderEligibilityBadge.tsx

supabase/functions/_shared/ai-routing/
  types.ts
  capability-policy.ts
  preference-resolution.ts
  execution-planner.ts
  credential-resolution.ts
  errors.ts
  telemetry.ts
  adapters/
    openai-api.ts
    anthropic-api.ts
    google-ai.ts
    openrouter.ts
    higgsfield.ts
    agent-runtime.ts

supabase/functions/ai-provider-connections/index.ts
supabase/functions/ai-execute/index.ts
supabase/functions/ai-runtime-callback/index.ts

services/agent-runtime/
  Dockerfile
  package.json
  tsconfig.json
  src/
    server.ts
    config.ts
    auth/internalAuth.ts
    connections/connectionStore.ts
    execution/executionService.ts
    execution/jobLease.ts
    runtime/runtimeSupervisor.ts
    runtime/runtimeProfile.ts
    providers/codex/CodexAppServerClient.ts
    providers/codex/CodexAuthService.ts
    providers/codex/CodexExecutionAdapter.ts
    providers/claude/ClaudeCodeAuthService.ts
    providers/claude/ClaudeCodeExecutionAdapter.ts
    security/redaction.ts
    telemetry/metrics.ts
  tests/
```

## Slice 0 — Policy Gates and Provider Registry Decisions

### Task 0.1: Record approval state

Create:

- `docs/runbooks/ai-subscription-provider-approval.md`

Document:

- provider;
- permitted authentication flow;
- permitted user scope;
- permitted platform/shared scope;
- agreement/contact reference;
- approval owner and date;
- expiration or review date.

Acceptance:

- absence of an approval record means `platform_shared` is unavailable for Codex and Claude Code subscription auth.
- Claude Code user-auth flag also stays false until the hosted-binary requirements have been accepted.

### Task 0.2: Add feature-flag keys

Add migration:

- `supabase/migrations/20260905120000_ai_provider_connection_flags.sql`

Seed all flags from the design with safe defaults. Do not overwrite an existing operator value on replay.

Tests:

- migration replay test;
- settings read test;
- non-admin write denied.

## Slice 1 — Database Schema, RLS, and Seed Data

### Task 1.1: Provider/auth method schema

Add:

- `supabase/migrations/20260905121000_ai_provider_auth_methods.sql`

Actions:

1. Create `ai_provider_auth_methods`.
2. Add CHECK constraints for runtime kind, scope, and default traffic policy.
3. Keep `ai_providers.auth_type` unchanged for compatibility.
4. Seed auth methods idempotently.
5. Seed distinct provider rows for `codex`, `anthropic`, and `claude_code` if absent.
6. Do not rename the existing `openai` or `higgsfield` provider rows.

Seed examples:

| Provider | Method | Runtime | Default policy |
|---|---|---|---|
| openai | api_key | http_api | platform_shared / own_user by scope |
| codex | chatgpt_device_code | codex_app_server | own_user |
| codex | chatgpt_browser | codex_app_server | own_user |
| anthropic | api_key | http_api | platform_shared / own_user by scope |
| claude_code | first_party_login | claude_code | own_user, disabled flag |
| higgsfield | oauth_pkce | mcp | scope-dependent |

### Task 1.2: Connections and model availability

Add:

- `supabase/migrations/20260905122000_ai_provider_connections.sql`

Create:

- `ai_provider_connections`
- `ai_connection_models`

RLS/grants:

- authenticated user may read only non-secret columns on their own user connections;
- authenticated user may delete/disconnect only through the Edge Function, not update secret metadata directly;
- platform connections are admin-readable through an RPC/view with secret columns omitted;
- service role has required access;
- anon has zero access.

Add safe views:

- `user_ai_provider_connection_status`
- `admin_ai_provider_connection_status`

Views must exclude `secret_ref`, `runtime_profile_ref`, and internal errors.

### Task 1.3: User routing preferences

Add:

- `supabase/migrations/20260905123000_user_ai_routing_preferences.sql`

Create:

- `user_ai_routing_preferences`
- ownership-safe composite FK for the preferred user connection;
- capability CHECK including new `vision` category;
- unique global/per-account preference rule.

Add RPCs:

- `get_effective_ai_routing_preference(p_user_id, p_social_account_id, p_capability)` service-role only;
- `upsert_my_ai_routing_preference(...)` authenticated, derives owner from `auth.uid()`;
- `delete_my_ai_routing_preference(...)` authenticated, derives owner from `auth.uid()`.

Do not accept an arbitrary target user id from browser calls.

### Task 1.4: Execution jobs and audit

Add:

- `supabase/migrations/20260905124000_ai_execution_jobs.sql`

Create:

- `ai_execution_jobs`
- indexes for user history, queued jobs, connection/model analytics;
- idempotency uniqueness;
- append-only audit protections;
- user-safe execution status view.

### Task 1.5: Migration harness

Update the existing PostgreSQL test harness with tests for:

- idempotent replay;
- CHECK constraints;
- RLS ownership;
- composite FK rejecting another user's connection;
- platform connection hidden from normal users;
- no token/secret column in safe views;
- service-role RPC execution;
- anon has no grants.

Gate:

- apply Slices 1.1–1.4 to production before any frontend merge that queries them.

## Slice 2 — Shared Domain Types and Capability Policy

### Task 2.1: Frontend domain types

Create:

- `src/features/ai-provider-connections/domain/types.ts`
- `src/features/ai-provider-connections/domain/capabilityPolicy.ts`

Update:

- `src/hooks/ai-config/types.ts`
- `src/hooks/useAIConfiguration.ts`
- `src/components/admin/DefaultModelSelector.tsx`

Changes:

- add `vision` to `ModelCategory`;
- add runtime kind, auth method, scope, traffic policy, connection status, cost owner;
- define provider maximum-capability matrix;
- provide a pure `modelEligibility()` function returning `{ eligible, reason }`.

Tests:

- Codex cannot select image/video/tts/stt/embedding in v1;
- Claude Code cannot select media-generation categories;
- connection-discovered capabilities cannot exceed provider policy;
- `admin_only` cannot serve a subscriber execution;
- `platform_shared` is rejected when approval flag is false.

### Task 2.2: Backend mirror

Create:

- `supabase/functions/_shared/ai-routing/types.ts`
- `supabase/functions/_shared/ai-routing/capability-policy.ts`
- `supabase/functions/_shared/ai-routing/capability-policy.test.ts`

The backend is authoritative. Keep the frontend matrix as a UI mirror and point its header comment at the backend authority.

## Slice 3 — Routing Preference Resolution and Execution Planner

### Task 3.1: Pure preference precedence

Create:

- `src/features/ai-provider-connections/domain/routingPreference.ts`
- `supabase/functions/_shared/ai-routing/preference-resolution.ts`
- matching Vitest and Deno tests.

Test precedence:

1. social-account capability;
2. user capability;
3. user `*`;
4. `postora_only`.

### Task 3.2: Backend execution planner

Create:

- `supabase/functions/_shared/ai-routing/execution-planner.ts`
- `supabase/functions/_shared/ai-routing/execution-planner.test.ts`

The planner must:

- authenticate ownership before resolving preferences;
- load only connected/healthy candidates;
- validate capability and model availability;
- enforce traffic policy;
- build user candidates before platform candidates only for `user_first`;
- omit all platform candidates for `user_only`;
- preserve current Admin primary/fallback/fallback2 order for `postora_only`;
- include a deterministic reason for every skipped candidate.

Required tests:

- default current behavior with flags off;
- user-owned success path;
- user-owned expired connection;
- explicit platform fallback;
- fallback prohibited;
- unsupported model;
- another user's connection id;
- admin-only subscription offered to subscriber request;
- no configured candidates.

### Task 3.3: Error taxonomy

Create:

- `supabase/functions/_shared/ai-routing/errors.ts`

Stable codes:

```text
AI_CONNECTION_REQUIRED
AI_RECONNECT_REQUIRED
AI_MODEL_UNAVAILABLE
AI_CAPABILITY_UNSUPPORTED
AI_PROVIDER_RATE_LIMITED
AI_PROVIDER_TIMEOUT
AI_RUNTIME_UNAVAILABLE
AI_PLATFORM_FALLBACK_DISABLED
AI_POLICY_BLOCKED
AI_NOT_CONFIGURED
AI_ALL_CANDIDATES_FAILED
```

Separate sanitized user messages from operator diagnostics.

## Slice 4 — HTTP API Provider Adapters

### Task 4.1: Credential resolution

Create:

- `supabase/functions/_shared/ai-routing/credential-resolution.ts`

Resolution rules:

- user connection secret only for the same authenticated owner;
- platform connection secret only for an eligible platform candidate;
- environment variable compatibility remains during migration;
- no environment credential is used for a user-owned candidate;
- secret-store failure fails closed.

### Task 4.2: Adapter interface and API adapters

Create:

- `supabase/functions/_shared/ai-routing/adapters/openai-api.ts`
- `supabase/functions/_shared/ai-routing/adapters/anthropic-api.ts`
- `supabase/functions/_shared/ai-routing/adapters/google-ai.ts`
- `supabase/functions/_shared/ai-routing/adapters/openrouter.ts`

Normalize:

- text/chat response;
- structured output where supported;
- image input;
- provider error classification;
- timeout/abort;
- usage metadata;
- rate-limit metadata.

Do not place API-specific branching back into feature Edge Functions.

Tests use stubbed fetch only. Include non-2xx, 200-with-error payload, malformed JSON, timeout, empty output, and token-redaction cases.

### Task 4.3: Replace `getAiEndpoint` behavior behind a flag

Update:

- `supabase/functions/_shared/ai-fallback.ts`

Add an adapter bridge while preserving the old exports. Do not delete the legacy path until all callers have migrated.

Acceptance:

- OpenAI is never accidentally routed to the Google-compatible endpoint.
- provider-specific headers and request shapes live in their adapter.

## Slice 5 — Generalize Higgsfield Without Breaking Production

### Task 5.1: Higgsfield adapter

Create:

- `supabase/functions/_shared/ai-routing/adapters/higgsfield.ts`

Wrap:

- `resolveHiggsfieldCredential`;
- model discovery;
- generation execution;
- refresh/reconnect mapping;
- BYO vs platform attribution.

Do not change the existing resolver's behavior in this task.

### Task 5.2: Connection metadata dual-write

Update:

- `supabase/functions/higgsfield-oauth/index.ts`

When the generic flag is enabled:

- continue writing the existing Higgsfield record;
- upsert non-secret canonical connection metadata;
- sync connection models;
- keep legacy reads as authoritative until a later cutover flag.

Tests:

- platform scope admin only;
- user scope ignores supplied user id;
- status returns no token;
- disconnect clears both metadata paths;
- failed generic dual-write does not falsely report successful generic connection;
- existing Higgsfield generation still works with generic flags off.

### Task 5.3: Secret-store migration

After dual-write production evidence:

1. migrate Higgsfield refresh/access tokens to the canonical secret store;
2. rotate or refresh credentials;
3. switch resolver to `secret_ref`;
4. verify no client access;
5. null/remove legacy token values only in a separate, recoverable migration after rollback window closes.

## Slice 6 — Provider Connection Edge API

### Task 6.1: Connection endpoint

Create:

- `supabase/functions/ai-provider-connections/index.ts`

Implement actions:

- `list`
- `start_auth`
- `complete_auth`
- `status`
- `test`
- `sync_models`
- `disconnect`
- `save_user_api_key`
- `set_traffic_policy`

Rules:

- authenticate before action dispatch;
- platform actions require admin;
- user actions derive owner from auth;
- validate provider/method/scope compatibility;
- rate-limit auth start, callback, test, and sync actions;
- redact provider errors;
- audit every mutation and refusal.

### Task 6.2: Internal runtime client

Create:

- `supabase/functions/_shared/ai-routing/adapters/agent-runtime.ts`

It signs requests with:

- timestamp;
- request id;
- method/path/body hash;
- short-lived internal JWT or HMAC;
- replay window.

Tests:

- valid signature;
- expired signature;
- body tampering;
- replayed request id;
- runtime timeout;
- sanitized error response.

## Slice 7 — `agent-runtime` Service Foundation

### Task 7.1: Service scaffold

Create the `services/agent-runtime` tree from the file structure above.

Choose a supported Node.js LTS runtime and pin dependency versions. The service must have:

- `/health/live`
- `/health/ready`
- internal auth middleware;
- JSON request-size limits;
- structured redacted logs;
- graceful shutdown;
- per-connection concurrency limits;
- global overload protection;
- runtime version reporting.

### Task 7.2: Runtime profiles

Implement:

- opaque profile identifiers;
- path allowlist rooted in one dedicated volume;
- one profile per connection;
- encrypted persistent storage at rest;
- lifecycle lock to prevent simultaneous auth mutation;
- secure deletion/tombstone on disconnect;
- no email/user id in filesystem path;
- ownership lookup through the database connection id.

### Task 7.3: Runtime supervisor

Implement:

- spawn/stop/restart;
- stdio JSON-RPC framing for Codex App Server;
- bounded stdout/stderr buffers;
- process timeout and kill escalation;
- circuit breaker;
- process count and memory caps;
- version compatibility check;
- no arbitrary command from HTTP request input.

### Task 7.4: Deployment

Add:

- `services/agent-runtime/Dockerfile`
- a dedicated service in `docker-compose.yml` or the production deployment manifest;
- internal network only;
- persistent encrypted auth volume;
- health checks;
- CPU/memory/process limits;
- runtime secret injection;
- no public port mapping.

The existing nginx `postora` container remains unchanged except for its deployment relationship.

## Slice 8 — Codex Authentication and Execution

### Task 8.1: Codex App Server client

Create:

- `services/agent-runtime/src/providers/codex/CodexAppServerClient.ts`

Implement protocol operations:

- initialize;
- account read;
- login start with `chatgptDeviceCode`;
- optional managed browser login for supported deployment topology;
- login completion notifications;
- logout;
- rate-limit read;
- model list;
- thread start/turn start;
- cancellation and timeout;
- clean shutdown.

Generate/pin protocol schemas from the installed Codex version. CI must fail when the runtime version changes without regenerated schemas.

### Task 8.2: Codex auth service

Create:

- `services/agent-runtime/src/providers/codex/CodexAuthService.ts`

Flow:

1. Edge creates a pending connection owned by the caller.
2. Runtime creates/locks the profile.
3. Runtime starts device-code login.
4. Browser receives only verification URL, user code, connection id, and expiry.
5. Runtime watches completion.
6. Backend stores connected metadata and runtime profile reference.
7. Runtime syncs models, plan type, and rate limits.

Do not send Codex auth files or ChatGPT tokens to Supabase rows or the browser.

### Task 8.3: Codex execution adapter

Create:

- `services/agent-runtime/src/providers/codex/CodexExecutionAdapter.ts`

Initial capabilities:

- `chat`, feature-flagged;
- `vision`, only for models whose discovered `inputModalities` includes image;
- `agent`, only after the separate agent-tool acceptance gate.

Restrictions:

- ephemeral/read-only workspace for POSTORA content tasks;
- no shell/process/filesystem tools for automatic replies;
- no image/video/audio generation claim;
- bounded turns and output size;
- no thread reuse across users;
- record rate-limit failure without exposing account details.

### Task 8.4: Admin Codex card policy

An admin may connect and test Codex. Persist `traffic_policy = admin_only` unless both:

- approval record exists;
- `ai_codex_platform_shared_enabled = true`.

Backend enforcement is mandatory even if the UI button is disabled.

### Task 8.5: Codex tests

Add protocol fakes covering:

- successful device-code login;
- cancel and expiry;
- login notification failure;
- model discovery;
- image input rejected by text-only model;
- rate-limit exhaustion;
- one user's profile requested by another;
- admin-only connection used for subscriber request;
- process crash and restart;
- stderr token redaction;
- timeout/cancellation.

## Slice 9 — Claude Code Conditional Authentication

### Task 9.1: Hard policy gate

Before installing or enabling runtime auth, assert:

- approval/terms record present;
- unmodified binary requirement accepted;
- first-party authentication flow preserved;
- no token collection/intermediation;
- each end user authenticates their own connection;
- platform-shared policy separately approved if ever requested.

If the gate is absent, backend returns `AI_POLICY_BLOCKED`; UI shows `Unavailable pending provider approval`.

### Task 9.2: Claude Code runtime adapter

Create:

- `services/agent-runtime/src/providers/claude/ClaudeCodeAuthService.ts`
- `services/agent-runtime/src/providers/claude/ClaudeCodeExecutionAdapter.ts`

Requirements:

- run the published unmodified binary;
- preserve all first-party auth methods;
- store runtime state only inside the isolated profile;
- never parse/copy/export Claude.ai tokens;
- prevent `ANTHROPIC_API_KEY` from accidentally overriding a subscription-auth profile;
- distinguish subscription from API billing in status;
- no shared admin subscription traffic by default.

### Task 9.3: Anthropic API remains independent

The `anthropic` HTTP adapter from Slice 4 is the supported platform path regardless of Claude Code flag state. Its Admin card accepts API credentials and can be selected in Chat, Agent, and Vision categories when compatible models are active.

### Task 9.4: Claude tests

Cover:

- policy gate missing;
- API key accidentally present in subscription profile environment;
- user ownership isolation;
- admin-only traffic enforcement;
- first-party login handoff without token capture;
- unsupported media capability;
- runtime exit/rate limit/reconnect state.

## Slice 10 — User Settings UI

### Task 10.1: Query/mutation layer

Create:

- `src/features/ai-provider-connections/application/connectionQueries.ts`
- `src/features/ai-provider-connections/application/connectionCommands.ts`
- infrastructure repositories.

Use React Query keys scoped by authenticated user and social account. Never cache secrets because no secret enters the client.

### Task 10.2: Accounts and routing panel

Create:

- `AiAccountsRoutingPanel.tsx`
- `AiProviderConnectionCard.tsx`
- `AiRoutingModeSelector.tsx`
- `CapabilityRoutingTable.tsx`
- `ProviderModelPicker.tsx`

Update:

- `src/pages/Settings.tsx`
- `src/components/automation/DatabaseConnectorsManager.tsx`

Recommended placement:

- render the new panel before the general database/app connector manager in the integrations tab;
- retain Higgsfield's current connector preset during compatibility rollout;
- avoid displaying duplicate Connect actions by having the legacy Higgsfield card deep-link to the canonical AI account card once enabled.

### Task 10.3: User UX states

Implement:

- disconnected;
- connecting with device code;
- connected;
- model syncing;
- reconnect required;
- provider rate limited;
- policy unavailable;
- connection disabled by admin;
- platform fallback explicitly on/off.

The save button must explain when `user_first` can consume POSTORA quota after user-provider failure.

### Task 10.4: User UI tests

Vitest/Testing Library:

- only eligible providers/models appear;
- another user's status is never rendered;
- `user_only` hides/disables platform fallback;
- `user_first` requires explicit fallback checkbox;
- device-code URL/code rendered without token fields;
- reconnect flow;
- policy-blocked Claude Code card;
- account-specific preference overrides global preference;
- switching accounts does not save to the previous account.

Playwright:

- connect/status/disconnect with fake provider runtime;
- global preference save;
- per-capability save;
- per-social-account override;
- fallback warning and confirmation.

## Slice 11 — Admin Authentication UI and Model Selectors

### Task 11.1: Authentication cards

Create:

- `src/components/admin/settings/ai/AiAuthenticationCards.tsx`
- `PlatformProviderConnectionCard.tsx`
- `ProviderEligibilityBadge.tsx`

Update:

- `src/components/admin/settings/ai/AiProvidersCard.tsx`
- `src/components/admin/AdminAiSettings.tsx`
- admin settings catalog/search entries.

Render two groups:

1. API Connections.
2. Account Authentication, with Higgsfield, Codex, and Claude Code adjacent.

Each account card supports status, connect, reconnect, test, sync, and disconnect. Only eligible connections show `Use as platform fallback`.

### Task 11.2: Distinct providers in model cards

Update:

- `src/components/admin/DefaultModelSelector.tsx`
- `src/components/admin/settings/ai/AiCategoryCards.tsx`
- `src/hooks/useAIConfiguration.ts`

Requirements:

- provider groups show `OpenAI API`, `Codex`, `Anthropic API`, `Claude Code` separately;
- add a Vision category card;
- filter models by capability, connection availability, and traffic policy;
- show badges `API`, `Account`, `Platform`, `Admin only`, `User only`, `Approval required`;
- disabled model includes the backend-derived reason;
- never allow admin-only auth as a platform chain candidate.

### Task 11.3: Admin API changes

Update:

- `supabase/functions/ai-config/index.ts`

Add actions:

- list provider auth methods;
- list safe platform connection status;
- update provider capability enablement;
- validate model chain candidate eligibility;
- reject a subscription-auth model if no eligible platform-shared connection exists.

Existing `set-service-key` remains supported.

### Task 11.4: Admin tests

Cover:

- non-admin forbidden;
- Codex/Claude cards visible with correct policy;
- admin login succeeds but shared toggle remains disabled;
- Anthropic API model selectable while Claude Code is gated;
- Vision model filters;
- no unsupported media selection;
- stale model availability;
- platform chain refuses admin-only connection server-side.

## Slice 12 — Unified Execution API and Quota Reservation

### Task 12.1: `ai-execute`

Create:

- `supabase/functions/ai-execute/index.ts`

Flow:

1. authenticate caller;
2. validate capability input schema;
3. check POSTORA feature entitlement;
4. resolve preference and candidate plan;
5. create idempotent execution row;
6. attempt candidates within deadline;
7. reserve platform quota immediately before first platform call;
8. release reservation if platform dispatch fails;
9. persist result attribution and sanitized error;
10. return normalized response or queued status.

### Task 12.2: Telemetry helper

Create:

- `supabase/functions/_shared/ai-routing/telemetry.ts`

Fields:

- execution id;
- user id;
- social account id;
- capability;
- provider/model;
- connection id;
- credential source;
- cost owner;
- candidate tier;
- fallback reason;
- latency/status/error code;
- token/usage counts where safe;
- no prompt/response/token.

### Task 12.3: Quota RPC

Add:

- `supabase/migrations/20260905125000_ai_execution_quota_reservation.sql`

Create atomic reserve/release/settle semantics generalized from Higgsfield. User-owned successful execution must not reserve platform AI-provider quota. POSTORA plan/concurrency/abuse limits remain separate checks.

Tests include concurrency races and idempotent settlement.

## Slice 13 — Migrate Chat, Caption, and Hashtags

### Task 13.1: Caption and hashtag callers

Update:

- `supabase/functions/generate-caption/index.ts`
- `supabase/functions/generate-hashtags/index.ts`

Route through the planner/adapters behind `ai_user_routing_enabled`.

Preserve:

- current response shape;
- prompt templates;
- current platform chain when flag is off;
- existing logging contract until the new audit is verified.

Tests:

- platform-only parity;
- user OpenAI/Anthropic BYOK;
- user Codex chat under flag;
- explicit platform fallback;
- `user_only` failure;
- no duplicate platform quota charge;
- timeout within Edge budget.

### Task 13.2: Vision entry point

If no canonical vision function exists, create:

- `supabase/functions/analyze-media/index.ts`

Do not overload image generation. Vision input and image generation are separate capabilities and model selectors.

Tests:

- text-only model rejection before provider call;
- image URL ownership/expiry validation;
- user Codex model with image modality;
- Anthropic/OpenAI API vision;
- content-size bounds.

## Slice 14 — Migrate AI Agent Reply

### Task 14.1: Planner integration

Update:

- `supabase/functions/ai-agent-reply/index.ts`
- `supabase/functions/ai-agent-reply/logic.ts`

Replace the platform-global model selection at the execution boundary with `AiExecutionPlanner`, preserving the existing prompt, knowledge, handoff, account ownership, and tool logic.

### Task 14.2: Tool compatibility gate

Initial rollout:

- HTTP API agents continue using the current allowlisted tool loop.
- Codex and Claude Code can run agent replies only after adapter-level tool tests pass.
- do not rely on experimental Codex dynamic tools for the production auto-reply path.
- without tool compatibility, Codex/Claude Code are selectable for Chat/Vision but disabled for automatic Agent with reason.

### Task 14.3: Auto-reply deadline and escalation

- enforce total execution deadline below gateway timeout;
- cap turns/tool iterations;
- cancel runtime turn on webhook cancellation;
- if no candidate succeeds, use current human escalation path;
- do not queue an unbounded reply after the conversation has already escalated.

### Task 14.4: Agent tests

Run all existing `ai-agent-reply` tests unmodified, then add:

- account-scoped preference;
- connected user provider;
- platform fallback consent;
- admin-only connection rejection;
- tool-disabled subscription runtime;
- timeout to human escalation;
- execution audit and cost attribution;
- no secret in prompt/log/error.

## Slice 15 — Image, Video, Speech, Search, and Embeddings

### Task 15.1: Image/video

Update:

- `supabase/functions/generate-image/index.ts`
- relevant video generation functions.

Use the generic planner for Higgsfield and compatible API providers. Codex and Claude Code do not enter image/video generation candidate lists in v1.

Preserve reference-image staging cleanup and reserve/release semantics.

### Task 15.2: TTS/STT/search/embedding

Migrate one capability per PR. Each capability requires:

- adapter contract;
- model capability filter;
- payload and output normalization;
- timeout and size limits;
- quota attribution tests;
- current platform-only behavior parity.

Do not enable a provider because it supports generic chat; each capability needs a tested adapter.

## Slice 16 — Observability, Security Review, and Operations

### Task 16.1: Dashboards and alerts

Add metrics and operator views for:

- connection status by provider;
- authentication failures;
- execution success/error/latency;
- user vs platform cost source;
- fallback frequency/reasons;
- queue depth/runtime capacity;
- process crashes;
- rate-limit exhaustion;
- stale model catalogs.

Alerts:

- cross-tenant refusal;
- repeated signature failure;
- runtime restart storm;
- platform fallback spike;
- secret-store failure;
- provider-wide auth failure.

### Task 16.2: Security tests

Run targeted tests for:

- IDOR on connection ids;
- platform action without admin role;
- OAuth state replay;
- device-code leakage;
- callback open redirect;
- SSRF through provider endpoints;
- command injection into runtime spawn;
- path traversal in runtime profile id;
- log injection/redaction;
- another user's social account preference;
- service-role missing tenancy predicate;
- public runtime port exposure.

### Task 16.3: Runbooks

Create:

- `docs/runbooks/ai-provider-connection-incident.md`
- `docs/runbooks/agent-runtime-operations.md`
- `docs/runbooks/ai-provider-secret-rotation.md`
- `docs/runbooks/ai-provider-fallback-cost-spike.md`

Include rollback flags and credential revocation steps.

## Slice 17 — Rollout and Legacy Cleanup

### Task 17.1: Shadow planning

With execution still on the legacy path:

- build the new plan;
- compare it with the current selected provider/model;
- log only mismatches and reason codes;
- do not call an additional provider.

Acceptance:

- platform-only traffic matches current routing for a defined observation window.

### Task 17.2: Internal cohort

Enable in order:

1. administrator safe status cards;
2. internal user BYOK;
3. generic Higgsfield;
4. Codex user authentication;
5. Codex Chat;
6. Codex Vision;
7. Codex Agent after tool gate;
8. Claude Code only after policy gate.

### Task 17.3: Gradual production rollout

Roll out by user allowlist/percentage and capability. Monitor:

- success rate;
- p50/p95 latency;
- fallback rate;
- platform cost movement;
- reconnect frequency;
- support tickets;
- runtime saturation.

Rollback by disabling the capability/provider flag; do not delete connection metadata during operational rollback.

### Task 17.4: Cleanup

Only after production stability:

- remove duplicate legacy dispatch branches;
- retire `user_ai_model_overrides` from runtime resolution if replaced, while preserving admin audit history;
- remove Higgsfield dual-read/dual-write;
- remove legacy raw secret columns after migration and credential rotation;
- update `ARCHITECTURE.md` with the runtime service and canonical AI execution path.

Cleanup is a separate PR and migration set, never part of the initial cutover.

## Test Matrix

| Layer | Required coverage |
|---|---|
| Pure domain | capability eligibility, routing precedence, traffic policy, fallback consent |
| PostgreSQL | migration replay, RLS, grants, composite ownership, quota concurrency, audit append-only |
| Edge/Deno | auth actions, planner, adapters, timeouts, idempotency, sanitized errors |
| Runtime unit | JSON-RPC framing, process supervision, profile isolation, signatures, redaction |
| Runtime integration | Codex fake/real staging login, model list, turn, cancel, rate limit |
| Frontend Vitest | connection cards, capability filters, routing saves, account switching |
| Playwright | connect/status/disconnect, model selection, fallback confirmation |
| Security | IDOR, CSRF/state replay, SSRF, injection, traversal, secret leakage |
| Production smoke | platform parity, BYO attribution, rollback flags, no public runtime port |

## CI Gates

Each PR must pass the relevant subset:

```bash
npm run typecheck
npm run lint
npm run test
deno test --no-check --node-modules-dir=none supabase/functions/_shared/ai-routing/
deno test --no-check --node-modules-dir=none supabase/functions/ai-provider-connections/
deno test --no-check --node-modules-dir=none supabase/functions/ai-execute/
deno test --no-check --node-modules-dir=none supabase/functions/ai-agent-reply/
npm --prefix services/agent-runtime run typecheck
npm --prefix services/agent-runtime test
```

The migration harness and container image scan are required for schema/runtime slices.

## Suggested Pull Request Breakdown

1. **PR A — schema and feature flags**  
   Slices 0–1 only; apply migrations before dependent frontend.

2. **PR B — domain policy and planner**  
   Slices 2–3; no behavior change.

3. **PR C — HTTP adapters and compatibility bridge**  
   Slice 4; flags off.

4. **PR D — generic Higgsfield metadata and adapter**  
   Slice 5; dual-write, legacy execution remains authoritative.

5. **PR E — connection Edge API**  
   Slice 6.

6. **PR F — agent-runtime foundation**  
   Slice 7; private deployment, no providers enabled.

7. **PR G — Codex auth and execution**  
   Slice 8; internal allowlist.

8. **PR H — Claude Code conditional adapter**  
   Slice 9; cannot merge enabled without policy gate.

9. **PR I — user settings UI**  
   Slice 10.

10. **PR J — admin auth UI and model selectors**  
    Slice 11.

11. **PR K — execution/quota API**  
    Slice 12.

12. **PR L — chat/caption/hashtags/vision**  
    Slice 13.

13. **PR M — AI agent reply**  
    Slice 14 after tool gate.

14. **PR N+ — remaining capabilities**  
    One capability per PR from Slice 15.

15. **PR O — observability/runbooks**  
    Slice 16.

16. **PR P — legacy cleanup**  
    Slice 17.4 only after stability window.

## Definition of Done

The initiative is complete only when:

1. schema, RLS, safe views, and migrations pass replay/integration tests;
2. platform-only routing remains compatible with production defaults;
3. user routing preference works globally and per capability;
4. explicit fallback consent controls every user-to-platform transition;
5. Codex user auth works through managed/device-code App Server flow in an isolated runtime;
6. administrator Codex connection is blocked from subscriber traffic unless separately approved and enabled;
7. Anthropic API works independently of Claude Code;
8. Claude Code auth cannot execute without its policy gate and isolated unmodified runtime;
9. Admin UI exposes separate OpenAI/Codex and Anthropic/Claude Code provider/model groups;
10. Chat, Agent, Vision, Image, Video, Speech, Search, and Embedding selectors show only tested compatible models;
11. every execution has credential source, cost owner, fallback state, and sanitized result telemetry;
12. no secret appears in browser responses, logs, metrics, audit rows, or cross-user storage;
13. Higgsfield remains operational and can roll back to its legacy path;
14. runbooks, dashboards, alerts, and rollback flags are verified in production;
15. `ARCHITECTURE.md` describes the final canonical route and agent-runtime ownership.
