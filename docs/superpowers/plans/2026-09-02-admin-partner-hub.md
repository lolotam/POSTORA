# Admin Partner Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/admin/partner-hub`: KPI cards, a cross-workspace partner-key table with quota bars, a mint dialog with one-time plaintext display, a revoke dialog, and an activity/webhook drawer — all backed by admin-gated SQL RPCs.

**Architecture:** One expand-only migration adds admin-only `SECURITY DEFINER` RPCs, widens the key-management predicate to platform admins, and adds `request_id`/`latency_ms` to the usage ledger. The `partner-api` edge function fills the two new ledger columns. The frontend is a `src/features/partner-hub` module (domain rules, RPC adapters, react-query hooks) consumed by components in `src/components/admin/partner/` and the page `src/pages/admin/AdminPartnerHub.tsx`.

**Tech Stack:** Postgres 17 (plpgsql, `has_role`), Deno edge functions, React 18 + TypeScript + Vite, TanStack Query, shadcn/ui, vitest + Testing Library, SQL harness (`scripts/db-harness.sh`).

**Spec:** `docs/superpowers/specs/2026-09-02-admin-partner-hub-design.md` (read it first; decisions D1–D10 are binding).

**Required reading before any code:** `ARCHITECTURE.md` §3, §11, §13, §23, §24, §33, §39; `AGENTS.md` "What a reviewer should hold this repo to".

**Work in the worktree `F:/Postora-partner-hub` (branch `feat/admin-partner-hub`).** Never touch `F:/Postora_new`.

**Slices (disjoint path sets, for delegation):**
- Slice A — Tasks 1–3: migration, SQL suite, harness registration, `types.ts`.
- Slice B — Tasks 4–5: edge ledger columns + Deno tests.
- Slice C — Tasks 6–14: frontend module, components, page, route, sidebar, vitest.
- Slice C depends on Slice A's `types.ts` edit (Task 3). Slice B is independent.

