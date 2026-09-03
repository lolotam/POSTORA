# Spec — Hybrid AI Agent Connectors (native + Composio) with Connection & Usage Tracking

**Date:** 2026-09-03
**Branch:** `feat/hybrid-agent-connectors` (worktree `F:/Postora-connectors`)
**Status:** binding design, approved approach A (connection registry + existing tool table)
**Plan:** `docs/superpowers/plans/2026-09-03-hybrid-agent-connectors-tracking.md`

Continues `docs/superpowers/specs/2026-08-30-per-account-connectors-design.md` (per-account
connectors, Vault credentials, adapters) and `2026-09-02-admin-partner-hub-design.md`
(admin-gated SQL readers, ledger `request_id`/`latency_ms`). Neither is superseded; every
invariant they established is kept and named where this spec touches it.

---

## 0. Why this exists

Postora's agent can already call native connectors (WooCommerce, Supabase, …) that the user
configures with real vendor credentials. Three things are missing:

1. **Global SaaS tools** (Google Sheets, Slack, Google Calendar, HubSpot, Notion, Airtable)
   have no adapter and would each need an OAuth app, a consent screen, refresh handling and a
   vendor client. Composio provides managed OAuth ("Connect Links") and a hosted tool catalogue
   for exactly these.
2. **Nothing records tool execution.** A connector call leaves no row anywhere: not which
   workspace called what, not how long it took, not whether it failed. The Admin Partner Hub
   cannot show connector usage, and a partner key cannot be told what its tools cost.
3. **YouTube publishing depends on Postora's own Google OAuth app**, whose verification and
   refresh path have been unreliable. A Composio-connected channel is a second, independent
   publishing path that does not depend on that app.

This spec adds a Composio bridge, a connection registry, a call ledger, three partner-API
routes, admin readers, and a per-account Composio publishing provider for YouTube — without
replacing anything that works today.

---

## 1. Evidence (verified 2026-09-03 against the working tree)

| Fact | Where |
|---|---|
| Connectors are rows in `ai_agent_tools` keyed by `user_id`, optionally `social_account_id`, with `scope ∈ {account, all_accounts}`, Vault-backed `credentials_secret_id`, `settings jsonb`, `connector_type`, nullable `url`/`secret`. Sharing is `ai_agent_tool_accounts`. | `supabase/migrations/20260831130000_connector_scope_and_sharing.sql` |
| The runtime loads tools by `request.user_id`, narrows per account in `resolveToolsForAccount`, and routes execution through `executeRoutedCustomTool` → `ai-agent-adapters` (6 s budget, 8 000-char output cap) or the legacy webhook. | `ai-agent-reply/index.ts:846-900`, `connectorExecution.ts`, `_shared/toolResolution.ts` |
| Twelve registry types; the DB `CHECK` mirrors them via Migration A; `PENDING_DB_CONNECTOR_TYPES` is the staging seam for a type that lands before its migration. | `_shared/connectorRegistry.ts`, `src/lib/connectorRegistry.ts` (contract-tested mirror) |
| `usageGuide` + `composeToolDescription.ts` already turn registry metadata into per-tool model instructions. | `_shared/composeToolDescription.ts` |
| `partner_api_usage` already carries `action, request_id, latency_ms, workspace_id, key_id`; it is billing history (RESTRICT FK) and only rows with a resolved key reach it. | `20260813120000_partner_api_foundation.sql`, `20260902200000_admin_partner_hub.sql` |
| Partner keys bind to a workspace and to accounts through `partner_api_key_accounts`; every `/v1` read anchors on that join table and filters `workspace_id` twice. | `partner-api/v1/binding.ts` |
| Adding a scope touches five parity-tested places: `GENERIC_SCOPES`, `openapi.yaml GenericScope`, `src/features/partner-hub/domain/partnerScopes.ts`, `ACTION_SCOPES`, `ACTION_RISK_CLASSES`. | `_shared/partnerScopes.ts`, `partner-api/router.ts`, `router.test.ts` |
| `/v1` routes are declared in `V1_ROUTES` with `withPartnerAuth(action, riskClass, handler)`; mutations use `_shared/partnerApiIdempotency.ts`. | `partner-api/v1/router.ts` |
| `social_accounts` has `workspace_id` (composite unique `(id, workspace_id)`); `workspaces.owner_id` is one user; the partner posts route refuses mixed-owner targets. | `20260813120000_…`, `partner-api/v1/posts.ts:286-292` |
| YouTube publishing is `postToYouTube` in `process-post/index.ts` (7 395 lines): resumable upload with `snippet,status,recordingDetails,contentDetails`, `notifySubscribers`, a thumbnail call, and refresh via `_shared/social-auth.ts:refreshYouTubeToken` using `GOOGLE_CLIENT_ID/SECRET`. `check-connection-health` probes `channels?mine=true`. | `process-post/index.ts:7147-7340`, `refresh-tokens/index.ts:471-497` |
| No Composio code, SDK, or skill exists in this repository. | `grep -ri composio` → nothing |
| Composio facts (docs, 2026-09-03): REST base `https://backend.composio.dev/api/v3.1`, header `x-api-key`; `POST /connected-accounts` (auth config id + user id + callback) returns a redirect URL; `GET /connected-accounts?user_ids=`; `DELETE /connected-accounts/{id}`; `GET /tools?toolkit_slug=` and `GET /tools/{slug}` return schemas; `POST /tools/execute/{slug}` takes `user_id`, `connected_account_id`, `arguments`, `version`; a toolkit **version is required** for direct execution. Only the API key is a runtime parameter; the project id is not. | docs.composio.dev |
| Composio `YOUTUBE_UPLOAD_VIDEO` inputs: `title, description, categoryId, privacyStatus, tags, videoFilePath`. **No** made-for-kids, publishAt, notifySubscribers, or thumbnail (thumbnail is `YOUTUBE_UPDATE_THUMBNAIL`). `YOUTUBE_LIST_CHANNELS` resolves the channel. The managed Google app shares API quota across Composio users. | docs.composio.dev/toolkits/youtube |
| **Live spike, 2026-09-03 (Task 6 + Task 25, production key):** paths use underscores — `/auth_configs`, `/connected_accounts` (`/connected-accounts` is a 404 page); `/tools?toolkit_slug=&tool_slugs=a,b` filters as expected; every tool carries a pinned `version` (`YYYYMMDD_NN`) and `available_versions`; `GET /tools/{slug}?version=latest` is accepted. Toolkit versions today: googlesheets `20260902_00`, slack `20260826_00`, googlecalendar `20260902_00`, hubspot `20260826_00`, notion `20260819_00`, airtable `20260902_00`, youtube `20260721_00`. `POST /connected_accounts` answers `{ id: "ca_…", status: "INITIATED", redirect_url, redirect_uri, connectionData }`; a listed account carries `user_id`, `status`, `auth_config: { id, auth_scheme, is_composio_managed }`, `toolkit: { slug }`, `word_id`, `alias`, `created_at` — `auth_config.id` is **nested**, and there is no `metadata` object. The docs name the callback parameter both `connected_account_id` and `connectedAccountId`, plus `status=success|failed`. **`YOUTUBE_UPLOAD_VIDEO` does not exist**: the upload tool is `YOUTUBE_MULTIPART_UPLOAD_VIDEO` (required `title, description, categoryId, privacyStatus, videoFile`; optional `tags`) whose `videoFile` is `{ name, mimetype, s3key }` obtained by `POST /files/upload/request { toolkit_slug, tool_slug, filename, mimetype, md5 }` → `{ id, key, new_presigned_url }` then a `PUT` of the bytes to that URL. `YOUTUBE_UPDATE_THUMBNAIL` takes `{ videoId, thumbnailUrl }` (public URL, ≤ 2 MB). `HUBSPOT_SEARCH_CONTACTS` / `HUBSPOT_GET_CONTACT` do not exist; the real slugs are `HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA` and `HUBSPOT_READ_CONTACT`. The YouTube auth config `ac_ZZF6rPlq_i9_` is Composio-managed and its scopes include `youtube.upload`. | this session, `curl` from the functions container |
| **Unverified (blocked by a DB timeout today):** the count of `social_accounts` rows with `workspace_id IS NULL`. | Slice A precondition |

