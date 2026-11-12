# AI Providers — One-Click Test & Model Sync + Daily Health Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin card's browser-driven **Sync all** with **one button** that tests
the connection of every configured AI provider (API key *and* subscription login), syncs the
model catalogue of every provider whose test passed, and shows **one result table** — plus a
daily `pg_cron` job that runs the same test + sync server-side, stores the latest per-provider
result, and alerts admins when a provider degrades from *connected* to *failed* / *needs
re-login*.

**Architecture:**
- One server-side runner is the single implementation for both callers. The browser calls the
  edge function in chunks; `pg_cron` calls the same function four times a day, seven minutes
  apart. Neither caller holds provider policy.
- The runner is split into a **pure** module (`_shared/aiProviderHealth.ts`: target planning,
  classification, sanitisation, chunk slicing) and an **impure** runner
  (`ai-provider-health/run.ts`) with injected ports, so both are Deno-testable without a
  network or a database.
- The provider probe moves out of `ai-config/index.ts` into `_shared/aiProviderTest.ts` so the
  card's Test button and the health runner share one implementation — and so the probe gets an
  explicit timeout, which it does not have today.
- Results live in a new `public.ai_provider_health` table, one row per
  `(provider_code, auth_method)`, written by three service-role-only RPCs. The RPC that
  writes a row also copies the old status into `previous_status`, which is what makes the
  "connected → failed" transition detectable in SQL and therefore exactly once.
- Models become keyed by `(provider_id, model_id, auth_method)` through a new
  `ai_models.auth_method` column, so the OAuth catalogue and the API-key catalogue of the same
  provider can coexist.
- The existing generic lease (`acquire_cron_run_lease` / `release_cron_run_lease`) serialises a
  manual click against the daily run. The lease holder is derived from the **run id**, so the
  four daily cron entries extend one lease instead of fighting over it.

**Tech Stack:** Deno edge functions (Deno test), Supabase Postgres + `pg_cron` + Vault,
React 18 + TanStack Query + shadcn (Vitest), i18next with Arabic bundles.

**Spec:** `docs/superpowers/specs/2026-11-13-ai-providers-test-and-sync-design.md`. Read it
fully before Task 1; §6 holds the design decisions and §11 the open questions.

## Global Constraints

- Required reading before editing `supabase/functions/**` or `src/**`: `ARCHITECTURE.md`
  (§0, §1, §11–16, §17, §23, §25, §26, §27, §28, §39, §40, §43, §44) and `CLAUDE.md`
  (Task Execution Workflow — authoritative).
- Keys come only from `resolveProviderKey(db, provider_code)`. OAuth credentials come only
  from `getFreshOAuthCredential(db, oauthProvider)`. **Never** log, return, toast or store a
  key or a token.
- Every provider-facing HTTP call gets an explicit timeout. The probes in `ai-config` have
  none today; the extraction in Task 3 adds `HEALTH_TARGET_TIMEOUT_MS`.
- Every reason string that reaches the browser, the database or a log goes through
  `describeProviderFailure` (fixed sentences) and then `redactProviderError` (key and header
  redaction, 500-char truncation).
- The planner's safety rules are inherited and must not be weakened: never erase a stored
  name / price / context / description; never remove an admin-granted capability; never switch
  off a model used as a default or fallback; never switch off a model with no managed
  capability.
- "Never switch off a default or fallback" is scoped **per `(provider_code, auth_method)`**:
  an API-key tier must not protect an OAuth row and the other way round.
- An OAuth target that fails its test gets **no sync at all**. Its models are never
  deactivated, never deleted.
- The only writer of `ai_models`, `ai_provider_health` and `admin_notifications` is the service
  role inside the edge function. The browser never writes them.
- `admin_notifications` is a **broadcast to every signed-in user**. Its message carries no
  secret and no user data.
- The cron secret is never a literal in a migration: the job body calls `get_cron_secret()`.
- The migration timestamp is `20261113180000` or later. Never edit an already-applied
  migration.
