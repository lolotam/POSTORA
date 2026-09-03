# Hybrid AI Agent Connectors (Composio + Tracking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace connect Composio-backed SaaS tools in one click, expose them to agent accounts like native connectors, meter every tool execution from every door, surface usage in the Admin Partner Hub, add three `/v1` partner routes, and add a Composio-backed YouTube publishing provider — without touching any native path that works today.

**Architecture:** Approach A from the spec: `connector_connections` is a workspace-scoped registry of Composio connected accounts; `ai_agent_tools` gains `auth_strategy` + `connection_id` so exposure keeps using the existing resolver. A REST-only `_shared/composioClient.ts` and a new `composio-connect` edge function own every Composio call. `_shared/connectorTelemetry.ts` writes `connector_call_logs` from the agent, partner, test and publish doors. `process-post` branches per `social_accounts.auth_provider`.

**Tech Stack:** Postgres 17 (plpgsql, RLS, pg_cron), Deno edge functions (`npm:` imports only where already used), React 18 + TypeScript + Vite, TanStack Query, shadcn/ui, vitest + Testing Library, SQL harness (`scripts/db-harness.sh`), Composio REST v3.1.

**Spec:** `docs/superpowers/specs/2026-09-03-hybrid-agent-connectors-tracking.md` — decisions D1–D12 and §11's fail-closed matrix are binding. Read it before any task.

**Required reading before any code:** `ARCHITECTURE.md` §0, §12, §13, §14, §16, §17, §24, §26, §33, §40, §41; `AGENTS.md`; the August spec `docs/superpowers/specs/2026-08-30-per-account-connectors-design.md` §4 and §12–§13 (scope, sharing, usage guides).

**Work in the worktree `F:/Postora-connectors` (branch `feat/hybrid-agent-connectors`).** Never touch `F:/Postora_new` (another CLI drives its HEAD). Split into sub-branches per slice if delegating in parallel; the path sets below are disjoint except where a task says "depends on".

## Global Constraints

- Composio REST base `https://backend.composio.dev/api/v3.1`, header `x-api-key`; a toolkit `version` is required on `POST /tools/execute/{slug}` (spec §1).
- Composio `user_id` **is always** `workspace_id`, read server-side (spec D2). Never from a request body.
- Every Composio path refuses with `connector_unavailable` when `COMPOSIO_API_KEY` is unset (spec D11).
- Every refusal writes a `connector_call_logs` row with `status='refused'` and a stable `error_code` (spec §11).
- Agent-side Composio execution budget `COMPOSIO_EXECUTE_TIMEOUT_MS = 6_000`; partner door 20 000; publish door 50 000 (spec §7.2, §8.2, §10.3).
- `PENDING_DB_CONNECTOR_TYPES` stays **empty** on this branch: migration `20260903120000` (Slice A) rebuilt the CHECK with all nineteen types before the registry commit, so the seam test's exact-gap assertion requires `[]`. Production is protected by deploy order (migration before edge code, spec §13). The seam re-arms only if a future type is ever committed ahead of its migration.
- Scope additions change five parity-tested places in one commit: `_shared/partnerScopes.ts`, `docs/api/openapi.yaml`, `src/features/partner-hub/domain/partnerScopes.ts`, `ACTION_SCOPES`, `ACTION_RISK_CLASSES` (spec D6).
- Never log `COMPOSIO_API_KEY`, `COMPOSIO_STATE_SECRET`, signed URLs, or Composio bodies beyond a 300-char sanitized prefix.
- Migrations are expand-only and idempotent; rehearse on the harness (an outer `BEGIN` does not rehearse a self-committing migration).
- Edge deploys go through the runtime checkout on Contabo (`git fetch` + `restart`), never `npx supabase functions deploy`.