**Gate commands (run from the worktree):**
```bash
# Deno tests need no node_modules; run them with plain `deno test` (never --node-modules-dir=auto here, it breaks vitest). Frontend tools run through bunx (bun installs tsc as a .bunx shim that npx cannot find).
deno test --allow-env --allow-read --no-check supabase/functions/_shared/partnerApiMetering.test.ts supabase/functions/partner-api/v1/authenticated.test.ts
bun install
bunx tsc -b --noEmit
bunx vitest run src/features/partner-hub src/components/admin/partner
bunx vitest run
# SQL harness (PG17 container; see supabase/tests/README.md "Running locally")
DB_URL='postgres://supabase_admin:postgres@localhost:5432/postgres' HARNESS_DB_NAME=partner_api_harness bash scripts/db-harness.sh
```

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260902200000_admin_partner_hub.sql` | ledger columns, admin gate, predicate widening, 5 admin RPCs, grants |
| `supabase/tests/partner_hub_admin.sql` | harness suite for the above |
| `scripts/db-harness.sh` | register the suite |
| `src/integrations/supabase/types.ts` | `Functions` entries for `create_partner_key` + 5 admin RPCs |
| `supabase/functions/_shared/partnerApiMetering.ts` | `UsageInput.requestId/latencyMs`, written by `recordUsage` |
| `supabase/functions/partner-api/v1/authenticated.ts` | capture start time, fill both fields |
| `supabase/functions/partner-api/index.ts` | alias door passes request id + start time |
| `src/features/partner-hub/domain/*.ts` | pure rules: quota tone, key mint, scope twin, endpoint map, credentials file |
| `src/features/partner-hub/infrastructure/partnerHubApi.ts` | RPC adapters |
| `src/features/partner-hub/ui/hooks/usePartnerHub.ts` | react-query hooks |
| `src/features/partner-hub/index.ts` | public surface |
| `src/components/admin/partner/*.tsx` | UI components |
| `src/pages/admin/AdminPartnerHub.tsx` | page composition |
| `src/components/AnimatedRoutes.tsx`, `src/components/admin/AdminLayout.tsx` | route + sidebar |

---

## Slice A — database

### Task 1: Migration `20260902200000_admin_partner_hub.sql`

**Files:**
- Create: `supabase/migrations/20260902200000_admin_partner_hub.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Admin Partner Hub (spec: docs/superpowers/specs/2026-09-02-admin-partner-hub-design.md).
--
-- Expand-only and idempotent. Three things, in dependency order:
--   1. Two nullable ledger columns (request_id, latency_ms) so an operator can
--      correlate a partner's "the 09:14 call failed" with one row.
--   2. Platform admins may manage keys in ANY workspace (spec D1). The shared
--      predicate is widened, and revoke_partner_key is rewritten to USE the
--      shared predicate instead of its inline copy -- otherwise the widening
--      never reaches revocation.
--   3. Five admin-only SECURITY DEFINER readers (spec D2). No table policy is
--      widened; each function refuses a non-admin with insufficient_privilege
--      (a refused read must never look like an empty one) and never selects
--      key_hash, secret or previous_secret.

-- ---------------------------------------------------------------------------
-- 1. Ledger columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_api_usage
  ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE public.partner_api_usage
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_api_usage_latency_ms_nonneg'
  ) THEN
    ALTER TABLE public.partner_api_usage
      ADD CONSTRAINT partner_api_usage_latency_ms_nonneg
      CHECK (latency_ms IS NULL OR latency_ms >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.partner_api_usage.request_id IS
  'The X-Postora-Request-Id the response carried. NULL for rows written before 2026-09-02.';
COMMENT ON COLUMN public.partner_api_usage.latency_ms IS
  'Wall-clock milliseconds from request entry to response, measured by the edge worker. NULL for older rows.';

-- ---------------------------------------------------------------------------
-- 2. The admin gate, private
-- ---------------------------------------------------------------------------
-- RAISE, not RETURN FALSE: every caller below is a reader, and a reader that
-- silently returns nothing for the wrong caller is indistinguishable from
-- "there is no data" (AGENTS.md reviewer rule 3).
CREATE OR REPLACE FUNCTION public.partner_hub_assert_admin()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'platform admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_hub_assert_admin() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Platform admins may manage keys in any workspace (D1)
-- ---------------------------------------------------------------------------
-- Same signature as 20260831170000, so this is a replacement. Widening for
-- the admin role only; nothing is narrowed. The actor is still auth.uid(), so
-- created_by / actor_id record the administrator, never a service role.
CREATE OR REPLACE FUNCTION public.partner_caller_may_manage_keys(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'admin'::public.app_role)
      OR EXISTS (
        SELECT 1 FROM public.workspace_members m
         WHERE m.workspace_id = p_workspace_id
           AND m.user_id = auth.uid()
           AND m.role IN ('owner', 'admin')
      );
$$;

-- revoke_partner_key carried its own inline copy of the membership rule.
-- Rewritten to consult the shared predicate; every other property is kept:
-- one-way, refuses an already-revoked key, actor stamped server-side, audit
-- row ONLY on a real revocation, returns BOOLEAN.
CREATE OR REPLACE FUNCTION public.revoke_partner_key(p_key_id UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated      INTEGER;
  v_workspace_id UUID;
BEGIN
  UPDATE public.partner_api_keys k
     SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = p_reason
   WHERE k.id = p_key_id
     AND k.revoked_at IS NULL
     AND public.partner_caller_may_manage_keys(k.workspace_id)
  RETURNING k.workspace_id INTO v_workspace_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, metadata)
    VALUES (
      v_workspace_id, p_key_id, auth.uid(), 'revoke',
      jsonb_build_object('reason', p_reason)
    );
  END IF;

  RETURN v_updated > 0;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Readers (D2)
-- ---------------------------------------------------------------------------

-- 4a. The four KPI cards in one row. Definitions are spec D7; the month
-- boundary is the same date_trunc('month', now()) reserve_partner_quota uses,
-- so the cards and the quota counters agree on what "this month" means.
CREATE OR REPLACE FUNCTION public.admin_partner_hub_overview()
RETURNS TABLE (
  active_keys        BIGINT,
  revoked_keys       BIGINT,
  month_billable     BIGINT,
  month_posts        BIGINT,
  requests_30d       BIGINT,
  success_30d        BIGINT,
  deliveries_30d     BIGINT,
  delivered_30d      BIGINT,
  exhausted_30d      BIGINT,
  pending_deliveries BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.partner_api_keys k
      WHERE k.revoked_at IS NULL
        AND k.superseded_by_key_id IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())),
    (SELECT count(*) FROM public.partner_api_keys k WHERE k.revoked_at IS NOT NULL),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.billable AND u.created_at >= date_trunc('month', now())),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.action = 'create_post' AND u.http_status < 300
        AND u.created_at >= date_trunc('month', now())),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.created_at >= now() - interval '30 days' AND u.http_status < 400),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.created_at >= now() - interval '30 days' AND d.status = 'delivered'),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.created_at >= now() - interval '30 days' AND d.status = 'exhausted'),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.status IN ('pending', 'delivering'));
END;
$$;

-- 4b. Every key, every workspace. The charged total follows the SAME stale-
-- period rule as GET /v1/usage (usagePeriodFor): a row whose last_reset_at is
-- before this month has not been reset yet because nothing reserved, so it is
-- rendered as the next reservation will reset it -- zero.
CREATE OR REPLACE FUNCTION public.admin_partner_keys()
RETURNS TABLE (
  id                   UUID,
  name                 TEXT,
  environment          TEXT,
  key_prefix           TEXT,
  workspace_id         UUID,
  workspace_name       TEXT,
  social_account_id    UUID,
  account_platform     TEXT,
  account_username     TEXT,
  scopes               TEXT[],
  rate_limit_per_min   INTEGER,
  monthly_quota        INTEGER,
  usage_charged        INTEGER,
  usage_reserved       INTEGER,
  usage_confirmed      INTEGER,
  usage_indeterminate  INTEGER,
  period_start         TIMESTAMPTZ,
  status               TEXT,
  created_at           TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  revoked_reason       TEXT,
  superseded_by_key_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT
    k.id, k.name, k.environment, k.key_prefix,
    k.workspace_id, w.name,
    k.social_account_id, a.platform, a.platform_username,
    k.scopes, k.rate_limit_per_min, k.monthly_quota,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.current_usage_count END,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.usage_reserved END,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.usage_confirmed END,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.usage_indeterminate END,
    GREATEST(k.last_reset_at, date_trunc('month', now())),
    CASE
      WHEN k.revoked_at IS NOT NULL THEN 'revoked'
      WHEN k.superseded_by_key_id IS NOT NULL THEN 'rotated'
      WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
      ELSE 'active'
    END,
    k.created_at, k.last_used_at, k.expires_at, k.revoked_at, k.revoked_reason,
    k.superseded_by_key_id
  FROM public.partner_api_keys k
  LEFT JOIN public.workspaces w ON w.id = k.workspace_id
  LEFT JOIN public.social_accounts a ON a.id = k.social_account_id
  ORDER BY k.created_at DESC;
END;
$$;

-- 4c. What a new key may be pinned to. WhatsApp accounts only (spec D8): the
-- composite FK proves an account is in the workspace, not that it can send,
-- and every /v1 messaging op assumes the bound account is WhatsApp. Health
-- flags come along so the form can refuse an unhealthy account the way
-- scripts/create-partner-key.ts does.
CREATE OR REPLACE FUNCTION public.admin_partner_key_targets()
RETURNS TABLE (
  workspace_id      UUID,
  workspace_name    TEXT,
  social_account_id UUID,
  platform          TEXT,
  platform_username TEXT,
  is_active         BOOLEAN,
  needs_reauth      BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT w.id, w.name, a.id, a.platform, a.platform_username,
         COALESCE(a.is_active, false), COALESCE(a.needs_reauth, false)
    FROM public.social_accounts a
    JOIN public.workspaces w ON w.id = a.workspace_id
   WHERE a.platform = 'whatsapp'
   ORDER BY w.name, a.platform_username;
END;
$$;

-- 4d. Recent ledger rows for one key. Raises for an unknown key rather than
-- returning nothing -- for an admin, "no such key" is information.
CREATE OR REPLACE FUNCTION public.admin_partner_key_activity(
  p_key_id UUID,
  p_limit  INTEGER DEFAULT 50
)
RETURNS TABLE (
  id          UUID,
  created_at  TIMESTAMPTZ,
  action      TEXT,
  http_status INTEGER,
  error_code  TEXT,
  billable    BOOLEAN,
  request_id  TEXT,
  latency_ms  INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  IF NOT EXISTS (SELECT 1 FROM public.partner_api_keys k WHERE k.id = p_key_id) THEN
    RAISE EXCEPTION 'no such partner key' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT u.id, u.created_at, u.action, u.http_status, u.error_code, u.billable,
         u.request_id, u.latency_ms
    FROM public.partner_api_usage u
   WHERE u.key_id = p_key_id
   ORDER BY u.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- 4e. Webhook deliveries for the KEY'S WORKSPACE (spec D6): deliveries belong
-- to a subscription, and subscriptions belong to a workspace, not a key. The
-- secret columns are never projected.
CREATE OR REPLACE FUNCTION public.admin_partner_key_webhook_deliveries(
  p_key_id UUID,
  p_limit  INTEGER DEFAULT 50
)
RETURNS TABLE (
  id                UUID,
  occurred_at       TIMESTAMPTZ,
  event_type        TEXT,
  status            TEXT,
  attempts          INTEGER,
  next_attempt_at   TIMESTAMPTZ,
  last_status_code  INTEGER,
  last_error        TEXT,
  delivered_at      TIMESTAMPTZ,
  webhook_id        UUID,
  webhook_url       TEXT,
  webhook_is_active BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
BEGIN
  PERFORM public.partner_hub_assert_admin();
  SELECT k.workspace_id INTO v_workspace_id FROM public.partner_api_keys k WHERE k.id = p_key_id;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'no such partner key' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT d.id, d.occurred_at, d.event_type, d.status, d.attempts, d.next_attempt_at,
         d.last_status_code, d.last_error, d.delivered_at,
         w.id, w.url, w.is_active
    FROM public.partner_webhook_deliveries d
    JOIN public.partner_webhooks w ON w.id = d.webhook_id
   WHERE d.workspace_id = v_workspace_id
   ORDER BY d.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants. The gate is inside each function, so `authenticated` may EXECUTE.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_partner_hub_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_keys() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_key_targets() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_key_activity(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_key_webhook_deliveries(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_partner_hub_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_keys() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_key_targets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_key_activity(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_key_webhook_deliveries(UUID, INTEGER) TO authenticated;

-- PostgREST answers from a cached schema; without this a freshly created
-- function 404s until the next reload (memory: postora-migration-deploy-ordering).
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply it on the PG17 harness and confirm it loads**

Run: `DB_URL='postgres://supabase_admin:postgres@localhost:5432/postgres' HARNESS_DB_NAME=partner_api_harness bash scripts/db-harness.sh`
Expected: the migration step succeeds (existing suites still pass; the new suite is added in Task 2).

### Task 2: SQL suite `partner_hub_admin.sql` + harness registration

**Files:**
- Create: `supabase/tests/partner_hub_admin.sql`
- Modify: `scripts/db-harness.sh` (SUITES array, after `partner_key_environment.sql`)
- Modify: `supabase/tests/README.md` (suite table, one row)

- [ ] **Step 1: Write the suite**

```sql
-- ============================================================================
-- partner_hub_admin.sql — Admin Partner Hub (20260902200000)
--
-- Proves: (1) every admin_partner_* reader refuses a non-admin with
-- insufficient_privilege; (2) a platform admin reads keys across workspaces
-- they are not a member of; (3) no reader projects a secret column;
-- (4) a platform admin can create and revoke a key in a foreign workspace and
-- the audit trail names the admin; (5) a workspace owner still can;
-- (6) latency_ms refuses a negative value.
--
-- Run with psql AS A SUPERUSER against a throwaway database with every
-- migration applied. NEVER against production.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_hub_admin: start ==='

CREATE TEMP TABLE hub_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO hub_ids VALUES
  ('admin',   '88888888-8888-8888-8888-888888888881'),
  ('owner_a', '88888888-8888-8888-8888-888888888882'),
  ('owner_b', '88888888-8888-8888-8888-888888888883'),
  ('nobody',  '88888888-8888-8888-8888-888888888884'),
  ('ws_a',    '99999999-9999-9999-9999-999999999991'),
  ('ws_b',    '99999999-9999-9999-9999-999999999992'),
  ('acct_a',  'aaaaaaaa-9999-9999-9999-999999999991'),
  ('acct_b',  'aaaaaaaa-9999-9999-9999-999999999992');

CREATE OR REPLACE FUNCTION pg_temp.hub_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws uuid[] := ARRAY(SELECT id FROM hub_ids WHERE k IN ('ws_a','ws_b'));
  v_us uuid[] := ARRAY(SELECT id FROM hub_ids WHERE k IN ('admin','owner_a','owner_b','nobody'));
BEGIN
  DELETE FROM public.partner_webhook_deliveries WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_webhooks WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_usage WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_audit_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_key_accounts WHERE workspace_id = ANY(v_ws);
  UPDATE public.partner_api_keys SET superseded_by_key_id = NULL WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_keys WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.workspace_members WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.workspaces WHERE id = ANY(v_ws);
  DELETE FROM public.user_roles WHERE user_id = ANY(v_us);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.hub_cleanup();

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

-- Every reader, called under the current actor; raises insufficient_privilege
-- or not. Used by H1 (must raise) and H2 (must not).
CREATE OR REPLACE FUNCTION pg_temp.reader_refused(p_sql TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Seed: an admin who is a member of NO workspace, two workspace owners, an
-- outsider, two workspaces each with one WhatsApp account and one key.
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_admin   uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_owner_a uuid := (SELECT id FROM hub_ids WHERE k='owner_a');
  v_owner_b uuid := (SELECT id FROM hub_ids WHERE k='owner_b');
  v_nobody  uuid := (SELECT id FROM hub_ids WHERE k='nobody');
  v_ws_a    uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_ws_b    uuid := (SELECT id FROM hub_ids WHERE k='ws_b');
  v_acct_a  uuid := (SELECT id FROM hub_ids WHERE k='acct_a');
  v_acct_b  uuid := (SELECT id FROM hub_ids WHERE k='acct_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_admin,   'hub-admin@example.invalid'),
    (v_owner_a, 'hub-owner-a@example.invalid'),
    (v_owner_b, 'hub-owner-b@example.invalid'),
    (v_nobody,  'hub-nobody@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  -- The signup trigger may have inserted a default 'user' role; the admin
  -- role is an additional row (UNIQUE (user_id, role)).
  INSERT INTO public.user_roles (user_id, role) VALUES (v_admin, 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws_a, 'hub-ws-a', v_owner_a),
    (v_ws_b, 'hub-ws-b', v_owner_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws_a, v_owner_a, 'owner'),
    (v_ws_b, v_owner_b, 'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, workspace_id, is_active)
  VALUES
    (v_acct_a, v_owner_a, 'whatsapp', 'hub-acct-a', 'hub-a', 'seed-a', v_ws_a, true),
    (v_acct_b, v_owner_b, 'whatsapp', 'hub-acct-b', 'hub-b', 'seed-b', v_ws_b, true)
  ON CONFLICT (id) DO NOTHING;

  -- One key per workspace, minted by its owner through the real RPC.
  PERFORM pg_temp.act_as(v_owner_a);
  PERFORM public.create_partner_key(v_ws_a, v_acct_a, 'hub key a', 'pk_live_hub1',
    'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    ARRAY['messages:send'], 60, 100);
  PERFORM pg_temp.act_as(v_owner_b);
  PERFORM public.create_partner_key(v_ws_b, v_acct_b, 'hub key b', 'pk_test_hub2',
    'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    ARRAY['posts:write'], 60, NULL, NULL, NULL, 'staging');
END $seed$;

-- ===========================================================================
-- H1 — a non-admin is refused by every reader
-- ===========================================================================
DO $h1$
DECLARE
  v_owner_a uuid := (SELECT id FROM hub_ids WHERE k='owner_a');
  v_nobody  uuid := (SELECT id FROM hub_ids WHERE k='nobody');
  v_key_a   uuid := (SELECT id FROM public.partner_api_keys WHERE key_prefix = 'pk_live_hub1');
  v_actor   uuid;
BEGIN
  FOREACH v_actor IN ARRAY ARRAY[v_owner_a, v_nobody] LOOP
    PERFORM pg_temp.act_as(v_actor);
    PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_hub_overview()'), 'H1 overview refused');
    PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_keys()'), 'H1 keys refused');
    PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_key_targets()'), 'H1 targets refused');
    PERFORM pg_temp.must(pg_temp.reader_refused(format('SELECT * FROM public.admin_partner_key_activity(%L)', v_key_a)), 'H1 activity refused');
    PERFORM pg_temp.must(pg_temp.reader_refused(format('SELECT * FROM public.admin_partner_key_webhook_deliveries(%L)', v_key_a)), 'H1 deliveries refused');
  END LOOP;
  -- No JWT at all (service role / anon): also refused.
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_keys()'), 'H1 keys refused without a subject');
  RAISE NOTICE 'PASS H1: non-admins are refused by every reader';
END $h1$;

-- ===========================================================================
-- H2 — the admin reads across workspaces they do not belong to
-- ===========================================================================
DO $h2$
DECLARE
  v_admin uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_ws_a  uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_ws_b  uuid := (SELECT id FROM hub_ids WHERE k='ws_b');
  v_n     int;
BEGIN
  PERFORM pg_temp.act_as(v_admin);
  PERFORM pg_temp.must(NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE user_id = v_admin),
    'H2 precondition: admin is a member of no workspace');
  SELECT count(*) INTO v_n FROM public.admin_partner_keys() k WHERE k.workspace_id IN (v_ws_a, v_ws_b);
  PERFORM pg_temp.must(v_n = 2, 'H2 admin sees both seeded keys');
  PERFORM pg_temp.must(
    (SELECT k.status FROM public.admin_partner_keys() k WHERE k.key_prefix = 'pk_live_hub1') = 'active',
    'H2 status is active');
  PERFORM pg_temp.must(
    (SELECT k.workspace_name FROM public.admin_partner_keys() k WHERE k.key_prefix = 'pk_test_hub2') = 'hub-ws-b',
    'H2 workspace name joined');
  PERFORM pg_temp.must(
    (SELECT k.environment FROM public.admin_partner_keys() k WHERE k.key_prefix = 'pk_test_hub2') = 'staging',
    'H2 environment projected');
  SELECT count(*) INTO v_n FROM public.admin_partner_key_targets() t WHERE t.workspace_id IN (v_ws_a, v_ws_b);
  PERFORM pg_temp.must(v_n = 2, 'H2 targets lists both WhatsApp accounts');
  PERFORM pg_temp.must((SELECT o.active_keys FROM public.admin_partner_hub_overview() o) >= 2,
    'H2 overview counts the active keys');
  RAISE NOTICE 'PASS H2: admin reads across foreign workspaces';
END $h2$;

-- ===========================================================================
-- H3 — no reader projects a secret column
-- ===========================================================================
DO $h3$
DECLARE
  v_fn text;
  v_bad int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'admin_partner_hub_overview', 'admin_partner_keys', 'admin_partner_key_targets',
    'admin_partner_key_activity', 'admin_partner_key_webhook_deliveries'
  ] LOOP
    SELECT count(*) INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL unnest(p.proargnames) AS arg
     WHERE n.nspname = 'public' AND p.proname = v_fn
       AND arg IN ('key_hash', 'secret', 'previous_secret');
    PERFORM pg_temp.must(v_bad = 0, format('H3 %s projects no secret column', v_fn));
  END LOOP;
  RAISE NOTICE 'PASS H3: no secret column in any reader';
END $h3$;

-- ===========================================================================
-- H4 — the admin creates and revokes in a foreign workspace; audit names them
-- ===========================================================================
DO $h4$
DECLARE
  v_admin  uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_ws_a   uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM hub_ids WHERE k='acct_a');
  v_key    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_admin);
  v_key := public.create_partner_key(v_ws_a, v_acct_a, 'hub admin-minted', 'pk_live_hub3',
    'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
    ARRAY['accounts:read'], 60, 10);
  PERFORM pg_temp.must(
    (SELECT created_by FROM public.partner_api_keys WHERE id = v_key) = v_admin,
    'H4 created_by is the admin');
  PERFORM pg_temp.must(EXISTS (
    SELECT 1 FROM public.partner_audit_logs
     WHERE key_id = v_key AND action = 'create' AND actor_id = v_admin),
    'H4 create audit row names the admin');
  PERFORM pg_temp.must(public.revoke_partner_key(v_key, 'hub test'), 'H4 admin revokes');
  PERFORM pg_temp.must(
    (SELECT revoked_by FROM public.partner_api_keys WHERE id = v_key) = v_admin,
    'H4 revoked_by is the admin');
  PERFORM pg_temp.must(EXISTS (
    SELECT 1 FROM public.partner_audit_logs
     WHERE key_id = v_key AND action = 'revoke' AND actor_id = v_admin),
    'H4 revoke audit row names the admin');
  PERFORM pg_temp.must(NOT public.revoke_partner_key(v_key, 'again'), 'H4 second revoke is a no-op');
  PERFORM pg_temp.must(
    (SELECT k.status FROM public.admin_partner_keys() k WHERE k.id = v_key) = 'revoked',
    'H4 status reads revoked');
  RAISE NOTICE 'PASS H4: admin lifecycle in a foreign workspace is audited';
END $h4$;

-- ===========================================================================
-- H5 — a workspace owner still manages their own keys; an outsider cannot
-- ===========================================================================
DO $h5$
DECLARE
  v_owner_b uuid := (SELECT id FROM hub_ids WHERE k='owner_b');
  v_nobody  uuid := (SELECT id FROM hub_ids WHERE k='nobody');
  v_key_b   uuid := (SELECT id FROM public.partner_api_keys WHERE key_prefix = 'pk_test_hub2');
BEGIN
  PERFORM pg_temp.act_as(v_nobody);
  PERFORM pg_temp.must(NOT public.revoke_partner_key(v_key_b, 'outsider'), 'H5 outsider cannot revoke');
  PERFORM pg_temp.act_as(v_owner_b);
  PERFORM pg_temp.must(public.revoke_partner_key(v_key_b, 'owner'), 'H5 owner revokes own key');
  RAISE NOTICE 'PASS H5: owner path unchanged, outsider refused';
END $h5$;

-- ===========================================================================
-- H6 — ledger columns: activity projects them; negative latency is refused
-- ===========================================================================
DO $h6$
DECLARE
  v_admin uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_ws_a  uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_key_a uuid := (SELECT id FROM public.partner_api_keys WHERE key_prefix = 'pk_live_hub1');
  v_rows  int;
BEGIN
  INSERT INTO public.partner_api_usage (key_id, workspace_id, action, billable, http_status, request_id, latency_ms)
  VALUES (v_key_a, v_ws_a, 'list_accounts', false, 200, 'req-hub-1', 42);
  BEGIN
    INSERT INTO public.partner_api_usage (key_id, workspace_id, action, billable, http_status, latency_ms)
    VALUES (v_key_a, v_ws_a, 'list_accounts', false, 200, -1);
    RAISE EXCEPTION 'H6: negative latency was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  PERFORM pg_temp.act_as(v_admin);
  SELECT count(*) INTO v_rows FROM public.admin_partner_key_activity(v_key_a, 10) a
   WHERE a.request_id = 'req-hub-1' AND a.latency_ms = 42;
  PERFORM pg_temp.must(v_rows = 1, 'H6 activity projects request_id and latency_ms');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_partner_key_activity(v_key_a, 0)) = 1,
    'H6 limit is clamped to at least 1');
  BEGIN
    PERFORM * FROM public.admin_partner_key_activity('00000000-0000-0000-0000-000000000000');
    RAISE EXCEPTION 'H6: unknown key returned rows';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  RAISE NOTICE 'PASS H6: ledger columns and activity reader';
END $h6$;

SELECT pg_temp.hub_cleanup();
\echo '=== partner_hub_admin: done ==='
```

- [ ] **Step 2: Register the suite**

In `scripts/db-harness.sh`, add `partner_hub_admin.sql` after `partner_key_environment.sql` in `SUITES=(...)`. In `supabase/tests/README.md`, add a table row: `| partner_hub_admin.sql | Admin Partner Hub readers, admin key lifecycle in foreign workspaces, ledger columns; self-cleaning |`.

- [ ] **Step 3: Run the harness**

Run: `DB_URL='postgres://supabase_admin:postgres@localhost:5432/postgres' HARNESS_DB_NAME=partner_api_harness bash scripts/db-harness.sh`
Expected: `PASS H1` … `PASS H6` notices and the script exits 0.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260902200000_admin_partner_hub.sql supabase/tests/partner_hub_admin.sql scripts/db-harness.sh supabase/tests/README.md
git commit -m "feat(partner-hub): admin readers, admin key management, ledger request_id/latency"
```

### Task 3: Generated types for the RPCs

**Files:**
- Modify: `src/integrations/supabase/types.ts` (inside `public.Functions`, next to `revoke_partner_key`)

- [ ] **Step 1: Add the entries** (hand-maintained until the next regeneration; shapes match what `supabase gen types` produces for `RETURNS TABLE`)

```ts
      create_partner_key: {
        Args: {
          p_workspace_id: string
          p_social_account_id: string
          p_name: string
          p_key_prefix: string
          p_key_hash: string
          p_scopes: string[]
          p_rate_limit_per_min?: number
          p_monthly_quota?: number | null
          p_expires_at?: string | null
          p_request_id?: string | null
          p_environment?: string
        }
        Returns: string
      }
      admin_partner_hub_overview: {
        Args: Record<PropertyKey, never>
        Returns: {
          active_keys: number
          revoked_keys: number
          month_billable: number
          month_posts: number
          requests_30d: number
          success_30d: number
          deliveries_30d: number
          delivered_30d: number
          exhausted_30d: number
          pending_deliveries: number
        }[]
      }
      admin_partner_keys: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          name: string
          environment: string
          key_prefix: string
          workspace_id: string
          workspace_name: string | null
          social_account_id: string
          account_platform: string | null
          account_username: string | null
          scopes: string[]
          rate_limit_per_min: number
          monthly_quota: number | null
          usage_charged: number
          usage_reserved: number
          usage_confirmed: number
          usage_indeterminate: number
          period_start: string
          status: string
          created_at: string
          last_used_at: string | null
          expires_at: string | null
          revoked_at: string | null
          revoked_reason: string | null
          superseded_by_key_id: string | null
        }[]
      }
      admin_partner_key_targets: {
        Args: Record<PropertyKey, never>
        Returns: {
          workspace_id: string
          workspace_name: string
          social_account_id: string
          platform: string
          platform_username: string | null
          is_active: boolean
          needs_reauth: boolean
        }[]
      }
      admin_partner_key_activity: {
        Args: { p_key_id: string; p_limit?: number }
        Returns: {
          id: string
          created_at: string
          action: string
          http_status: number
          error_code: string | null
          billable: boolean
          request_id: string | null
          latency_ms: number | null
        }[]
      }
      admin_partner_key_webhook_deliveries: {
        Args: { p_key_id: string; p_limit?: number }
        Returns: {
          id: string
          occurred_at: string
          event_type: string
          status: string
          attempts: number
          next_attempt_at: string
          last_status_code: number | null
          last_error: string | null
          delivered_at: string | null
          webhook_id: string
          webhook_url: string
          webhook_is_active: boolean
        }[]
      }
```

- [ ] **Step 2: Typecheck and commit**

Run: `bunx tsc -b --noEmit` → Expected: no errors.
```bash
git add src/integrations/supabase/types.ts
git commit -m "chore(types): partner hub RPC signatures"
```

---

## Slice B — edge ledger columns

### Task 4: `recordUsage` writes `request_id` and `latency_ms`

**Files:**
- Modify: `supabase/functions/_shared/partnerApiMetering.ts` (`UsageInput`, `recordUsage`)
- Test: `supabase/functions/_shared/partnerApiMetering.test.ts`

- [ ] **Step 1: Write the failing tests** (append)

```ts
Deno.test("recordUsage writes request_id and latency_ms when given", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return { insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "list_accounts",
    billable: false, httpStatus: 200, requestId: "req-42", latencyMs: 17,
  });
  assertEquals(inserted[0].request_id, "req-42");
  assertEquals(inserted[0].latency_ms, 17);
});

Deno.test("recordUsage writes null for request_id and latency_ms when absent", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return { insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "list_accounts", billable: false, httpStatus: 200,
  });
  assertEquals(inserted[0].request_id, null);
  assertEquals(inserted[0].latency_ms, null);
});

Deno.test("recordUsage rounds latency to a non-negative integer", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return { insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "list_accounts",
    billable: false, httpStatus: 200, latencyMs: -0.4,
  });
  assertEquals(inserted[0].latency_ms, 0);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/partnerApiMetering.test.ts`
Expected: the three new tests FAIL (`undefined` instead of the values).

- [ ] **Step 3: Implement**

In `UsageInput` add:
```ts
  /** The X-Postora-Request-Id the response carried; the operator's only correlation handle. */
  requestId?: string;
  /** Wall-clock ms from request entry to response. Rounded and floored at 0 on write. */
  latencyMs?: number;