- The migration must be **idempotent** against the concurrent branch
  (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`).
- Do not redesign the API/Auth grouping in the model selectors, do not touch
  `isOAuthProvider` in `AiProvidersCard.tsx`, and do not set `ai_providers.auth_type` on
  `claude` or `openai`. That is the concurrent branch's work (spec §8).
- i18n: English is the call-site default (`t(key, "English copy")`); Arabic is a real bundle.
  A new namespace must be registered in `src/i18n/index.ts` **and** have an
  `src/i18n/locales/ar/<ns>.json` bundle, or `npm run check:i18n` fails.
- No `git stash`. Commit with explicit paths: `git commit -- <paths>`. Never commit
  `graphify-out/`, `.env*`, logs or secrets.
- Commit trailer on every commit in this plan:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.
- Deno tests: run **before** vitest, never after it in the same session (Deno can corrupt
  `node_modules`). If vitest then fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, run
  `bun install --frozen-lockfile` and retry.
- Exact commands used in this plan:
  - `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none <files>`
  - `npx vitest run <paths>`
  - `npx tsc -p tsconfig.app.json --noEmit`
  - `npm run check:i18n`
  - `bash scripts/db-harness.sh`
- Frontend tests use `fireEvent`, not `userEvent` (the repo convention).
- Add no new `any`; match the neighbouring style.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20261113180000_ai_provider_health.sql` | create | `ai_provider_health` table, `ai_models.auth_method`, 3 RPCs, RLS/grants, 4 guarded cron entries |
| `supabase/tests/ai_provider_health.sql` | create | SQL proof |
| `scripts/db-harness.sh` | modify | register `ai_provider_health.sql` in `SUITES=(` |
| `src/integrations/supabase/types.ts` | modify | the new table + the 3 RPC signatures |
| `supabase/functions/_shared/aiProviderHealth.ts` | create | **pure**: target planning, classification, sanitisation, chunk slicing |
| `supabase/functions/_shared/aiProviderHealth.test.ts` | create | Deno tests |
| `supabase/functions/_shared/aiProviderTest.ts` | create | the provider probe, extracted from `ai-config`, with a timeout |
| `supabase/functions/_shared/aiProviderTest.test.ts` | create | Deno tests |
| `supabase/functions/ai-provider-health/run.ts` | create | the runner: plan → slice → test → sync → record → notify |
| `supabase/functions/ai-provider-health/run.test.ts` | create | Deno tests |
| `supabase/functions/ai-provider-health/deps.ts` | create | the real ports |
| `supabase/functions/ai-provider-health/handler.ts` | create | the request handler (auth, actions, lease) |
| `supabase/functions/ai-provider-health/handler.test.ts` | create | Deno tests |
| `supabase/functions/ai-provider-health/index.ts` | create | the `Deno.serve` entry |
| `supabase/functions/ai-config/index.ts` | modify | import the shared probe; delete the private copy |
| `supabase/functions/ai-config/providerTestKind.ts` | delete | folded into `_shared/aiProviderTest.ts` |
| `supabase/functions/ai-config/providerTestKind.test.ts` | delete | folded into `_shared/aiProviderTest.test.ts` |
| `supabase/functions/_shared/modelCatalogSyncRun.ts` | modify | `auth_method`-aware read/upsert and in-use scoping |
| `supabase/functions/_shared/modelCatalogSyncRun.test.ts` | modify | the `auth_method` cases |
| `src/features/ai-providers/infrastructure/aiProviderHealthGateway.ts` | create | the `supabase.functions.invoke` wrapper |
| `src/hooks/ai-config/useAiProviderHealth.ts` | create | the status query + the run mutation |
| `src/hooks/ai-config/types.ts` | modify | the health result types |
| `src/components/admin/settings/ai/ProviderHealthButton.tsx` | create | the one button + the result table |
| `src/components/admin/settings/ai/ProviderHealthButton.test.tsx` | create | Vitest tests |
| `src/components/admin/settings/ai/SyncAllButton.tsx` | delete | replaced by `ProviderHealthButton` |
| `src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx` | delete | replaced by `ProviderHealthButton.test.tsx` |
| `src/components/admin/settings/ai/AiProvidersCard.tsx` | modify | mount the new button |
| `src/i18n/locales/ar/adminai.json` | create | the Arabic copy |
| `src/i18n/index.ts` | modify | register the `adminai` namespace |

---

### Task 1: Migration lane — the result table, the RPCs and the daily schedule

**Files:**
- Create: `supabase/migrations/20261113180000_ai_provider_health.sql`
- Create: `supabase/tests/ai_provider_health.sql`
- Modify: `scripts/db-harness.sh` (append `ai_provider_health.sql` to the `SUITES=(` array,
  after `ai_provider_oauth.sql`)
- Modify: `src/integrations/supabase/types.ts`

**Interfaces — Produces:**
- Table `public.ai_provider_health`, primary key `(provider_code, auth_method)`, columns
  `status`, `previous_status`, `reason`, `models_added`, `models_updated`,
  `models_deactivated`, `latency_ms`, `run_id`, `checked_at`, `notified_at`, `claim_token`,
  `claimed_at`.
- Column `public.ai_models.auth_method text NOT NULL DEFAULT 'api_key'` and the unique index
  `ai_models_provider_model_auth_method_key` on `(provider_id, model_id, auth_method)`.
- RPC `record_ai_provider_health(p_provider_code text, p_auth_method text, p_status text,
  p_reason text, p_models_added int, p_models_updated int, p_models_deactivated int,
  p_latency_ms int, p_run_id uuid) → void`.
- RPC `claim_ai_provider_health_notifications(p_claim_token uuid) →
  TABLE(provider_code text, auth_method text, status text, reason text, previous_status text)`.
- RPC `mark_ai_provider_health_notified(p_claim_token uuid) → void`.
- Four `pg_cron` jobs `ai-provider-health-1..4` at `5 3 * * *`, `12 3 * * *`, `19 3 * * *`,
  `26 3 * * *`, each `net.http_post`-ing
  `https://api.postora.cloud/functions/v1/ai-provider-health` with
  `'Authorization', 'Bearer ' || get_cron_secret()` and a body carrying the chunk number.

- [ ] **Step 1: Write the SQL proof first** (`supabase/tests/ai_provider_health.sql`). Copy
  the header, the `BEGIN;`/`ROLLBACK;` shape and the assertion style from
  `supabase/tests/ai_provider_oauth.sql`. The suite must assert, in order:

  1. `SET ROLE authenticated;` → `SELECT count(*) FROM ai_provider_health` is `0`, and
     `SELECT record_ai_provider_health('claude','api_key','connected',NULL,0,0,0,10,NULL)`
     raises `insufficient_privilege`. Then `RESET ROLE;`
  2. As service role: `record_ai_provider_health('claude','api_key','connected',NULL,3,1,0,42,
     '11111111-1111-1111-1111-111111111111')` → the row exists with
     `status='connected'`, `previous_status IS NULL`, `models_added=3`.
  3. `record_ai_provider_health('claude','api_key','failed','Rate limit exceeded',0,0,0,50,
     '11111111-1111-1111-1111-111111111111')` → the row now has `status='failed'` and
     `previous_status='connected'`.
  4. `claim_ai_provider_health_notifications('22222222-2222-2222-2222-222222222222')` returns
     exactly one row: `('claude','api_key','failed','Rate limit exceeded','connected')`.
     A second call with a different token returns **zero** rows (the row is already claimed).
  5. `mark_ai_provider_health_notified('22222222-2222-2222-2222-222222222222')` →
     `notified_at IS NOT NULL` and `claim_token IS NULL`. A later
     `claim_ai_provider_health_notifications('33333333-3333-3333-3333-333333333333')` returns
     **zero** rows.
  6. A row whose `previous_status` is **not** `connected` is never claimed: record
     `('openai','api_key','failed','Rate limit exceeded',0,0,0,10,'44444444-4444-4444-4444-444444444444')`
     twice and the claim returns zero rows for it.
  7. `ai_models.auth_method` exists and defaults to `'api_key'`:
     `SELECT auth_method FROM ai_models LIMIT 1` is `'api_key'` for an existing row, and two
     rows with the same `(provider_id, model_id)` but different `auth_method` can both exist
     (insert one `auth_method='oauth'` row and assert both rows are present).
  8. `INSERT INTO ai_provider_health (provider_code, auth_method, status) VALUES
     ('claude','api_key','bogus')` violates the `status` CHECK.
  9. `INSERT INTO ai_provider_health (provider_code, auth_method, status) VALUES
     ('claude','saml','connected')` violates the `auth_method` CHECK.
  10. `SELECT cron.jobname FROM cron.job WHERE jobname LIKE 'ai-provider-health%'` returns the
      four names — **only when `pg_cron` is installed**; guard that assertion with
      `to_regclass('cron.job') IS NOT NULL` so the suite passes on a DB without `pg_cron`.

- [ ] **Step 2: Run it and confirm it fails.**

  Run: `bash scripts/db-harness.sh`

  Expected: FAIL — `relation "ai_provider_health" does not exist`.

- [ ] **Step 3: Write the migration** (`supabase/migrations/20261113180000_ai_provider_health.sql`).

  ```sql
  -- Latest provider health per (provider, auth_method), written by the ai-provider-health
  -- edge function (spec 2026-11-13-ai-providers-test-and-sync-design.md).
  --
  -- WHY a table and not a log
  -- The admin card shows "last checked" and the status for every provider without running
  -- anything, and the daily job must leave a result behind. A log cannot answer "what is the
  -- status now" without replaying every entry.
  --
  -- WHY previous_status
  -- The alert fires on a transition: connected -> failed or connected -> needs re-login.
  -- Copying the old status into previous_status on every write turns "did it just break?"
  -- into a comparison the database can answer under a row lock, so two concurrent runs
  -- cannot both fire the same alert.
  --
  -- WHY claim_token / claimed_at / notified_at
  -- The notification is sent in two phases: claim the row, send, then mark it notified. A
  -- run that dies between the send and the mark re-claims the row after 10 minutes instead of
  -- losing the alert or sending it twice.

  CREATE TABLE IF NOT EXISTS public.ai_provider_health (
    provider_code       text NOT NULL REFERENCES public.ai_providers(provider_code) ON DELETE CASCADE,
    auth_method        text NOT NULL DEFAULT 'api_key' CHECK (auth_method IN ('api_key','oauth')),
    status             text NOT NULL CHECK (status IN ('connected','failed','needs_relogin')),
    previous_status    text CHECK (previous_status IN ('connected','failed','needs_relogin')),
    reason             text,
    models_added       integer NOT NULL DEFAULT 0,
    models_updated     integer NOT NULL DEFAULT 0,
    models_deactivated integer NOT NULL DEFAULT 0,
    latency_ms         integer,
    run_id             uuid,
    checked_at         timestamptz NOT NULL DEFAULT now(),
    notified_at        timestamptz,
    claim_token        uuid,
    claimed_at         timestamptz,
    PRIMARY KEY (provider_code, auth_method)
  );

  CREATE INDEX IF NOT EXISTS ai_provider_health_checked_at_idx
    ON public.ai_provider_health (checked_at DESC);

  ALTER TABLE public.ai_provider_health ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.ai_provider_health FROM PUBLIC, anon;

  -- Admin only: a normal authenticated user reads no row and writes none.
  CREATE POLICY ai_provider_health_admin_all ON public.ai_provider_health
    FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_provider_health TO service_role;

  -- Models are keyed by credential kind: one provider can serve an API key and a
  -- subscription login with the same model_id. The statements are idempotent so this
  -- migration is safe next to the concurrent auth-grouping branch.
  ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'api_key';
  ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_provider_id_model_id_key;
  CREATE UNIQUE INDEX IF NOT EXISTS ai_models_provider_model_auth_method_key
    ON public.ai_models (provider_id, model_id, auth_method);
  ```

  Then the three RPCs. `record_ai_provider_health` reads the old status under a row lock so
  two concurrent runs cannot both see `connected`:

  ```sql
  CREATE OR REPLACE FUNCTION public.record_ai_provider_health(
    p_provider_code text,
    p_auth_method text,
    p_status text,
    p_reason text,
    p_models_added int,
    p_models_updated int,
    p_models_deactivated int,
    p_latency_ms int,
    p_run_id uuid
  )
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_old text;
  BEGIN
    IF coalesce(p_provider_code, '') = '' OR coalesce(p_auth_method, '') = '' THEN
      RAISE EXCEPTION 'record_ai_provider_health: provider_code and auth_method are required'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('connected','failed','needs_relogin') THEN
      RAISE EXCEPTION 'record_ai_provider_health: unknown status %', p_status
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT status INTO v_old FROM public.ai_provider_health
      WHERE provider_code = p_provider_code AND auth_method = p_auth_method
      FOR UPDATE;

    INSERT INTO public.ai_provider_health AS h (
      provider_code, auth_method, status, previous_status, reason,
      models_added, models_updated, models_deactivated, latency_ms, run_id, checked_at
    )
    VALUES (
      p_provider_code, p_auth_method, p_status, v_old,
      left(coalesce(p_reason, ''), 500),
      coalesce(p_models_added, 0), coalesce(p_models_updated, 0), coalesce(p_models_deactivated, 0),
      p_latency_ms, p_run_id, now()
    )
    ON CONFLICT (provider_code, auth_method) DO UPDATE SET
      status = EXCLUDED.status,
      previous_status = EXCLUDED.previous_status,
      reason = EXCLUDED.reason,
      models_added = EXCLUDED.models_added,
      models_updated = EXCLUDED.models_updated,
      models_deactivated = EXCLUDED.models_deactivated,
      latency_ms = EXCLUDED.latency_ms,
      run_id = EXCLUDED.run_id,
      checked_at = EXCLUDED.checked_at;
  END;
  $$;

  REVOKE ALL ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) TO service_role;
  ```

  `claim_ai_provider_health_notifications` returns the newly-degraded rows and claims them.
  A claim older than 10 minutes with no `notified_at` is re-claimable, so a run that died
  mid-notification does not lose the alert:

  ```sql
  CREATE OR REPLACE FUNCTION public.claim_ai_provider_health_notifications(p_claim_token uuid)
  RETURNS TABLE (
    provider_code text, auth_method text, status text, reason text, previous_status text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF p_claim_token IS NULL THEN
      RAISE EXCEPTION 'claim_ai_provider_health_notifications: claim token is required'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    UPDATE public.ai_provider_health h
       SET claim_token = p_claim_token, claimed_at = now()
     WHERE h.previous_status = 'connected'
       AND h.status IN ('failed','needs_relogin')
       AND h.notified_at IS NULL
       AND (h.claim_token IS NULL OR h.claimed_at IS NULL OR h.claimed_at < now() - interval '10 minutes')
    RETURNING h.provider_code, h.auth_method, h.status, h.reason, h.previous_status;
  END;
  $$;

  REVOKE ALL ON FUNCTION public.claim_ai_provider_health_notifications(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.claim_ai_provider_health_notifications(uuid) TO service_role;

  CREATE OR REPLACE FUNCTION public.mark_ai_provider_health_notified(p_claim_token uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    UPDATE public.ai_provider_health
       SET notified_at = now(), claim_token = NULL, claimed_at = NULL
     WHERE claim_token = p_claim_token;
  END;
  $$;

  REVOKE ALL ON FUNCTION public.mark_ai_provider_health_notified(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.mark_ai_provider_health_notified(uuid) TO service_role;
  ```

  Then the four cron entries. Each is guarded exactly like
  `20261030140000_sweep_ai_image_staging_cron.sql`: it checks that `pg_cron` and
  `public.get_cron_secret()` exist, and it never contains a literal secret.

  ```sql
  -- Once a day: test every configured AI provider and sync the catalogue of the ones that
  -- pass. The run is split over four entries seven minutes apart because a single edge
  -- invocation has a hard 50 second budget and pg_cron cannot wait for a follow-up call.
  -- The body carries the chunk number; chunk 1..4 cover today's maximum of sixteen targets.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
      RAISE NOTICE 'ai-provider-health cron not scheduled: pg_cron or get_cron_secret() is missing';
      RETURN;
    END IF;

    FOR i IN 1..4 LOOP
      IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-' || i) THEN
        PERFORM cron.schedule(
          'ai-provider-health-' || i,
          (ARRAY['5 3 * * *','12 3 * * *','19 3 * * *','26 3 * * *'])[i],
          format(
            'SELECT net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''Authorization'',''Bearer '' || get_cron_secret()), body := %L::jsonb);',
            'https://api.postora.cloud/functions/v1/ai-provider-health',
            json_build_object('action', 'run', 'scope', 'daily', 'chunk', i)::text
          )
        );
      END IF;
    END LOOP;
  END $$;
  ```

  **Verify the cron body before you commit it.** `cron.schedule` runs the third argument as a
  SQL statement, so the body must be a single valid statement. After applying the migration,
  run:

  ```sql
  SELECT jobid, jobname, schedule, left(command, 200) FROM cron.job WHERE jobname LIKE 'ai-provider-health%';
  ```

  and then, by hand, `SELECT <the command body>;` — it must parse. If `format()` produced a
  quoted body that does not parse, replace the `format(...)` with four literal
  `PERFORM cron.schedule(...)` calls, one per chunk, each with its own literal body:

  ```sql
  PERFORM cron.schedule(
    'ai-provider-health-1',
    '5 3 * * *',
    $$
    SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/ai-provider-health', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":1}'::jsonb);
    $$
  );
  ```

  and the same for chunks 2, 3 and 4 with `'12 3 * * *'`, `'19 3 * * *'` and `'26 3 * * *'`.

- [ ] **Step 4: Register the suite** in `scripts/db-harness.sh`: append `ai_provider_health.sql`
  to the `SUITES=(` array, on the line after `ai_provider_oauth.sql`.

- [ ] **Step 5: Update `src/integrations/supabase/types.ts`** — add the
  `ai_provider_health` table (`Row` / `Insert` / `Update` / `Relationships`) and the three
  `Functions` entries, following the shape of the neighbouring `ai_provider_oauth_connections`
  block. Keep the file's alphabetical ordering of the `public` tables.

- [ ] **Step 6: Run the suite and confirm it passes.**

  Run: `bash scripts/db-harness.sh`

  Expected: PASS, including the ten assertions from Step 1.

- [ ] **Step 7: Commit**

  ```bash
  git commit -m "feat(admin-ai): provider health table, RPCs and the daily check schedule" -- supabase/migrations/20261113180000_ai_provider_health.sql supabase/tests/ai_provider_health.sql scripts/db-harness.sh src/integrations/supabase/types.ts
  ```

  End the message with the trailer:

  ```
  Co-Authored-By: MiniMax <noreply@minimax.io>
  ```

---

### Task 2: The pure module — planning, classification, sanitisation, chunk slicing

**Files:**
- Create: `supabase/functions/_shared/aiProviderHealth.ts`
- Test: `supabase/functions/_shared/aiProviderHealth.test.ts`

**Interfaces — Produces:**
- `export type HealthAuthMethod = 'api_key' | 'oauth'`
- `export type HealthStatus = 'connected' | 'failed' | 'needs_relogin'`
- `export interface HealthTarget { provider_code: string; auth_method: HealthAuthMethod; display_name: string; oauth_provider?: string }`
- `export interface HealthResult { provider_code: string; auth_method: HealthAuthMethod; display_name: string; status: HealthStatus; reason: string | null; models_added: number | null; models_updated: number | null; models_deactivated: number | null; latency_ms: number | null; checked_at: string }`
- `export interface DegradedProvider { provider_code: string; auth_method: HealthAuthMethod; status: 'failed' | 'needs_relogin'; reason: string | null }`
- `export const HEALTH_RUN_CONCURRENCY = 3`
- `export const HEALTH_TARGET_TIMEOUT_MS = 12_000`
- `export const HEALTH_RUN_DEADLINE_MS = 40_000`
- `export const HEALTH_CHUNK_SIZE = 6`
- `export function planHealthTargets(apiKeyProviders: Array<{ provider_code: string; name: string }>, oauthConnections: Array<{ oauth_provider: string; provider_code: string; name: string }>): HealthTarget[]`
- `export function sliceHealthChunk(targets: HealthTarget[], chunk: number): { slice: HealthTarget[]; done: boolean; nextChunk: number | null }`
- `export function classifyApiKeyFailure(status: number, bodyText: string, apiKey?: string | null): { status: HealthStatus; reason: string }`
- `export function classifyOAuthFailure(code: string): { status: HealthStatus; reason: string }`
- `export function sanitizeReason(text: string, apiKey: string | null): string`
- `export function summarizeHealthResults(results: HealthResult[]): { total: number; connected: number; failed: number; needs_relogin: number }`
- `export function deriveRunId(scope: 'daily' | 'manual', token: string, now: Date): string`

- [ ] **Step 1: Write the failing tests** (`supabase/functions/_shared/aiProviderHealth.test.ts`):

  ```ts
  import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
  import {
    classifyApiKeyFailure,
    classifyOAuthFailure,
    deriveRunId,
    planHealthTargets,
    sanitizeReason,
    sliceHealthChunk,
    summarizeHealthResults,
    type HealthResult,
  } from "./aiProviderHealth.ts";

  Deno.test("the target list holds one row per credential kind and never a provider without one", () => {
    const targets = planHealthTargets(
      [{ provider_code: "claude", name: "Claude" }, { provider_code: "openai", name: "OpenAI" }],
      [{ oauth_provider: "anthropic", provider_code: "claude", name: "Claude" },
       { oauth_provider: "openai-codex", provider_code: "openai", name: "OpenAI" }],
    );
    assertEquals(targets.map((t) => `${t.provider_code}:${t.auth_method}`), [
      "claude:api_key", "openai:api_key", "claude:oauth", "openai:oauth",
    ]);
    assertEquals(targets[2].oauth_provider, "anthropic");
  });

  Deno.test("the chunk slice is empty and done past the last chunk", () => {
    const targets = planHealthTargets(
      Array.from({ length: 7 }, (_, i) => ({ provider_code: `p${i}`, name: `P${i}` })), []);
    const first = sliceHealthChunk(targets, 1);
    assertEquals(first.slice.length, 6);
    assertEquals(first.done, false);
    assertEquals(first.nextChunk, 2);
    const second = sliceHealthChunk(targets, 2);
    assertEquals(second.slice.length, 1);
    assertEquals(second.done, true);
    assertEquals(second.nextChunk, null);
  });

  Deno.test("an invalid api key is a failure with a fixed sentence and no key", () => {
    const out = classifyApiKeyFailure(401, '{"error":{"message":"Incorrect API key provided: sk-live-ABCDEF"}}', "sk-live-ABCDEF");
    assertEquals(out.status, "failed");
    assert(!out.reason.includes("sk-live-ABCDEF"));
  });

  Deno.test("a provider that echoes the key back has it redacted", () => {
    const out = classifyApiKeyFailure(500, '{"error":{"message":"upstream rejected sk-live-ABCDEF"}}', "sk-live-ABCDEF");
    assert(!out.reason.includes("sk-live-ABCDEF"));
    assert(out.reason.includes("[REDACTED]"));
  });

  Deno.test("a rate limit is a failure, not a re-login", () => {
    assertEquals(classifyApiKeyFailure(429, '{"error":{"type":"rate_limit"}}').reason, "Rate limit exceeded");
  });

  Deno.test("an expired oauth refresh needs a re-login", () => {
    const out = classifyOAuthFailure("reauth_required");
    assertEquals(out.status, "needs_relogin");
    assert(out.reason.length > 0);
    assert(!/token|secret|bearer/i.test(out.reason));
  });

  Deno.test("the sanitizer removes the key and the authorization header and truncates", () => {
    const out = sanitizeReason('bad key sk-live-ABCDEF with Authorization: Bearer sk-live-ABCDEF', "sk-live-ABCDEF");
    assert(!out.includes("sk-live-ABCDEF"));
    assert(out.length <= 500);
  });

  Deno.test("the summary counts every status", () => {
    const base: HealthResult = {
      provider_code: "claude", auth_method: "api_key", display_name: "Claude",
      status: "connected", reason: null, models_added: 1, models_updated: 0,
      models_deactivated: 0, latency_ms: 12, checked_at: "2026-11-13T00:00:00Z",
    };
    assertEquals(summarizeHealthResults([
      base,
      { ...base, status: "failed" },
      { ...base, status: "needs_relogin" },
    ]), { total: 3, connected: 1, failed: 1, needs_relogin: 1 });
  });

  Deno.test("the daily run id is stable for a day and the manual one follows its token", () => {
    const day = new Date("2026-11-13T03:05:00Z");
    assertEquals(
      deriveRunId("daily", "cron", day),
      deriveRunId("daily", "cron", new Date("2026-11-13T03:26:00Z")),
    );
    assert(deriveRunId("daily", "cron", day) !== deriveRunId("daily", "cron", new Date("2026-11-14T03:05:00Z")));
    assert(deriveRunId("manual", "token-a", day) !== deriveRunId("manual", "token-b", day));
  });
  ```

- [ ] **Step 2: Run and see it fail**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderHealth.test.ts`

  Expected: FAIL — `Cannot find module "./aiProviderHealth.ts"`.

- [ ] **Step 3: Implement** `supabase/functions/_shared/aiProviderHealth.ts`.

  The module is **pure**: no `Deno.env`, no `fetch`, no database. Everything it needs arrives
  as an argument.

  ```ts
  // Planning, classification and sanitisation for the AI provider health run.
  //
  // WHY a pure module
  // The run has two callers (the admin button and the daily cron job) and they must agree
  // on every rule: which providers are targets, what a failure is called, what a reason may
  // contain, and how the targets are split into chunks that fit the edge function's 50
  // second budget. Keeping those rules here, with no I/O, is what makes them testable and
  // what stops the two callers from drifting apart.

  export type HealthAuthMethod = "api_key" | "oauth";
  export type HealthStatus = "connected" | "failed" | "needs_relogin";

  export interface HealthTarget {
    provider_code: string;
    auth_method: HealthAuthMethod;
    display_name: string;
    /** The pi-ai OAuth provider id; present only for auth_method 'oauth'. */
    oauth_provider?: string;
  }

  export interface HealthResult {
    provider_code: string;
    auth_method: HealthAuthMethod;
    display_name: string;
    status: HealthStatus;
    reason: string | null;
    models_added: number | null;
    models_updated: number | null;
    models_deactivated: number | null;
    latency_ms: number | null;
    checked_at: string;
  }

  /** A provider that just degraded — the shape the admin alert is built from. */
  export interface DegradedProvider {
    provider_code: string;
    auth_method: HealthAuthMethod;
    status: "failed" | "needs_relogin";
    reason: string | null;
  }

  /** Probes in flight at once. Three keeps 16 targets inside the 40 second budget. */
  export const HEALTH_RUN_CONCURRENCY = 3;
  /** One probe. The probes in ai-config have no timeout today; this bounds them. */
  export const HEALTH_TARGET_TIMEOUT_MS = 12_000;
  /** Server-side hard stop, 10 seconds of headroom under the 50 second platform limit. */
  export const HEALTH_RUN_DEADLINE_MS = 40_000;
  /** Targets per HTTP call. 6 x 12s / 3 concurrent = 24s even when every probe times out. */
  export const HEALTH_CHUNK_SIZE = 6;

  const REASON_LIMIT = 500;

  export function planHealthTargets(
    apiKeyProviders: Array<{ provider_code: string; name: string }>,
    oauthConnections: Array<{ oauth_provider: string; provider_code: string; name: string }>,
  ): HealthTarget[] {
    const targets: HealthTarget[] = [];
    // Sorted so the chunk boundaries do not move when a provider is added or removed.
    for (const p of [...apiKeyProviders].sort((a, b) => a.provider_code.localeCompare(b.provider_code))) {
      targets.push({ provider_code: p.provider_code, auth_method: "api_key", display_name: p.name });
    }
    for (const c of [...oauthConnections].sort((a, b) => a.oauth_provider.localeCompare(b.oauth_provider))) {
      targets.push({
        provider_code: c.provider_code,
        auth_method: "oauth",
        display_name: c.name,
        oauth_provider: c.oauth_provider,
      });
    }
    return targets;
  }

  export function sliceHealthChunk(
    targets: HealthTarget[],
    chunk: number,
  ): { slice: HealthTarget[]; done: boolean; nextChunk: number | null } {
    const index = Math.max(1, Math.floor(chunk)) - 1;
    const slice = targets.slice(index * HEALTH_CHUNK_SIZE, (index + 1) * HEALTH_CHUNK_SIZE);
    const done = slice.length === 0 || (index + 1) * HEALTH_CHUNK_SIZE >= targets.length;
    return { slice, done, nextChunk: done ? null : index + 2 };
  }
  ```

  `classifyApiKeyFailure` reuses `describeProviderFailure` from `_shared/providerErrors.ts`, so
  the health run and the card's Test button say the same thing about the same failure:

  ```ts
  import { describeProviderFailure } from "./providerErrors.ts";
  import { redactProviderError } from "./ai-routing-errors.ts";

  export function sanitizeReason(text: string, apiKey: string | null): string {
    // redactProviderError removes the exact key and any authorization / x-api-key header
    // value, then truncates. The key is used for the comparison and is never stored.
    const redacted = redactProviderError(text, apiKey ?? "");
    return redacted.slice(0, REASON_LIMIT);
  }

  export function classifyApiKeyFailure(
    status: number,
    bodyText: string,
    apiKey?: string | null,
  ): { status: HealthStatus; reason: string } {
    return {
      status: "failed",
      reason: sanitizeReason(describeProviderFailure("Provider", status, bodyText), apiKey ?? null),
    };
  }
  ```

  `classifyOAuthFailure` maps the stable `AiOAuthError` code to a status and to one of a
  small set of fixed sentences. A raw provider error never reaches this function:

  ```ts
  export function classifyOAuthFailure(code: string): { status: HealthStatus; reason: string } {
    if (code === "reauth_required" || code === "refresh_failed") {
      return { status: "needs_relogin", reason: "The subscription sign-in expired. Sign in again." };
    }
    if (code === "refresh_timeout") {
      return { status: "failed", reason: "The subscription sign-in could not be refreshed in time." };
    }
    if (code === "not_connected") {
      return { status: "needs_relogin", reason: "No subscription sign-in is connected." };
    }
    return { status: "failed", reason: "The subscription sign-in could not be checked." };
  }
  ```

  `deriveRunId` produces a stable UUID-shaped string. The daily id depends only on the UTC
  date, so the four cron entries of one day share a run id; the manual id depends on the
  browser's token, so two clicks never share one:

  ```ts
  export function deriveRunId(scope: "daily" | "manual", token: string, now: Date): string {
    const day = now.toISOString().slice(0, 10);
    const seed = scope === "daily" ? `daily:${day}` : `manual:${token}`;
    // A deterministic UUID-shaped id; the database only ever sees it as text.
    let h = 2166136261;
    for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const hex = (n: number) => n.toString(16).padStart(8, "0");
    const a = hex(h);
    const b = hex(Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0);
    return `${a.slice(0, 8)}-${a.slice(8, 12)}-4${a.slice(13, 16)}-8${b.slice(0, 3)}-${b.slice(3, 15)}`;
  }
  ```

  `summarizeHealthResults` counts the three statuses.

- [ ] **Step 4: Run and see it pass**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderHealth.test.ts`

  Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git commit -m "feat(admin-ai): pure planning and classification for the provider health run" -- supabase/functions/_shared/aiProviderHealth.ts supabase/functions/_shared/aiProviderHealth.test.ts
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 3: Extract the provider probe so both callers share it, and give it a timeout

**Files:**
- Create: `supabase/functions/_shared/aiProviderTest.ts`
- Test: `supabase/functions/_shared/aiProviderTest.test.ts`
- Modify: `supabase/functions/ai-config/index.ts` (import the shared module; delete the
  private `testTarget` / `runProviderTest` / `testFirecrawl` … `testOpenAI` block)
- Delete: `supabase/functions/ai-config/providerTestKind.ts`
- Delete: `supabase/functions/ai-config/providerTestKind.test.ts`

**Interfaces — Consumes:** `HEALTH_TARGET_TIMEOUT_MS` from Task 2.

**Interfaces — Produces:**
- `export type ProviderTestKind` (moved unchanged from `ai-config/providerTestKind.ts`)
- `export function providerTestKind(provider: { provider_code: string; api_type?: string | null }): ProviderTestKind`
- `export interface ProviderProbeTarget { id: string; provider_code: string; api_type: string | null; api_endpoint: string }`
- `export async function probeProvider(db: unknown, provider: ProviderProbeTarget, key: string, timeoutMs?: number): Promise<void>`
  — throws `ProviderTestError` on a provider failure; resolves when the probe succeeded.
- `export async function loadProbeTarget(db: RowReader, providerCode: string): Promise<ProviderProbeTarget | null>`

**Why this task exists:** the probes live inside `ai-config/index.ts` today, so the health
runner cannot use them without a second copy — the exact drift the comment at the top of
`providerTestKind.ts` warns about. Moving them to `_shared/` gives both callers one
implementation and, more importantly, one place to add the timeout the probes still lack.

- [ ] **Step 1: Write the failing tests** (`supabase/functions/_shared/aiProviderTest.test.ts`).
  Take the existing cases from `supabase/functions/ai-config/providerTestKind.test.ts` and move
  them here unchanged, then add the timeout case:

  ```ts
  import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
  import { ProviderTestError } from "./providerErrors.ts";
  import { probeProvider, providerTestKind } from "./aiProviderTest.ts";

  Deno.test("the probe kind still follows the provider code first", () => {
    assertEquals(providerTestKind({ provider_code: "xai", api_type: "openai" }), "xai");
    assertEquals(providerTestKind({ provider_code: "custom", api_type: "anthropic" }), "anthropic");
    assertEquals(providerTestKind({ provider_code: "custom", api_type: null }), "openai");
  });

  Deno.test("a provider that never answers fails with a timeout, not a hang", async () => {
    const slowFetch = (_url: string, _init?: RequestInit) =>
      new Promise<Response>((_resolve) => { /* never settles */ });
    await assertRejects(
      () => probeProvider({}, { id: "1", provider_code: "xai", api_type: "openai", api_endpoint: "https://api.x.ai/v1" }, "sk-test", 50),
      ProviderTestError,
    );
  });

  Deno.test("a provider error carries the status and never the key", async () => {
    const err = await assertRejects(
      () => probeProvider({}, { id: "1", provider_code: "xai", api_type: "openai", api_endpoint: "https://api.x.ai/v1" }, "sk-secret", 1000),
      ProviderTestError,
    ) as unknown as ProviderTestError;
    assertEquals(err.status, 401);
    assert(!err.message.includes("sk-secret"));
  });
  ```

  The last two tests need the probe to accept an injected `fetch` so they do not touch the
  network. Add an optional fourth parameter:

  ```ts
  export async function probeProvider(
    db: unknown,
    provider: ProviderProbeTarget,
    key: string,
    timeoutMs = HEALTH_TARGET_TIMEOUT_MS,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void>
  ```

- [ ] **Step 2: Run and see it fail**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderTest.test.ts`

  Expected: FAIL — `Cannot find module "./aiProviderTest.ts"`.

- [ ] **Step 3: Implement** `supabase/functions/_shared/aiProviderTest.ts`.

  Move the probe code **verbatim** out of `supabase/functions/ai-config/index.ts`
  (`testTarget`, `runProviderTest` and the `testFirecrawl` … `testOpenAI` helpers), and move
  `providerTestKind.ts` in as well. Three changes while moving:

  1. Every `fetch` gains `signal: AbortSignal.timeout(timeoutMs)`. Today they have none, so a
     provider that stops answering hangs the whole function.
  2. `fetch` becomes the injected `fetchImpl` parameter, defaulting to the global `fetch`.
  3. The exported name is `probeProvider` (not `runProviderTest`): it is a probe, and the
     new name says what it does.

  Keep the `ProviderTestError` import from `./providerErrors.ts` and the `RowReader` import
  from `./providerEndpoint.ts`.

  The public entry point:

  ```ts
  export async function probeProvider(
    db: unknown,
    provider: ProviderProbeTarget,
    key: string,
    timeoutMs = HEALTH_TARGET_TIMEOUT_MS,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const ep = provider.api_endpoint;
    switch (providerTestKind(provider)) {
      case "firecrawl": return testFirecrawl(key, timeoutMs, fetchImpl);
      case "apify": return testApify(key, timeoutMs, fetchImpl);
      case "elevenlabs": return testElevenLabs(key, ep, timeoutMs, fetchImpl);
      case "brave": return testBrave(key, timeoutMs, fetchImpl);
      case "exa": return testExa(key, timeoutMs, fetchImpl);
      case "jina": return testJina(key, timeoutMs, fetchImpl);
      case "zai": return testZAI(key, ep, timeoutMs, fetchImpl);
      case "xai": return testXAI(key, ep, timeoutMs, fetchImpl);
      case "minimax": return testMinimax(key, ep, timeoutMs, fetchImpl);
      case "perplexity": return testPerplexity(key, ep, timeoutMs, fetchImpl);
      case "google": return testGemini(key, ep, timeoutMs, fetchImpl);
      case "anthropic": return testAnthropic(key, ep, timeoutMs, fetchImpl);
      case "openai": return testOpenAI(key, ep, await defaultTestModel(db, provider), timeoutMs, fetchImpl);
    }
  }
  ```

  `loadProbeTarget` is `testTarget` renamed and exported.

- [ ] **Step 4: Point `ai-config` at the shared module.** In
  `supabase/functions/ai-config/index.ts`:

  - delete the `import { providerTestKind } from './providerTestKind.ts';` line and the whole
    `// ── Test helpers ──` block;
  - add
    `import { loadProbeTarget, probeProvider } from '../_shared/aiProviderTest.ts';`;
  - replace `testTarget(supabase as unknown as RowReader, provider_code)` with
    `loadProbeTarget(supabase as unknown as RowReader, provider_code)`;
  - replace `await runProviderTest(supabase, provider, apiKey);` with
    `await probeProvider(supabase, provider, apiKey);`.

  The card's Test button must behave exactly as before, except that a hung provider now
  times out instead of hanging the request.

- [ ] **Step 5: Run and see it pass**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderTest.test.ts supabase/functions/_shared/aiProviderHealth.test.ts supabase/functions/ai-config/`

  Expected: all PASS, including the tests that moved out of
  `supabase/functions/ai-config/providerTestKind.test.ts`.

- [ ] **Step 6: Commit**

  ```bash
  git commit -m "refactor(admin-ai): share one provider probe with a timeout between the card and the health run" -- supabase/functions/_shared/aiProviderTest.ts supabase/functions/_shared/aiProviderTest.test.ts supabase/functions/ai-config/index.ts supabase/functions/ai-config/providerTestKind.ts supabase/functions/ai-config/providerTestKind.test.ts
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 4: The runner — plan, slice, test, sync, record

**Files:**
- Create: `supabase/functions/ai-provider-health/run.ts`
- Create: `supabase/functions/ai-provider-health/deps.ts`
- Test: `supabase/functions/ai-provider-health/run.test.ts`

**Interfaces — Consumes:** everything from Task 2, `probeProvider` / `loadProbeTarget` from
Task 3, `runCatalogSync` from `_shared/modelCatalogSyncRun.ts`.

**Interfaces — Produces:**
- `export interface HealthRunPorts {`
  `  listApiKeyProviders(): Promise<Array<{ provider_code: string; name: string }>>;`
  `  listOAuthConnections(): Promise<Array<{ oauth_provider: string; provider_code: string; name: string; status: string }>>;`
  `  resolveApiKey(providerCode: string): Promise<string | null>;`
  `  probeApiKey(target: HealthTarget, key: string): Promise<void>;`
  `  probeOAuth(target: HealthTarget): Promise<void>;`
  `  syncApiKeyCatalogue(providerCode: string): Promise<{ added: number; updated: number; deactivated: number }>;`
  `  syncOAuthCatalogue(target: HealthTarget): Promise<{ added: number; updated: number; deactivated: number }>;`
  `  recordResult(result: HealthResult, runId: string): Promise<void>;`
  `  claimAlerts(claimToken: string): Promise<DegradedProvider[]>;`
  `  sendAlert(provider: DegradedProvider): Promise<void>;`
  `  now(): Date;`
  `}`
- `export interface HealthRunOptions { runId: string; chunk: number; deadlineMs?: number; concurrency?: number }`
- `export async function runHealthChunk(ports: HealthRunPorts, options: HealthRunOptions): Promise<{ run_id: string; chunk: number; done: boolean; next_chunk: number | null; results: HealthResult[]; summary: { total: number; connected: number; failed: number; needs_relogin: number } }>`

- [ ] **Step 1: Write the failing tests** (`supabase/functions/ai-provider-health/run.test.ts`):

  ```ts
  import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
  import { runHealthChunk, type HealthRunPorts } from "./run.ts";
  import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";

  function fakePorts(overrides: Partial<HealthRunPorts> = {}) {
    const recorded: HealthResult[] = [];
    const synced: string[] = [];
    const ports: HealthRunPorts = {
      listApiKeyProviders: async () => [
        { provider_code: "openai", name: "OpenAI" },
        { provider_code: "xai", name: "xAI" },
      ],
      listOAuthConnections: async () => [
        { oauth_provider: "anthropic", provider_code: "claude", name: "Claude", status: "connected" },
      ],
      resolveApiKey: async (code) => (code === "xai" ? null : "sk-test"),
      probeApiKey: async () => {},
      probeOAuth: async () => {},
      syncApiKeyCatalogue: async (code) => { synced.push(code); return { added: 1, updated: 0, deactivated: 0 }; },
      syncOAuthCatalogue: async () => ({ added: 0, updated: 0, deactivated: 0 }),
      recordResult: async (result) => { recorded.push(result); },
      claimAlerts: async () => [],
      sendAlert: async () => {},
      now: () => new Date("2026-11-13T03:05:00Z"),
      ...overrides,
    };
    return { ports, recorded, synced };
  }

  Deno.test("a provider without a key is not a target", async () => {
    const { ports, recorded } = fakePorts();
    const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    assertEquals(out.results.map((r) => `${r.provider_code}:${r.auth_method}`), ["openai:api_key", "claude:oauth"]);
    assertEquals(recorded.length, 2);
  });

  Deno.test("one failing provider does not stop the others", async () => {
    const { ports, recorded, synced } = fakePorts({
      probeApiKey: async (target) => {
        if (target.provider_code === "openai") throw new Error("HTTP 500");
      },
    });
    const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    assertEquals(out.summary.failed, 1);
    assertEquals(out.summary.connected, 1);
    assertEquals(synced.length, 1);
    assertEquals(recorded.filter((r) => r.status === "failed").length, 1);
  });

  Deno.test("a failed provider is never synced", async () => {
    const { ports, synced } = fakePorts({ probeApiKey: async () => { throw new Error("boom"); } });
    await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    assertEquals(synced.length, 0);
  });

  Deno.test("a provider that echoes the key back never stores it in the reason", async () => {
    const { ports, recorded } = fakePorts({
      resolveApiKey: async () => "sk-live-ABCDEF",
      probeApiKey: async () => { throw new Error("upstream rejected sk-live-ABCDEF"); },
    });
    await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    const failed = recorded.find((r) => r.status === "failed");
    assert(!String(failed?.reason).includes("sk-live-ABCDEF"));
  });

  Deno.test("an expired oauth refresh needs a re-login and syncs nothing", async () => {
    const { ports, synced, recorded } = fakePorts({
      probeOAuth: async () => { throw new AiOAuthError("reauth_required"); },
    });
    const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    const oauth = out.results.find((r) => r.auth_method === "oauth");
    assertEquals(oauth?.status, "needs_relogin");
    assertEquals(oauth?.models_added, null);
    assertEquals(synced.length, 1); // only the api-key provider synced
    assertEquals(recorded.find((r) => r.auth_method === "oauth")?.status, "needs_relogin");
  });

  Deno.test("a chunk past the end is done and writes nothing", async () => {
    const { ports, recorded } = fakePorts();
    const out = await runHealthChunk(ports, { runId: "run-1", chunk: 9 });
    assertEquals(out.done, true);
    assertEquals(out.results.length, 0);
    assertEquals(recorded.length, 0);
  });

  Deno.test("the counts are empty for a provider that failed", async () => {
    const { ports } = fakePorts({ probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("x"); } });
    const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    const failed = out.results.find((r) => r.status === "failed");
    assertEquals(failed?.models_added, null);
    assertEquals(failed?.models_updated, null);
    assertEquals(failed?.models_deactivated, null);
  });
  ```

- [ ] **Step 2: Run and see it fail**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/ai-provider-health/run.test.ts`

  Expected: FAIL — `Cannot find module "./run.ts"`.

- [ ] **Step 3: Implement** `supabase/functions/ai-provider-health/run.ts`.

  The runner is one function: plan the targets, take the chunk's slice, process each target
  inside its own `try`/`catch`, record the outcome. **A failure in one target never leaves
  the loop.**

  ```ts
  import {
    HEALTH_CHUNK_SIZE, HEALTH_RUN_CONCURRENCY, HEALTH_RUN_DEADLINE_MS,
    classifyApiKeyFailure, classifyOAuthFailure, planHealthTargets, sanitizeReason,
    sliceHealthChunk, summarizeHealthResults,
    type HealthResult, type HealthStatus, type HealthTarget, type DegradedProvider,
  } from "../_shared/aiProviderHealth.ts";
  import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";

  export interface HealthRunPorts {
    listApiKeyProviders(): Promise<Array<{ provider_code: string; name: string }>>;
    listOAuthConnections(): Promise<Array<{ oauth_provider: string; provider_code: string; name: string; status: string }>>;
    resolveApiKey(providerCode: string): Promise<string | null>;
    probeApiKey(target: HealthTarget, key: string): Promise<void>;
    probeOAuth(target: HealthTarget): Promise<void>;
    syncApiKeyCatalogue(providerCode: string): Promise<{ added: number; updated: number; deactivated: number }>;
    syncOAuthCatalogue(target: HealthTarget): Promise<{ added: number; updated: number; deactivated: number }>;
    recordResult(result: HealthResult, runId: string): Promise<void>;
    claimAlerts(claimToken: string): Promise<DegradedProvider[]>;
    sendAlert(provider: DegradedProvider): Promise<void>;
    now(): Date;
  }

  export interface HealthRunOptions {
    runId: string;
    chunk: number;
    deadlineMs?: number;
    concurrency?: number;
  }

  async function runOneTarget(
    ports: HealthRunPorts,
    target: HealthTarget,
    runId: string,
  ): Promise<HealthResult> {
    const started = Date.now();
    const checkedAt = ports.now().toISOString();
    let status: HealthStatus = "connected";
    let reason: string | null = null;
    let added: number | null = null;
    let updated: number | null = null;
    let deactivated: number | null = null;
    // Kept in scope so a reason can be redacted against it. It is never stored or logged.
    let apiKey: string | null = null;

    try {
      if (target.auth_method === "oauth") {
        await ports.probeOAuth(target);
      } else {
        apiKey = await ports.resolveApiKey(target.provider_code);
        if (!apiKey) {
          // No key: this target does not exist. The planner already filtered these out,
          // so reaching here means the key vanished mid-run.
          throw new Error("no key");
        }
        await ports.probeApiKey(target, apiKey);
      }
    } catch (error) {
      const classified = classifyTargetFailure(error, apiKey);
      status = classified.status;
      reason = classified.reason;
    }

    // Only a provider whose test passed is synced. A failed OAuth target is never synced,
    // so its models are never deactivated and never deleted.
    if (status === "connected") {
      try {
        const report = target.auth_method === "oauth"
          ? await ports.syncOAuthCatalogue(target)
          : await ports.syncApiKeyCatalogue(target.provider_code);
        added = report.added;
        updated = report.updated;
        deactivated = report.deactivated;
      } catch (error) {
        status = "failed";
        reason = sanitizeReason(error instanceof Error ? error.message : String(error), apiKey);
        added = null;
        updated = null;
        deactivated = null;
      }
    }

    const result: HealthResult = {
      provider_code: target.provider_code,
      auth_method: target.auth_method,
      display_name: target.display_name,
      status,
      reason,
      models_added: added,
      models_updated: updated,
      models_deactivated: deactivated,
      latency_ms: Date.now() - started,
      checked_at: checkedAt,
    };
    await ports.recordResult(result, runId);
    return result;
  }
  ```

  `classifyTargetFailure` is a small local helper that routes the two failure families:

  ```ts
  function classifyTargetFailure(error: unknown, apiKey: string | null): { status: HealthStatus; reason: string } {
    if (error instanceof AiOAuthError) return classifyOAuthFailure(error.code);
    if (error instanceof ProviderTestError) {
      return {
        status: "failed",
        reason: sanitizeReason(describeProviderFailure("Provider", error.status, error.body), apiKey),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", reason: sanitizeReason(message, apiKey) };
  }
  ```

  `runHealthChunk` plans, slices, runs the slice with a bounded concurrency and a deadline,
  and returns the summary:

  ```ts
  export async function runHealthChunk(ports: HealthRunPorts, options: HealthRunOptions) {
    const apiKeyProviders = await ports.listApiKeyProviders();
    const oauthConnections = (await ports.listOAuthConnections()).filter((c) => c.status !== "reauth_required");
    const reauthConnections = (await ports.listOAuthConnections()).filter((c) => c.status === "reauth_required");

    const targets = planHealthTargets(apiKeyProviders, oauthConnections);
    // A connection already in reauth_required is a target that must be reported as
    // "needs re-login" without any network call.
    for (const c of reauthConnections) {
      targets.push({
        provider_code: c.provider_code,
        auth_method: "oauth",
        display_name: c.name,
        oauth_provider: c.oauth_provider,
      });
    }

    const { slice, done, nextChunk } = sliceHealthChunk(targets, options.chunk);
    const deadline = Date.now() + (options.deadlineMs ?? HEALTH_RUN_DEADLINE_MS);
    const concurrency = options.concurrency ?? HEALTH_RUN_CONCURRENCY;
    const results: HealthResult[] = [];
    let index = 0;

    async function worker() {
      while (index < slice.length && Date.now() < deadline) {
        const target = slice[index++];
        results.push(await runOneTarget(ports, target, options.runId));
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));

    return {
      run_id: options.runId,
      chunk: options.chunk,
      done,
      next_chunk: nextChunk,
      results,
      summary: summarizeHealthResults(results),
    };
  }
  ```

  **Careful with the reauth list.** `listOAuthConnections()` is called twice above on
  purpose only to keep the call count low; call it **once** into a local variable and derive
  both lists from it. The final code must be:

  ```ts
  const connections = await ports.listOAuthConnections();
  const oauthConnections = connections.filter((c) => c.status !== "reauth_required");
  const reauthConnections = connections.filter((c) => c.status === "reauth_required");
  ```

  A connection in `reauth_required` is reported as `needs_relogin` with **no** network call
  and **no** sync — that is the owner's "must not erase its models" rule.

- [ ] **Step 4: Implement** `supabase/functions/ai-provider-health/deps.ts` — the real ports.

  ```ts
  import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
  import { resolveProviderKey } from "../_shared/providerKeys.ts";
  import { loadProbeTarget, probeProvider } from "../_shared/aiProviderTest.ts";
  import { getFreshOAuthCredential } from "../_shared/aiOAuth/credentials.ts";
  import { runCatalogSync } from "../_shared/modelCatalogSyncRun.ts";

  export function createHealthRunPorts(admin: ReturnType<typeof createClient>) { /* … */ }
  ```

  The ports must:
  - read `ai_providers` (`provider_code`, `name`) where `is_active` and `provider_code` is in
    `SYNCABLE_PROVIDERS`;
  - read `ai_provider_oauth_connections` joined to `ai_providers` for the display name;
  - resolve the key with `resolveProviderKey`;
  - probe with `loadProbeTarget` + `probeProvider`;
  - probe OAuth with `getFreshOAuthCredential` + the pi-ai probe already used by
    `ai-provider-auth` (reuse `callPiOAuth` from `_shared/aiOAuth/piCall.ts` — **do not
    write a second OAuth probe**);
  - sync with `runCatalogSync(db, provider_code, fetch, { authMethod: 'api_key' })` (Task 5
    adds that option);
  - record with the `record_ai_provider_health` RPC from Task 1.

- [ ] **Step 5: Run and see it pass**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/ai-provider-health/run.test.ts supabase/functions/_shared/aiProviderHealth.test.ts`

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git commit -m "feat(admin-ai): the provider health runner tests every target and syncs the ones that pass" -- supabase/functions/ai-provider-health/run.ts supabase/functions/ai-provider-health/deps.ts supabase/functions/ai-provider-health/run.test.ts
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 5: Key the models by credential kind

**Files:**
- Modify: `supabase/functions/_shared/modelCatalogSyncRun.ts`
- Modify: `supabase/functions/_shared/modelCatalogSyncRun.test.ts`

**Interfaces — Consumes:** the `ai_models.auth_method` column and the unique index from Task 1.

**Interfaces — Produces:**
- `runCatalogSync(db, providerCode, fetchImpl, options)` gains
  `options: { dryRun?: boolean; authMethod?: 'api_key' | 'oauth' }` (default `'api_key'`).
- The upsert uses `onConflict: "provider_id,model_id,auth_method"` and every written row
  carries `auth_method`.
- `defaultModelsInUse(settings, providerCode, authMethod)` only protects models used by a tier
  with **the same** credential kind.

**Why this task exists:** `ai_models` was keyed by `(provider_id, model_id)`. Without the
`auth_method` column, the OAuth catalogue of `claude` would collide with the API-key
catalogue of `claude`, and the OAuth rows could never be stored at all.

- [ ] **Step 1: Write the failing tests** (append to
  `supabase/functions/_shared/modelCatalogSyncRun.test.ts`):

  ```ts
  Deno.test("the upsert targets the credential kind and never another one", async () => {
    const upserts: Array<{ rows: unknown[]; onConflict: string }> = [];
    const db = fakeCatalogDb({
      upsert: (rows: unknown[], options: { onConflict: string }) => {
        upserts.push({ rows, onConflict: options.onConflict });
        return { error: null };
      },
    });
    await runCatalogSync(db, "claude", fakeModelsFetch([{ id: "claude-sonnet-4" }]), { authMethod: "oauth" });
    assertEquals(upserts[0].onConflict, "provider_id,model_id,auth_method");
    assertEquals((upserts[0].rows[0] as { auth_method: string }).auth_method, "oauth");
  });

  Deno.test("an api-key default does not protect an oauth model from being switched off", () => {
    const inUse = defaultModelsInUse(
      [{ value: { provider_code: "claude", model_id: "claude-sonnet-4" } }],
      "claude",
      "oauth",
    );
    assertEquals(inUse.size, 0);
    assertEquals(
      defaultModelsInUse([{ value: { provider_code: "claude", model_id: "claude-sonnet-4" } }], "claude", "api_key").size,
      1,
    );
  });

  Deno.test("an oauth default protects the oauth model", () => {
    const inUse = defaultModelsInUse(
      [{ value: { provider_code: "claude", model_id: "claude-sonnet-4", auth_method: "oauth" } }],
      "claude",
      "oauth",
    );
    assertEquals(inUse.size, 1);
  });
  ```

  `defaultModelsInUse` must be exported for this test.

- [ ] **Step 2: Run and see it fail**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/modelCatalogSyncRun.test.ts`

  Expected: FAIL — the upsert still targets `provider_id,model_id` and
  `defaultModelsInUse` takes two arguments.

- [ ] **Step 3: Implement.**

  In `_shared/modelCatalogSyncRun.ts`:

  1. `defaultModelsInUse(settings, providerCode, authMethod)` gains the third parameter and
     only accepts a setting whose `provider_code` matches **and** whose `auth_method` matches
     the kind being synced. A setting with **no** `auth_method` is an API-key tier:

     ```ts
     function defaultModelsInUse(
       settings: Array<{ value: unknown }>,
       providerCode: string,
       authMethod: "api_key" | "oauth",
     ): Set<string> {
       const inUse = new Set<string>();
       for (const s of settings) {
         let v: unknown = s.value;
         if (typeof v === "string") {
           try { v = JSON.parse(v); } catch { continue; }
         }
         const setting = v as { provider_code?: unknown; model_id?: unknown; auth_method?: unknown } | null;
         if (!setting || setting.provider_code !== providerCode) continue;
         if (typeof setting.model_id !== "string" || !setting.model_id) continue;
         // A tier without auth_method is an API-key tier; an OAuth tier says so explicitly.
         const tierAuthMethod = setting.auth_method === "oauth" ? "oauth" : "api_key";
         if (tierAuthMethod !== authMethod) continue;
         inUse.add(setting.model_id);
       }
       return inUse;
     }
     ```

  2. `runCatalogSync` gains `options.authMethod` (default `"api_key"`), passes it to
     `defaultModelsInUse`, filters the `ai_models` read by it, adds it to every written row and
     changes the conflict target:

     ```ts
     const authMethod = options.authMethod ?? "api_key";
     const { data: existingData, error: existingError } = await db.from("ai_models")
       .select(MODEL_COLUMNS).eq("provider_id", provider.id).eq("auth_method", authMethod);
     if (existingError) throw new Error("ai_models read failed");
     const existing = (existingData ?? []) as ExistingModelRow[];
     const { data: settings, error: settingsError } = await db.from("system_settings")
       .select("key, value").like("key", "default_ai_model%");
     if (settingsError) throw new Error("system_settings read failed");
     const inUse = defaultModelsInUse((settings ?? []) as Array<{ value: unknown }>, providerCode, authMethod);
     const plan = planCatalogSync(existing, mapped, inUse);
     const now = new Date().toISOString();
     const row = (m: Omit<ExistingModelRow, "id">) => ({
       provider_id: provider.id, model_id: m.model_id, name: m.name, description: m.description,
       capabilities: m.capabilities, context_limit: m.context_limit,
       cost_per_1m_input_tokens: m.cost_per_1m_input_tokens, cost_per_1m_output_tokens: m.cost_per_1m_output_tokens,
       metadata: m.metadata, is_active: m.is_active, updated_at: now, auth_method: authMethod,
     });
     const deactivated = existing.filter((r) => plan.deactivateIds.includes(r.id));
     const rows = [
       ...plan.inserts.map((m) => row({ ...m, is_active: true })),
       ...plan.updates.map((u) => row(u)),
       ...deactivated.map((r) => row({ ...r, is_active: false, metadata: { ...(r.metadata ?? {}), sync_deactivated: true } })),
     ];
     const dryRun = options.dryRun === true;
     if (!dryRun) {
       if (rows.length) {
         const { error } = await db.from("ai_models").upsert(rows, { onConflict: "provider_id,model_id,auth_method" });
         if (error) throw new Error(`ai_models upsert failed: ${error.message}`);
       }
       const { error: stampError } = await db.from("system_settings").upsert(
         { key: `model_catalog_synced_at_${providerCode}_${authMethod}`, value: { at: now } }, { onConflict: "key" },
       );
       if (stampError) throw new Error(`system_settings write failed: ${stampError.message}`);
     }
     ```

  3. The `model_catalog_synced_at_<provider_code>` stamp key gains the credential kind, so an
     API-key sync and an OAuth sync of the same provider do not overwrite each other's
     stamp: `model_catalog_synced_at_${providerCode}_${authMethod}`.

  4. `MODEL_COLUMNS` stays as it is — `auth_method` is the filter, not a column it needs to
     read back.

- [ ] **Step 4: Run and see it pass**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/modelCatalogSyncRun.test.ts supabase/functions/_shared/modelCatalogSync.test.ts`

  Expected: all PASS. The existing API-key tests must still pass unchanged — the default is
  `auth_method = 'api_key'`.

- [ ] **Step 5: Commit**

  ```bash
  git commit -m "feat(admin-ai): key the model catalogue by credential kind" -- supabase/functions/_shared/modelCatalogSyncRun.ts supabase/functions/_shared/modelCatalogSyncRun.test.ts
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 6: The edge function — one door for the button and the cron

**Files:**
- Create: `supabase/functions/ai-provider-health/handler.ts`
- Create: `supabase/functions/ai-provider-health/handler.test.ts`
- Create: `supabase/functions/ai-provider-health/index.ts`

**Interfaces — Consumes:** `runHealthChunk` from Task 4, `verifyCronOrAdmin` from
`_shared/cron-auth.ts`, `acquire_cron_run_lease` / `release_cron_run_lease` from the Task 1
database.

**Interfaces — Produces:**
- `export interface HealthHandlerPorts {`
  `  runChunk(chunk: number, runId: string, scope: 'daily' | 'manual'): Promise<HealthChunkResponse>;`
  `  readResults(): Promise<HealthResult[]>;`
  `  acquireLease(job: string, holder: string, ttlSeconds: number): Promise<boolean>;`
  `  releaseLease(job: string, holder: string): Promise<boolean>;`
  `  isAuthorized(req: Request): Promise<{ ok: true } | { ok: false; response: Response }>;`
  `}`
- `export async function handleHealthRequest(req: Request, ports: HealthHandlerPorts): Promise<Response>`
- `export function parseHealthRequest(body: unknown): { action: 'run' | 'status'; chunk: number; scope: 'daily' | 'manual'; runToken: string | null }`

- [ ] **Step 1: Write the failing tests** (`supabase/functions/ai-provider-health/handler.test.ts`):

  ```ts
  import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
  import { handleHealthRequest, parseHealthRequest, type HealthHandlerPorts } from "./handler.ts";

  function fakePorts(overrides: Partial<HealthHandlerPorts> = {}) {
    const leases: Array<{ job: string; holder: string }> = [];
    const ports: HealthHandlerPorts = {
      runChunk: async (chunk) => ({
        run_id: "run-1", chunk, done: true, next_chunk: null, results: [], summary: { total: 0, connected: 0, failed: 0, needs_relogin: 0 },
      }),
      readResults: async () => [],
      acquireLease: async (job, holder) => { leases.push({ job, holder }); return true; },
      releaseLease: async (job, holder) => { leases.push({ job, holder }); return true; },
      isAuthorized: async () => ({ ok: true }),
      ...overrides,
    };
    return { ports, leases };
  }

  Deno.test("the action defaults to status and the chunk to one", () => {
    assertEquals(parseHealthRequest({}), { action: "status", chunk: 1, scope: "manual", runToken: null });
  });

  Deno.test("a run without a token is rejected", () => {
    assertEquals(parseHealthRequest({ action: "run" }).action, "run");
    assertEquals(parseHealthRequest({ action: "run", scope: "manual" }).runToken, null);
  });

  Deno.test("an unauthorized caller gets 401 and no run", async () => {
    const { ports } = fakePorts({ isAuthorized: async () => ({ ok: false, response: new Response("no", { status: 401 }) }) });
    const res = await handleHealthRequest(new Request("https://x.test", { method: "POST" }), ports);
    assertEquals(res.status, 401);
  });

  Deno.test("a busy lease answers 409 and runs nothing", async () => {
    let ran = false;
    const { ports } = fakePorts({
      acquireLease: async () => false,
      runChunk: async () => { ran = true; throw new Error("must not run"); },
    });
    const res = await handleHealthRequest(
      new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual", run_token: "t" }) }),
      ports,
    );
    assertEquals(res.status, 409);
    assertEquals(ran, false);
  });

  Deno.test("a manual run takes the lease with a holder derived from the token", async () => {
    const { ports, leases } = fakePorts();
    const res = await handleHealthRequest(
      new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual", run_token: "token-a" }) }),
      ports,
    );
    assertEquals(res.status, 200);
    assertEquals(leases[0].job, "ai-provider-health");
    assert(leases[0].holder.length > 0);
  });

  Deno.test("the daily scope does not need a token", async () => {
    const { ports } = fakePorts();
    const res = await handleHealthRequest(
      new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "daily", chunk: 2 }) }),
      ports,
    );
    assertEquals(res.status, 200);
  });

  Deno.test("the status action returns the stored results", async () => {
    const { ports } = fakePorts({
      readResults: async () => [{
        provider_code: "claude", auth_method: "api_key", display_name: "Claude", status: "connected",
        reason: null, models_added: 1, models_updated: 0, models_deactivated: 0, latency_ms: 10, checked_at: "t",
      }],
    });
    const res = await handleHealthRequest(new Request("https://x.test?action=status"), ports);
    const body = await res.json();
    assertEquals((body as { results: unknown[] }).results.length, 1);
  });
  ```

- [ ] **Step 2: Run and see it fail**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/ai-provider-health/handler.test.ts`

  Expected: FAIL — `Cannot find module "./handler.ts"`.