**Gate commands (run from the worktree):**
```bash
# Deno first, then bun install (the Deno node_modules flag breaks vitest).
deno test --allow-env --allow-read --allow-write --allow-net --no-check supabase/functions/_shared supabase/functions/composio-connect supabase/functions/ai-agent-reply supabase/functions/partner-api supabase/functions/process-post supabase/functions/messaging-api
# ai-agent-adapters pins npm:zod@3.23.8, which bun's node_modules (3.25.x) cannot satisfy; bypass the node_modules resolver for that directory only:
deno test --node-modules-dir=none --allow-env --allow-read --allow-write --allow-net --no-check supabase/functions/ai-agent-adapters
bun install
bunx tsc -b --noEmit
bunx vitest run
# SQL harness (PG17 container; see supabase/tests/README.md "Running locally")
DB_URL='postgres://supabase_admin:postgres@localhost:5432/postgres' HARNESS_DB_NAME=connectors_harness bash scripts/db-harness.sh
```

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260903120000_hybrid_connectors_tracking.sql` | `connector_connections`, `connector_call_logs`, `ai_agent_tools` columns + tenancy trigger, RLS, 6 RPCs, `revoke_connector_connection`, 2 crons |
| `supabase/migrations/20260903120100_youtube_composio_provider.sql` | `social_accounts.auth_provider` + `connection_id` |
| `supabase/tests/hybrid_connectors.sql`, `supabase/tests/youtube_composio_provider.sql` | harness suites |
| `scripts/db-harness.sh` | register both suites |
| `src/integrations/supabase/types.ts` | `Tables` + `Functions` entries |
| `supabase/functions/_shared/connectorRegistry.ts`, `src/lib/connectorRegistry.ts` | `auth_strategy`, `category`, `composio` binding, 7 new types |
| `supabase/functions/_shared/connectorTelemetry.ts` | `recordConnectorCall`, `withConnectorCall` |
| `supabase/functions/_shared/composioClient.ts` | REST wrapper, `ComposioError` |
| `supabase/functions/_shared/composioState.ts` | HMAC state sign/verify |
| `supabase/functions/_shared/composioConnections.ts` | `loadActiveConnection(admin, id, workspaceId)` shared by every door |
| `supabase/functions/composio-connect/{index,handler,callback,revoke}.ts` | new edge function |
| `supabase/functions/messaging-api/toolWrites.ts` | accept `connection_id`, derive `auth_strategy` |
| `supabase/functions/ai-agent-reply/{composioTools,composioExecution}.ts`, `tools.ts`, `connectorExecution.ts`, `index.ts` | merge + execute + telemetry |
| `supabase/functions/_shared/partnerScopes.ts`, `partner-api/router.ts`, `partner-api/v1/{connectors,tools,errors}.ts`, `docs/api/openapi.yaml` | scopes, routes, errors |
| `supabase/functions/_shared/youtubeComposioOptions.ts`, `process-post/youtubeComposio.ts`, `process-post/index.ts`, `refresh-tokens/index.ts`, `check-connection-health/index.ts` | YouTube provider |
| `src/features/connectors/{domain,infrastructure,ui/hooks}` | connectors feature module |
| `src/components/automation/connectors/*.tsx`, `src/components/automation/DatabaseConnectorsManager.tsx` | connector cards, tabs, usage line |
| `src/features/partner-hub/infrastructure/partnerHubApi.ts`, `ui/hooks/usePartnerHub.ts`, `domain/partnerScopes.ts` | admin readers + scope twin |
| `src/components/admin/partner/{ConnectorUsageTables,ConnectorConnectionsTable}.tsx`, `PartnerKeyActivitySheet.tsx`, `PartnerHubKpiCards.tsx` | Hub additions |

---

## Slice A — Database & telemetry

### Task 1: Precondition — accounts without a workspace

**Files:** none (evidence only, recorded in the PR description)

- [ ] **Step 1: Run against production (read-only)** via `supabase_postora_mcp` or `ssh-contabo-mcp` → `docker exec supabase-db psql`:

```sql
SELECT platform, count(*) FILTER (WHERE workspace_id IS NULL) AS no_workspace, count(*) AS total
FROM public.social_accounts GROUP BY platform ORDER BY platform;
```

- [x] **Step 2: Record the result** in `docs/superpowers/plans/2026-09-03-hybrid-agent-connectors-tracking.md` under this task. If `no_workspace > 0` for any platform, Task 19's `ConnectionPicker` must show "This account has no workspace; connect it from Profiles first" for those accounts (the trigger in Task 2 already refuses the write).

**Result (production, 2026-09-03, read-only):**

| platform | no_workspace | total |
|---|---|---|
| bluesky | 0 | 1 |
| facebook | 2 | 13 |
| instagram | 6 | 24 |
| linkedin | 0 | 1 |
| pinterest | 0 | 8 |
| threads | 4 | 17 |
| tiktok | 0 | 14 |
| twitter | 0 | 2 |
| whatsapp | 0 | 32 |
| youtube | 1 | 4 |

13 of 116 accounts have no workspace, so Task 19's picker message is required, and the telemetry
fallback to the owner's personal workspace (Task 5) is exercised by real rows.

### Task 2: Migration `20260903120000_hybrid_connectors_tracking.sql`

**Files:**
- Create: `supabase/migrations/20260903120000_hybrid_connectors_tracking.sql`

**Interfaces — Produces:** tables `connector_connections`, `connector_call_logs`; columns `ai_agent_tools.auth_strategy`, `ai_agent_tools.connection_id`; trigger `ai_agent_tools_connection_workspace_matches`; RPCs `workspace_connector_usage(p_workspace_id uuid, p_days int)`, `admin_connector_overview()`, `admin_connector_usage_by_type(p_days int)`, `admin_connector_usage_by_key(p_days int)`, `admin_connector_connections(p_workspace_id uuid)`, `admin_partner_key_connector_activity(p_key_id uuid, p_limit int)`, `revoke_connector_connection(p_connection_id uuid)`; crons `connector_logs_retention`, `connector_connections_sweep`.

- [x] **Step 1: Write the migration.** Tables exactly as spec §4.1 and §4.3 (copy the DDL verbatim, wrapped in `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`). Then:

```sql
-- 4.2 (pre) rebuild the connector_type CHECK with all nineteen registry types.
-- Migration A section E did this for twelve; without it every new type fails check_violation.
ALTER TABLE public.ai_agent_tools DROP CONSTRAINT IF EXISTS ai_agent_tools_connector_type_check;
ALTER TABLE public.ai_agent_tools ADD CONSTRAINT ai_agent_tools_connector_type_check
  CHECK (connector_type IN (
    'supabase','mysql_postgres','woocommerce','shopify','salla','zid','formula','custom_rest',
    'myfatoorah','stripe','higgsfield','mcp_custom',
    'google_sheets','slack','google_calendar','hubspot','notion','airtable','youtube'));

-- 4.2 ai_agent_tools
ALTER TABLE public.ai_agent_tools
  ADD COLUMN IF NOT EXISTS auth_strategy TEXT NOT NULL DEFAULT 'manual_credentials',
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.connector_connections(id) ON DELETE RESTRICT;
DO $$ BEGIN
  ALTER TABLE public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_auth_strategy_check CHECK (auth_strategy IN ('manual_credentials','composio_oauth')),
    ADD CONSTRAINT ai_agent_tools_connection_matches_strategy CHECK ((auth_strategy = 'composio_oauth') = (connection_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.ai_agent_tools_connection_workspace_matches()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws UUID; v_acct_ws UUID;
BEGIN
  IF NEW.connection_id IS NULL THEN RETURN NEW; END IF;
  SELECT workspace_id INTO v_ws FROM public.connector_connections WHERE id = NEW.connection_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'connection % not found', NEW.connection_id USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = v_ws AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'tool owner is not a member of the connection workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.social_account_id IS NOT NULL THEN
    SELECT workspace_id INTO v_acct_ws FROM public.social_accounts WHERE id = NEW.social_account_id;
    IF v_acct_ws IS DISTINCT FROM v_ws THEN
      RAISE EXCEPTION 'account workspace does not match connection workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_agent_tools_connection_workspace_matches ON public.ai_agent_tools;
CREATE TRIGGER ai_agent_tools_connection_workspace_matches
  BEFORE INSERT OR UPDATE OF connection_id, social_account_id, user_id ON public.ai_agent_tools
  FOR EACH ROW EXECUTE FUNCTION public.ai_agent_tools_connection_workspace_matches();
```

RLS:

```sql
ALTER TABLE public.connector_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_call_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Workspace members read connections" ON public.connector_connections;
CREATE POLICY "Workspace members read connections" ON public.connector_connections FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = connector_connections.workspace_id AND m.user_id = auth.uid()));
DROP POLICY IF EXISTS "Workspace members read call logs" ON public.connector_call_logs;
CREATE POLICY "Workspace members read call logs" ON public.connector_call_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = connector_call_logs.workspace_id AND m.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.connector_connections, public.connector_call_logs FROM authenticated, anon;
```

RPCs (each `SECURITY DEFINER SET search_path = public`; admin ones start with `PERFORM public.partner_hub_assert_admin();`):

```sql
CREATE OR REPLACE FUNCTION public.workspace_connector_usage(p_workspace_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (tool_id UUID, connector_type TEXT, calls BIGINT, failures BIGINT, refused BIGINT, p50_latency_ms INT, last_used_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  -- failures = failed|timeout everywhere; refused is its own count (spec §4.3).
  SELECT l.tool_id, l.connector_type, count(*), count(*) FILTER (WHERE l.status IN ('failed','timeout')),
         count(*) FILTER (WHERE l.status = 'refused'),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms)::INT, max(l.created_at)
  FROM public.connector_call_logs l
  WHERE l.workspace_id = p_workspace_id
    AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid())
    AND l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90))
  GROUP BY l.tool_id, l.connector_type;
$$;

CREATE OR REPLACE FUNCTION public.admin_connector_overview()
RETURNS TABLE (active_connections BIGINT, workspaces_with_connections BIGINT, calls_30d BIGINT, failures_30d BIGINT, refused_30d BIGINT, p95_latency_30d INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT (SELECT count(*) FROM public.connector_connections WHERE status = 'active'),
         (SELECT count(DISTINCT workspace_id) FROM public.connector_connections WHERE status = 'active'),
         count(*), count(*) FILTER (WHERE status IN ('failed','timeout')), count(*) FILTER (WHERE status = 'refused'),
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::INT
  FROM public.connector_call_logs WHERE created_at >= now() - interval '30 days';
END $$;

CREATE OR REPLACE FUNCTION public.admin_connector_usage_by_type(p_days INT DEFAULT 30)
RETURNS TABLE (connector_type TEXT, auth_strategy TEXT, calls BIGINT, failures BIGINT, p50_latency_ms INT, p95_latency_ms INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY SELECT l.connector_type, l.auth_strategy, count(*), count(*) FILTER (WHERE l.status IN ('failed','timeout')),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms)::INT, percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::INT
  FROM public.connector_call_logs l WHERE l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days,1),90))
  GROUP BY l.connector_type, l.auth_strategy ORDER BY count(*) DESC;
END $$;

CREATE OR REPLACE FUNCTION public.admin_connector_usage_by_key(p_days INT DEFAULT 30)
RETURNS TABLE (partner_key_id UUID, key_name TEXT, key_prefix TEXT, workspace_id UUID, workspace_name TEXT, calls BIGINT, failures BIGINT, p95_latency_ms INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY SELECT l.partner_key_id, k.name, k.key_prefix, l.workspace_id, w.name, count(*),
    count(*) FILTER (WHERE l.status IN ('failed','timeout')), percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::INT
  FROM public.connector_call_logs l
  LEFT JOIN public.partner_api_keys k ON k.id = l.partner_key_id
  LEFT JOIN public.workspaces w ON w.id = l.workspace_id
  WHERE l.partner_key_id IS NOT NULL AND l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days,1),90))
  GROUP BY l.partner_key_id, k.name, k.key_prefix, l.workspace_id, w.name ORDER BY count(*) DESC;
END $$;

CREATE OR REPLACE FUNCTION public.admin_connector_connections(p_workspace_id UUID DEFAULT NULL)
RETURNS TABLE (id UUID, workspace_id UUID, workspace_name TEXT, connector_type TEXT, toolkit TEXT, external_account_label TEXT, status TEXT, failure_code TEXT, dependent_tools BIGINT, connected_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY SELECT c.id, c.workspace_id, w.name, c.connector_type, c.toolkit, c.external_account_label, c.status, c.failure_code,
    (SELECT count(*) FROM public.ai_agent_tools t WHERE t.connection_id = c.id), c.connected_at, c.last_used_at, c.revoked_at
  FROM public.connector_connections c JOIN public.workspaces w ON w.id = c.workspace_id
  WHERE p_workspace_id IS NULL OR c.workspace_id = p_workspace_id
  ORDER BY c.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.admin_partner_key_connector_activity(p_key_id UUID, p_limit INT DEFAULT 50)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, connector_type TEXT, action_name TEXT, status TEXT, error_code TEXT, latency_ms INT, request_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  IF NOT EXISTS (SELECT 1 FROM public.partner_api_keys WHERE partner_api_keys.id = p_key_id) THEN
    RAISE EXCEPTION 'partner key not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT l.id, l.created_at, l.connector_type, l.action_name, l.status, l.error_code, l.latency_ms, l.request_id
  FROM public.connector_call_logs l WHERE l.partner_key_id = p_key_id
  ORDER BY l.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200);
END $$;

CREATE OR REPLACE FUNCTION public.revoke_connector_connection(p_connection_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws UUID;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.connector_connections WHERE id = p_connection_id AND status IN ('initiated','active');
  IF v_ws IS NULL THEN RAISE EXCEPTION 'connection not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT (public.has_role(auth.uid(), 'admin') OR EXISTS (
      SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = v_ws AND m.user_id = auth.uid() AND m.role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.connector_connections SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = p_connection_id;
  UPDATE public.ai_agent_tools SET is_enabled = false WHERE connection_id = p_connection_id;
  -- social_accounts.needs_reauth is added by Slice F's migration, which CREATE OR REPLACEs this function (no dynamic SQL here).
END $$;
```

Grants and crons:

```sql
DO $$ DECLARE f TEXT; BEGIN
  FOREACH f IN ARRAY ARRAY['workspace_connector_usage(uuid,int)','admin_connector_overview()','admin_connector_usage_by_type(int)',
    'admin_connector_usage_by_key(int)','admin_connector_connections(uuid)','admin_partner_key_connector_activity(uuid,int)','revoke_connector_connection(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP; END $$;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('connector_logs_retention','connector_connections_sweep');
SELECT cron.schedule('connector_logs_retention', '17 3 * * *',
  $$DELETE FROM public.connector_call_logs WHERE created_at < now() - interval '90 days'$$);
SELECT cron.schedule('connector_connections_sweep', '*/15 * * * *',
  $$UPDATE public.connector_connections SET status='failed', failure_code='expired', updated_at=now() WHERE status='initiated' AND created_at < now() - interval '1 hour'$$);