```
In `recordUsage`, the insert becomes:
```ts
    const { error } = await client.from("partner_api_usage").insert({
      key_id: input.keyId,
      workspace_id: input.workspaceId,
      action: input.action,
      billable: input.billable,
      http_status: input.httpStatus,
      error_code: input.errorCode ?? null,
      request_id: input.requestId ?? null,
      // The column CHECK refuses a negative; a clock that ran backwards must
      // not cost the row.
      latency_ms: input.latencyMs === undefined ? null : Math.max(0, Math.round(input.latencyMs)),
    });
```

- [ ] **Step 4: Run to see them pass**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/partnerApiMetering.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/partnerApiMetering.ts supabase/functions/_shared/partnerApiMetering.test.ts
git commit -m "feat(partner-api): usage ledger carries request_id and latency_ms"
```

### Task 5: Both doors fill the two fields

**Files:**
- Modify: `supabase/functions/partner-api/v1/authenticated.ts` (`withPartnerAuth`, `usageRowFor`)
- Modify: `supabase/functions/partner-api/index.ts` (`respond()` helper ~line 484 and its one call site ~line 186; request entry ~line 145)
- Test: `supabase/functions/partner-api/v1/authenticated.test.ts`

- [ ] **Step 1: Write the failing test** (append to `authenticated.test.ts`)

```ts
Deno.test("every ledger row carries the request id and a non-negative integer latency", async () => {
  const { admin, inserts } = ledgerStub();
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  await wrapped(get("pk_live_test"), "req-77", {}, () => admin);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].request_id, "req-77");
  const latency = inserts[0].latency_ms;
  assertEquals(typeof latency, "number");
  assertEquals(Number.isInteger(latency) && (latency as number) >= 0, true);
});
```

Then make the existing deep-equal assertions on `inserts` tolerate the two new fields: add near the top of the file

```ts
/** The ledger row without the fields this suite does not assert on
 *  (latency is wall-clock; request_id is asserted in its own test). */
function comparable(rows: Record<string, unknown>[]) {
  return rows.map(({ latency_ms: _l, request_id: _r, ...rest }) => rest);
}
```

and change every `assertEquals(inserts, [...])` to `assertEquals(comparable(inserts), [...])`.

- [ ] **Step 2: Run to see it fail**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/partner-api/v1/authenticated.test.ts`
Expected: the new test FAILS (`request_id` undefined).

- [ ] **Step 3: Implement in `authenticated.ts`**

Inside the returned async function, first line after the signature:
```ts
    const startedAt = performance.now();
```
Change `ledgered` to:
```ts
    const ledgered = async (res: Response): Promise<Response> => {
      if (record) {
        await recordUsage(admin, await usageRowFor(record, action, res, requestId, startedAt));
      }
      return res;
    };
```
Change `usageRowFor`:
```ts
async function usageRowFor(
  record: PartnerKeyRecord,
  action: string,
  res: Response,
  requestId: string,
  startedAt: number,
): Promise<UsageInput> {
  const replayed = res.headers.get("Idempotency-Replayed") === "true";
  return {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable: QUOTA_RESERVING_ACTIONS.has(action) && res.status < 300 && !replayed,
    httpStatus: res.status,
    errorCode: res.status >= 400 ? await errorCodeOf(res) : undefined,
    requestId,
    latencyMs: performance.now() - startedAt,
  };
}
```
(Keep the existing comments.)

- [ ] **Step 4: Implement in `index.ts` (alias door)**

Right after `const requestId = crypto.randomUUID();` add `const startedAt = performance.now();`.
Add a final parameter to `respond()`: `startedAt?: number`, and pass both into `recordUsage`:
```ts
  await recordUsage(admin, {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable,
    httpStatus: status,
    errorCode,
    requestId,
    latencyMs: startedAt === undefined ? undefined : performance.now() - startedAt,
  });