- [ ] **Step 3: Implement** `supabase/functions/ai-provider-health/handler.ts`.

  ```ts
  import { deriveRunId } from "../_shared/aiProviderHealth.ts";

  const LEASE_JOB = "ai-provider-health";
  const LEASE_TTL_SECONDS = 15 * 60;

  export function parseHealthRequest(body: unknown) {
    const raw = (body ?? {}) as { action?: unknown; chunk?: unknown; scope?: unknown; run_token?: unknown };
    const action = raw.action === "run" ? "run" : "status";
    const chunk = Number.isFinite(raw.chunk) ? Math.max(1, Math.floor(Number(raw.chunk))) : 1;
    const scope = raw.scope === "daily" ? "daily" : "manual";
    const runToken = typeof raw.run_token === "string" && raw.run_token ? raw.run_token : null;
    return { action, chunk, scope, runToken };
  }

  export async function handleHealthRequest(req: Request, ports: HealthHandlerPorts): Promise<Response> {
    const auth = await ports.isAuthorized(req);
    if (!auth.ok) return auth.response;

    const body = req.method === "POST" ? await safeJson(req) : null;
    const parsed = parseHealthRequest(body ?? (req.method === "GET" ? { action: "status" } : {}));

    if (parsed.action === "status") {
      const results = await ports.readResults();
      return json(200, { results });
    }

    // A manual run needs the browser's token: it is the run id, and without it two clicks
    // would share one lease and one run id.
    if (parsed.scope === "manual" && !parsed.runToken) {
      return json(400, { error: "run_token is required" });
    }

    const runId = deriveRunId(parsed.scope, parsed.runToken ?? "cron", new Date());
    const holder = runId;
    const acquired = await ports.acquireLease(LEASE_JOB, holder, LEASE_TTL_SECONDS);
    if (!acquired) {
      return json(409, { error: "busy" });
    }
    try {
      const result = await ports.runChunk(parsed.chunk, runId, parsed.scope);
      return json(200, result);
    } finally {
      await ports.releaseLease(LEASE_JOB, holder);
    }
  }
  ```

  `json(status, body)` writes the response with `Content-Type: application/json` and the
  restricted CORS headers from `_shared/cors.ts`.

  **Why the holder is the run id:** the four daily cron entries of one day share the daily
  run id, so each of them *extends* the same lease instead of failing to take it. A manual
  click has its own run id, so it either takes the lease (when free) or gets `409 busy`.