---

## 2. Goal and non-goals

**Goal.** A workspace member can connect a Composio-backed tool in one click, expose it to one
or all of their agent accounts exactly like a native connector, watch it being used, and let a
partner key list, connect and execute it headlessly — with every execution metered, every
refusal audited, and no path by which one workspace reaches another's connection.

**Non-goals (explicit).**
- No `daftra` connector: it has no registry entry and no adapter; it is a separate task.
- No Tool Router / `session.tools()` meta-tool loop (D4).
- No migration of existing native YouTube accounts to Composio; the native path stays.
- No partner-quota billing of tool executions (they are metered, not charged — D5).
- No cross-workspace or org-level connection sharing.

---

## 3. Decisions (binding)

| # | Decision | Choice and reason |
|---|---|---|
| **D1** | Tenancy seam | **Approach A.** `connector_connections` is a *credential registry* for Composio connected accounts, scoped by `workspace_id`. Exposure to agent accounts stays in `ai_agent_tools` (`scope`, `ai_agent_tool_accounts`, collision rules, admin_only). One resolver, one UI list. |
| **D2** | Composio entity id | `user_id` sent to Composio **is the Postora `workspace_id`**, always read from `social_accounts.workspace_id` or `partner_api_keys.workspace_id` on the server, never from a request body. The callback re-verifies it (§6.3). |
| **D3** | Transport | `_shared/composioClient.ts` wraps REST v3.1 with `fetch`, `AbortSignal.timeout`, and §26 retry policy. The npm SDK is not a dependency; Slice B task 1 is a bounded spike to confirm the endpoint shapes against a live key, nothing more. |
| **D4** | Tool exposure | Concrete tool schemas, fetched per `connector_type` from `GET /tools` and cached on the connection row, merged into the existing `customToolDefinitions` payload. Each Composio `connector_type` carries a **curated allow-list of tool slugs** in the registry; execution refuses any other slug (`connector_tool_not_allowed`). |
| **D5** | Call ledger | New table `connector_call_logs`, one row per execution attempt from every door (`agent`, `partner`, `test`, `publish`), including refusals. The partner door **also** writes `partner_api_usage` (non-billable) so the existing Hub views keep working. Not built on `api_logs` (same reason as partner metering). |
| **D6** | Scopes | Three new generic scopes: `connectors:read`, `connectors:manage`, `tools:execute`. Risk classes: `list_connectors` A; `create_connect_link` C (outbound, creates state); `execute_tool` C (outbound third-party, may mutate). No legacy scope satisfies any of them. |
| **D7** | Idempotency | `POST /v1/tools/execute` and `POST /v1/connectors/{type}/connect-link` require `Idempotency-Key` and use `partnerApiIdempotency.ts` unchanged. |
| **D8** | Registry | Registry gains `auth_strategy`, `category`, and (Composio only) `composio: { toolkit, tools: readonly string[] }`. The UI's `CONNECTOR_DIRECTORY.category` is deleted in favour of the registry's. "Skill instructions" are `usageGuide` entries; no parallel mechanism. New types land through `PENDING_DB_CONNECTOR_TYPES` until their migration is live. |
| **D9** | Frontend location | New feature module `src/features/connectors/{domain,infrastructure,ui/hooks}`. `DatabaseConnectorsManager.tsx` (2 298 lines) gets the category tabs and a `ComposioConnectCard` slot, nothing else. Admin additions live in `src/features/partner-hub` + `src/components/admin/partner/`. |
| **D10** | YouTube via Composio | A second publishing provider, per account: `social_accounts.auth_provider ∈ {native, composio}`. `process-post` branches per row into a new module; native is untouched. Options Composio cannot express are **refused at post creation**, never silently dropped (§10). |
| **D11** | Fail-closed matrix | Every refusal in §11 returns a stable error code, writes a `connector_call_logs` row with `status='refused'`, and never leaks the connection id, Composio ids, or vendor error bodies to a customer-facing reply. Missing `COMPOSIO_API_KEY` disables every Composio path with `connector_unavailable`. |
| **D12** | Retention | `connector_call_logs` is kept 90 days by a daily `pg_cron` job (same pattern as the Logflare retention crons). Aggregates the Hub shows are computed in SQL over that window. |