NOTIFY pgrst, 'reload schema';
```

- [x] **Step 2: Apply on the harness** (`bash scripts/db-harness.sh` with the suite from Task 3 registered) — expected: no error, `\df admin_connector_*` lists six functions.
- [x] **Step 3: Commit** `git add supabase/migrations/20260903120000_hybrid_connectors_tracking.sql && git commit -m "feat(connectors): connection registry, call ledger, admin readers"`

### Task 3: Harness suite `supabase/tests/hybrid_connectors.sql`

**Files:**
- Create: `supabase/tests/hybrid_connectors.sql`
- Modify: `scripts/db-harness.sh:101-110` (add `hybrid_connectors.sql` to `SUITES`)

- [x] **Step 1: Write the suite** in the `partner_hub_admin.sql` style (temp id table, `pg_temp.cleanup()`, `\set ON_ERROR_STOP on`). Prove, in order:

```sql
-- (1) a member of ws_a inserting a tool whose connection is in ws_b -> check_violation
SET LOCAL ROLE postgres;
INSERT INTO public.connector_connections (id, workspace_id, connector_type, toolkit, composio_auth_config_id, status)
VALUES (:'conn_b', :'ws_b', 'google_sheets', 'googlesheets', 'ac_test', 'active');
DO $$ BEGIN
  INSERT INTO public.ai_agent_tools (user_id, name, description, connector_type, auth_strategy, connection_id, scope)
  VALUES (:'owner_a', 'sheets', 'x', 'google_sheets', 'composio_oauth', :'conn_b', 'all_accounts');
  RAISE EXCEPTION 'expected check_violation';