- [ ] **Step 4: Implement** `supabase/functions/ai-provider-health/index.ts` — the thin entry:

  ```ts
  import { handleRestrictedCorsOptions, restrictedCorsHeaders } from "../_shared/cors.ts";
  import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
  import { handleHealthRequest, type HealthHandlerPorts } from "./handler.ts";
  import { createHealthHandlerPorts } from "./deps.ts";

  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
    const ports: HealthHandlerPorts = await createHealthHandlerPorts();
    return handleHealthRequest(req, ports);
  });
  ```

  `createHealthHandlerPorts` lives in `deps.ts` (Task 4) and returns the ports wired to the
  service-role client, `verifyCronOrAdmin`, `runHealthChunk`, the lease RPCs and the
  `ai_provider_health` read.

- [ ] **Step 5: Run and see it pass**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/ai-provider-health/ supabase/functions/_shared/aiProviderHealth.test.ts`

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git commit -m "feat(admin-ai): one cron-or-admin endpoint for the provider health run" -- supabase/functions/ai-provider-health/handler.ts supabase/functions/ai-provider-health/handler.test.ts supabase/functions/ai-provider-health/index.ts
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 7: The admin alert when a provider degrades

**Files:**
- Create: `supabase/functions/_shared/aiProviderAlert.ts`
- Test: `supabase/functions/_shared/aiProviderAlert.test.ts`
- Modify: `supabase/functions/ai-provider-health/deps.ts` (wire the alert in)
- Modify: `supabase/functions/ai-provider-health/run.test.ts` (the alert cases)

**Interfaces — Consumes:** `claim_ai_provider_health_notifications` and
`mark_ai_provider_health_notified` from Task 1; `DegradedProvider` from
`_shared/aiProviderHealth.ts` (Task 2).

**Interfaces — Produces:**
- `export function buildAlertTitle(p: DegradedProvider): string`
- `export function buildAlertMessage(p: DegradedProvider): string`
- `export function alertRowsToDegraded(rows: Array<Record<string, unknown>>): DegradedProvider[]`

- [ ] **Step 1: Write the failing tests** (`supabase/functions/_shared/aiProviderAlert.test.ts`):

  ```ts
  import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
  import { alertRowsToDegraded, buildAlertMessage, buildAlertTitle } from "./aiProviderAlert.ts";

  Deno.test("the title names the provider", () => {
    assertEquals(
      buildAlertTitle({ provider_code: "claude", auth_method: "oauth", status: "needs_relogin", reason: null }),
      "AI provider needs attention: claude",
    );
  });

  Deno.test("the message names the credential kind and the sanitized reason", () => {
    assertEquals(
      buildAlertMessage({ provider_code: "claude", auth_method: "oauth", status: "needs_relogin", reason: "The subscription sign-in expired. Sign in again." }),
      "claude (subscription) needs re-login: The subscription sign-in expired. Sign in again.",
    );
  });

  Deno.test("a null reason still produces a readable message", () => {
    const message = buildAlertMessage({ provider_code: "openrouter", auth_method: "api_key", status: "failed", reason: null });
    assert(message.includes("openrouter"));
    assert(message.includes("API key"));
  });

  Deno.test("the claim rows become degraded providers", () => {
    const rows = alertRowsToDegraded([
      { provider_code: "claude", auth_method: "oauth", status: "needs_relogin", reason: "x", previous_status: "connected" },
    ]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].auth_method, "oauth");
  });
  ```

- [ ] **Step 2: Run and see it fail**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderAlert.test.ts`

  Expected: FAIL — `Cannot find module "./aiProviderAlert.ts"`.