```
At the one call site (the arrow around line 186) append `startedAt` after `requestId`.

- [ ] **Step 5: Run the Deno suites**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/partner-api/ supabase/functions/_shared/partnerApiMetering.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/partner-api/v1/authenticated.ts supabase/functions/partner-api/v1/authenticated.test.ts supabase/functions/partner-api/index.ts
git commit -m "feat(partner-api): both doors stamp request_id and latency on the ledger"
```

---

## Slice C — frontend

Conventions: shadcn/ui from `@/components/ui/*`, `useToast` from `@/hooks/use-toast`, `supabase` from `@/integrations/supabase/client`, `format` from `date-fns`, icons from `lucide-react`. Tests use `render/screen/fireEvent` from `@testing-library/react` (never `userEvent` — clipboard breaks it) and wrap with a `QueryClientProvider`.

### Task 6: Domain — quota, mint, scopes, endpoints, credentials file

**Files:**
- Create: `src/features/partner-hub/domain/quotaUsage.ts`
- Create: `src/features/partner-hub/domain/partnerKeyMint.ts`
- Create: `src/features/partner-hub/domain/partnerScopes.ts`
- Create: `src/features/partner-hub/domain/activityEndpoints.ts`
- Create: `src/features/partner-hub/domain/credentialsFile.ts`
- Test: `src/features/partner-hub/domain/__tests__/quotaUsage.test.ts`, `partnerKeyMint.test.ts`, `partnerScopes.test.ts`, `activityEndpoints.test.ts`, `credentialsFile.test.ts`

- [ ] **Step 1: Write the failing tests**

`quotaUsage.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { quotaPercent, quotaTone } from "../quotaUsage";

describe("quotaPercent", () => {
  it("is null when the quota is unlimited", () => {
    expect(quotaPercent(10, null)).toBeNull();
  });
  it("rounds to a whole percent and caps at 100", () => {
    expect(quotaPercent(1, 3)).toBe(33);
    expect(quotaPercent(120, 100)).toBe(100);
  });
  it("treats a zero quota as fully used once anything is charged", () => {
    expect(quotaPercent(0, 0)).toBe(0);
    expect(quotaPercent(1, 0)).toBe(100);
  });
});

describe("quotaTone", () => {
  it("is ok below 80, warning at 80, critical at 95", () => {
    expect(quotaTone(79)).toBe("ok");
    expect(quotaTone(80)).toBe("warning");
    expect(quotaTone(94)).toBe("warning");
    expect(quotaTone(95)).toBe("critical");
  });
  it("is ok for an unlimited quota", () => {
    expect(quotaTone(null)).toBe("ok");
  });
});
```

`partnerKeyMint.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { generatePartnerKey, KEY_PREFIX_BY_ENVIRONMENT } from "../partnerKeyMint";

// Browser twin of supabase/functions/_shared/partnerApiKeys.ts generatePartnerKey.
// The database enforces prefix<->environment and the 64-hex digest; this
// pins the shape the database will accept.
describe("generatePartnerKey", () => {
  it("mints a production key with the pk_live_ prefix and a 32-char base62 body", async () => {
    const { key, prefix, hash } = await generatePartnerKey("production");
    expect(key.startsWith(KEY_PREFIX_BY_ENVIRONMENT.production)).toBe(true);
    expect(key.slice(8)).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("mints a staging key with the pk_test_ prefix", async () => {
    const { key } = await generatePartnerKey("staging");
    expect(key.startsWith("pk_test_")).toBe(true);
  });
  it("hashes deterministically", async () => {
    const { hashPartnerKey } = await import("../partnerKeyMint");
    expect(await hashPartnerKey("pk_live_x")).toBe(await hashPartnerKey("pk_live_x"));
  });
  it("never mints the same key twice", async () => {
    const a = await generatePartnerKey("production");
    const b = await generatePartnerKey("production");
    expect(a.key).not.toBe(b.key);
  });
});
```

`partnerScopes.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PARTNER_SCOPES } from "../partnerScopes";

// The same parity check the Deno suite runs (partnerScopes.test.ts): the
// mintable list must equal docs/api/openapi.yaml GenericScope, so the form
// can never offer a scope the API does not enforce, or miss one it does.
// Layout in the file (verified 2026-09-02): `    GenericScope:` … `      enum:` followed by
// one `        - <scope>` line per value, ended by the next non-list line.
function genericScopesFromOpenApi(): string[] {
  const lines = readFileSync(resolve(process.cwd(), "docs/api/openapi.yaml"), "utf8").split(/\r?\n/);
  const schemaAt = lines.findIndex((l) => /^\s*GenericScope:\s*$/.test(l));
  const enumAt = lines.findIndex((l, i) => i > schemaAt && /^\s*enum:\s*$/.test(l));
  if (schemaAt < 0 || enumAt < 0) throw new Error("GenericScope enum not found in docs/api/openapi.yaml");
  const values: string[] = [];
  for (let i = enumAt + 1; i < lines.length; i++) {
    const m = /^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i]);
    if (!m) break;
    values.push(m[1]);
  }
  return values;
}

describe("PARTNER_SCOPES", () => {
  it("equals the published GenericScope vocabulary", () => {
    expect([...PARTNER_SCOPES.map((s) => s.value)].sort()).toEqual(genericScopesFromOpenApi().sort());
  });
  it("never offers a legacy whatsapp:* scope", () => {
    expect(PARTNER_SCOPES.some((s) => s.value.startsWith("whatsapp:"))).toBe(false);
  });
  it("describes every scope", () => {
    for (const s of PARTNER_SCOPES) expect(s.description.length).toBeGreaterThan(0);
  });
});
```
(Before writing the parser, open `docs/api/openapi.yaml`, find `GenericScope`, and adapt the slicing to the file's actual layout; the assertion is what matters.)

`activityEndpoints.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { endpointForAction } from "../activityEndpoints";

describe("endpointForAction", () => {
  it("maps ledger actions to the documented /v1 routes", () => {
    expect(endpointForAction("send_template")).toBe("POST /v1/messages");
    expect(endpointForAction("create_post")).toBe("POST /v1/posts");
    expect(endpointForAction("list_accounts")).toBe("GET /v1/accounts");
    expect(endpointForAction("get_usage")).toBe("GET /v1/usage");
    expect(endpointForAction("test_webhook")).toBe("POST /v1/webhooks/{id}/test");
  });
  it("falls back to the raw action for an unknown one", () => {
    expect(endpointForAction("something_new")).toBe("something_new");
  });
});
```

`credentialsFile.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { buildCredentialsFile } from "../credentialsFile";

describe("buildCredentialsFile", () => {
  it("serialises the one-time credential bundle", () => {
    const json = buildCredentialsFile({
      name: "Danat", environment: "staging", key: "pk_test_abc", keyPrefix: "pk_test_abc",
      scopes: ["messages:send"], workspaceId: "ws", socialAccountId: "acct",
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const parsed = JSON.parse(json);
    expect(parsed.key).toBe("pk_test_abc");
    expect(parsed.base_url).toBe("https://api.postora.cloud/functions/v1/partner-api/v1");
    expect(parsed.scopes).toEqual(["messages:send"]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bunx vitest run src/features/partner-hub` → Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`quotaUsage.ts`
```ts
/** Quota bar arithmetic. Thresholds are the spec's: warning at 80%, critical at 95%. */
export type QuotaTone = "ok" | "warning" | "critical";

/** Whole percent used, capped at 100; null when the key has no quota. */
export function quotaPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function quotaTone(percent: number | null): QuotaTone {
  if (percent === null) return "ok";
  if (percent >= 95) return "critical";
  if (percent >= 80) return "warning";
  return "ok";
}
```

`partnerKeyMint.ts`
```ts
// Browser twin of supabase/functions/_shared/partnerApiKeys.ts generatePartnerKey.
//
// Minting happens in the browser on purpose (spec D3): the plaintext exists
// only in this tab and only until the dialog closes; the server receives the
// prefix and the SHA-256 digest, exactly as scripts/create-partner-key.ts
// sends them. The database refuses a prefix that disagrees with the
// environment and a digest that is not 64 hex chars, so a drift here fails
// loudly rather than minting a wrong key.

export type PartnerEnvironment = "production" | "staging";

export const KEY_PREFIX_BY_ENVIRONMENT: Record<PartnerEnvironment, string> = {
  production: "pk_live_",
  staging: "pk_test_",
};

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface MintedPartnerKey {
  /** The plaintext. Show once, never store. */
  key: string;
  /** First 12 chars, e.g. "pk_live_a1b2" — what the table displays. */
  prefix: string;
  /** SHA-256 hex digest of the plaintext — what the database stores. */
  hash: string;
}

export async function hashPartnerKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generatePartnerKey(environment: PartnerEnvironment): Promise<MintedPartnerKey> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += BASE62[b % BASE62.length];
  const key = KEY_PREFIX_BY_ENVIRONMENT[environment] + body;
  return { key, prefix: key.slice(0, 12), hash: await hashPartnerKey(key) };
}
```

`partnerScopes.ts`
```ts
// Frontend twin of GENERIC_SCOPES in supabase/functions/_shared/partnerScopes.ts.
// Kept honest by __tests__/partnerScopes.test.ts, which asserts equality with
// docs/api/openapi.yaml GenericScope. Legacy whatsapp:* scopes are never
// offered (decision D3): they are frozen and not issuable to new keys.

export interface PartnerScopeOption {
  value: string;
  description: string;
}

export const PARTNER_SCOPES: readonly PartnerScopeOption[] = [
  { value: "accounts:read", description: "List and read bound social accounts" },
  { value: "conversations:read", description: "List conversations" },
  { value: "media:read", description: "Read uploaded media" },
  { value: "media:write", description: "Upload media (billed storage)" },
  { value: "messages:read", description: "Read messages" },
  { value: "messages:send", description: "Send WhatsApp messages (consumes monthly quota)" },
  { value: "posts:publish", description: "Publish posts immediately" },
  { value: "posts:read", description: "Read posts and their status" },
  { value: "posts:schedule", description: "Schedule and unschedule posts" },
  { value: "posts:write", description: "Create posts" },
  { value: "templates:read", description: "List approved WhatsApp templates" },
  { value: "usage:read", description: "Read this key's usage meters" },
  { value: "webhooks:manage", description: "Create, update, delete and test webhooks" },
  { value: "webhooks:read", description: "List webhooks" },
] as const;
```

`activityEndpoints.ts`
```ts
/** Ledger `action` → the documented /v1 route (partner-api/v1/router.ts). */
const ACTION_ENDPOINTS: Record<string, string> = {
  list_accounts: "GET /v1/accounts",
  get_account: "GET /v1/accounts/{id}",
  list_conversations: "GET /v1/conversations",
  get_conversation: "GET /v1/conversations/{id}",
  list_conversation_messages: "GET /v1/conversations/{id}/messages",
  get_message: "GET /v1/messages/{id}",
  send_template: "POST /v1/messages",
  send_text: "POST /v1/messages",
  send_media: "POST /v1/messages",
  list_templates: "GET /v1/templates",
  upload_media: "POST /v1/media",
  get_media: "GET /v1/media/{id}",
  list_webhooks: "GET /v1/webhooks",
  get_webhook: "GET /v1/webhooks/{id}",
  create_webhook: "POST /v1/webhooks",
  update_webhook: "PATCH /v1/webhooks/{id}",
  delete_webhook: "DELETE /v1/webhooks/{id}",
  rotate_webhook_secret: "POST /v1/webhooks/{id}/rotate-secret",
  test_webhook: "POST /v1/webhooks/{id}/test",
  create_post: "POST /v1/posts",
  get_post: "GET /v1/posts/{id}",
  get_post_status: "GET /v1/posts/{id}/status",
  schedule_post: "POST /v1/posts/{id}/schedule",
  unschedule_post: "DELETE /v1/posts/{id}/schedule",
  get_usage: "GET /v1/usage",
};

export function endpointForAction(action: string): string {
  return Object.hasOwn(ACTION_ENDPOINTS, action) ? ACTION_ENDPOINTS[action] : action;
}
```
(Verify the HTTP verbs against `supabase/functions/partner-api/v1/router.ts` while implementing and fix any that differ; the test pins five of them.)

`credentialsFile.ts`
```ts
export const PARTNER_API_BASE_URL = "https://api.postora.cloud/functions/v1/partner-api/v1";

export interface CredentialsFileInput {
  name: string;
  environment: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  workspaceId: string;
  socialAccountId: string;
  createdAt: string;
}

/** The JSON the success view lets the admin download. Built once, from the
 *  same values shown on screen; never re-read from anywhere. */
export function buildCredentialsFile(input: CredentialsFileInput): string {
  return JSON.stringify(
    {
      name: input.name,
      environment: input.environment,
      key: input.key,
      key_prefix: input.keyPrefix,
      scopes: input.scopes,
      workspace_id: input.workspaceId,
      social_account_id: input.socialAccountId,
      base_url: PARTNER_API_BASE_URL,
      header: "x-postora-key",
      created_at: input.createdAt,
    },
    null,
    2,
  );
}
```

- [ ] **Step 4: Run to see them pass**

Run: `bunx vitest run src/features/partner-hub` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/partner-hub/domain
git commit -m "feat(partner-hub): domain rules — quota tone, browser mint, scope twin, endpoint map"
```

### Task 7: Infrastructure adapters

**Files:**
- Create: `src/features/partner-hub/infrastructure/partnerHubApi.ts`
- Test: `src/features/partner-hub/infrastructure/__tests__/partnerHubApi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { createPartnerKey, fetchOverview, fetchKeys, revokePartnerKey } from "../partnerHubApi";

describe("partnerHubApi", () => {
  beforeEach(() => rpc.mockReset());

  it("fetchOverview unwraps the single row", async () => {
    rpc.mockResolvedValue({ data: [{ active_keys: 2 }], error: null });
    const row = await fetchOverview();
    expect(rpc).toHaveBeenCalledWith("admin_partner_hub_overview");
    expect(row.active_keys).toBe(2);
  });

  it("fetchKeys throws on a PostgREST error instead of returning an empty list", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "platform admin only" } });
    await expect(fetchKeys()).rejects.toMatchObject({ message: "platform admin only" });
  });

  it("createPartnerKey sends only the prefix and a 64-hex hash, never the plaintext", async () => {
    rpc.mockResolvedValue({ data: "key-id", error: null });
    const result = await createPartnerKey({
      name: "Danat", workspaceId: "ws", socialAccountId: "acct", environment: "staging",
      scopes: ["messages:send"], monthlyQuota: 100, rateLimitPerMin: 60,
    });
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("create_partner_key");
    expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_key_prefix).toBe(result.key.slice(0, 12));
    expect(args.p_environment).toBe("staging");
    expect(JSON.stringify(args)).not.toContain(result.key);
    expect(result.id).toBe("key-id");
  });

  it("revokePartnerKey reports a refused revocation as an error", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(revokePartnerKey("k", "leaked")).rejects.toThrow(/not revoked/i);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bunx vitest run src/features/partner-hub/infrastructure` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { generatePartnerKey, type PartnerEnvironment } from "../domain/partnerKeyMint";

/**
 * Supabase adapters for the Admin Partner Hub. Every read is an admin-gated
 * SECURITY DEFINER RPC (migration 20260902200000); a refused read raises in
 * SQL and is rethrown here — a failed read must never look like an empty one.
 */

type Fns = Database["public"]["Functions"];
export type PartnerHubOverview = Fns["admin_partner_hub_overview"]["Returns"][number];
export type PartnerKeyRow = Fns["admin_partner_keys"]["Returns"][number];
export type PartnerKeyTarget = Fns["admin_partner_key_targets"]["Returns"][number];
export type PartnerKeyActivityRow = Fns["admin_partner_key_activity"]["Returns"][number];
export type PartnerWebhookDeliveryRow = Fns["admin_partner_key_webhook_deliveries"]["Returns"][number];

export async function fetchOverview(): Promise<PartnerHubOverview> {
  const { data, error } = await supabase.rpc("admin_partner_hub_overview");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("admin_partner_hub_overview returned no row");
  return row as PartnerHubOverview;
}

export async function fetchKeys(): Promise<PartnerKeyRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_keys");
  if (error) throw error;
  return (data ?? []) as PartnerKeyRow[];
}

export async function fetchTargets(): Promise<PartnerKeyTarget[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_targets");
  if (error) throw error;
  return (data ?? []) as PartnerKeyTarget[];
}

export async function fetchKeyActivity(keyId: string, limit = 50): Promise<PartnerKeyActivityRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_activity", { p_key_id: keyId, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as PartnerKeyActivityRow[];
}

export async function fetchKeyDeliveries(keyId: string, limit = 50): Promise<PartnerWebhookDeliveryRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_webhook_deliveries", { p_key_id: keyId, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as PartnerWebhookDeliveryRow[];
}

export interface CreatePartnerKeyInput {
  name: string;
  workspaceId: string;
  socialAccountId: string;
  environment: PartnerEnvironment;
  scopes: string[];
  /** null = unlimited */
  monthlyQuota: number | null;
  rateLimitPerMin: number;
}

export interface CreatedPartnerKey {
  id: string;
  /** Plaintext. Exists only in the caller's memory; never persisted or logged. */
  key: string;
  prefix: string;
  createdAt: string;
}

/**
 * Mint in the browser, store only the digest (spec D3). The RPC runs under
 * the admin's JWT so created_by and the audit actor are the administrator.
 */
export async function createPartnerKey(input: CreatePartnerKeyInput): Promise<CreatedPartnerKey> {
  const minted = await generatePartnerKey(input.environment);
  const { data, error } = await supabase.rpc("create_partner_key", {
    p_workspace_id: input.workspaceId,
    p_social_account_id: input.socialAccountId,
    p_name: input.name,
    p_key_prefix: minted.prefix,
    p_key_hash: minted.hash,
    p_scopes: input.scopes,
    p_rate_limit_per_min: input.rateLimitPerMin,
    p_monthly_quota: input.monthlyQuota,
    p_environment: input.environment,
  });
  if (error) throw error;
  return { id: data as string, key: minted.key, prefix: minted.prefix, createdAt: new Date().toISOString() };
}

/** One-way. The RPC returns false when nothing changed (already revoked, or
 *  not permitted); that is a failure to the caller, not a silent success. */
export async function revokePartnerKey(keyId: string, reason: string): Promise<void> {
  const { data, error } = await supabase.rpc("revoke_partner_key", { p_key_id: keyId, p_reason: reason });
  if (error) throw error;
  if (data !== true) throw new Error("Key was not revoked (already revoked or not permitted)");
}
```

- [ ] **Step 4: Run to see it pass** — `bunx vitest run src/features/partner-hub` → PASS. `bunx tsc -b --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/partner-hub/infrastructure
git commit -m "feat(partner-hub): RPC adapters"
```

### Task 8: Hooks and public surface

**Files:**
- Create: `src/features/partner-hub/ui/hooks/usePartnerHub.ts`
- Create: `src/features/partner-hub/index.ts`

- [ ] **Step 1: Implement the hooks**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPartnerKey,
  fetchKeyActivity,
  fetchKeyDeliveries,
  fetchKeys,
  fetchOverview,
  fetchTargets,
  revokePartnerKey,
  type CreatePartnerKeyInput,
} from "../../infrastructure/partnerHubApi";