EXCEPTION WHEN check_violation THEN NULL; END $$;
-- (2) composio strategy without connection_id -> check_violation (constraint)
-- (3) RLS: SET ROLE authenticated + request.jwt.claim.sub = owner_a sees only ws_a rows in both tables
-- (4) every admin_connector_* raises insufficient_privilege for owner_a, returns rows for admin
-- (5) workspace_connector_usage returns nothing for a non-member, aggregates for a member
-- (6) revoke_connector_connection disables dependent tools, refuses a viewer, allows owner and platform admin
-- (7) admin_partner_key_connector_activity raises no_data_found for a random uuid, clamps p_limit
-- (8) latency_ms rejects -1; status rejects 'weird'
-- (9) cron.job has both jobnames
-- (10) an ai_agent_tools row with each of the seven new connector_type values (manual_credentials, no connection) INSERTs; 'daftra' is refused by the CHECK
```

Write each block fully (no elision) — copy the assertion pattern from `partner_hub_admin.sql` lines 40–120.

- [x] **Step 2: Register** the suite in `SUITES=(...)` after `publishing_seam.sql`.
- [x] **Step 3: Run** `DB_URL=... HARNESS_DB_NAME=connectors_harness bash scripts/db-harness.sh` — expected: `=== hybrid_connectors: ok ===` and every prior suite still green.
- [x] **Step 4: Commit** `git add supabase/tests/hybrid_connectors.sql scripts/db-harness.sh && git commit -m "test(connectors): harness suite for connection registry and ledger"`

### Task 4: Generated types

**Files:**
- Modify: `src/integrations/supabase/types.ts`

- [x] **Step 1: Regenerate** on the harness DB (memory: rehearsal on Contabo or local PG17) with `supabase gen types typescript --db-url "$DB_URL" > /tmp/types.ts`, then copy only the `connector_connections`, `connector_call_logs`, `ai_agent_tools` (two new columns) and the seven `Functions` entries into `types.ts` (do not overwrite unrelated drift).
- [x] **Step 2: Verify** `bunx tsc -b --noEmit` passes.
- [x] **Step 3: Commit** `git commit -m "chore(types): connector registry, ledger and readers" -- src/integrations/supabase/types.ts`

### Task 5: `_shared/connectorTelemetry.ts`

**Files:**
- Create: `supabase/functions/_shared/connectorTelemetry.ts`
- Test: `supabase/functions/_shared/connectorTelemetry.test.ts`

**Interfaces — Produces:**

```ts
export type ConnectorCallSource = "agent" | "partner" | "test" | "publish";
export type ConnectorCallStatus = "success" | "failed" | "refused" | "timeout";
export interface ConnectorCallMeta {
  workspaceId: string; toolId?: string | null; connectionId?: string | null;
  socialAccountId?: string | null; partnerKeyId?: string | null;
  connectorType: string; authStrategy: "manual_credentials" | "composio_oauth";
  actionName: string; source: ConnectorCallSource; requestId?: string | null;
}
export interface ConnectorCallOutcome { status: ConnectorCallStatus; errorCode?: string | null; latencyMs?: number | null; }
export async function recordConnectorCall(client: any, meta: ConnectorCallMeta, outcome: ConnectorCallOutcome): Promise<void>;
export async function withConnectorCall<T>(client: any, meta: ConnectorCallMeta, fn: (signal: AbortSignal) => Promise<T>, opts: { timeoutMs: number; now?: () => number }): Promise<T>;
export class ConnectorRefusal extends Error { constructor(public readonly code: string, message?: string) { super(message ?? code); } }
/** Spec §4.3 workspace rule: the account's workspace when known, else the owner's personal workspace. Never null: throws only if the owner has no personal workspace, which the 2026-07-26 backfill guarantees exists. */
export async function resolveWorkspaceForCall(client: any, input: { socialAccountId?: string | null; userId: string }): Promise<string>;
```

- [x] **Step 1: Write failing tests** (`Deno.test` + a fake client whose `.from("connector_call_logs").insert(row)` records `row`):
  - `resolveWorkspaceForCall`: account with `workspace_id` → it; account with NULL `workspace_id` or no account → `workspaces` row where `owner_id = userId AND is_personal`; neither → throws `Error("workspace_unresolved")`.
  - `recordConnectorCall` maps camelCase → snake_case and floors `latency_ms` at 0.
  - insert error → `console.error` called, promise resolves.
  - `withConnectorCall` resolves → row `status='success'`, `latency_ms` = `now()` delta.
  - fn throws `ConnectorRefusal("connector_tool_not_allowed")` → row `status='refused', error_code=…`, rethrown.
  - fn throws `DOMException("AbortError")` (or aborts on the signal) → `status='timeout'`.
  - other error → `status='failed', error_code = error.code ?? "connector_failure"`.
- [x] **Step 2: Run** `deno test --no-check supabase/functions/_shared/connectorTelemetry.test.ts` — expected FAIL (module missing).
- [x] **Step 3: Implement** — `withConnectorCall` creates `AbortController`, `setTimeout(abort, timeoutMs)`, measures with `opts.now ?? performance.now`, classifies in `finally`-style try/catch, always calls `recordConnectorCall`, never lets the insert throw.
- [x] **Step 4: Run** — expected PASS.
- [x] **Step 5: Commit** `git commit -m "feat(connectors): shared call telemetry wrapper" -- supabase/functions/_shared/connectorTelemetry.ts supabase/functions/_shared/connectorTelemetry.test.ts`

---

## Slice B — Composio bridge

### Task 6: Bounded spike — REST shapes with a live key (≤ 1 hour, throwaway)

**Files:** `docs/superpowers/specs/2026-09-03-hybrid-agent-connectors-tracking.md` §1 (update the Composio row if anything differs)

- [x] **Step 1:** With `COMPOSIO_API_KEY` in a local env only, `curl -H "x-api-key: $KEY" https://backend.composio.dev/api/v3.1/auth-configs` and record the `id` for each of `googlesheets, slack, googlecalendar, hubspot, notion, airtable, youtube`.
- [x] **Step 2:** `POST /connected-accounts` with `{ "auth_config": {"id": "<id>"}, "connection": {"user_id": "spike-ws", "callback_url": "https://example.invalid/cb"} }`; record the exact response keys for the redirect URL. Then open the redirect URL in a browser, complete the OAuth once, and **record the exact query parameters Composio appends to the callback** (the connected-account id parameter name is what Task 11's callback reads — spec §6.3 step 3).
- [x] **Step 3:** `GET /tools?toolkit_slug=googlesheets` and `GET /tools/GOOGLESHEETS_BATCH_GET`; record the version field name and the input schema location.
- [x] **Step 4:** Write the confirmed field names into `composioClient.ts`'s header comment (Task 8) and, if they differ from the spec table, edit spec §1. Delete every spike artefact; nothing from this task is committed except the two docs.

**Result (2026-09-03, production key from the functions container):** paths are `/auth_configs`, `/connected_accounts`, `/files/upload/request` (underscores; the hyphen path is a 200 HTML 404). Initiate answers `{id, status, redirect_url}`; listed accounts nest `auth_config.id` and `toolkit.slug`. `tool_slugs` filters; versions pinned per toolkit (see spec §1) and written into both registries. Callback parameter documented as both `connectedAccountId` and `connected_account_id`; the callback accepts both and falls back to listing. Wrong slugs corrected: HubSpot search/read, YouTube upload.

### Task 7: Registry — strategies, categories, Composio bindings, seven new types

**Files:**
- Modify: `supabase/functions/_shared/connectorRegistry.ts`, `src/lib/connectorRegistry.ts`
- Modify: `supabase/functions/_shared/connectorRegistry.test.ts`, `src/lib/__tests__/connectorRegistry.test.ts`
- Modify: `src/components/automation/DatabaseConnectorsManager.tsx:266-470` (delete `category`/`categoryLabel` from `ConnectorDirectoryItem`, read the registry)

**Interfaces — Produces:** spec §5 types verbatim; `CONNECTOR_TYPES` += `"google_sheets" | "slack" | "google_calendar" | "hubspot" | "notion" | "airtable" | "youtube"`; `PENDING_DB_CONNECTOR_TYPES = [those seven]`; `isComposioType(type): boolean`; `composioBinding(type): ComposioBinding | undefined`; `CONNECTOR_CATEGORY_LABELS: Record<ConnectorCategory,string>`.

- [x] **Step 1: Write failing tests** in both test files:
  - every definition has `auth_strategy` and `category`;
  - `composio` present ⇔ `auth_strategy === "composio_oauth"`, and then `credentials.length === 0`;
  - `composio.tools` unique, non-empty, `mutating ⊆ tools`, `toolkitVersion` matches `/^\d{8}_\d{2}$|^latest$/` (use what Task 6 found);
  - `PENDING_DB_CONNECTOR_TYPES` equals the seven new types (this re-arms the seam);
  - the browser and Deno copies serialize identically (existing contract test, extend to new fields).
- [x] **Step 2: Run** both test commands — expected FAIL.
- [x] **Step 3: Implement.** Add the fields to all twelve existing entries (`auth_strategy: "manual_credentials"`, categories: `supabase/mysql_postgres → databases`, `woocommerce/shopify/salla/zid/myfatoorah/stripe → ecommerce_payments`, `formula/custom_rest/higgsfield/mcp_custom → automation`). Add the seven entries; example:

```ts
google_sheets: {
  type: "google_sheets", label: "Google Sheets", auth_strategy: "composio_oauth", category: "productivity_crm",
  credentials: [],
  composio: {
    toolkit: "googlesheets", toolkitVersion: "<from Task 6>",
    tools: ["GOOGLESHEETS_BATCH_GET", "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW", "GOOGLESHEETS_GET_SPREADSHEET_INFO", "GOOGLESHEETS_BATCH_UPDATE"],
    mutating: ["GOOGLESHEETS_BATCH_UPDATE"],
  },
  usageGuide: {
    whenToUse: "Rows in the connected Google Sheets spreadsheet — stock lists, bookings, price tables the business keeps in a sheet.",
    requestExamples: ["is item 42 in the stock sheet", "what price does the sheet list for the large size"],
    limits: "Reads the connected account's sheets only. Writing rows changes the customer's data and is off unless the connector allows writes.",
  },
},
```

Do the same for `slack` (`SLACK_SEARCH_MESSAGES`, `SLACK_LIST_CONVERSATIONS`, `SLACK_SEND_MESSAGE` mutating), `google_calendar` (`GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_FIND_FREE_SLOTS`, `GOOGLECALENDAR_CREATE_EVENT` mutating), `hubspot` (`HUBSPOT_SEARCH_CONTACTS`, `HUBSPOT_GET_CONTACT`, `HUBSPOT_CREATE_CONTACT` mutating), `notion` (`NOTION_SEARCH_NOTION_PAGE`, `NOTION_FETCH_DATA`, `NOTION_QUERY_DATABASE`), `airtable` (`AIRTABLE_LIST_RECORDS`, `AIRTABLE_GET_RECORD`, `AIRTABLE_CREATE_RECORD` mutating), `youtube` (`YOUTUBE_LIST_CHANNELS`, `YOUTUBE_UPLOAD_VIDEO`, `YOUTUBE_UPDATE_THUMBNAIL`; both upload slugs mutating; category `automation`). Confirm every slug exists via Task 6's `GET /tools` before committing; replace any that does not.

- [x] **Step 4:** In `DatabaseConnectorsManager.tsx`, delete `category`/`categoryLabel` from `ConnectorDirectoryItem` and the 12 literals; replace `item.category` reads with `connectorDefinition(item.id).category` and labels with `CONNECTOR_CATEGORY_LABELS`. Add directory entries for the seven new types (logo + tagline only).
- [x] **Step 5: Run** Deno + vitest registry tests and `bunx tsc -b --noEmit` — expected PASS.
- [x] **Step 6: Commit** `git commit -m "feat(registry): auth strategy, category and Composio bindings; seven pending types"` scoped to the five files.

### Task 8: `_shared/composioClient.ts`

**Files:**
- Create: `supabase/functions/_shared/composioClient.ts`
- Test: `supabase/functions/_shared/composioClient.test.ts`

**Interfaces — Produces:**

```ts
export class ComposioError extends Error { constructor(public readonly code: "composio_unavailable" | "composio_rejected" | "composio_timeout", public readonly status?: number) { super(code); } }
export interface ComposioConnectedAccount { id: string; status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE"; userId: string; authConfigId: string; toolkit: string; createdAt: string; metadata: Record<string, unknown>; }
export interface ComposioToolSchema { slug: string; description: string; inputParameters: Record<string, unknown>; version: string; }
export interface ComposioClientOptions { apiKey: string; baseUrl?: string; fetch?: typeof fetch; }
export function composioClientFromEnv(getEnv?: (n: string) => string | undefined): ComposioClient | null;  // null when COMPOSIO_API_KEY unset
export class ComposioClient {
  initiateConnection(i: { workspaceId: string; authConfigId: string; callbackUrl: string }): Promise<{ connectionRequestId: string; redirectUrl: string }>;
  getConnectedAccount(id: string): Promise<ComposioConnectedAccount>;
  listConnectedAccounts(workspaceId: string): Promise<ComposioConnectedAccount[]>;
  deleteConnectedAccount(id: string): Promise<void>;
  listTools(toolkit: string, slugs: readonly string[], version: string): Promise<ComposioToolSchema[]>;
  executeTool(i: { slug: string; version: string; workspaceId: string; connectedAccountId: string; arguments: Record<string, unknown>; signal: AbortSignal }): Promise<{ successful: boolean; data: unknown; error?: string }>;
}
export const COMPOSIO_BODY_CAP = 64 * 1024;
```

- [x] **Step 1: Write failing tests** with a recording `fetch` stub: header `x-api-key` present and never in thrown messages; each method's path/method/body per Task 6; GET retried once on 503 and on `TypeError`; execute never retried; 4xx → `composio_rejected` with status; abort → `composio_timeout`; body > 64 KB → `composio_rejected`; `composioClientFromEnv` returns null without the key.
- [x] **Step 2: Run** — FAIL. **Step 3: Implement** (private `request<T>(method, path, body, signal, retry)`; `AbortSignal.timeout(5_000)` default; `response.text()` length-checked before `JSON.parse`).
- [x] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "feat(composio): REST client with timeouts, single-retry reads and body cap"`.

### Task 9: `_shared/composioState.ts`

**Files:** Create `supabase/functions/_shared/composioState.ts`, test `composioState.test.ts`

**Interfaces — Produces:**

```ts
export interface ConnectState { connectionId: string; workspaceId: string; nonce: string; exp: number; }
export async function signConnectState(state: ConnectState, secret: string): Promise<string>;      // base64url(json) + "." + base64url(hmac-sha256)
export async function verifyConnectState(token: string, secret: string, now?: () => number): Promise<ConnectState | null>;  // null on bad sig / expired / malformed
export function newNonce(): string;   // 16 random bytes, hex
```

- [x] **Step 1: Tests:** round-trip; tampered payload → null; wrong secret → null; `exp` in the past → null; malformed token → null (never throws).
- [x] **Step 2–4:** FAIL → implement with `crypto.subtle` HMAC → PASS.
- [x] **Step 5: Commit** `git commit -m "feat(composio): signed connect state"`.

### Task 10: `_shared/composioConnections.ts`

**Files:** Create `supabase/functions/_shared/composioConnections.ts`, test `composioConnections.test.ts`

**Interfaces — Produces:**

```ts
export interface ActiveConnection { id: string; workspaceId: string; connectorType: string; toolkit: string; composioConnectedAccountId: string; toolSchemaCache: ComposioToolSchema[] | null; }
export type ConnectionLookup = { ok: true; connection: ActiveConnection } | { ok: false; code: "connection_inactive" | "tenancy_mismatch" | "connection_not_found" };
export async function loadActiveConnection(client: any, connectionId: string, workspaceId: string): Promise<ConnectionLookup>;
```

Queries `connector_connections` by `id` **and** `workspace_id`; a row found by id alone but in another workspace returns `tenancy_mismatch` (the second query exists only to name the refusal correctly; both are refusals). Tests cover all four outcomes.

- [x] Steps: test → FAIL → implement → PASS → commit `feat(composio): shared active-connection lookup`.

### Task 11: Edge function `composio-connect`

**Files:**
- Create: `supabase/functions/composio-connect/index.ts` (adapter only: CORS, auth, route, sanitized error), `handler.ts` (initiate + refresh-schema), `callback.ts`, `revoke.ts`, `dependencies.ts` (constructs `ComposioClient`, admin client, env)
- Test: `supabase/functions/composio-connect/handler.test.ts`, `callback.test.ts`, `revoke.test.ts`

**Interfaces — Consumes:** Tasks 5, 8, 9, 10. **Produces:** routes per spec §6.2; env names `COMPOSIO_API_KEY`, `COMPOSIO_STATE_SECRET`, `COMPOSIO_CALLBACK_URL`, `COMPOSIO_AUTH_CONFIG_<TYPE_UPPER>` (e.g. `COMPOSIO_AUTH_CONFIG_GOOGLE_SHEETS`), `APP_RETURN_URL` (default `https://postora.cloud/settings?tab=integrations`; the callback appends `&connection=&result=`).

- [x] **Step 1: Failing tests for `initiate`** (`handler.test.ts`, fake admin client + fake `ComposioClient`):
  - caller not a `workspace_members` row → 403 `forbidden`, no Composio call;
  - `connector_type` not Composio → 400 `connector_type_not_connectable`;
  - missing `COMPOSIO_AUTH_CONFIG_*` → 503 `connector_unavailable` + refused log row;
  - happy path inserts `{status:'initiated', state_nonce, initiated_by}` then calls `initiateConnection({ workspaceId, authConfigId, callbackUrl: COMPOSIO_CALLBACK_URL + "?state=" + signed })` and returns `{ connection_id, redirect_url, expires_at }`;
  - Composio failure → row set `failed('composio_unavailable')`, 503.
- [x] **Step 2: Failing tests for `callback`** — each of spec §6.3 steps 1–6: bad/expired/replayed state (nonce already null) → `invalid_state`; missing connected-account query param → `connection_not_found`; `getConnectedAccount` returns a non-ACTIVE or different-auth-config account → `connection_not_found`; fetched account `userId !== state.workspaceId` → `failed('tenancy_mismatch')` + refused log row; success caches schemas via `listTools(toolkit, binding.tools, binding.toolkitVersion)` and 302s to `APP_RETURN_URL&connection=<id>&result=ok` (append with `&` because the default already carries `?tab=integrations`).
- [x] **Step 2b: JWT exemption.** Add to `supabase/config.toml`:

```toml
[functions.composio-connect]
verify_jwt = false
```

and apply the same exemption wherever the self-hosted runtime configures it (check how `threads-webhook` is exempted on the Contabo functions volume / compose env and copy that mechanism; record the exact file in the deploy runbook). The function verifies user JWTs itself on `initiate`/`revoke`/`refresh-schema` via `_shared/auth-helper.ts`; only `callback` is anonymous.

  **Verified 2026-09-03 on Contabo:** the runtime's `main/index.ts` gates on `VERIFY_JWT`, which the compose file sets from `FUNCTIONS_VERIFY_JWT`, and that is `false` in the stack's `.env`. No function is JWT-checked at the gateway (that is how `threads-webhook` works today), so the callback needs **no runtime change**; the `config.toml` entry only documents intent and keeps the CLI honest.
- [x] **Step 3: Failing tests for `revoke`** — membership required; calls `deleteConnectedAccount` (failure logged, not fatal); calls RPC `revoke_connector_connection` under the **user's** JWT client (so the RPC's own gate applies), 200.
- [x] **Step 4: Run** — FAIL. **Step 5: Implement** — `index.ts` follows the §12 shape; routes by `new URL(req.url).pathname` suffix; user routes use `_shared/auth-helper.ts`; callback route is unauthenticated and returns 302 only. Never `console.log` the state token or the redirect URL.
- [x] **Step 6: Run** — PASS. **Step 7: Commit** `git commit -m "feat(composio-connect): initiate, callback, revoke, refresh-schema"`.