- [ ] **Step 3: Implement** `supabase/functions/_shared/aiProviderAlert.ts`.

  ```ts
  // The admin alert for a provider that just degraded.
  //
  // WHY admin_notifications
  // It is the existing admin notification mechanism: the admin UI writes it, the bell reads
  // it, /admin/notifications lists it. Reusing it adds no table, no channel and no UI.
  //
  // WHY the message is so plain
  // admin_notifications is a broadcast to every signed-in user, so the message carries no
  // secret and no user data — a provider code, a credential kind and a sanitized sentence.

  import type { DegradedProvider } from "./aiProviderHealth.ts";

  const CREDENTIAL_LABEL: Record<DegradedProvider["auth_method"], string> = {
    api_key: "API key",
    oauth: "subscription",
  };

  export function buildAlertTitle(p: DegradedProvider): string {
    return `AI provider needs attention: ${p.provider_code}`;
  }

  export function buildAlertMessage(p: DegradedProvider): string {
    const state = p.status === "needs_relogin" ? "needs re-login" : "failed";
    const reason = p.reason ? `: ${p.reason}` : ".";
    return `${p.provider_code} (${CREDENTIAL_LABEL[p.auth_method]}) ${state}${reason}`;
  }

  export function alertRowsToDegraded(rows: Array<Record<string, unknown>>): DegradedProvider[] {
    return rows.map((row) => ({
      provider_code: String(row.provider_code ?? ""),
      auth_method: row.auth_method === "oauth" ? "oauth" : "api_key",
      status: row.status === "needs_relogin" ? "needs_relogin" : "failed",
      reason: typeof row.reason === "string" ? row.reason : null,
    }));
  }
  ```