---

## 4. Data model

One expand-only, idempotent migration `20260903120000_hybrid_connectors_tracking.sql`, plus a
second `20260903120100_youtube_composio_provider.sql` for §10 so Slice F can ship alone.

### 4.1 `connector_connections` (new)

```sql
CREATE TABLE public.connector_connections (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connector_type                TEXT NOT NULL,            -- registry type, e.g. 'google_sheets'
  toolkit                       TEXT NOT NULL,            -- Composio toolkit slug, e.g. 'googlesheets'
  auth_strategy                 TEXT NOT NULL DEFAULT 'composio_oauth'
                                  CHECK (auth_strategy = 'composio_oauth'),
  composio_auth_config_id       TEXT NOT NULL,
  composio_connected_account_id TEXT UNIQUE,              -- NULL until the callback confirms
  external_account_id           TEXT,                     -- e-mail / channel id from Composio metadata
  external_account_label        TEXT,
  status                        TEXT NOT NULL DEFAULT 'initiated'
                                  CHECK (status IN ('initiated','active','failed','revoked')),
  failure_code                  TEXT,
  state_nonce                   TEXT,                     -- set at initiate, cleared by the callback (§6.2)
  tool_schema_cache             JSONB,
  tool_schema_cached_at         TIMESTAMPTZ,
  initiated_by                  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at                  TIMESTAMPTZ,
  revoked_at                    TIMESTAMPTZ,
  last_used_at                  TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connector_connections_id_workspace_key UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX connector_connections_one_active_per_external
  ON public.connector_connections (workspace_id, connector_type, external_account_id)
  WHERE status = 'active';
CREATE INDEX connector_connections_workspace_idx ON public.connector_connections (workspace_id, status);
```

- Only Composio rows live here. Native credentials stay in Vault on `ai_agent_tools`
  (August spec §4). Nothing secret is stored: Composio holds the tokens.
- `status` is monotonic past `active`: `revoked` and `failed` are terminal; reconnecting mints
  a new row. `initiated` rows older than one hour are swept to `failed('expired')` by the
  same cron as D12.
- RLS: members of the workspace may `SELECT`; nobody but the service role writes. Writes go
  through the edge function in §6 so the Composio call and the row change stay together.

### 4.2 `ai_agent_tools` (extend)

```sql
ALTER TABLE public.ai_agent_tools
  ADD COLUMN auth_strategy TEXT NOT NULL DEFAULT 'manual_credentials'
    CHECK (auth_strategy IN ('manual_credentials','composio_oauth')),
  ADD COLUMN connection_id UUID REFERENCES public.connector_connections(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_agent_tools_connection_matches_strategy
    CHECK ((auth_strategy = 'composio_oauth') = (connection_id IS NOT NULL));
```