const ROOT = ["admin", "partner-hub"] as const;
export const partnerHubKeys = {
  overview: () => [...ROOT, "overview"] as const,
  keys: () => [...ROOT, "keys"] as const,
  targets: () => [...ROOT, "targets"] as const,
  activity: (keyId: string) => [...ROOT, "activity", keyId] as const,
  deliveries: (keyId: string) => [...ROOT, "deliveries", keyId] as const,
};

export function usePartnerHubOverview() {
  return useQuery({ queryKey: partnerHubKeys.overview(), queryFn: fetchOverview, refetchInterval: 60_000 });
}

export function usePartnerKeys() {
  return useQuery({ queryKey: partnerHubKeys.keys(), queryFn: fetchKeys, refetchInterval: 60_000 });
}

export function usePartnerKeyTargets(enabled: boolean) {
  return useQuery({ queryKey: partnerHubKeys.targets(), queryFn: fetchTargets, enabled });
}

export function usePartnerKeyActivity(keyId: string | null) {
  return useQuery({
    queryKey: partnerHubKeys.activity(keyId ?? ""),
    queryFn: () => fetchKeyActivity(keyId as string),
    enabled: keyId !== null,
    refetchInterval: 15_000,
  });
}

export function usePartnerKeyDeliveries(keyId: string | null) {
  return useQuery({
    queryKey: partnerHubKeys.deliveries(keyId ?? ""),
    queryFn: () => fetchKeyDeliveries(keyId as string),
    enabled: keyId !== null,
    refetchInterval: 15_000,
  });
}

export function useCreatePartnerKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePartnerKeyInput) => createPartnerKey(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: partnerHubKeys.keys() });
      qc.invalidateQueries({ queryKey: partnerHubKeys.overview() });
    },
  });
}

export function useRevokePartnerKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keyId, reason }: { keyId: string; reason: string }) => revokePartnerKey(keyId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: partnerHubKeys.keys() });
      qc.invalidateQueries({ queryKey: partnerHubKeys.overview() });
    },
  });
}
```

- [ ] **Step 2: Public surface** (`index.ts`)

```ts
export {
  useCreatePartnerKey,
  usePartnerHubOverview,
  usePartnerKeyActivity,
  usePartnerKeyDeliveries,
  usePartnerKeys,
  usePartnerKeyTargets,
  useRevokePartnerKey,
} from "./ui/hooks/usePartnerHub";
export type {
  CreatePartnerKeyInput,
  CreatedPartnerKey,
  PartnerHubOverview,
  PartnerKeyActivityRow,
  PartnerKeyRow,
  PartnerKeyTarget,
  PartnerWebhookDeliveryRow,
} from "./infrastructure/partnerHubApi";
export { quotaPercent, quotaTone, type QuotaTone } from "./domain/quotaUsage";
export { PARTNER_SCOPES, type PartnerScopeOption } from "./domain/partnerScopes";
export { endpointForAction } from "./domain/activityEndpoints";
export { buildCredentialsFile } from "./domain/credentialsFile";
export type { PartnerEnvironment } from "./domain/partnerKeyMint";
```

- [ ] **Step 3: Typecheck and commit**

```bash
bunx tsc -b --noEmit
git add src/features/partner-hub/ui src/features/partner-hub/index.ts
git commit -m "feat(partner-hub): react-query hooks and public surface"
```

### Task 9: `QuotaUsageBar`, `ScopeBadges`, `PartnerHubKpiCards`

**Files:**
- Create: `src/components/admin/partner/QuotaUsageBar.tsx`, `ScopeBadges.tsx`, `PartnerHubKpiCards.tsx`
- Test: `src/components/admin/partner/__tests__/QuotaUsageBar.test.tsx`, `ScopeBadges.test.tsx`, `PartnerHubKpiCards.test.tsx`

- [ ] **Step 1: Write the failing tests**

`QuotaUsageBar.test.tsx`
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuotaUsageBar } from "../QuotaUsageBar";

describe("QuotaUsageBar", () => {
  it("shows used / limit and the percent", () => {
    render(<QuotaUsageBar used={40} limit={100} />);
    expect(screen.getByText("40 / 100")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByTestId("quota-bar")).toHaveAttribute("data-tone", "ok");
  });
  it("turns warning at 80% and critical at 95%", () => {
    const { rerender } = render(<QuotaUsageBar used={80} limit={100} />);
    expect(screen.getByTestId("quota-bar")).toHaveAttribute("data-tone", "warning");
    rerender(<QuotaUsageBar used={95} limit={100} />);
    expect(screen.getByTestId("quota-bar")).toHaveAttribute("data-tone", "critical");
  });
  it("shows only the count for an unlimited quota", () => {
    render(<QuotaUsageBar used={7} limit={null} />);
    expect(screen.getByText(/7 · unlimited/i)).toBeInTheDocument();
    expect(screen.queryByTestId("quota-bar")).not.toBeInTheDocument();
  });
});
```

`ScopeBadges.test.tsx`
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScopeBadges } from "../ScopeBadges";