- [ ] **Step 4: Wire the alert into the runner.** The two ports already exist on
  `HealthRunPorts` from Task 4 (`claimAlerts`, `sendAlert`); implement them in `deps.ts`:

  1. `claimAlerts` calls `claim_ai_provider_health_notifications` with a fresh claim token
     and maps the rows with `alertRowsToDegraded`;
  2. `sendAlert` inserts an `admin_notifications` row with `buildAlertTitle` /
     `buildAlertMessage`;
  3. after the alerts are sent, the runner calls `mark_ai_provider_health_notified` with the
     same claim token.

  The runner calls `ports.claimAlerts(claimToken)` after the chunk's results are written,
  sends each claimed row with `ports.sendAlert(row)`, and then closes the claim.

  A failed insert must not fail the run: catch it, log
  `event: 'ai_provider_alert_failed'`, and leave the claim open so the next run re-claims
  the row after 10 minutes.

  Add the alert case to `run.test.ts` (the port receives a `DegradedProvider`, so the title is
  built inside `sendAlert`):

  ```ts
  Deno.test("a provider that just degraded produces one admin alert", async () => {
    const alerts: string[] = [];
    const { ports } = fakePorts({
      probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("boom"); },
      claimAlerts: async () => ([
        { provider_code: "openai", auth_method: "api_key", status: "failed", reason: "Invalid API key", previous_status: "connected" },
      ]),
      sendAlert: async (row) => { alerts.push(buildAlertTitle(row)); },
    });
    await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
    assertEquals(alerts.length, 1);
    assert(alerts[0].includes("openai"));
  });
  ```

  Add `claimAlerts` and `sendAlert` to `HealthRunPorts` (both optional in the fake so the
  earlier tests keep working — give them defaults that return `[]` and do nothing).