### Task 12: Tool writes accept a connection

**Files:**
- Modify: `supabase/functions/messaging-api/toolWrites.ts:38-120` (`ParsedUpsertToolInput` + `parseUpsertToolInput`), `:287-390` (`upsertAccountScopedTool`)
- Test: `supabase/functions/messaging-api/toolWrites.test.ts`

**Interfaces — Produces:** `ParsedUpsertToolInput.connectionId?: string`, `.authStrategy: "manual_credentials" | "composio_oauth"`; new `ToolWriteError` codes `connection_required`, `connection_inactive`, `connection_forbidden`.

- [x] **Step 1: Failing tests:** Composio type without `connection_id` → `connection_required`; with a connection not `active` → `connection_inactive`; with a connection in a workspace the caller is not a member of → `connection_forbidden`; native type with a `connection_id` → parse strips it and strategy is `manual_credentials`; happy path writes `auth_strategy='composio_oauth', connection_id` and no Vault call.
- [x] **Step 2–4:** FAIL → implement (`isComposioType` from Task 7; connection lookup via `loadActiveConnection` plus a `workspace_members` check on `parsed.userId`) → PASS.
- [x] **Step 5: Commit** `git commit -m "feat(messaging-api): connectors may bind a Composio connection"`.

---

## Slice C — Runtime & Partner API

### Task 13: Merge Composio tools into the prompt (`ai-agent-reply`)

**Files:**
- Create: `supabase/functions/ai-agent-reply/composioTools.ts`, test `composioTools.test.ts`
- Modify: `supabase/functions/_shared/toolResolution.ts:14-27` (`ResolvableTool` += `auth_strategy`, `connection_id`), `ai-agent-reply/tools.ts:327-345` (`CustomTool` += same two), `:419-520` (`customToolDefinitions` branch), `ai-agent-reply/index.ts:846-900` (select the two columns; call `attachComposioTools`)
- Test: `ai-agent-reply/tools.test.ts` (extend)

**Interfaces — Produces:**

```ts
export interface ComposioReadyTool extends CustomTool { auth_strategy: "composio_oauth"; connection: ActiveConnection; }
export async function attachComposioTools(admin: any, tools: CustomTool[], account: { workspaceId: string | null; id: string | null }, warn?: (message: string) => void): Promise<CustomTool[]>;
export function composioToolParameters(tool: ComposioReadyTool, binding: ComposioBinding): { type: "object"; properties: {...}; required: ["capability"] };
```

- [x] **Step 1: Failing tests:** account with `workspaceId: null` → every Composio tool omitted and `console.warn` called with `connection_not_found`; inactive → omitted + `connection_inactive`; other workspace → `tenancy_mismatch`; empty cache → `schema_missing`; **no `connector_call_logs` insert in any omission case** (spec §7.1: prompt-assembly omissions are console-only); active + cached → tool returned with `connection`; native tools pass through untouched; one connection referenced by two tools is loaded once. Drop the `log` parameter from `attachComposioTools`; take `warn: (msg: string) => void` instead (default `console.warn`). `composioToolParameters` restricts `capability.enum` to `binding.tools` and merges cached `inputParameters` under `parameters` (same flat shape the adapter path uses, no `oneOf`); descriptions go through `composeToolDescription` with the 600-char budget.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** In `index.ts`, after `resolveToolsForAccount`, load the account's `workspace_id` (one `social_accounts` select by id + `user_id`) and call `attachComposioTools`; `customToolDefinitions` uses `composioToolParameters` when `tool.auth_strategy === "composio_oauth"`.
- [x] **Step 6: Run** the whole `ai-agent-reply` Deno suite — PASS. **Step 7: Commit** `git commit -m "feat(ai-agent-reply): offer Composio tools with enum-restricted slugs"`.

### Task 14: Execute Composio tools with telemetry

**Files:**
- Create: `supabase/functions/ai-agent-reply/composioExecution.ts`, test `composioExecution.test.ts`
- Modify: `ai-agent-reply/connectorExecution.ts:200-215` (third branch), `connectorRouting.test.ts` (extend); `ai-agent-reply/index.ts:1040-1060` (pass `requestId`/account into `ToolContext` if not already there)
- Modify: `ai-agent-adapters/handler.ts` — wrap only `test_connection` in `withConnectorCall(source='test')` (workspace via `resolveWorkspaceForCall({ socialAccountId: tool.social_account_id, userId })`). **Native `execute` calls are metered in `executeRoutedCustomTool`** (below), which holds the `ToolContext` with the conversation's account — never in the adapter, or every native call would be counted twice.

**Interfaces — Produces:** `export async function executeComposioTool(context: ToolContext, tool: ComposioReadyTool, args: Record<string, unknown>, deps?: { client?: ComposioClient; admin?: any; timeoutMs?: number }): Promise<ToolResult>`; `COMPOSIO_EXECUTE_TIMEOUT_MS = 6_000`.