describe("ScopeBadges", () => {
  it("renders one badge per scope and reports a click", () => {
    const onToggle = vi.fn();
    render(<ScopeBadges scopes={["messages:send", "posts:write"]} activeScope={null} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "messages:send" }));
    expect(onToggle).toHaveBeenCalledWith("messages:send");
  });
  it("marks the active scope", () => {
    render(<ScopeBadges scopes={["messages:send"]} activeScope="messages:send" onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "messages:send" })).toHaveAttribute("aria-pressed", "true");
  });
});
```

`PartnerHubKpiCards.test.tsx`
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PartnerHubKpiCards } from "../PartnerHubKpiCards";

const OVERVIEW = {
  active_keys: 3, revoked_keys: 1, month_billable: 120, month_posts: 4,
  requests_30d: 200, success_30d: 190, deliveries_30d: 50, delivered_30d: 45, exhausted_30d: 5, pending_deliveries: 2,
};

describe("PartnerHubKpiCards", () => {
  it("renders the four KPIs from the overview row", () => {
    render(<PartnerHubKpiCards overview={OVERVIEW} isLoading={false} error={null} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument(); // 190/200
    expect(screen.getByText("90%")).toBeInTheDocument(); // 45/(45+5)
  });
  it("shows a dash when there were no requests or no settled deliveries", () => {
    render(<PartnerHubKpiCards overview={{ ...OVERVIEW, requests_30d: 0, success_30d: 0, delivered_30d: 0, exhausted_30d: 0 }} isLoading={false} error={null} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
  it("shows the error instead of numbers when the read failed", () => {
    render(<PartnerHubKpiCards overview={undefined} isLoading={false} error={new Error("platform admin only")} />);
    expect(screen.getByText(/platform admin only/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail** — `bunx vitest run src/components/admin/partner` → FAIL.

- [ ] **Step 3: Implement**

`QuotaUsageBar.tsx`
```tsx
import { Progress } from "@/components/ui/progress";
import { quotaPercent, quotaTone, type QuotaTone } from "@/features/partner-hub";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<QuotaTone, string> = {
  ok: "[&>div]:bg-primary",
  warning: "[&>div]:bg-amber-500",
  critical: "[&>div]:bg-destructive",
};

interface QuotaUsageBarProps {
  used: number;
  limit: number | null;
}

/** "used / limit" with a tone-coloured bar; unlimited quotas get a count only. */
export function QuotaUsageBar({ used, limit }: QuotaUsageBarProps) {
  const percent = quotaPercent(used, limit);
  if (percent === null) {
    return <span className="text-sm text-muted-foreground">{used} · unlimited</span>;
  }
  const tone = quotaTone(percent);
  return (
    <div className="min-w-[160px] space-y-1">
      <div className="flex justify-between text-xs">
        <span>{used} / {limit}</span>
        <span className={cn(tone === "critical" && "text-destructive", tone === "warning" && "text-amber-600")}>{percent}%</span>
      </div>
      <Progress data-testid="quota-bar" data-tone={tone} value={percent} className={cn("h-2", TONE_CLASS[tone])} />
    </div>
  );
}
```

`ScopeBadges.tsx`
```tsx
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ScopeBadgesProps {
  scopes: string[];
  activeScope: string | null;
  onToggle: (scope: string) => void;
}

/** Clickable scope badges; clicking one filters the table by that scope. */
export function ScopeBadges({ scopes, activeScope, onToggle }: ScopeBadgesProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <button
          key={scope}
          type="button"
          aria-pressed={activeScope === scope}
          onClick={() => onToggle(scope)}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant={activeScope === scope ? "default" : "secondary"} className={cn("cursor-pointer font-mono text-[11px]")}>
            {scope}
          </Badge>
        </button>
      ))}
    </div>
  );
}
```

`PartnerHubKpiCards.tsx`
```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, KeyRound, MessageSquare, Webhook } from "lucide-react";
import type { PartnerHubOverview } from "@/features/partner-hub";

interface PartnerHubKpiCardsProps {
  overview: PartnerHubOverview | undefined;
  isLoading: boolean;
  error: Error | null;
}