- [ ] **Step 5: Run and see it pass**

  Run:
  `deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderAlert.test.ts supabase/functions/ai-provider-health/run.test.ts`

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git commit -m "feat(admin-ai): alert admins when a provider degrades" -- supabase/functions/_shared/aiProviderAlert.ts supabase/functions/_shared/aiProviderAlert.test.ts supabase/functions/ai-provider-health/deps.ts supabase/functions/ai-provider-health/run.test.ts
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 8: The frontend data layer

**Files:**
- Create: `src/features/ai-providers/infrastructure/aiProviderHealthGateway.ts`
- Create: `src/hooks/ai-config/useAiProviderHealth.ts`
- Modify: `src/hooks/ai-config/types.ts`

**Interfaces — Consumes:** the `ai-provider-health` edge function from Task 6.

**Interfaces — Produces:**
- `src/features/ai-providers/infrastructure/aiProviderHealthGateway.ts`:
  - `export type ProviderHealthStatus = 'connected' | 'failed' | 'needs_relogin'`
  - `export interface ProviderHealthRow { provider_code: string; auth_method: AiAuthMethod; display_name: string; status: ProviderHealthStatus; reason: string | null; models_added: number | null; models_updated: number | null; models_deactivated: number | null; latency_ms: number | null; checked_at: string }`
  - `export interface ProviderHealthChunk { run_id: string; chunk: number; done: boolean; next_chunk: number | null; results: ProviderHealthRow[]; summary: { total: number; connected: number; failed: number; needs_relogin: number } }`
  - `export async function fetchProviderHealth(): Promise<ProviderHealthRow[]>`
  - `export async function runProviderHealthChunk(chunk: number, runToken: string): Promise<ProviderHealthChunk>`
- `src/hooks/ai-config/useAiProviderHealth.ts`:
  - `export function useProviderHealthStatus(): { data: ProviderHealthRow[] | undefined; isLoading: boolean }`
  - `export function useRunProviderHealth(): { run: () => Promise<ProviderHealthRow[]>; isRunning: boolean; error: string | null }`
- `src/hooks/ai-config/types.ts` gains the re-exported health types.