- The same migration drops and recreates `ai_agent_tools_connector_type_check` with all
  nineteen registry types (Migration A's section E did this for twelve). Without it every
  save of a new type fails with `check_violation` even after the registry seam is emptied.
- The default keeps every existing row meaning what it meant (the August spec's argument for
  `'all_accounts'` applies unchanged).
- `ON DELETE RESTRICT`: a connection is revoked, not deleted, while tools reference it.
  Revocation sets `is_enabled = false` on every dependent tool (§6.4) so the model never
  sees a tool whose credential is gone.
- **Tenancy trigger** `ai_agent_tools_connection_workspace_matches`: on insert/update, when
  `connection_id` is set, the tool's owner (`user_id`) must be a member of the connection's
  workspace, and when `social_account_id` is set, `social_accounts.workspace_id` must equal
  `connector_connections.workspace_id`. Raises `check_violation`. This is structural because
  the runtime runs under the service role (ARCHITECTURE §24).
- The write path is `messaging-api/toolWrites.ts` (`parseUpsertToolInput` →
  `upsertAccountScopedTool`), not an RPC. It learns the two columns and derives
  `auth_strategy` from the registry for the type (a `google_sheets` row cannot be
  `manual_credentials`); a Composio type without a `connection_id` is refused with
  `connection_required`, and the connection must be `active` and in the caller's workspace.

### 4.3 `connector_call_logs` (new)

```sql
CREATE TABLE public.connector_call_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  tool_id           UUID REFERENCES public.ai_agent_tools(id) ON DELETE SET NULL,
  connection_id     UUID REFERENCES public.connector_connections(id) ON DELETE SET NULL,
  social_account_id UUID,                                   -- no FK: the row must outlive the account
  partner_key_id    UUID,                                   -- no FK: same reasoning as partner_audit_logs
  connector_type    TEXT NOT NULL,
  auth_strategy     TEXT NOT NULL,
  action_name       TEXT NOT NULL,                          -- capability name or Composio tool slug
  source            TEXT NOT NULL CHECK (source IN ('agent','partner','test','publish')),
  status            TEXT NOT NULL CHECK (status IN ('success','failed','refused','timeout')),
  error_code        TEXT,
  request_id        TEXT,
  latency_ms        INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX connector_call_logs_ws_time_idx   ON public.connector_call_logs (workspace_id, created_at DESC);
CREATE INDEX connector_call_logs_type_time_idx ON public.connector_call_logs (connector_type, created_at DESC);
CREATE INDEX connector_call_logs_key_time_idx  ON public.connector_call_logs (partner_key_id, created_at DESC)
  WHERE partner_key_id IS NOT NULL;
```

- Written only by the service role through `_shared/connectorTelemetry.ts` (§7.2). A failed
  insert is logged and never fails the call it describes.
- **`workspace_id` resolution rule** (one rule, in `connectorTelemetry.ts`, used by every
  door): the account's `social_accounts.workspace_id` when the door knows the account;
  otherwise the tool owner's personal workspace (`workspaces.owner_id = user_id AND
  is_personal`). An `all_accounts` tool called through the agent uses the *conversation's*
  account. If neither resolves, the row is written with the personal workspace of the
  owner; a row is never silently dropped for want of a workspace.
- **Failure definition**, used identically by every reader: `failures = status IN
  ('failed','timeout')`; `refused` is counted separately and never folded into failures.
- **`auth_strategy = 'unknown'`** (added in Slice C2): a partner-door refusal that happens
  *before* any tool is resolved (`tool_not_found` for an unbound account or unknown tool id)
  still owes a `refused` row, and both `auth_strategy` and `connector_type` are NOT NULL. The
  row is written with `'unknown'` in both rather than inventing a strategy nobody established.
  Readers that group by type will show an `unknown` bucket for these probes; the Hub (Slice D)
  labels it "unresolved requests".
- `request_id` is the `X-Postora-Request-Id` on the partner door and the reply/publish
  correlation id on the others, so one id joins `partner_api_usage`, `connector_call_logs`
  and the edge logs.
- RLS: workspace members `SELECT` their own workspace's rows; admins read through RPCs.

### 4.4 Reader RPCs

All `SECURITY DEFINER`, `SET search_path = public`, no dynamic SQL, `REVOKE ALL FROM PUBLIC,
anon; GRANT EXECUTE TO authenticated`, and `NOTIFY pgrst, 'reload schema'` at the end
(memory: a function is invisible until PostgREST reloads).

| RPC | Gate | Returns |
|---|---|---|
| `workspace_connector_usage(p_workspace_id, p_days int default 30)` | caller is a workspace member | per `tool_id`: `calls, failures, refused, p50_latency_ms, last_used_at` — feeds the "142 calls this month" badge |
| `admin_connector_overview()` | `partner_hub_assert_admin()` | `active_connections, workspaces_with_connections, calls_30d, failures_30d, refused_30d, p95_latency_30d` |
| `admin_connector_usage_by_type(p_days)` | admin | per `connector_type, auth_strategy`: `calls, failures, p50, p95` |
| `admin_connector_usage_by_key(p_days)` | admin | per `partner_key_id` with key name/prefix/workspace: `calls, failures, p95` |
| `admin_connector_connections(p_workspace_id uuid default null)` | admin | connection rows without `tool_schema_cache`, with workspace name and dependent tool count |
| `admin_partner_key_connector_activity(p_key_id, p_limit default 50)` | admin; `no_data_found` if the key does not exist | recent `connector_call_logs` for that key, limit clamped 1..200 — the Live Activity Drawer's third section |

### 4.5 Retention and sweep

`cron.schedule('connector_logs_retention', '17 3 * * *', $$ DELETE FROM public.connector_call_logs WHERE created_at < now() - interval '90 days' $$)`
and `('connector_connections_sweep', '*/15 * * * *', …)` marking `initiated` rows older than
one hour `failed` with `failure_code='expired'`.

---

## 5. Registry changes (`_shared/connectorRegistry.ts` + browser mirror)

```ts
export type AuthStrategy = "manual_credentials" | "composio_oauth";
export type ConnectorCategory = "ecommerce_payments" | "productivity_crm" | "databases" | "automation";

export interface ComposioBinding {
  toolkit: string;                    // Composio toolkit slug
  tools: readonly string[];           // the ONLY slugs the agent may call
  mutating: readonly string[];        // subset of tools that change vendor state (§7.2 gate)
  toolkitVersion: string;             // pinned; required by /tools/execute. "latest" ONLY until
                                      // the Slice B spike (plan Task 6) records real versions —
                                      // under "latest" a cached schema and an execution can
                                      // silently disagree after Composio bumps a toolkit.
}

export interface ConnectorDefinition {
  type: ConnectorType;
  label: string;
  auth_strategy: AuthStrategy;
  category: ConnectorCategory;
  credentials: Field[];               // [] for composio_oauth
  usageGuide?: UsageGuide;            // the per-card "skill instructions"
  capabilities?: readonly ConnectorCapabilityDefinition[];   // native adapters only
  composio?: ComposioBinding;         // present iff auth_strategy === "composio_oauth"
}
```

New types: `google_sheets`, `slack`, `google_calendar`, `hubspot`, `notion`, `airtable`,
`youtube`. They enter `PENDING_DB_CONNECTOR_TYPES` in the same commit and leave it in the
commit that follows the migration deploy, exactly as Migration A's seam intends.

Each Composio entry's `tools` list is read-leaning and short (5–8 slugs). Mutating slugs
(send a Slack message, create a calendar event, append a row) are included only where the
`usageGuide.limits` text tells the model the consequence, and are marked in a
`mutating: readonly string[]` sub-list so §11 can require `admin_only` or an explicit
per-tool "allow writes" setting for them. Deletion slugs are never listed.

The existing `CONNECTOR_DIRECTORY.category` in `DatabaseConnectorsManager.tsx` is removed;
the directory reads `connectorDefinition(type).category`. The contract test that keeps the
two registry copies aligned is extended to the new fields.

---

## 6. Composio bridge

### 6.1 `_shared/composioClient.ts`

Pure fetch wrapper, constructed with `{ apiKey, baseUrl, fetch, now }` for tests.

| Method | Composio call | Budget |
|---|---|---|
| `initiateConnection({ workspaceId, authConfigId, callbackUrl })` | `POST /connected-accounts` | 5 s |
| `getConnectedAccount(id)` | `GET /connected-accounts/{id}` | 5 s |
| `listConnectedAccounts(workspaceId)` | `GET /connected-accounts?user_ids=` | 5 s |
| `deleteConnectedAccount(id)` | `DELETE /connected-accounts/{id}` | 5 s |
| `listTools(toolkit, slugs, version)` | `GET /tools` | 5 s |
| `executeTool({ slug, version, workspaceId, connectedAccountId, arguments, signal })` | `POST /tools/execute/{slug}` | caller-supplied |

Rules: one retry on network error or 5xx for idempotent GETs only; never on execute. Every
response body is size-capped (64 KB) before parsing. Errors map to `ComposioError { code:
"composio_unavailable" | "composio_rejected" | "composio_timeout", status }`. The API key
never appears in a log line, an error message or a thrown value (§13 logging).

### 6.2 Edge function `composio-connect`

New function, shape per ARCHITECTURE §12. Routes:

| Route | Auth | Does |
|---|---|---|
| `POST /composio-connect/initiate` `{ connector_type, workspace_id }` | user JWT; caller must be a member of the workspace (`workspace_members`) | Inserts `connector_connections(status='initiated')`, calls `initiateConnection` with `callbackUrl = COMPOSIO_CALLBACK_URL?state=<signed>`, returns `{ connection_id, redirect_url, expires_at }` |
| `GET /composio-connect/callback?state=&connectedAccountId=` | none (browser redirect from Composio; `verify_jwt = false` in `supabase/config.toml` like `threads-webhook`, and the same exemption in the self-hosted runtime's function config) | §6.3; ends in a 302 to `/settings?tab=integrations&connection=<id>&result=ok|error_code` |
| `POST /composio-connect/revoke` `{ connection_id }` | user JWT + membership | §6.4 |
| `POST /composio-connect/refresh-schema` `{ connection_id }` | user JWT + membership | Re-fetches the allow-listed tool schemas into `tool_schema_cache` |

`state` is `base64url(connection_id.workspace_id.nonce.exp)` + HMAC-SHA256 with
`COMPOSIO_STATE_SECRET`. The nonce is stored in `connector_connections.state_nonce` and
cleared on use, so a replayed callback is refused.

### 6.3 Callback verification (fail-closed)

1. Verify the HMAC and expiry; refuse with `invalid_state`.
2. Load the connection by id **and** `workspace_id` from the state; refuse if missing or not
   `initiated` (`connection_not_pending`).
3. Read the connected-account id Composio appends to the redirect — the docs show it as both
   `connectedAccountId` and `connected_account_id`, so both are accepted, and `status=failed`
   is refused outright. When neither spelling is present, fall back to
   `listConnectedAccounts(workspace_id)` and pick the `ACTIVE` account whose `auth_config.id`
   equals the row's `composio_auth_config_id`, created after the row. Then
   `getConnectedAccount(id)`. Refuse with `connection_not_found` if missing, not `ACTIVE`, or
   its auth config differs from the row's `composio_auth_config_id`.
4. **Tenancy check:** the fetched account's `user_id` must equal the **state's**
   `workspace_id`. This compares two independent sources (Composio's record vs the signed
   state) — listing accounts by `user_ids=workspace_id` and comparing would be a tautology. A
   mismatch is `tenancy_mismatch`: status `failed`, audit row, no redirect parameters beyond
   the code.
5. Resolve `external_account_id/label` from the account metadata; for `youtube` call
   `YOUTUBE_LIST_CHANNELS(mine=true)` (§10.2).
6. Set `active`, `connected_at`, `composio_connected_account_id`, fetch and cache schemas.

Every refusal writes `connector_call_logs(source='test', action_name='callback', status='refused', error_code=…)`.

### 6.4 Revoke

`deleteConnectedAccount` at Composio (best effort, logged) → `status='revoked'`,
`revoked_at` → `UPDATE ai_agent_tools SET is_enabled=false WHERE connection_id=…`. One
transaction via an RPC `revoke_connector_connection(p_connection_id)` that carries the
membership check, so the edge function cannot half-apply it. Slice F's migration
`CREATE OR REPLACE`s the same function to add `social_accounts.needs_reauth=true` for §10
accounts (no dynamic SQL, no `information_schema` guard).

---

## 7. Runtime: `ai-agent-reply`

### 7.1 Tool merge

After `resolveToolsForAccount` (unchanged), for each tool with
`auth_strategy='composio_oauth'`:

1. Load its connection **by `connection_id` and `workspace_id = account.workspace_id`**
   (the second predicate is the structural tenancy check under the service role). Missing,
   not `active`, or a different workspace → the tool is omitted from the prompt with a
   sanitized `console.warn` naming the tool id and reason. **No ledger row**: an omission at
   prompt assembly is not an execution attempt, and one row per reply per dead connection
   would swamp `refused_30d`. Ledger rows are written only when something tries to execute.
2. Take `tool_schema_cache`. A reply never calls Composio for schemas: the cache is filled by
   the callback and by `refresh-schema` (§6.2), and an empty cache omits the tool with the
   same `console.warn` (`schema_missing`). Emit one function per tool exactly as native
   adapters do:
   `{ capability: <slug>, parameters: <object> }`, with `capability` enum-restricted to the
   registry's allow-list and descriptions composed by `composeToolDescription.ts` from the
   cached schema plus `usageGuide`.
3. Connections resolve once per reply and are cached in the tool context; one reply never
   fetches the same connection twice.

Native tools are untouched. `customToolDefinitions` gains one branch, not a second builder.

### 7.2 Execution and telemetry

`executeRoutedCustomTool` gains a third branch: `auth_strategy === "composio_oauth"` →
`executeComposioTool(context, tool, args)` in `ai-agent-reply/composioExecution.ts`:

- `context.dryRun` short-circuits before any network call (same rule as the adapter path).
- Refuse before calling Composio when the slug is not allow-listed, when a mutating slug is
  called by a non-admin without the tool's `settings.allow_writes = true`, or when the
  connection is inactive. Each refusal is a log row and a model-visible message naming the
  reason, never the ids.
- Budget: `COMPOSIO_EXECUTE_TIMEOUT_MS = 6_000`, the same as the adapter budget, for the same
  60 s-worker arithmetic. Output capped at `ADAPTER_OUTPUT_LIMIT`.
- Secrets redaction reuses `redactKnownSecrets` with the Composio API key added to the list.

`_shared/connectorTelemetry.ts` exports
`recordConnectorCall(client, row)` and `withConnectorCall(client, meta, fn)` — the wrapper
measures `performance.now()`, maps a thrown `ComposioError` / `AbortError` to
`failed` / `timeout`, writes the row, and rethrows or returns. All four doors use it; no door
writes the table directly. **Native agent calls are metered in `executeRoutedCustomTool`**
(it holds the `ToolContext` with the conversation's account); `ai-agent-adapters` meters
only `test_connection` (`source='test'`), so no execution is counted twice.

---

## 8. Partner API (`/v1`)

### 8.1 Scopes and actions

```
GENERIC_SCOPES += "connectors:read", "connectors:manage", "tools:execute"
ACTION_SCOPES:  list_connectors ["connectors:read"], create_connect_link ["connectors:manage"], execute_tool ["tools:execute"]
ACTION_RISK_CLASSES: list_connectors "A", create_connect_link "C", execute_tool "C"
```

`openapi.yaml GenericScope` and the frontend twin change in the same commit; the existing
parity tests are the gate. `scopeIsMintable` accepts them; the Mint dialog offers them with
descriptions ("Execute connected tools headlessly (metered, not billed)").

### 8.2 Routes

| Route | Action | Behaviour |
|---|---|---|
| `GET /v1/connectors` | `list_connectors` | Tools resolvable by **any bound account** of the key (reuse `boundAccountIds` + `resolveToolsForAccount` per account, union, de-duplicated by tool id) joined to connection status and the 30-day counts from `workspace_connector_usage`. Never lists tools of unbound accounts, never exposes Composio ids. |
| `POST /v1/connectors/{type}/connect-link` | `create_connect_link` | Body `{ social_account_id? }`. Requires `Idempotency-Key`. Same flow as §6.2 initiate, with `workspace_id = record.workspaceId`, `initiated_by = key.created_by`. Returns `{ connection_id, redirect_url, expires_at }`. Type must be a `composio_oauth` registry type (`connector_type_not_connectable` otherwise). |
| `POST /v1/tools/execute` | `execute_tool` | Body `{ tool_id, social_account_id, capability, parameters }`. Requires `Idempotency-Key`. Authorisation is **the same resolver the agent uses**: the tool must resolve for `social_account_id`, and that account must be bound to the key; otherwise `tool_not_found` (non-enumerable 404). Dispatches to the adapter (native) or Composio (D4) with a 20 s budget. Response `{ ok, data | error, request_id, latency_ms }`. Writes `connector_call_logs(source='partner', partner_key_id)` **and** `partner_api_usage(billable=false)`. |

Native tools are executable through this route too; that is what makes it "hybrid" for
partners. `mutating` Composio slugs additionally require the tool's `allow_writes` setting,
exactly as in §7.2 — a partner key cannot widen what the tool's owner allowed.

### 8.3 Errors

New stable codes in `v1/errors.ts`: `connector_unavailable` (503, Composio disabled or
unreachable), `connection_inactive` (409), `connector_tool_not_allowed` (403),
`connector_type_not_connectable` (400), `tool_execution_failed` (502, sanitized),
`tool_execution_timeout` (504). Vendor bodies never pass through.

---

## 9. Frontend

### 9.1 Connectors Manager

`DatabaseConnectorsManager` is mounted twice today: read-only on **Settings → Integrations**
(`/settings?tab=integrations`) and editable on the agent page's **Tools** tab
(`/automation/agents`, `AiAgentManager`). The split maps onto D1:

- **Connections live on Settings → Integrations** (workspace-level, like the credential they
  are). Tabs from the registry category: **E-Commerce & Payments**, **Productivity & Apps**
  (Composio cards), **Databases**, **Automation**. A Composio card's `Connect` →
  `POST composio-connect/initiate` → `window.location = redirect_url`; the callback returns
  here and the tab reads `?connection=&result=` to show the outcome. A connected card shows
  the external account label, a `Connected` badge, a usage line ("142 calls · 30 d · p50
  640 ms") from `workspace_connector_usage`, and `Disconnect`. The `readOnly` prop keeps
  hiding the *tool* form here; it does not hide connection controls.
- **Exposure lives on the agent Tools tab** and reuses the existing tool form: choosing a
  Composio type hides the credential fields, requires an active connection
  (`ConnectionPicker`, scoped to the selected account's workspace), and writes
  `auth_strategy='composio_oauth', connection_id`. Scope, account, sharing and the usage
  guide behave exactly as for native tools.
- Every configured tool card, native or Composio, gains the usage line. Nothing else in the
  2 298-line file changes.
- **Known limit (Slice D):** the callback always returns to Settings → Integrations, which
  shows the signed-in user's *personal* workspace. A connection initiated from the agent Tools
  tab for an account in a team workspace completes and toasts correctly, but its card is
  listed only when that workspace is selected. A workspace selector on the Integrations tab,
  or a `return_to` hint carried in the signed state, is the follow-up; neither is in this spec.

Module `src/features/connectors/`:
`domain/connectorCategories.ts` (tab order, pure), `domain/usageSummary.ts` (format the
usage line, pure), `infrastructure/connectorsApi.ts` (edge calls + RPC), `ui/hooks/useConnectorConnections.ts`,
`ui/hooks/useConnectorUsage.ts`. Components: `src/components/automation/connectors/ComposioConnectCard.tsx`,
`ConnectorUsageLine.tsx`, `ConnectionPicker.tsx`.

### 9.2 Admin Partner Hub

- KPI row gains "Connector calls (30 d)" and "Connector failures (30 d)".
- New section **Connectors** with two tables: by type (`admin_connector_usage_by_type`) and
  by partner key (`admin_connector_usage_by_key`), plus a connections table
  (`admin_connector_connections`) with workspace, type, external label, status, dependent
  tools, and an admin-only `Revoke` (same RPC as §6.4, admin gate widened as D1 of the Hub
  spec did for keys).
- The Live Activity Drawer (`PartnerKeyActivitySheet.tsx`) gains a third section, **Connector
  calls**, from `admin_partner_key_connector_activity`: time, connector, action, status,
  latency, request id.
- Mint dialog: the three scopes appear through the twin list automatically.

---

## 10. YouTube via Composio (publishing provider)

### 10.1 Data

```sql
ALTER TABLE public.social_accounts
  ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'native' CHECK (auth_provider IN ('native','composio')),
  ADD COLUMN connection_id UUID REFERENCES public.connector_connections(id) ON DELETE RESTRICT,
  ADD CONSTRAINT social_accounts_provider_matches_connection
    CHECK ((auth_provider = 'composio') = (connection_id IS NOT NULL));
```

A Composio-backed channel is still a `social_accounts` row (`platform='youtube'`), so posts,
calendar, history, analytics and partner bindings work unchanged. Its `access_token` and
`refresh_token` are `NULL`; `token_expires_at` is `NULL`.

### 10.2 Connect

The registry type `youtube` (`composio_oauth`, category `automation`, toolkit `youtube`,
tools `['YOUTUBE_LIST_CHANNELS','YOUTUBE_MULTIPART_UPLOAD_VIDEO','YOUTUBE_UPDATE_THUMBNAIL']`,
pinned `20260721_00`) is connected through §6 like any other. The app door's `initiate` accepts an
optional `social_profile_id`; it rides in the signed state (`ConnectState.socialProfileId`) so the
callback can home the channel on the `/profiles` tab the user started from, and a YouTube callback
redirects to `/profiles?connection=…&result=…` instead of the integrations tab. The callback's step 5 runs `YOUTUBE_LIST_CHANNELS`
`mine=true`; for each channel returned it upserts a `social_accounts` row
(`auth_provider='composio'`, `connection_id`, `platform_user_id=channel id`,
`platform_username=title`, `avatar_url`, `workspace_id` = the connection's) under the
connection's `initiated_by` user, `ON CONFLICT ON CONSTRAINT social_accounts_user_platform_unique`
(`user_id, platform, platform_user_id`), setting `social_profile_id` only when the state carries
one, or refuses with `no_channel` if none. A conflicting row that is `auth_provider='native'` is
**not** overwritten: the callback refuses with `channel_already_native` so a working native channel
is never silently re-homed. Entry point in the UI: the existing YouTube "Connect" on `/profiles`
opens `YouTubeConnectMethodDialog` (two explicit choices, **Direct Google OAuth** and **Composio
Managed**, default remembered per browser in `localStorage` `postora.youtubeConnectMethod`) when
`VITE_COMPOSIO_YOUTUBE_ENABLED === "true"`; otherwise the native flow starts directly as before.
A channel-upsert failure after activation marks the row `failed` while the Composio account stays
ACTIVE upstream; that is the existing failed-connection shape and fails closed at publish time.

### 10.3 Publish

`process-post/index.ts` `case "youtube"` becomes

```ts
result = account.auth_provider === "composio"
  ? await publishYouTubeViaComposio(account, post, mediaUrls, deps)
  : await postToYouTube(account, post, mediaUrls, mediaFiles);
```

`process-post/youtubeComposio.ts` (new, tested with a fake client):

1. Resolve the connection (`connection_id`, `workspace_id = account.workspace_id`, `active`);
   otherwise fail the platform post with `connection_inactive` and set `needs_reauth`.
2. Read the single video file from storage (signed URL, existing helper) into memory; refuse
   above `YOUTUBE_COMPOSIO_MAX_BYTES` before reading. Push it into Composio with
   `_shared/composioFiles.ts` (`POST /files/upload/request` with the MD5, then a `PUT` to the
   presigned URL) and keep the returned `s3key`. The bytes cross the edge worker twice, which
   is why the cap exists.
3. `executeTool('YOUTUBE_MULTIPART_UPLOAD_VIDEO', { title, description, categoryId, privacyStatus, tags, videoFile: { name, mimetype, s3key } })`
   with a 50 s budget inside the worker ceiling; the result's `data.id` is the video id.
4. If the post has a thumbnail, `YOUTUBE_UPDATE_THUMBNAIL` (best effort, logged).
5. `platform_post_id = video id`, URL `https://youtu.be/<id>` (Shorts and videos share it).
6. Every step goes through `withConnectorCall(source='publish')`.

### 10.4 Capability parity (D10, fail-closed)

The metadata keys are the `PlatformMetadata` fields in `process-post/index.ts:356-376`.

| Native option (`PlatformMetadata` key) | Composio | Rule |
|---|---|---|
| `youtube_title`, `youtube_description`, `youtube_tags`, `youtube_category`, `youtube_visibility` | `YOUTUBE_UPLOAD_VIDEO` inputs | mapped |
| `youtube_thumbnail_url` | `YOUTUBE_UPDATE_THUMBNAIL` | second call, best effort |
| `youtube_video_type = 'short'` | same upload | no change |
| `youtube_made_for_kids = true` | not supported | **refused at create** (`youtube_option_unsupported_on_composio`) |
| `youtube_notify_subscribers = false` | not supported | refused at create |
| `youtube_allow_embedding = false`, `youtube_public_stats_viewable = false` | not supported | refused at create |
| `youtube_contains_synthetic_media = true`, `youtube_has_paid_promotion = true` | not supported | refused at create |
| `youtube_video_language`, `youtube_audio_language`, `youtube_recording_date`, `youtube_license = 'creativeCommon'` | not supported | refused at create |
| `youtube_allowed_countries`, `youtube_blocked_countries` | not supported | refused at create |
| `youtube_first_comment` | no Composio comment slug is allow-listed | refused at create |

"Refused at create" means `messaging-api`/post creation validates the target account's
provider and returns a 400 the composer shows, so a user never schedules something that will
fail at publish time. The validation is a pure function in `_shared/youtubeComposioOptions.ts`
shared with the UI's disabled-state logic.

### 10.5 Health and refresh

`refresh-tokens` skips `auth_provider='composio'` rows for token work and instead probes
`getConnectedAccount`; a status other than `ACTIVE` sets `needs_reauth = true` through the
same code path its `invalid_grant` branch uses today (`refresh-tokens/index.ts:494`).
`check-connection-health` reports those rows from `connector_connections.status` without
calling Google. `refreshYouTubeToken` is never called for them.

### 10.6 Known limits (recorded, not solved)

- Composio's managed Google app shares YouTube API quota across all Composio customers. If
  uploads start failing on quota, the auth config must switch to Postora's own Google client,
  which brings the verification question back. Recorded as the operational trade-off.
- **Confirmed 2026-09-03:** auth config `ac_ZZF6rPlq_i9_` is Composio-managed and its scope
  set includes `youtube.upload`.
- Video size: Composio does **not** fetch from a URL; the edge function must read the file and
  PUT it to Composio's presigned slot inside the worker budget. `YOUTUBE_COMPOSIO_MAX_BYTES`
  starts at 64 MB (Shorts and short videos) and is raised only after a measured production
  upload; `publishYouTubeViaComposio` refuses larger files with a clear error rather than
  timing out.

---

## 11. Security invariants and fail-closed matrix

| Condition | Result | Log row |
|---|---|---|
| `COMPOSIO_API_KEY` unset | every Composio path `connector_unavailable`; native unaffected | `refused` |
| Callback state invalid / replayed / expired | 302 with `result=invalid_state` | `refused` |
| Composio account `user_id ≠ workspace_id` | connection `failed('tenancy_mismatch')` | `refused` |
| Tool's connection not `active` | tool omitted from prompt (`console.warn`, no row); partner 409 | `refused` (partner/execute only) |
| Tool's connection in another workspace than the account | omitted (`console.warn`); partner 404 | `refused` (partner/execute only) |
| Slug not in the registry allow-list | 403 / model-visible refusal | `refused` |
| Mutating slug without `allow_writes` and not admin | same | `refused` |
| Partner key not bound to the account | 404 `tool_not_found` (non-enumerable) | `refused` |
| Composio timeout | 504 / model-visible "timed out" | `timeout` |
| Composio error body | sanitized 502, code only | `failed` |
| Telemetry insert fails | the call's outcome is unaffected; `console.error` | — |

Never logged: `COMPOSIO_API_KEY`, `COMPOSIO_STATE_SECRET`, signed URLs, Composio response
bodies beyond a 300-char sanitized prefix. Never returned to a customer or partner:
`composio_connected_account_id`, `composio_auth_config_id`, `connection_id` of another
workspace.

---

## 12. Testing

| Layer | What proves it |
|---|---|
| Registry contract | existing browser/Deno parity test extended: `auth_strategy`, `category`, `composio` present and equal; every `composio.tools` entry is unique and non-empty; `mutating ⊆ tools`. |
| SQL harness (`supabase/tests/hybrid_connectors.sql`) | tables, CHECKs, the tenancy trigger (cross-workspace tool → `check_violation`), RLS (member sees own rows, other member sees none, service role writes), every RPC's gate (`insufficient_privilege` for non-admin), retention/sweep crons registered, `revoke_connector_connection` disables dependent tools atomically. |
| `composioClient.test.ts` | request shapes, header, timeouts, single-retry rule, body cap, error mapping, key never in thrown values. |
| `composio-connect` tests | state sign/verify/replay, callback steps 1–6 with a fake client, tenancy mismatch path, YouTube channel upsert. |
| `connectorTelemetry.test.ts` | status mapping, latency floor, insert failure swallowed. |
| `ai-agent-reply` tests | merge branch (inactive connection omitted + logged; cached schema used; enum restricted), `composioExecution` refusals, dry-run never calls fetch. |
| `partner-api` | `router.test.ts` drift checks pass with three new actions; `partnerScopes.test.ts` + openapi parity; route tests for 8.2 including non-enumerable 404 and idempotent replay; e2e chain (`partner-api/e2e`) executes a native tool through PostgREST on the harness. |
| `process-post` | `youtubeComposio.test.ts` with a fake client: happy path, thumbnail best-effort, inactive connection sets `needs_reauth`, oversize refusal; `youtubeComposioOptions.test.ts` parity table. |
| Frontend (vitest) | `src/features/connectors` domain + api + hooks; components render states (disconnected / initiated / connected / revoked), usage line formatting; Partner Hub additions; Mint dialog shows the three scopes. |
| Gates | `deno test` per function, `bunx tsc -b --noEmit`, `bunx vitest run`, SQL harness, `clean-code-guard`, `test-guard`, `docs-guard` on openapi + AGENT-CONTEXT. |

---

## 13. Deployment order (load-bearing)

1. Dokploy secrets: `COMPOSIO_API_KEY`, `COMPOSIO_STATE_SECRET` (32 random bytes),
   `COMPOSIO_CALLBACK_URL=https://api.postora.cloud/functions/v1/composio-connect/callback`,
   `APP_RETURN_URL=https://postora.cloud/settings?tab=integrations`,
   `COMPOSIO_AUTH_CONFIG_<TYPE>` per connector type, `COMPOSIO_YOUTUBE_ENABLED=false`.
   (`=` not `:`; verify the container was recreated — memory `postora-cron-secret-unset-503`.)
2. Migration `20260903120000` (harness-rehearsed first; outer BEGIN does not rehearse it).
3. Edge deploy via the runtime checkout: `composio-connect`, `ai-agent-reply`,
   `ai-agent-adapters`, `partner-api`, `messaging-api`.
4. Registry commit that empties `PENDING_DB_CONNECTOR_TYPES`; frontend deploys on merge.
5. Migration `20260903120100` + `process-post`, `refresh-tokens`, `check-connection-health`
   deploy; then flip `COMPOSIO_YOUTUBE_ENABLED`.

Rollback at any step: unset `COMPOSIO_API_KEY` disables every Composio path without a deploy.

---

## 14. Open items carried into the plan

- Slice A precondition: count `social_accounts WHERE workspace_id IS NULL`; if non-zero,
  those accounts cannot host a Composio tool and the UI must say so (D1 does not backfill).
- Slice B task 1: confirm REST v3.1 shapes and the `version` requirement with a live key.
- Slice F task 1: confirm the managed YouTube auth config's scopes and the upload size bound.