function percent(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

export function PartnerHubKpiCards({ overview, isLoading, error }: PartnerHubKpiCardsProps) {
  if (error) {
    return <p className="text-sm text-destructive">Could not load partner metrics: {error.message}</p>;
  }
  const settled = (overview?.delivered_30d ?? 0) + (overview?.exhausted_30d ?? 0);
  const cards = [
    { title: "Active partners", icon: KeyRound, value: overview ? String(overview.active_keys) : null, hint: `${overview?.revoked_keys ?? 0} revoked` },
    { title: "Monthly consumption", icon: MessageSquare, value: overview ? String(overview.month_billable) : null, hint: `billable sends this month · ${overview?.month_posts ?? 0} posts created` },
    { title: "API health (30d)", icon: Activity, value: overview ? percent(overview.success_30d, overview.requests_30d) : null, hint: `${overview?.requests_30d ?? 0} authenticated requests` },
    { title: "Webhooks health (30d)", icon: Webhook, value: overview ? percent(overview.delivered_30d, settled) : null, hint: `${overview?.deliveries_30d ?? 0} deliveries · ${overview?.pending_deliveries ?? 0} pending` },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading || card.value === null ? <Skeleton className="h-8 w-16" /> : <div className="text-2xl font-bold">{card.value}</div>}
            <p className="text-xs text-muted-foreground">{card.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to see them pass** — `bunx vitest run src/components/admin/partner` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/partner
git commit -m "feat(partner-hub): KPI cards, quota bar, scope badges"
```

### Task 10: `PartnerKeysTable` + `RevokePartnerKeyDialog`

**Files:**
- Create: `src/components/admin/partner/PartnerKeysTable.tsx`, `RevokePartnerKeyDialog.tsx`
- Test: `src/components/admin/partner/__tests__/PartnerKeysTable.test.tsx`, `RevokePartnerKeyDialog.test.tsx`

- [ ] **Step 1: Write the failing tests**

`PartnerKeysTable.test.tsx`
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PartnerKeysTable } from "../PartnerKeysTable";
import type { PartnerKeyRow } from "@/features/partner-hub";

const base: PartnerKeyRow = {
  id: "k1", name: "Danat backend", environment: "production", key_prefix: "pk_live_a1b2",
  workspace_id: "ws", workspace_name: "Danat", social_account_id: "acct", account_platform: "whatsapp", account_username: "danat",
  scopes: ["messages:send", "templates:read"], rate_limit_per_min: 60, monthly_quota: 100,
  usage_charged: 85, usage_reserved: 0, usage_confirmed: 85, usage_indeterminate: 0, period_start: "2026-09-01T00:00:00Z",
  status: "active", created_at: "2026-09-01T10:00:00Z", last_used_at: "2026-09-02T09:14:00Z", expires_at: null,
  revoked_at: null, revoked_reason: null, superseded_by_key_id: null,
};
const revoked: PartnerKeyRow = { ...base, id: "k2", name: "Old key", key_prefix: "pk_live_zzzz", status: "revoked", revoked_at: "2026-08-30T00:00:00Z", environment: "staging" };

describe("PartnerKeysTable", () => {
  it("renders name, environment, prefix, workspace and account", () => {
    render(<PartnerKeysTable keys={[base]} isLoading={false} error={null} activeScope={null} onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText("Danat backend")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("pk_live_a1b2…")).toBeInTheDocument();
    expect(screen.getByText(/Danat/)).toBeInTheDocument();
    expect(screen.getByText(/whatsapp · danat/)).toBeInTheDocument();
  });
  it("disables Revoke for a non-active key and enables it for an active one", () => {
    render(<PartnerKeysTable keys={[base, revoked]} isLoading={false} error={null} activeScope={null} onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /revoke key/i });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
  });
  it("calls back with the key for View Live Activity and Revoke", () => {
    const onView = vi.fn(); const onRevoke = vi.fn();
    render(<PartnerKeysTable keys={[base]} isLoading={false} error={null} activeScope={null} onToggleScope={() => {}} onViewActivity={onView} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByRole("button", { name: /view live activity/i }));
    fireEvent.click(screen.getByRole("button", { name: /revoke key/i }));
    expect(onView).toHaveBeenCalledWith(base);
    expect(onRevoke).toHaveBeenCalledWith(base);
  });
  it("filters rows by the active scope", () => {
    render(<PartnerKeysTable keys={[base, { ...revoked, scopes: ["posts:write"] }]} isLoading={false} error={null} activeScope="posts:write" onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    expect(screen.queryByText("Danat backend")).not.toBeInTheDocument();
    expect(screen.getByText("Old key")).toBeInTheDocument();
  });
  it("shows the error instead of an empty table", () => {
    render(<PartnerKeysTable keys={undefined} isLoading={false} error={new Error("platform admin only")} activeScope={null} onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText(/platform admin only/)).toBeInTheDocument();
  });
});
```

`RevokePartnerKeyDialog.test.tsx`
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RevokePartnerKeyDialog } from "../RevokePartnerKeyDialog";

describe("RevokePartnerKeyDialog", () => {
  it("requires a reason before confirming", () => {
    const onConfirm = vi.fn();
    render(<RevokePartnerKeyDialog keyName="Danat backend" open onOpenChange={() => {}} onConfirm={onConfirm} isPending={false} />);
    const confirm = screen.getByRole("button", { name: /revoke key/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "leaked in a log" } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("leaked in a log");
  });
});
```

- [ ] **Step 2: Run to see them fail** — `bunx vitest run src/components/admin/partner` → FAIL.

- [ ] **Step 3: Implement**

`RevokePartnerKeyDialog.tsx`
```tsx
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

interface RevokePartnerKeyDialogProps {
  keyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}

/** Revocation is one-way (spec D5): a reason is required and there is no undo. */
export function RevokePartnerKeyDialog({ keyName, open, onOpenChange, onConfirm, isPending }: RevokePartnerKeyDialogProps) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) setReason(""); onOpenChange(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{keyName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Every request using this key will be refused immediately. This cannot be undone; mint a new key to restore access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="revoke-reason">Reason (recorded in the audit trail)</Label>
          <Textarea id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. credential leaked in partner logs" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={trimmed.length === 0 || isPending}
            onClick={(e) => { e.preventDefault(); onConfirm(trimmed); }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

`PartnerKeysTable.tsx`
```tsx
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { Activity, Ban } from "lucide-react";
import type { PartnerKeyRow } from "@/features/partner-hub";
import { QuotaUsageBar } from "./QuotaUsageBar";
import { ScopeBadges } from "./ScopeBadges";

interface PartnerKeysTableProps {
  keys: PartnerKeyRow[] | undefined;
  isLoading: boolean;
  error: Error | null;
  activeScope: string | null;
  onToggleScope: (scope: string) => void;
  onViewActivity: (key: PartnerKeyRow) => void;
  onRevoke: (key: PartnerKeyRow) => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  revoked: "destructive",
  expired: "secondary",
  rotated: "outline",
};

function when(value: string | null): string {
  return value ? format(new Date(value), "yyyy-MM-dd HH:mm") : "—";
}

export function PartnerKeysTable({ keys, isLoading, error, activeScope, onToggleScope, onViewActivity, onRevoke }: PartnerKeysTableProps) {
  if (error) return <p className="text-sm text-destructive">Could not load partner keys: {error.message}</p>;
  if (isLoading || !keys) return <Skeleton className="h-40 w-full" />;
  const rows = activeScope ? keys.filter((k) => k.scopes.includes(activeScope)) : keys;
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{activeScope ? `No keys hold ${activeScope}.` : "No partner keys yet."}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Partner / key</TableHead>
            <TableHead>Prefix</TableHead>
            <TableHead>Workspace · account</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Monthly quota</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((key) => (
            <TableRow key={key.id}>
              <TableCell>
                <div className="font-medium">{key.name}</div>
                <Badge variant={key.environment === "production" ? "default" : "secondary"} className="mt-1">{key.environment}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{key.key_prefix}…</TableCell>
              <TableCell>
                <div>{key.workspace_name ?? key.workspace_id}</div>
                <div className="text-xs text-muted-foreground">{key.account_platform ?? "?"} · {key.account_username ?? key.social_account_id}</div>
              </TableCell>
              <TableCell><ScopeBadges scopes={key.scopes} activeScope={activeScope} onToggle={onToggleScope} /></TableCell>
              <TableCell><QuotaUsageBar used={key.usage_charged} limit={key.monthly_quota} /></TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[key.status] ?? "outline"}>{key.status}</Badge>
                {key.revoked_reason && <div className="mt-1 max-w-[160px] truncate text-xs text-muted-foreground" title={key.revoked_reason}>{key.revoked_reason}</div>}
              </TableCell>
              <TableCell className="text-xs">{when(key.created_at)}</TableCell>
              <TableCell className="text-xs">{when(key.last_used_at)}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => onViewActivity(key)}>
                    <Activity className="mr-1 h-3.5 w-3.5" /> View live activity
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={key.status !== "active"} onClick={() => onRevoke(key)}>
                    <Ban className="mr-1 h-3.5 w-3.5" /> Revoke key
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 4: Run to see them pass** — `bunx vitest run src/components/admin/partner` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/partner
git commit -m "feat(partner-hub): keys table and revoke dialog"
```

### Task 11: `GeneratePartnerKeyDialog` + `PartnerKeyCreatedView`

**Files:**
- Create: `src/components/admin/partner/GeneratePartnerKeyDialog.tsx`, `PartnerKeyCreatedView.tsx`
- Test: `src/components/admin/partner/__tests__/GeneratePartnerKeyDialog.test.tsx`, `PartnerKeyCreatedView.test.tsx`

- [ ] **Step 1: Write the failing tests**

`PartnerKeyCreatedView.test.tsx`
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PartnerKeyCreatedView } from "../PartnerKeyCreatedView";

const CREATED = {
  name: "Danat", environment: "staging" as const, key: "pk_test_abcdefghijklmnopqrstuvwxyz012345", prefix: "pk_test_abcd",
  scopes: ["messages:send"], workspaceId: "ws", socialAccountId: "acct", createdAt: "2026-09-02T00:00:00.000Z",
};

describe("PartnerKeyCreatedView", () => {
  it("shows the plaintext once with a copy button and the never-again warning", async () => {
    render(<PartnerKeyCreatedView created={CREATED} onDone={() => {}} />);
    expect(screen.getByDisplayValue(CREATED.key)).toBeInTheDocument();
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CREATED.key);
  });
  it("offers a JSON download built from the shown values", () => {
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { writable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: revokeObjectURL });
    render(<PartnerKeyCreatedView created={CREATED} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});
```

`GeneratePartnerKeyDialog.test.tsx`
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GeneratePartnerKeyDialog } from "../GeneratePartnerKeyDialog";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const TARGETS = [
  { workspace_id: "ws1", workspace_name: "Danat", social_account_id: "a1", platform: "whatsapp", platform_username: "danat", is_active: true, needs_reauth: false },
  { workspace_id: "ws1", workspace_name: "Danat", social_account_id: "a2", platform: "whatsapp", platform_username: "danat-old", is_active: false, needs_reauth: true },
];

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("GeneratePartnerKeyDialog", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_targets") return Promise.resolve({ data: TARGETS, error: null });
      if (fn === "create_partner_key") return Promise.resolve({ data: "new-id", error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("submits prefix + hash (never the plaintext) and then shows the plaintext once", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByText(/Generate partner key/i);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Danat backend" } });
    // Workspace and account are native <select> elements so fireEvent.change works in jsdom.
    fireEvent.change(screen.getByLabelText(/workspace/i), { target: { value: "ws1" } });
    fireEvent.change(screen.getByLabelText(/account/i), { target: { value: "a1" } });
    fireEvent.click(screen.getByLabelText("staging"));
    fireEvent.click(screen.getByLabelText("messages:send"));
    fireEvent.change(screen.getByLabelText(/monthly quota/i), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /generate key/i }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_partner_key", expect.anything()));
    const args = rpc.mock.calls.find((c) => c[0] === "create_partner_key")![1] as Record<string, unknown>;
    expect(args.p_environment).toBe("staging");
    expect(args.p_key_prefix).toMatch(/^pk_test_/);
    expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_scopes).toEqual(["messages:send"]);
    expect(args.p_monthly_quota).toBe(500);
    const shown = (await screen.findByDisplayValue(/^pk_test_/)) as HTMLInputElement;
    expect(JSON.stringify(args)).not.toContain(shown.value);
  });

  it("lists an unhealthy account but does not let it be chosen", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByText(/Generate partner key/i);
    fireEvent.change(screen.getByLabelText(/workspace/i), { target: { value: "ws1" } });
    const option = screen.getByRole("option", { name: /danat-old/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("refuses to submit without a scope", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByText(/Generate partner key/i);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/workspace/i), { target: { value: "ws1" } });
    fireEvent.change(screen.getByLabelText(/account/i), { target: { value: "a1" } });
    expect(screen.getByRole("button", { name: /generate key/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to see them fail** — `bunx vitest run src/components/admin/partner` → FAIL.

- [ ] **Step 3: Implement**

`PartnerKeyCreatedView.tsx`
```tsx
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { buildCredentialsFile, type PartnerEnvironment } from "@/features/partner-hub";
import { AlertTriangle, Copy, Download } from "lucide-react";

export interface CreatedKeyDisplay {
  name: string;
  environment: PartnerEnvironment;
  key: string;
  prefix: string;
  scopes: string[];
  workspaceId: string;
  socialAccountId: string;
  createdAt: string;
}

interface PartnerKeyCreatedViewProps {
  created: CreatedKeyDisplay;
  onDone: () => void;
}

/** The one-time plaintext display. The parent drops `created` from state when
 *  the dialog closes, so this view cannot be reopened for the same key. */
export function PartnerKeyCreatedView({ created, onDone }: PartnerKeyCreatedViewProps) {
  const { toast } = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      toast({ title: "Copied", description: "The key is on your clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the key and copy it manually.", variant: "destructive" });
    }
  };

  const download = () => {
    const blob = new Blob([buildCredentialsFile({
      name: created.name, environment: created.environment, key: created.key, keyPrefix: created.prefix,
      scopes: created.scopes, workspaceId: created.workspaceId, socialAccountId: created.socialAccountId, createdAt: created.createdAt,
    })], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `postora-partner-key-${created.prefix}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Copy this key now</AlertTitle>
        <AlertDescription>It will not be shown again. Postora stores only a hash; a lost key must be revoked and re-issued.</AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Input readOnly value={created.key} className="font-mono text-xs" aria-label="Partner API key" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={copy}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
      </div>
      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={download}><Download className="mr-1 h-4 w-4" /> Download credentials JSON</Button>
        <Button type="button" onClick={onDone}>I have saved the key</Button>
      </div>
    </div>
  );
}
```

`GeneratePartnerKeyDialog.tsx` — native `<select>` for workspace/account (jsdom-testable, and the lists are short), radios for environment, checkboxes for scopes:
```tsx
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PARTNER_SCOPES, useCreatePartnerKey, usePartnerKeyTargets, type PartnerEnvironment } from "@/features/partner-hub";
import { Loader2 } from "lucide-react";
import { PartnerKeyCreatedView, type CreatedKeyDisplay } from "./PartnerKeyCreatedView";

interface GeneratePartnerKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SELECT_CLASS = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export function GeneratePartnerKeyDialog({ open, onOpenChange }: GeneratePartnerKeyDialogProps) {
  const { toast } = useToast();
  const targets = usePartnerKeyTargets(open);
  const create = useCreatePartnerKey();

  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [environment, setEnvironment] = useState<PartnerEnvironment>("production");
  const [scopes, setScopes] = useState<string[]>([]);
  const [quota, setQuota] = useState("");
  const [rateLimit, setRateLimit] = useState("60");
  const [created, setCreated] = useState<CreatedKeyDisplay | null>(null);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of targets.data ?? []) seen.set(t.workspace_id, t.workspace_name);
    return [...seen.entries()];
  }, [targets.data]);
  const accounts = useMemo(() => (targets.data ?? []).filter((t) => t.workspace_id === workspaceId), [targets.data, workspaceId]);

  const quotaValue = quota.trim() === "" ? null : Number(quota);
  const rateValue = Number(rateLimit);
  const quotaValid = quotaValue === null || (Number.isInteger(quotaValue) && quotaValue >= 0 && quotaValue <= 2_147_483_647);
  const rateValid = Number.isInteger(rateValue) && rateValue >= 1 && rateValue <= 100_000;
  const canSubmit = name.trim().length > 0 && workspaceId !== "" && accountId !== "" && scopes.length > 0 && quotaValid && rateValid && !create.isPending;

  const reset = () => {
    setName(""); setWorkspaceId(""); setAccountId(""); setEnvironment("production");
    setScopes([]); setQuota(""); setRateLimit("60"); setCreated(null);
  };

  const close = (next: boolean) => {
    if (!next) reset(); // the plaintext leaves memory with the dialog
    onOpenChange(next);
  };

  const submit = async () => {
    try {
      const result = await create.mutateAsync({
        name: name.trim(), workspaceId, socialAccountId: accountId, environment, scopes,
        monthlyQuota: quotaValue, rateLimitPerMin: rateValue,
      });
      setCreated({
        name: name.trim(), environment, key: result.key, prefix: result.prefix, scopes,
        workspaceId, socialAccountId: accountId, createdAt: result.createdAt,
      });
    } catch (err) {
      toast({ title: "Key not created", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const toggleScope = (scope: string, on: boolean) =>
    setScopes((prev) => (on ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope)));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{created ? "Partner key created" : "Generate partner key"}</DialogTitle>
          <DialogDescription>
            {created ? "Hand this to the partner over a secure channel." : "The key is generated in this browser; Postora stores only its hash."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <PartnerKeyCreatedView created={created} onDone={() => close(false)} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="pk-name">Name</Label>
              <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Danat backend" />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pk-workspace">Workspace</Label>
                <select id="pk-workspace" className={SELECT_CLASS} value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setAccountId(""); }}>
                  <option value="">{targets.isLoading ? "Loading…" : "Select a workspace"}</option>
                  {workspaces.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pk-account">Account (WhatsApp)</Label>
                <select id="pk-account" className={SELECT_CLASS} value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={workspaceId === ""}>
                  <option value="">Select an account</option>
                  {accounts.map((a) => {
                    const healthy = a.is_active && !a.needs_reauth;
                    const suffix = !a.is_active ? " (inactive)" : a.needs_reauth ? " (needs re-authorization)" : "";
                    return <option key={a.social_account_id} value={a.social_account_id} disabled={!healthy}>{a.platform_username ?? a.social_account_id}{suffix}</option>;
                  })}
                </select>
              </div>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Environment</legend>
              <div className="flex gap-4">
                {(["production", "staging"] as const).map((env) => (
                  <label key={env} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="pk-env" value={env} checked={environment === env} onChange={() => setEnvironment(env)} aria-label={env} />
                    {env} <span className="font-mono text-xs text-muted-foreground">{env === "production" ? "pk_live_" : "pk_test_"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Scopes</legend>
              <div className="grid gap-2 md:grid-cols-2">
                {PARTNER_SCOPES.map((scope) => (
                  <div key={scope.value} className="flex items-start gap-2">
                    <Checkbox id={`pk-scope-${scope.value}`} checked={scopes.includes(scope.value)} onCheckedChange={(v) => toggleScope(scope.value, v === true)} aria-label={scope.value} />
                    <div className="leading-tight">
                      <Label htmlFor={`pk-scope-${scope.value}`} className="font-mono text-xs">{scope.value}</Label>
                      <p className="text-xs text-muted-foreground">{scope.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pk-quota">Monthly quota (blank = unlimited)</Label>
                <Input id="pk-quota" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="e.g. 5000" />
                {!quotaValid && <p className="text-xs text-destructive">Must be a whole number ≥ 0.</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="pk-rate">Rate limit per minute</Label>
                <Input id="pk-rate" inputMode="numeric" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
                {!rateValid && <p className="text-xs text-destructive">Must be a whole number ≥ 1.</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button type="button" onClick={submit} disabled={!canSubmit}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate key
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```
Note for the test: the scope checkbox is a Radix button, so `getByLabelText("messages:send")` resolves via `aria-label` and `fireEvent.click` toggles it. If `@/components/ui/alert` does not exist, check `src/components/ui/` and use the existing alert component or a styled `div` with `role="alert"`.

- [ ] **Step 4: Run to see them pass** — `bunx vitest run src/components/admin/partner` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/partner
git commit -m "feat(partner-hub): generate-key dialog with one-time plaintext view"
```

### Task 12: `PartnerKeyActivitySheet`

**Files:**
- Create: `src/components/admin/partner/PartnerKeyActivitySheet.tsx`
- Test: `src/components/admin/partner/__tests__/PartnerKeyActivitySheet.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PartnerKeyActivitySheet } from "../PartnerKeyActivitySheet";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const KEY = { id: "k1", name: "Danat backend", workspace_name: "Danat" };

describe("PartnerKeyActivitySheet", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_activity") return Promise.resolve({ data: [
        { id: "u1", created_at: "2026-09-02T09:14:00Z", action: "send_template", http_status: 200, error_code: null, billable: true, request_id: "req-1", latency_ms: 321 },
        { id: "u2", created_at: "2026-09-02T09:15:00Z", action: "list_accounts", http_status: 403, error_code: "insufficient_scope", billable: false, request_id: null, latency_ms: null },
      ], error: null });
      if (fn === "admin_partner_key_webhook_deliveries") return Promise.resolve({ data: [
        { id: "d1", occurred_at: "2026-09-02T09:14:05Z", event_type: "message.delivered", status: "delivered", attempts: 1, next_attempt_at: "2026-09-02T09:14:05Z", last_status_code: 200, last_error: null, delivered_at: "2026-09-02T09:14:06Z", webhook_id: "w1", webhook_url: "https://partner.example/hook", webhook_is_active: true },
      ], error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("renders requests with endpoint, status, request id and latency, dashes for nulls", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PartnerKeyActivitySheet partnerKey={KEY} open onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText("POST /v1/messages")).toBeInTheDocument();
    expect(screen.getByText("req-1")).toBeInTheDocument();
    expect(screen.getByText("321 ms")).toBeInTheDocument();
    expect(screen.getByText("insufficient_scope")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the workspace's webhook deliveries", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PartnerKeyActivitySheet partnerKey={KEY} open onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText("message.delivered")).toBeInTheDocument();
    expect(screen.getByText(/Webhook deliveries — workspace Danat/)).toBeInTheDocument();
    expect(screen.getByText("https://partner.example/hook")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see it fail** — FAIL.

- [ ] **Step 3: Implement**

```tsx
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { endpointForAction, usePartnerKeyActivity, usePartnerKeyDeliveries } from "@/features/partner-hub";

interface PartnerKeyActivitySheetProps {
  partnerKey: { id: string; name: string; workspace_name: string | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DASH = "—";
const stamp = (iso: string | null) => (iso ? format(new Date(iso), "MM-dd HH:mm:ss") : DASH);

function statusVariant(status: number): "default" | "secondary" | "destructive" {
  if (status >= 500) return "destructive";
  if (status >= 400) return "secondary";
  return "default";
}

function deliveryVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "delivered") return "default";
  if (status === "exhausted") return "destructive";
  if (status === "delivering") return "secondary";
  return "outline";
}

export function PartnerKeyActivitySheet({ partnerKey, open, onOpenChange }: PartnerKeyActivitySheetProps) {
  const keyId = open && partnerKey ? partnerKey.id : null;
  const activity = usePartnerKeyActivity(keyId);
  const deliveries = usePartnerKeyDeliveries(keyId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Live activity — {partnerKey?.name ?? ""}</SheetTitle>
          <SheetDescription>Last 50 authenticated requests and the workspace's recent webhook deliveries. Refreshes every 15 s.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="mt-4 h-[calc(100vh-8rem)] pr-4">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Recent API requests</h3>
            {activity.error ? (
              <p className="text-sm text-destructive">Could not load requests: {activity.error.message}</p>
            ) : activity.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (activity.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No requests recorded for this key.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead><TableHead>Endpoint</TableHead><TableHead>Status</TableHead>
                    <TableHead>Request ID</TableHead><TableHead>Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(activity.data ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">{stamp(row.created_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{endpointForAction(row.action)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(row.http_status)}>{row.http_status}</Badge>
                        {row.error_code && <span className="ml-1 text-xs text-muted-foreground">{row.error_code}</span>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.request_id ?? DASH}</TableCell>
                      <TableCell className="text-xs">{row.latency_ms === null ? DASH : `${row.latency_ms} ms`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="mt-6 space-y-2">
            <h3 className="text-sm font-semibold">Webhook deliveries — workspace {partnerKey?.workspace_name ?? DASH}</h3>
            {deliveries.error ? (
              <p className="text-sm text-destructive">Could not load deliveries: {deliveries.error.message}</p>
            ) : deliveries.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (deliveries.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No webhook deliveries for this workspace.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Occurred</TableHead><TableHead>Event</TableHead><TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead><TableHead>Endpoint</TableHead><TableHead>Last result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(deliveries.data ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs">{stamp(d.occurred_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                      <TableCell><Badge variant={deliveryVariant(d.status)}>{d.status}</Badge></TableCell>
                      <TableCell className="text-xs">{d.attempts}{d.status === "pending" ? ` · next ${stamp(d.next_attempt_at)}` : ""}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono text-xs" title={d.webhook_url}>
                        {d.webhook_url}{!d.webhook_is_active && <span className="ml-1 text-destructive">(disabled)</span>}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs" title={d.last_error ?? undefined}>
                        {d.last_status_code ?? DASH}{d.last_error ? ` · ${d.last_error}` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run to see it pass**, then commit

```bash
bunx vitest run src/components/admin/partner
git add src/components/admin/partner
git commit -m "feat(partner-hub): live activity and webhook delivery sheet"
```

### Task 13: Page, route, sidebar

**Files:**
- Create: `src/pages/admin/AdminPartnerHub.tsx`
- Modify: `src/components/AnimatedRoutes.tsx` (lazy import next to `AdminRateLimits` ~line 126; route after `/admin/scaling` ~line 525)
- Modify: `src/components/admin/AdminLayout.tsx` (icon import line 9; sidebar item after "OAuth Apps")
- Test: `src/pages/admin/__tests__/AdminPartnerHub.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import AdminPartnerHub from "../AdminPartnerHub";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

describe("AdminPartnerHub", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_hub_overview") return Promise.resolve({ data: [{ active_keys: 1, revoked_keys: 0, month_billable: 5, month_posts: 0, requests_30d: 10, success_30d: 10, deliveries_30d: 0, delivered_30d: 0, exhausted_30d: 0, pending_deliveries: 0 }], error: null });
      if (fn === "admin_partner_keys") return Promise.resolve({ data: [{
        id: "k1", name: "Danat backend", environment: "production", key_prefix: "pk_live_a1b2", workspace_id: "ws", workspace_name: "Danat",
        social_account_id: "a", account_platform: "whatsapp", account_username: "danat", scopes: ["messages:send"], rate_limit_per_min: 60,
        monthly_quota: 100, usage_charged: 5, usage_reserved: 0, usage_confirmed: 5, usage_indeterminate: 0, period_start: "2026-09-01T00:00:00Z",
        status: "active", created_at: "2026-09-01T00:00:00Z", last_used_at: null, expires_at: null, revoked_at: null, revoked_reason: null, superseded_by_key_id: null,
      }], error: null });
      return Promise.resolve({ data: [], error: null });
    });
  });

  it("renders the KPIs and the keys table, and opens the generate dialog", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><AdminPartnerHub /></QueryClientProvider>);
    expect(await screen.findByText("Danat backend")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument(); // API health 10/10
    fireEvent.click(screen.getByRole("button", { name: /generate partner key/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement the page**

```tsx
import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { usePartnerHubOverview, usePartnerKeys, useRevokePartnerKey, type PartnerKeyRow } from "@/features/partner-hub";
import { PartnerHubKpiCards } from "@/components/admin/partner/PartnerHubKpiCards";
import { PartnerKeysTable } from "@/components/admin/partner/PartnerKeysTable";
import { GeneratePartnerKeyDialog } from "@/components/admin/partner/GeneratePartnerKeyDialog";
import { RevokePartnerKeyDialog } from "@/components/admin/partner/RevokePartnerKeyDialog";
import { PartnerKeyActivitySheet } from "@/components/admin/partner/PartnerKeyActivitySheet";
import { Plus, X } from "lucide-react";

export default function AdminPartnerHub() {
  const { toast } = useToast();
  const overview = usePartnerHubOverview();
  const keys = usePartnerKeys();
  const revoke = useRevokePartnerKey();

  const [activeScope, setActiveScope] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PartnerKeyRow | null>(null);
  const [activityTarget, setActivityTarget] = useState<PartnerKeyRow | null>(null);

  const confirmRevoke = (reason: string) => {
    if (!revokeTarget) return;
    revoke.mutate({ keyId: revokeTarget.id, reason }, {
      onSuccess: () => { toast({ title: "Key revoked", description: `${revokeTarget.name} no longer authenticates.` }); setRevokeTarget(null); },
      onError: (err) => toast({ title: "Revocation failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
    });
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">Partner Hub</h1>
            <p className="text-sm text-muted-foreground">Partner API keys, quotas and live consumption across every workspace.</p>
          </div>
          <Button onClick={() => setGenerateOpen(true)}><Plus className="mr-1 h-4 w-4" /> Generate partner key</Button>
        </div>

        <PartnerHubKpiCards overview={overview.data} isLoading={overview.isLoading} error={overview.error as Error | null} />

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Partner keys</CardTitle>
                <CardDescription>Click a scope to filter. Quota bars turn amber at 80% and red at 95%.</CardDescription>
              </div>
              {activeScope && (
                <Button variant="ghost" size="sm" onClick={() => setActiveScope(null)}><X className="mr-1 h-3.5 w-3.5" /> Clear filter: {activeScope}</Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <PartnerKeysTable
              keys={keys.data}
              isLoading={keys.isLoading}
              error={keys.error as Error | null}
              activeScope={activeScope}
              onToggleScope={(scope) => setActiveScope((prev) => (prev === scope ? null : scope))}
              onViewActivity={setActivityTarget}
              onRevoke={setRevokeTarget}
            />
          </CardContent>
        </Card>
      </div>

      <GeneratePartnerKeyDialog open={generateOpen} onOpenChange={setGenerateOpen} />
      <RevokePartnerKeyDialog
        keyName={revokeTarget?.name ?? ""}
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        onConfirm={confirmRevoke}
        isPending={revoke.isPending}
      />
      <PartnerKeyActivitySheet partnerKey={activityTarget} open={activityTarget !== null} onOpenChange={(open) => { if (!open) setActivityTarget(null); }} />
    </AdminLayout>
  );
}
```

- [ ] **Step 3: Route and sidebar**

`AnimatedRoutes.tsx`: next to the other admin lazies add
```ts
const AdminPartnerHub = lazyWithRetry(() => import("@/pages/admin/AdminPartnerHub"), "AdminPartnerHub");
```
and after the `/admin/scaling` route add
```tsx
        <Route path="/admin/partner-hub" element={<AnimatedPage><AdminPartnerHub /></AnimatedPage>} />
```
`AdminLayout.tsx`: add `Handshake` to the lucide import and, after the "OAuth Apps" item:
```ts
  { icon: Handshake, label: "Partner Hub", href: "/admin/partner-hub" },
```

- [ ] **Step 4: Gates and commit**

```bash
bunx tsc -b --noEmit
bunx vitest run src/pages/admin/__tests__/AdminPartnerHub.test.tsx src/components/admin/partner src/features/partner-hub
git add src/pages/admin/AdminPartnerHub.tsx src/pages/admin/__tests__/AdminPartnerHub.test.tsx src/components/AnimatedRoutes.tsx src/components/admin/AdminLayout.tsx
git commit -m "feat(admin): Partner Hub page, route and sidebar entry"
```

### Task 14: Full gates

- [ ] `bunx tsc -b --noEmit` → 0 errors
- [ ] `bunx vitest run` → all green (baseline before this branch: 163 files, 1176 passed, 0 failed; expect that plus the new files)
- [ ] `deno test --allow-env --allow-read --no-check supabase/functions/_shared/partnerApiMetering.test.ts supabase/functions/partner-api/` → green
- [ ] `bash scripts/db-harness.sh` → green including `partner_hub_admin.sql`
- [ ] `bunx eslint src/features/partner-hub src/components/admin/partner src/pages/admin/AdminPartnerHub.tsx` → clean
- [ ] `clean-code-guard` over Slices B and C production code; `test-guard` over every test file touched.

---

## Deployment (orchestrator, after CodexBot approval, before merge)

1. `ssh-contabo-mcp`: `cd /root/postora-runtime && git fetch origin feat/admin-partner-hub -q && git show origin/feat/admin-partner-hub:supabase/migrations/20260902200000_admin_partner_hub.sql > /tmp/m.sql && sha256sum /tmp/m.sql` — compare with the local hash — then `docker exec -i postorasupabase-supabase-j8axyh-supabase-db psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -q < /tmp/m.sql`.
2. Probe: `curl -s -X POST https://api.postora.cloud/rest/v1/rpc/admin_partner_hub_overview -H "apikey: $ANON" -H "Authorization: Bearer <admin user JWT>"` → a JSON row; with the anon key alone → a 4xx carrying `platform admin only`.
3. Merge the PR (frontend auto-deploys).
4. Edge deploy per `docs/runbooks/deploy-edge-function.md` §0 for `partner-api/index.ts`, `partner-api/v1/authenticated.ts`, `_shared/partnerApiMetering.ts`; verify hashes; `docker compose up -d --no-deps functions` (or the runtime-checkout `restart` per memory).
5. Verify on https://postora.cloud/admin/partner-hub as the admin: KPIs render, mint a `staging` key, confirm it appears with status `active`, revoke it, confirm two `partner_audit_logs` rows with `actor_id` = admin.