- [ ] **Step 1: Write the failing tests**
  (`src/hooks/ai-config/useAiProviderHealth.test.tsx`):

  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { renderHook, waitFor } from '@testing-library/react';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { useProviderHealthStatus, useRunProviderHealth } from './useAiProviderHealth';

  const invoke = vi.fn();
  vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );

  describe('useAiProviderHealth', () => {
    beforeEach(() => invoke.mockReset());

    it('reads the stored results without running anything', async () => {
      invoke.mockResolvedValue({ data: { results: [{ provider_code: 'claude', auth_method: 'api_key', status: 'connected' }] }, error: null });
      const { result } = renderHook(() => useProviderHealthStatus(), { wrapper });
      await waitFor(() => expect(result.current.data?.length).toBe(1));
      expect(invoke.mock.calls[0][1].body.action).toBe('status');
    });

    it('walks the chunks until the server says it is done', async () => {
      invoke
        .mockResolvedValueOnce({ data: { run_id: 'r', chunk: 1, done: false, next_chunk: 2, results: [], summary: {} }, error: null })
        .mockResolvedValueOnce({ data: { run_id: 'r', chunk: 2, done: true, next_chunk: null, results: [{ provider_code: 'xai', auth_method: 'api_key', status: 'failed' }], summary: {} }, error: null });
      const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
      const rows = await result.current.run();
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(rows.length).toBe(1);
    });

    it('reports a busy server without throwing', async () => {
      invoke.mockResolvedValue({ data: { error: 'busy' }, error: null });
      const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
      await result.current.run();
      await waitFor(() => expect(result.current.error).toBe('busy'));
    });
  });
  ```

- [ ] **Step 2: Run and see it fail**

  Run: `npx vitest run src/hooks/ai-config/useAiProviderHealth.test.tsx`

  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement.**

  `aiProviderHealthGateway.ts` calls the edge function through the existing client:

  ```ts
  import { supabase } from '@/integrations/supabase/client';
  import type { AiAuthMethod } from '@/hooks/ai-config/types';

  export async function fetchProviderHealth(): Promise<ProviderHealthRow[]> {
    const { data, error } = await supabase.functions.invoke('ai-provider-health', { body: { action: 'status' } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return (data?.results ?? []) as ProviderHealthRow[];
  }

  export async function runProviderHealthChunk(chunk: number, runToken: string): Promise<ProviderHealthChunk> {
    const { data, error } = await supabase.functions.invoke('ai-provider-health', {
      body: { action: 'run', scope: 'manual', chunk, run_token: runToken },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data as ProviderHealthChunk;
  }
  ```

  `useAiProviderHealth.ts` exposes a query for the stored rows and a mutation that walks the
  chunks. The run token is generated **once per run** so the server derives one run id (and
  one lease holder) for the whole click:

  ```ts
  const runToken = crypto.randomUUID();
  ```

  The mutation returns the merged rows of every chunk and never throws on a `busy` answer:
  it stores the message in `error` so the button can show it.

- [ ] **Step 4: Run and see it pass**

  Run: `npx vitest run src/hooks/ai-config/useAiProviderHealth.test.tsx`

  Expected: all PASS.

- [ ] **Step 5: Type-check**

  Run: `npx tsc -p tsconfig.app.json --noEmit`

  Expected: 0 errors.

- [ ] **Step 6: Commit**

  ```bash
  git commit -m "feat(admin-ai): the frontend data layer for the provider health run" -- src/features/ai-providers/infrastructure/aiProviderHealthGateway.ts src/hooks/ai-config/useAiProviderHealth.ts src/hooks/ai-config/types.ts src/hooks/ai-config/useAiProviderHealth.test.tsx
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 9: The one button and the result table

**Files:**
- Create: `src/components/admin/settings/ai/ProviderHealthButton.tsx`
- Test: `src/components/admin/settings/ai/ProviderHealthButton.test.tsx`
- Modify: `src/components/admin/settings/ai/AiProvidersCard.tsx` (mount the new button)
- Delete: `src/components/admin/settings/ai/SyncAllButton.tsx`
- Delete: `src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx`

**Interfaces — Consumes:** the hooks from Task 8, the i18n namespace from Task 10.

**Interfaces — Produces:**
- `export function ProviderHealthButton(): JSX.Element` — the button plus the result table.
  It takes no props: the target list comes from the server.

- [ ] **Step 1: Write the failing tests**
  (`src/components/admin/settings/ai/ProviderHealthButton.test.tsx`):

  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen, fireEvent, waitFor } from '@testing-library/react';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { ProviderHealthButton } from './ProviderHealthButton';

  const invoke = vi.fn();
  vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
  const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
  vi.mock('sonner', () => ({ toast }));
  const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

  const chunk = (results: unknown[], done = true) => ({
    data: { run_id: 'r', chunk: 1, done, next_chunk: done ? null : 2, results, summary: { total: results.length, connected: 1, failed: 1, needs_relogin: 0 } },
    error: null,
  });

  describe('ProviderHealthButton', () => {
    beforeEach(() => { invoke.mockReset(); toast.error.mockReset(); });

    it('shows one row per provider with the status and the model counts', async () => {
      invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
        body.action === 'status'
          ? Promise.resolve({ data: { results: [] }, error: null })
          : Promise.resolve(chunk([
            { provider_code: 'claude', auth_method: 'api_key', display_name: 'Claude', status: 'connected', reason: null, models_added: 2, models_updated: 1, models_deactivated: 0, latency_ms: 10, checked_at: '2026-11-13T00:00:00Z' },
            { provider_code: 'openrouter', auth_method: 'api_key', display_name: 'OpenRouter', status: 'failed', reason: 'Rate limit exceeded', models_added: null, models_updated: null, models_deactivated: null, latency_ms: 20, checked_at: '2026-11-13T00:00:00Z' },
          ])));
      render(wrap(<ProviderHealthButton />));
      fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
      await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(2));
      expect(screen.getByText('Rate limit exceeded')).toBeTruthy();
      expect(screen.getByText('2')).toBeTruthy();
    });

    it('shows needs re-login for an expired subscription and never a count for it', async () => {
      invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
        body.action === 'status'
          ? Promise.resolve({ data: { results: [] }, error: null })
          : Promise.resolve(chunk([
            { provider_code: 'claude', auth_method: 'oauth', display_name: 'Claude', status: 'needs_relogin', reason: 'The subscription sign-in expired. Sign in again.', models_added: null, models_updated: null, models_deactivated: null, latency_ms: 5, checked_at: '2026-11-13T00:00:00Z' },
          ])));
      render(wrap(<ProviderHealthButton />));
      fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
      await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(1));
      expect(screen.getByText(/needs re-login/i)).toBeTruthy();
    });

    it('keeps going after one provider fails', async () => {
      invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
        body.action === 'status'
          ? Promise.resolve({ data: { results: [] }, error: null })
          : Promise.resolve(chunk([
            { provider_code: 'openai', auth_method: 'api_key', display_name: 'OpenAI', status: 'failed', reason: 'Invalid API key', models_added: null, models_updated: null, models_deactivated: null, latency_ms: 5, checked_at: 't' },
            { provider_code: 'xai', auth_method: 'api_key', display_name: 'xAI', status: 'connected', reason: null, models_added: 3, models_updated: 0, models_deactivated: 1, latency_ms: 5, checked_at: 't' },
          ])));
      render(wrap(<ProviderHealthButton />));
      fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
      await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(2));
    });

    it('says the daily check is running when the server is busy', async () => {
      invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
        body.action === 'status'
          ? Promise.resolve({ data: { results: [] }, error: null })
          : Promise.resolve({ data: { error: 'busy' }, error: null }));
      render(wrap(<ProviderHealthButton />));
      fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(String(toast.error.mock.calls[0][0])).toMatch(/daily check is running/i);
    });
  });
  ```

- [ ] **Step 2: Run and see it fail**

  Run: `npx vitest run src/components/admin/settings/ai/ProviderHealthButton.test.tsx`

  Expected: FAIL — the component does not exist.

- [ ] **Step 3: Implement** `src/components/admin/settings/ai/ProviderHealthButton.tsx`.

  - The button label is the i18n key `adminai:checkAndSyncAll` with the English default
    `"Check & sync all providers"`.
  - The button is **disabled while a run is in flight** and shows the i18n key
    `adminai:running` (*"Checking providers…"*). A second click must not start a second
    run.
  - On click: `run()` from `useRunProviderHealth`, then merge the returned rows into the
    table state.
  - The table has one `<tr data-testid="provider-health-row">` per row with the columns
    **Provider**, **Credential**, **Status**, **Reason**, **Added**, **Updated**,
    **Switched off**, **Checked**.
  - The status cell renders one of `adminai:statusConnected` / `adminai:statusFailed` /
    `adminai:statusNeedsRelogin`.
  - The credential cell renders `adminai:credentialApiKey` or `adminai:credentialOauth`.
  - The count cells render `—` when the count is `null` (the provider was not synced) and
    the number otherwise. **Never `0` for a provider that was not synced.**
  - The "Checked" cell renders the `checked_at` timestamp, with the i18n key
    `adminai:lastChecked` (*"Last checked {{time}}"*).
  - When there is no row at all, the table shows the i18n key `adminai:empty` (*"No provider
    has been checked yet."*).
  - On a `busy` error the button shows `adminai:busy` — *"The daily check is running. Try
    again in a few minutes."* — and the stored table stays visible.
  - On success the button shows the summary from the last chunk
    (`adminai:summary` — *"3 providers checked · 2 connected · 1 failed"*).
  - The component also renders the stored rows on mount (from `useProviderHealthStatus`),
    so the admin sees the last known state before clicking.

- [ ] **Step 4: Mount it in the card.** In
  `src/components/admin/settings/ai/AiProvidersCard.tsx`:

  - delete `import { SyncAllButton } from './SyncAllButton';` and add
    `import { ProviderHealthButton } from './ProviderHealthButton';`;
  - replace the `<SyncAllButton providerCodes={…} />` block (lines ~176-180) with
    `<ProviderHealthButton />`;
  - leave `isOAuthProvider` and every other line of the card untouched.

- [ ] **Step 5: Delete the old button and its test.**

  `rm -- src/components/admin/settings/ai/SyncAllButton.tsx src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx`

  Nothing else imports `SyncAllButton` — verify with
  `grep -rn "SyncAllButton" src/` before deleting.

- [ ] **Step 6: Run and see it pass**

  Run:
  `npx vitest run src/components/admin/settings/ai/ProviderHealthButton.test.tsx src/components/admin/settings/ai/__tests__/SyncModelsButton.test.tsx src/hooks/ai-config/useAiProviderHealth.test.tsx`

  Expected: all PASS.

- [ ] **Step 7: Type-check**

  Run: `npx tsc -p tsconfig.app.json --noEmit`

  Expected: 0 errors.

- [ ] **Step 8: Commit**

  ```bash
  git commit -m "feat(admin-ai): one button that tests every provider and syncs the ones that pass" -- src/components/admin/settings/ai/ProviderHealthButton.tsx src/components/admin/settings/ai/ProviderHealthButton.test.tsx src/components/admin/settings/ai/AiProvidersCard.tsx src/components/admin/settings/ai/SyncAllButton.tsx src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 10: The Arabic copy and the namespace registration

**Files:**
- Create: `src/i18n/locales/ar/adminai.json`
- Modify: `src/i18n/index.ts`

**Interfaces — Produces:** the `adminai` namespace, registered in `src/i18n/index.ts` and
filled in `src/i18n/locales/ar/adminai.json`.

**The keys** (the English default is the call-site default; the Arabic bundle carries the
same keys):

| Key | English default |
|---|---|
| `checkAndSyncAll` | `Check & sync all providers` |
| `running` | `Checking providers…` |
| `statusConnected` | `Connected` |
| `statusFailed` | `Failed` |
| `statusNeedsRelogin` | `Needs re-login` |
| `columnProvider` | `Provider` |
| `columnCredential` | `Credential` |
| `columnStatus` | `Status` |
| `columnReason` | `Reason` |
| `columnAdded` | `Added` |
| `columnUpdated` | `Updated` |
| `columnDeactivated` | `Switched off` |
| `columnChecked` | `Checked` |
| `credentialApiKey` | `API key` |
| `credentialOauth` | `Subscription` |
| `summary` | `{{total}} providers checked · {{connected}} connected · {{failed}} failed` |
| `busy` | `The daily check is running. Try again in a few minutes.` |
| `lastChecked` | `Last checked {{time}}` |
| `empty` | `No provider has been checked yet.` |

- [ ] **Step 1: Write the Arabic bundle** `src/i18n/locales/ar/adminai.json` with exactly
  those keys. Egyptian colloquial Arabic, matching the tone of the neighbouring bundles
  (`src/i18n/locales/ar/common.json`). Keep the interpolation placeholders identical to the
  English defaults.

- [ ] **Step 2: Register the namespace** in `src/i18n/index.ts`:

  - add `import adminai from "./locales/ar/adminai.json";` next to the other imports;
  - add `"adminai"` to the `ns: [...]` array;
  - add `adminai: {}` to the `en` resources;
  - add `adminai,` to the `ar` resources.

- [ ] **Step 3: Use the keys** in `ProviderHealthButton.tsx` with
  `const { t } = useTranslation('adminai');` and the English copy as the default, e.g.
  `t('checkAndSyncAll', 'Check & sync all providers')`.

- [ ] **Step 4: Run the i18n gate**

  Run: `npm run check:i18n`

  Expected: `OK [adminai]: N key(s) verified`, and no `MISSING`, `ORPHAN` or `UNREGISTERED`
  line anywhere. A key that is defined but unused is an orphan and fails the gate — remove
  it from the bundle instead of weakening the gate.

- [ ] **Step 5: Run the frontend tests**

  Run: `npx vitest run src/components/admin/settings/ai/ProviderHealthButton.test.tsx src/i18n/__tests__/i18n.test.ts`

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git commit -m "feat(admin-ai): Arabic copy for the provider health panel" -- src/i18n/locales/ar/adminai.json src/i18n/index.ts src/components/admin/settings/ai/ProviderHealthButton.tsx
  ```

  End the message with the trailer:
  `Co-Authored-By: MiniMax <noreply@minimax.io>`.

---

### Task 11: Full gates and the deploy note

- [ ] **Step 1:** `npx tsc -p tsconfig.app.json --noEmit`. Expected: 0 errors.
- [ ] **Step 2:** `npx eslint` on every changed `src/` file. Expected: 0 errors.
- [ ] **Step 3:** `npx vitest run`. Expected: all pass. Report any pre-existing failure with
  its name as pre-existing; do not fix unrelated tests.
- [ ] **Step 4:**
  ```bash
  deno test --no-config --allow-env --allow-read --allow-net --no-check --node-modules-dir=none supabase/functions/_shared/aiProviderHealth.test.ts supabase/functions/_shared/aiProviderTest.test.ts supabase/functions/_shared/aiProviderAlert.test.ts supabase/functions/_shared/modelCatalogSync.test.ts supabase/functions/_shared/modelCatalogSyncRun.test.ts supabase/functions/ai-provider-health/ supabase/functions/ai-config/
  ```
  Expected: all pass. Run this **before** vitest in the same session, never after.
- [ ] **Step 5:** `npm run check:i18n`. Expected: no drift.
- [ ] **Step 6:** `bash scripts/db-harness.sh`, if a local DB is available. Otherwise state
  that it was not run.
- [ ] **Step 7:** `git status --short`. Only the files in the file map may be modified, plus
  `graphify-out/`, which is never committed.
- [ ] **Step 8:** **Deploy** — the migration and the new edge function must be live before the
  cron fires. Per `CLAUDE.md`:
  - apply `supabase/migrations/20261113180000_ai_provider_health.sql` to the self-hosted
    stack;
  - redeploy `ai-provider-health` **and** `ai-config` (Task 3 changed it) through
    `ssh-contabo-mcp`: copy the changed files into
    `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify
    the SHA256 hashes, then `docker compose up -d --no-deps functions` from the stack dir
    (see `docs/runbooks/deploy-edge-function.md`);
  - **do not** run `npx supabase functions deploy` — that targets Supabase Cloud;
  - confirm the four cron jobs exist: `SELECT jobname, schedule FROM cron.job WHERE
    jobname LIKE 'ai-provider-health%';`
  - the frontend deploys automatically when `main` is pushed.

---

## Out of scope (do not implement)

- Redesigning the API/Auth grouping in the model selectors, or the login dialog's model list
  — the concurrent branch owns that (spec §8).
- Changing `ai_providers.auth_type` for `claude` or `openai`.
- Migrating API-key calls to pi-ai.
- User BYOK providers and `UserAiModelOverrides`.
- Turning the `feature_ai_provider_oauth` flag on.
- An admin-only email channel for the alert (open question 1 in the spec).
- A provider row for a provider that has no configured credential.
- GitHub Copilot.
- Pushing the branch or opening a PR.