- [x] **Step 1: Failing tests:** `dryRun` → no fetch, sandbox message; `capability` not in `binding.tools` → `ConnectorRefusal("connector_tool_not_allowed")` logged, model-visible "not allowed"; mutating slug, non-admin, `settings.allow_writes !== true` → `connector_write_not_allowed`; no client (`composioClientFromEnv` null) → `connector_unavailable`; success → output `Connector "<name>" returned: <json ≤ 8000 chars>` with `status='success'` row carrying `tool_id, connection_id, social_account_id, workspace_id, action_name=<slug>`; `successful:false` → `failed` with sanitized message (no Composio body beyond 300 chars); abort → `timeout` and "timed out".
- [x] **Step 2–4:** FAIL → implement using `withConnectorCall` (Task 5) around `client.executeTool` → PASS.
- [x] **Step 5:** `executeRoutedCustomTool`: `if (tool.auth_strategy === "composio_oauth") return executeComposioTool(...)` before the adapter check; wrap the **adapter and legacy branches** in `withConnectorCall(admin, { source: "agent", workspaceId: await resolveWorkspaceForCall(admin, { socialAccountId: context.socialAccountId, userId: context.userId }), toolId: tool.id, connectorType: tool.connector_type ?? "custom_rest", authStrategy: "manual_credentials", actionName: String(args.capability ?? "input"), socialAccountId: context.socialAccountId, requestId: context.requestId }, ...)`. `ToolContext` (`tools.ts:13-27`) has neither today; add `socialAccountId: string | null` and `requestId: string` and fill them where the context is built in `index.ts` (`request.social_account_id` when it is a UUID, else null; the reply's correlation id). Extend `connectorRouting.test.ts`: each branch writes exactly one row; a `dryRun` context writes none.
- [x] **Step 6:** Adapter `test_connection` wrapping + a test that it writes a `source='test'` row and that a failing insert does not change the adapter response.
- [x] **Step 7: Run** suites — PASS. **Step 8: Commit** `git commit -m "feat(connectors): meter every agent and test execution; execute Composio tools"`.

### Task 15: Scopes, actions, error codes

**Files:**
- Modify: `supabase/functions/_shared/partnerScopes.ts:47-63`, `docs/api/openapi.yaml:1276-1292`, `src/features/partner-hub/domain/partnerScopes.ts:11-26`, `supabase/functions/partner-api/router.ts:24-75` (`ACTION_SCOPES`) and `:80-140` (`ACTION_RISK_CLASSES`), `supabase/functions/partner-api/v1/errors.ts:33-180`
- Tests already exist: `_shared/partnerScopes.test.ts`, `partner-api/router.test.ts`, `src/features/partner-hub/domain/__tests__/partnerScopes.test.ts`

- [x] **Step 1:** Add to `GENERIC_SCOPES`: `"connectors:manage", "connectors:read", "tools:execute"` (keep alphabetical order — the parity test compares arrays). Add the same three to the openapi enum and to `PARTNER_SCOPES` with descriptions: `connectors:read` "List connected tools and their usage"; `connectors:manage` "Create connect links for Composio-backed tools"; `tools:execute` "Execute connected tools headlessly (metered, not billed)".
- [x] **Step 2:** `ACTION_SCOPES`: `list_connectors: ["connectors:read"]`, `create_connect_link: ["connectors:manage"]`, `execute_tool: ["tools:execute"]`. `ACTION_RISK_CLASSES`: `"A"`, `"C"`, `"C"` with a comment naming why (outbound third-party + state).
- [x] **Step 3:** `V1_ERROR_POLICY` += `connector_unavailable {503, retryable:true}`, `connection_inactive {409,false}`, `connector_tool_not_allowed {403,false}`, `connector_write_not_allowed {403,false}`, `connector_type_not_connectable {400,false}`, `tool_not_found {404,false}`, `tool_execution_failed {502,true}`, `tool_execution_timeout {504,true}`, with the messages from spec §8.3 (no vendor text).
- [x] **Step 4: Run** the three parity suites + `router.test.ts` — PASS (they fail if any of the five places is missed). **Step 5: Commit** `git commit -m "feat(partner-api): connectors and tools scopes, actions, error codes"`.

### Task 16: `GET /v1/connectors` and `POST /v1/connectors/{type}/connect-link`

**Files:**
- Create: `supabase/functions/partner-api/v1/connectors.ts`, test `connectors.test.ts`
- Modify: `partner-api/v1/router.ts:109` (`V1_ROUTES` entries)

**Interfaces — Consumes:** `boundAccountIds(authed)` (binding.ts), `resolveToolsForAccount`, `attachComposioTools`, `claimIdempotency`/`completeIdempotency`, the initiate logic from Task 11 (extract `initiateConnection(deps, { workspaceId, connectorType, initiatedBy })` into `_shared/composioInitiate.ts` in this task and reuse it from `composio-connect/handler.ts`). **Usage counts:** do not call `workspace_connector_usage` (its gate is `auth.uid()`, which is null under the service role). Read `connector_call_logs` directly under the admin client with `workspace_id = record.workspaceId AND created_at >= now() - 30 days`, grouped by `tool_id` in TypeScript — the partner door is service-role and structurally scoped, as every /v1 read is.

- [x] **Step 1: Failing tests for `listConnectors`:** unbound key → `{ data: [] }`; two bound accounts sharing one `all_accounts` tool → one entry; entries carry `{ tool_id, name, connector_type, auth_strategy, category, scope, social_account_id, connection: { status, external_account_label } | null, usage_30d: { calls, failures, p50_latency_ms, last_used_at } }` and **no** Composio ids; response shape follows `v1/respond.ts` + `pagination.ts` conventions.
- [x] **Step 2: Failing tests for `createConnectLink`:** missing `Idempotency-Key` → 400 (existing helper); non-Composio type → `connector_type_not_connectable`; replay returns the stored body; success returns `{ connection_id, redirect_url, expires_at }` and writes `partner_api_usage(action='create_connect_link', billable=false)` through the existing `withPartnerAuth` path (no extra code) and a `connector_call_logs(source='partner', action_name='connect_link', status='success', partner_key_id)` row.
- [x] **Step 3–5:** FAIL → implement → PASS.
- [x] **Step 6:** Register routes:

```ts
{ pattern: "/v1/connectors", methods: { GET: withPartnerAuth("list_connectors", "A", listConnectors) } },
{ pattern: "/v1/connectors/{type}/connect-link", methods: { POST: withPartnerAuth("create_connect_link", "C", createConnectLink) } },
```

- [x] **Step 7: Run** `router.test.ts` (non-enumerability, Allow headers) + new suite — PASS. **Step 8: Commit** `git commit -m "feat(partner-api): list connectors and mint connect links"`.

### Task 17: `POST /v1/tools/execute`

**Files:**
- Create: `supabase/functions/partner-api/v1/tools.ts`, test `tools.test.ts`
- Modify: `partner-api/v1/router.ts` (route), `partner-api/e2e/*` (one chain test)

**Interfaces — Consumes:** Task 14's `executeComposioTool`, `executeAdapterTool` (native, via the same internal call shape `connectorExecution.ts` uses), `withConnectorCall(source='partner', partnerKeyId, requestId)`, idempotency helpers. Body: `{ tool_id: uuid, social_account_id: uuid, capability: string, parameters: object }`.

- [x] **Step 1: Failing tests:** `social_account_id` not bound to the key → 404 `tool_not_found`; tool not resolvable for that account (`resolveToolsForAccount` with the account's links, `includeAdminOnly:false`) → 404 `tool_not_found`; native tool → adapter called with `tool_id, user_id = tool.user_id, capability, parameters`, 200 `{ ok:true, data, request_id, latency_ms }`; Composio tool → `executeComposioTool` with `dryRun:false`, budget 20 000; Composio refusals map to the 403/409/503 codes from Task 15; adapter `ok:false` → 502 `tool_execution_failed` with only `code`; abort → 504; every outcome writes `connector_call_logs(source='partner')` and the usual `partner_api_usage(billable=false)` row; idempotent replay returns the stored 200/502 body.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Route `{ pattern: "/v1/tools/execute", methods: { POST: withPartnerAuth("execute_tool", "C", executeTool) } }`.
- [x] **Step 6:** e2e chain (memory `postora-e2e-postgrest-harness`): seed a `supabase` native tool + key bound to its account on the harness, call the real handler through PostgREST, assert a `connector_call_logs` row with `partner_key_id` and the response `request_id` equal. "ignored" counts as failure.
- [x] **Step 7: Commit** `git commit -m "feat(partner-api): headless tool execution with metering and idempotency"`.

### Task 18: Partner docs

**Files:**
- Modify: `docs/api/openapi.yaml` (three paths + schemas `ConnectorSummary`, `ConnectLinkResponse`, `ToolExecuteRequest`, `ToolExecuteResponse`), `docs/developer/AGENT-CONTEXT.md` (connectors section), Postman collection if it is checked in

- [x] **Step 1:** Write the paths with the exact request/response shapes from Tasks 16–17 and the error codes from Task 15. **Step 2:** Run `docs-guard` against the handlers. **Step 3:** Commit `docs(partner-api): connectors and tools routes`.

---

## Slice D — UI & Partner Hub

### Task 19: Feature module `src/features/connectors/`

**Files:**
- Create: `src/features/connectors/domain/connectorCategories.ts`, `domain/usageSummary.ts`, `domain/__tests__/*.test.ts`, `infrastructure/connectorsApi.ts`, `infrastructure/__tests__/connectorsApi.test.ts`, `ui/hooks/useConnectorConnections.ts`, `ui/hooks/useConnectorUsage.ts`, `index.ts`

**Interfaces — Produces:**

```ts
// domain/connectorCategories.ts
export const CATEGORY_TABS: readonly { key: ConnectorCategory; label: string }[];  // ecommerce_payments, productivity_crm, databases, automation
export function typesInCategory(category: ConnectorCategory): ConnectorType[];
// domain/usageSummary.ts
export interface UsageRow { tool_id: string; calls: number; failures: number; p50_latency_ms: number | null; last_used_at: string | null; }
export function formatUsageLine(row: UsageRow | undefined, days: number): string;   // "142 calls · 30 d · p50 640 ms" | "No calls in 30 d"
// infrastructure/connectorsApi.ts
export type ConnectorConnectionRow = Tables<"connector_connections">;
export async function fetchConnections(workspaceId: string): Promise<ConnectorConnectionRow[]>;         // select via RLS
export async function fetchWorkspaceUsage(workspaceId: string, days?: number): Promise<UsageRow[]>;      // rpc workspace_connector_usage
export async function initiateConnection(input: { connector_type: ConnectorType; workspace_id: string }): Promise<{ connection_id: string; redirect_url: string; expires_at: string }>;  // fetch `${supabaseUrl}/functions/v1/composio-connect/initiate` with the session JWT, mirroring ConversationDetail.tsx:35
export async function revokeConnection(connectionId: string): Promise<void>;                             // same, path /revoke
export async function refreshConnectionSchema(connectionId: string): Promise<void>;
// hooks
export function useConnectorConnections(workspaceId: string | null);
export function useConnectorUsage(workspaceId: string | null, days?: number);
export function useInitiateConnection(); export function useRevokeConnection();
```

- [x] **Step 1: Failing tests:** `formatUsageLine` (three cases), `typesInCategory` covers every registry type exactly once, api adapters call the right function/RPC names and throw on `error` (mirror `partnerHubApi.test.ts`), hooks invalidate `connections` + `usage` keys on mutation success.
- [x] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(connectors-ui): feature module`.

### Task 20: Connector cards, tabs, picker, usage line

**Files:**
- Create: `src/components/automation/connectors/ComposioConnectCard.tsx`, `ConnectorUsageLine.tsx`, `ConnectionPicker.tsx`, `__tests__/*.test.tsx`
- Modify: `src/components/automation/DatabaseConnectorsManager.tsx` (tabs from `CATEGORY_TABS`; render `ComposioConnectCard` for `isComposioType` **in both mounts** — the `readOnly` prop hides the tool form, not connection controls (spec §9.1); tool form: hide credentials + show `ConnectionPicker` for Composio types; pass `connection_id`; show `ConnectorUsageLine` on every configured tool card)
- Modify: `src/pages/Settings.tsx:170-176` (Integrations tab reads `?connection=&result=` on mount, toasts the outcome, and strips the params)
- Modify: `src/hooks/useAiAgentTools.ts` (upsert payload += `connection_id`)

- [x] **Step 1: Failing component tests** (render with `QueryClientProvider`, no `userEvent` — memory: clipboard breaks it; use `fireEvent`): card states `disconnected` (Connect button calls `initiateConnection` then sets `window.location.href`), `initiated` (spinner + "Waiting for authorisation"), `active` (label, badge, usage line, Disconnect → confirm → `revokeConnection`), `revoked`/`failed` (reason + Reconnect). `ConnectionPicker` lists only `active` connections of the selected account's workspace and shows the Task 1 message when the account has no workspace. Tool form submits `connection_id` and omits credential fields for Composio types.
- [x] **Step 2–4:** FAIL → implement → PASS (`bunx vitest run src/components/automation`).
- [x] **Step 5: Commit** `feat(connectors-ui): Composio cards, category tabs, connection picker, usage line`.

### Task 21: Partner Hub readers and hooks

**Files:**
- Modify: `src/features/partner-hub/infrastructure/partnerHubApi.ts` (+ `fetchConnectorOverview`, `fetchConnectorUsageByType(days)`, `fetchConnectorUsageByKey(days)`, `fetchConnectorConnections(workspaceId?)`, `fetchKeyConnectorActivity(keyId, limit)`, `revokeConnection(connectionId)`), `ui/hooks/usePartnerHub.ts` (+ matching hooks and query keys), tests alongside.

- [x] Steps: failing api tests (RPC names/args, error throws) → implement → PASS → commit `feat(partner-hub): connector readers`.

### Task 22: Partner Hub components

**Files:**
- Create: `src/components/admin/partner/ConnectorUsageTables.tsx`, `ConnectorConnectionsTable.tsx`, `__tests__/*.test.tsx`
- Modify: `PartnerHubKpiCards.tsx` (+2 cards), `PartnerKeyActivitySheet.tsx` (third section "Connector calls"), `src/pages/admin/AdminPartnerHub.tsx` (mount the two tables under a "Connectors" heading)

- [x] **Step 1: Failing tests:** KPI cards render the two new numbers; usage tables render rows and a days selector (7/30/90) that refetches; connections table shows status badges and an admin Revoke dialog with confirmation; the activity sheet renders connector rows with latency and request id and "—" for nulls.
- [x] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(partner-hub): connector usage, connections and per-key activity`.

### Task 23: Mint dialog

**Files:** `src/components/admin/partner/GeneratePartnerKeyDialog.tsx` (no code change expected — it reads `PARTNER_SCOPES`), test `__tests__/GeneratePartnerKeyDialog.test.tsx`

- [x] **Step 1:** Add a test asserting the three scopes render with their descriptions and are submitted when checked. **Step 2:** Run — PASS if Task 15's twin is in place. **Step 3:** Commit `test(partner-hub): mint dialog offers connector scopes`.

---

## Slice E — Quality gates & landing

### Task 24: Guards, gates, PR

- [ ] **Step 1:** `clean-code-guard` on every changed production file; `test-guard` on every test file; `docs-guard` on openapi + AGENT-CONTEXT + both spec/plan docs.
- [ ] **Step 2:** Full gate block from the header; SQL harness green; `graphify update .`.
- [ ] **Step 3:** Rehearse migration `20260903120000` on the Contabo throwaway DB (memory `postora-migration-rehearsal-on-contabo`).
- [ ] **Step 4:** Apply the migration to production, then deploy edge functions via the runtime checkout in this order: `composio-connect`, `ai-agent-adapters`, `ai-agent-reply`, `messaging-api`, `partner-api`. Verify hashes. Set Dokploy secrets first (spec §13 step 1) and confirm the container was recreated. Apply the `composio-connect` JWT exemption from Task 11 step 2b on the self-hosted runtime and prove it with an unauthenticated `curl -I .../composio-connect/callback?state=bogus` returning 302 (not 401).
- [ ] **Step 5:** Commit that empties `PENDING_DB_CONNECTOR_TYPES` (registry test re-arms to expect `[]`), run gates, push, open the PR with the Task 1 evidence and the spec link; one bot review round (memory `postora-pr-bot-review-rounds`), merge.
- [ ] **Step 6:** Post-merge: connect one Google Sheets account on production, run one agent query and one `/v1/tools/execute`, confirm three `connector_call_logs` rows (`test`, `agent`, `partner`) and the Hub KPI moves. Save the mem0 summary.

---

## Slice F — YouTube via Composio (ships after Slice E; own PR)

### Task 25: Spike — managed YouTube auth config and upload bound (≤ 1 hour)

- [x] **Step 1:** In Composio's dashboard confirm the YouTube auth config's scopes include `https://www.googleapis.com/auth/youtube.upload`; record whether it is the managed app or Postora's client.
- [x] **Step 2:** With a throwaway workspace id, connect a test channel, run `YOUTUBE_LIST_CHANNELS` and `YOUTUBE_UPLOAD_VIDEO` with a 50 MB and a 500 MB `videoFilePath` URL; record success/latency/size limit.
- [x] **Step 3:** Write the results into spec §10.6 and set `YOUTUBE_COMPOSIO_MAX_BYTES` in Task 28 accordingly. If `youtube.upload` is absent from the managed app, STOP Slice F and report — the rest of the slice is worthless without it.

**Result (2026-09-03):** `ac_ZZF6rPlq_i9_` is Composio-managed with `youtube.upload`. The upload tool is `YOUTUBE_MULTIPART_UPLOAD_VIDEO` taking a `videoFile {name, mimetype, s3key}` obtained through `/files/upload/request` + presigned PUT (`_shared/composioFiles.ts`); Composio does not fetch from a URL. No real video was uploaded (no test channel is connected yet), so `YOUTUBE_COMPOSIO_MAX_BYTES = 64 MB` is a provisional cap, to be raised after a measured production upload.

### Task 26: Migration `20260903120100_youtube_composio_provider.sql` + harness

**Files:** Create the migration (spec §10.1 DDL, idempotent) and `supabase/tests/youtube_composio_provider.sql`; register in `scripts/db-harness.sh`; update `types.ts`.

- [x] **Step 1:** The migration adds the two columns and constraint (spec §10.1) and then `CREATE OR REPLACE FUNCTION public.revoke_connector_connection(p_connection_id UUID)` with Task 2's body plus `UPDATE public.social_accounts SET needs_reauth = true WHERE connection_id = p_connection_id;` before `END`. Suite proves: `auth_provider='composio'` without `connection_id` → `check_violation`; `revoke_connector_connection` now sets `needs_reauth` on the linked account and still disables dependent tools; RLS on `social_accounts` unchanged (existing suite still green).
- [x] **Step 2:** Harness green → commit `feat(youtube): composio publishing provider columns`.

### Task 27: `_shared/youtubeComposioOptions.ts` + create-time validation

**Files:** Create `supabase/functions/_shared/youtubeComposioOptions.ts` + test; modify the post-creation validator in `messaging-api` (or wherever `youtube_*` metadata is accepted — find with `grep -rn youtube_made_for_kids supabase/functions`), and `src/components/CreatePost*` YouTube tab to disable the same options when the selected channel is Composio-backed.

**Interfaces — Produces:**

```ts
/** Keys are the PlatformMetadata fields in process-post/index.ts:356-376. A key is offending only when set to a value Composio's upload cannot express (spec §10.4 table). */
export function youtubeOptionsUnsupportedOnComposio(metadata: PlatformMetadata | null | undefined): string[];   // returns offending keys; [] when fine
```

Offending conditions: `youtube_made_for_kids === true`, `youtube_notify_subscribers === false`, `youtube_allow_embedding === false`, `youtube_public_stats_viewable === false`, `youtube_contains_synthetic_media === true`, `youtube_has_paid_promotion === true`, `youtube_video_language`/`youtube_audio_language`/`youtube_recording_date`/`youtube_first_comment` non-empty, `youtube_license === "creativeCommon"`, `youtube_allowed_countries`/`youtube_blocked_countries` non-empty.

- [x] **Step 1: Tests:** each offending condition alone → its key; supported-only metadata (title, description, tags, category, visibility, thumbnail_url, video_type) → `[]`; `youtube_made_for_kids:false` and `youtube_notify_subscribers:true` are fine; `null`/`undefined` metadata → `[]`.
- [x] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Server validator returns 400 `youtube_option_unsupported_on_composio` naming the keys when the target account is `auth_provider='composio'`; UI disables the controls with the same list. **Step 6:** Commit `feat(youtube): refuse options Composio cannot express`.

### Task 28: `process-post/youtubeComposio.ts` + branch

**Files:**
- Create: `supabase/functions/process-post/youtubeComposio.ts`, test `youtubeComposio.test.ts`
- Modify: `process-post/index.ts:393-402` (`SocialAccount` += `auth_provider?: "native" | "composio"; connection_id?: string | null; workspace_id?: string | null`, and the select that loads accounts), `:1646-1648` (branch)

**Interfaces — Produces:**

```ts
export const YOUTUBE_COMPOSIO_MAX_BYTES = 64 * 1024 * 1024; // provisional (spec §10.6)
export interface YouTubeComposioDeps { admin: any; client: ComposioClient | null; signedUrlFor: (file: MediaFile) => Promise<string>; fetch?: typeof fetch; uploadFile?: typeof uploadFileForTool; timeoutMs?: number; }
export async function publishYouTubeViaComposio(account: SocialAccount, post: PostData, mediaFiles: MediaFile[], deps: YouTubeComposioDeps): Promise<PlatformPostResult>;
```

- [x] **Step 1: Failing tests:** no client → throws `Error("connector_unavailable")` and a `refused` publish row; connection inactive → sets `needs_reauth=true` and throws `connection_inactive`; no video file → throws the same message the native path uses; file above the bound → `youtube_file_too_large`; success → the bytes are read from the signed URL, staged with `uploadFileForTool`, and `YOUTUBE_MULTIPART_UPLOAD_VIDEO` is called with `{ title: metadata.youtube_title ?? caption first line, description, categoryId: metadata.youtube_category ?? "22", privacyStatus: metadata.youtube_visibility ?? "public", tags: metadata.youtube_tags ?? [], videoFile: { name, mimetype, s3key } }` (one `publish` ledger row for the upload, one for the thumbnail), result `{ id, url: "https://youtu.be/<id>" }`, `success` row with `source='publish'`; thumbnail present → `YOUTUBE_UPDATE_THUMBNAIL` called, its failure logged and the post still succeeds; abort at 50 000 ms → `timeout` row and thrown error.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Branch in `index.ts` exactly as spec §10.3; the account select adds the three columns.
- [x] **Step 6: Run** `process-post` suite — PASS. **Step 7: Commit** `feat(process-post): publish to Composio-connected YouTube channels`.

### Task 29: Skip Composio rows in refresh and health

**Files:** `supabase/functions/refresh-tokens/index.ts:471-497` and `:1002-1020`; `supabase/functions/check-connection-health/index.ts:85-100, 190`; tests alongside (extend existing).

- [x] **Step 1: Tests:** a `youtube` row with `auth_provider='composio'` is never passed to `refreshYouTubeToken`; `refresh-tokens` instead calls `getConnectedAccount(connection.composio_connected_account_id)` and, when status is not `ACTIVE`, applies the same update its `invalid_grant` branch applies at `:494` (`needs_reauth = true` plus whatever health columns that branch writes today — read the branch, copy its column list, do not invent one); `check-connection-health` reports the row from `connector_connections.status` and never calls `channels?mine=true` for it.
- [x] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(youtube): health and refresh understand the Composio provider`.

### Task 30: Channel upsert on callback + Profiles button

**Files:**
- Modify: `supabase/functions/composio-connect/callback.ts` (+ `upsertYouTubeChannels(deps, connection)` when `connector_type === "youtube"`), test
- Create: `src/components/profiles/YouTubeConnectMethodDialog.tsx` + `__tests__/YouTubeConnectMethodDialog.test.tsx` — a modal opened by the existing YouTube "Connect" control on `/profiles` (find it with `grep -rn "youtube-oauth" src/`). It offers two explicit radio choices with one-line explanations: **Direct Google OAuth** ("Postora's own Google app; full option support") and **Composio Managed** ("Composio's managed OAuth; some upload options unavailable — see the list"), a Continue button, and the Composio choice only when `VITE_COMPOSIO_YOUTUBE_ENABLED === "true"` (otherwise the dialog is skipped and the native flow starts directly, exactly as today). The user's choice is remembered per browser in `localStorage` key `postora.youtubeConnectMethod` as a default, never as a bypass — the dialog always shows.

- [x] **Step 1: Tests:** `YOUTUBE_LIST_CHANNELS` returning two channels → two `social_accounts` upserts `ON CONFLICT ON CONSTRAINT social_accounts_user_platform_unique` (`user_id, platform, platform_user_id` — verify it exists with `\d social_accounts` on the harness first; memory `whatsapp-qr-repair-unique-collision` records a silent 23505 on this table) with `auth_provider='composio', connection_id, workspace_id, access_token=null` and `social_profile_id` from the signed state when the app door sent one; zero channels → connection `failed('no_channel')`; an existing row for the same channel with `auth_provider='native'` is **not** overwritten (select first, refuse with `channel_already_native`).
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5: Dialog tests** (`fireEvent`, no `userEvent`): with the flag off, clicking Connect starts the native flow and renders no dialog; with the flag on, the dialog renders both options, defaults to the stored choice, Continue with "Direct Google OAuth" calls the existing native handler, Continue with "Composio Managed" calls `initiateConnection({ connector_type: "youtube", workspace_id, social_profile_id })` and sets `window.location.href`; the unsupported-options note lists the keys from `youtubeOptionsUnsupportedOnComposio`'s table.
- [x] **Step 6:** Implement the dialog; wire the `/profiles` control to open it. **Step 7:** Commit `feat(youtube): connection method selector and Composio channel connect`.

### Task 31: Land Slice F

- [ ] Guards, gates, harness; apply `20260903120100`; deploy `composio-connect`, `process-post`, `refresh-tokens`, `check-connection-health`; flip `COMPOSIO_YOUTUBE_ENABLED` / `VITE_COMPOSIO_YOUTUBE_ENABLED`; connect one channel, schedule one Short, confirm a `publish` ledger row and the video URL; mem0 summary; final report.

---

## Self-review (done at authoring)

- **Spec coverage:** §4 → Tasks 2–4, 26; §5 → 7; §6 → 8–11; §7 → 13–14; §8 → 15–18; §9 → 19–23; §10 → 25–30; §11 fail-closed rows → asserted in 5, 11, 13, 14, 17, 28; §12 tests → per task; §13 order → 24, 31; §14 open items → 1, 6, 25.
- **Type consistency:** `ActiveConnection` (Task 10) is what `ComposioReadyTool.connection` (13), `executeComposioTool` (14) and `publishYouTubeViaComposio` (28, via `loadActiveConnection`) consume; `ConnectorCallMeta.source` values match the DB CHECK; error codes in 15 match the refusal codes thrown in 14 and 17.
- **Placeholders:** the only deferred values are the three Task 6/25 measurements (`toolkitVersion`, confirmed slugs, `YOUTUBE_COMPOSIO_MAX_BYTES`), each with the task that fills it.
