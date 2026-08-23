# Unified Plan Quotas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every plan entitlement resolve from `subscription_plans`, so an admin edit on `/admin/plan-quotas` changes real enforcement everywhere, and delete the eight hardcoded copies of the quota table.

**Architecture:** One SQL function, `effective_user_quotas(user_id)`, becomes the single arbiter: `COALESCE(user_quotas.max_X, plan.max_X, free_literal)`. Every reader (client hook, DB trigger, RPCs) calls it; every writer stops writing limits and instead leaves the override columns NULL so users inherit their plan. `n8n-api` separately gains a `tier_rate_limits` step in its rate-limit resolver.

**Tech Stack:** PostgreSQL 15 (self-hosted Supabase), Deno edge functions, React 18 + TypeScript + Vite, vitest, React Query.

**Spec:** `docs/specs/2026-08-23-unified-plan-quotas.md` — read it before Task 1. This plan argues from it and does not repeat its evidence.

## Global Constraints

- **Branch:** `feat/unified-plan-quotas`. Already checked out.
- **Round-1 amendments are binding.** Ten tasks carry a "Round-1 amendments (BINDING)" block from the Codex adversarial review (spec section 9). Where a block conflicts with the steps above it, **the amendment wins**. Four of the five blockers it fixes were verified against the production database.
- **TDD is not optional.** Every task follows RED then GREEN: write the test, RUN IT, and paste the actual failing output into the report before writing any implementation. A report that shows only passing output is rejected and the task is re-dispatched. "I could tell it would fail" is not a failing run.
- **Required reading:** `ARCHITECTURE.md` before touching `src/**` or `supabase/functions/**`. §11 (no raw Supabase queries in pages), §23 (migration + types rules), §24 (service role), §16 (edge errors never 5xx).
- **`-1` means unlimited** in every quota column. It is the most permissive value and wins every comparison.
- **NULL in `user_quotas.max_*` means inherit from the plan.** A non-null value is a deliberate override that wins outright, and may raise *or* lower.
- **Backfill invariant:** no user's effective limit may decrease as a result of this work.
- **Never** commit `b64.txt`, logs, backups, `.env*`, or secret files. Commit scoped: `git commit -m "..." -- <files>` (note `--` comes *after* `-m`).
- **Never** run `npx supabase functions deploy` — it targets Supabase Cloud and fails on this self-hosted stack.
- **Migrations are never applied to PRODUCTION by this plan.** Applying them to the `quota_rehearsal` throwaway database is required by Tasks 1-5. Every migration is written and rehearsed only. Production application happens in the deployment sequence of spec §6, after review.
- **Free-tier literals**, used only as last-resort fallbacks: `max_profiles=2, max_social_accounts=3, max_posts_per_month=30, max_posts_per_day=2, max_media_uploads_per_day=20`.
- Frontend tests: `npx vitest run <path>`. Full suite: `npm test`. Edge tests: `deno test --allow-all supabase/functions/n8n-api/`.

## SQL Rehearsal Harness

Tasks 1-5 verify migrations against a throwaway database inside the production container. This harness is verified working. `supabase start` is broken locally — do not attempt it.

**Create (run once, before Task 1):**

```bash
# via ssh-contabo-mcp, one exec per line - the MCP has a ~1000 char cap
docker exec postorasupabase-supabase-j8axyh-supabase-db bash -c "psql -U postgres -c 'DROP DATABASE IF EXISTS quota_rehearsal' >/dev/null; psql -U postgres -c 'CREATE DATABASE quota_rehearsal' >/dev/null; pg_dump -U postgres -d postgres --schema-only -n public -n auth -f /tmp/pa.sql; psql -U postgres -d quota_rehearsal -q -c 'CREATE EXTENSION IF NOT EXISTS vector'; psql -U postgres -d quota_rehearsal -q -f /tmp/pa.sql 2>&1 | grep -c ERROR"
```

Expect `89` errors. They are unrelated objects (workspace helper functions, pgvector-dependent tables). All six quota functions and both quota tables restore correctly — verified.

**Apply a migration under test:**

```bash
docker cp supabase/migrations/<file>.sql postorasupabase-supabase-j8axyh-supabase-db:/tmp/m.sql
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -v ON_ERROR_STOP=1 -f /tmp/m.sql
```

**Two harness gotchas, both hit during verification:**

1. `psql -c "stmt1; stmt2"` runs as **one implicit transaction** — any error rolls back the whole batch and earlier statements vanish. Use one `-c` per statement when a step must survive a later failure.
2. Inserting into `auth.users` **fires `handle_new_user_quota`**, which creates the `user_quotas` row for you. Do not insert that row yourself; `UPDATE` it instead, or you get a duplicate-key error that silently rolls back your fixtures.

**Destroy (after Task 5):**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -c "DROP DATABASE IF EXISTS quota_rehearsal"
```

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260823140000_plan_quota_columns.sql` | Add + seed the four entitlement columns on `subscription_plans` |
| `supabase/migrations/20260823140100_effective_user_quotas.sql` | The single arbiter function |
| `supabase/migrations/20260823140200_quota_readers_use_arbiter.sql` | `can_create_post` and `can_upload_media` only |
| `supabase/migrations/20260823140300_quota_writers_clear_overrides.sql` | `handle_new_user_quota`, `set_user_quotas_for_plan`, trigger writes |
| `supabase/migrations/20260823140400_backfill_user_quota_overrides.sql` | Capability-preserving NULLing of 66 live rows |
| `supabase/migrations/20260823140500_seed_n8n_tier_rate_limits.sql` | **New (A8).** Tier rows for the ten `/api/v1/*` endpoints across three plans |
| `src/hooks/usePlanQuotas.tsx` | **New.** Read/write adapter for plan entitlement columns |
| `src/hooks/__tests__/usePlanQuotas.test.tsx` | **New.** Its tests |
| `src/hooks/useQuotas.tsx` | Resolve from DB, delete `PLAN_QUOTAS` and `pickMax` |
| `src/hooks/__tests__/useQuotas.resolution.test.ts` | **New.** Resolution-order tests |
| `src/pages/admin/AdminPlanQuotas.tsx` | Repointed at `subscription_plans` via the hook |
| `src/pages/admin/AdminPlans.tsx` | Label the shared profile field |
| `src/pages/admin/AdminRateLimits.tsx` | Hide tier controls for non-enforcing endpoints |
| `supabase/functions/stripe-webhook/index.ts` | Clear overrides instead of writing plan values |
| `supabase/functions/sync-user-quotas/index.ts` | Same |
| `supabase/functions/backfill-subscription/index.ts` | Same |
| `supabase/functions/n8n-api/rateLimitConfig.ts` | Add the tier resolution step |
| `supabase/functions/n8n-api/rateLimitConfig.test.ts` | Its tests |

---

### Task 1: Plan entitlement columns

**Files:**
- Create: `supabase/migrations/20260823140000_plan_quota_columns.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `subscription_plans.max_social_accounts`, `.max_posts_per_month`, `.max_posts_per_day`, `.max_media_uploads_per_day` — all `integer NULL`. `profile_limit` is unchanged and remains the canonical profile column.

- [ ] **Step 1: Create the rehearsal database**

Run the harness creation command above. Expect `89`.

- [ ] **Step 2: Write the assertion that fails**

Save as `/tmp/t1.sql` on the container (via `docker cp` of a local scratch file):

```sql
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM information_schema.columns
          WHERE table_name='subscription_plans'
            AND column_name IN ('max_social_accounts','max_posts_per_month',
                                'max_posts_per_day','max_media_uploads_per_day')) = 4,
    'expected 4 new entitlement columns';
  ASSERT (SELECT max_posts_per_day FROM subscription_plans WHERE slug='pro') = 30,
    'pro must seed to 30 posts/day';
  ASSERT (SELECT max_media_uploads_per_day FROM subscription_plans WHERE slug='business') = -1,
    'business uploads must be unlimited';
  RAISE NOTICE 'TASK1 PASS';
END $$;
```

- [ ] **Step 3: Run it to verify it fails**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -f /tmp/t1.sql
```

Expected: `ERROR: column "max_social_accounts" does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- Plan entitlements become database-backed so /admin/plan-quotas can edit them.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R1).
--
-- profile_limit is deliberately NOT renamed to max_profiles: it is read by the
-- public pricing page (PlanCard.tsx, PlanComparison.tsx), useSubscription,
-- useSubscriptionPlans and AdminUsers. It stays the canonical profile column and
-- these four join it.

ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS max_social_accounts       integer,
  ADD COLUMN IF NOT EXISTS max_posts_per_month       integer,
  ADD COLUMN IF NOT EXISTS max_posts_per_day         integer,
  ADD COLUMN IF NOT EXISTS max_media_uploads_per_day integer;

COMMENT ON COLUMN public.subscription_plans.max_posts_per_day IS
  '-1 = unlimited. Resolved through effective_user_quotas(); never read directly.';

-- Seed guarded on IS NULL: a replay converges a pristine row onto this baseline
-- and silently skips any row an admin has since tuned. Same pristineness
-- pattern as 20260823120000_unify_rate_limits.sql.
UPDATE public.subscription_plans SET
  max_social_accounts       = 3,
  max_posts_per_month       = 30,
  max_posts_per_day         = 2,
  max_media_uploads_per_day = 20
WHERE slug = 'free' AND max_posts_per_day IS NULL;

UPDATE public.subscription_plans SET
  max_social_accounts       = 30,
  max_posts_per_month       = 500,
  max_posts_per_day         = 30,
  max_media_uploads_per_day = -1
WHERE slug = 'pro' AND max_posts_per_day IS NULL;

UPDATE public.subscription_plans SET
  max_social_accounts       = -1,
  max_posts_per_month       = -1,
  max_posts_per_day         = -1,
  max_media_uploads_per_day = -1
WHERE slug = 'business' AND max_posts_per_day IS NULL;
```

- [ ] **Step 5: Seed plan rows in the rehearsal DB, then apply and re-run**

The schema-only dump leaves `subscription_plans` empty, so seed the three rows first:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "INSERT INTO subscription_plans (name,slug,profile_limit,sort_order) VALUES ('Free','free',2,1),('Pro','pro',15,2),('Business','business',-1,3)"
```

Then `docker cp` the migration and apply it, then re-run `/tmp/t1.sql`.
Expected: `NOTICE: TASK1 PASS`.

- [ ] **Step 6: Verify the replay guard**

Apply the same migration a second time, then:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "UPDATE subscription_plans SET max_posts_per_day=999 WHERE slug='pro'"
```

Apply a third time and assert pro is still `999`. Expected: `999` — the guard skipped the tuned row.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(db): add plan entitlement columns to subscription_plans" -- supabase/migrations/20260823140000_plan_quota_columns.sql
```

---

**Round-1 amendments (BINDING — override the steps above where they conflict).**

*A1 — drop the `user_quotas` defaults.* Add to this migration, before the seed:

```sql
-- Omitted INSERT columns take these defaults (2/4/2/20/20), which would make every
-- new row a pinned override instead of inheriting its plan. NULL must mean inherit.
ALTER TABLE public.user_quotas
  ALTER COLUMN max_profiles              DROP DEFAULT,
  ALTER COLUMN max_social_accounts       DROP DEFAULT,
  ALTER COLUMN max_posts_per_month       DROP DEFAULT,
  ALTER COLUMN max_posts_per_day         DROP DEFAULT,
  ALTER COLUMN max_media_uploads_per_day DROP DEFAULT;
```

Add an assertion: after this migration, `INSERT INTO user_quotas (user_id) VALUES (<uuid>)`
leaves all five limit columns NULL.

*A15 — seed each column independently.* Replace the three whole-row-guarded `UPDATE`
statements with per-column `COALESCE`, so a partially-seeded row is repaired and an
admin-edited column is preserved:

```sql
UPDATE public.subscription_plans SET
  max_social_accounts       = COALESCE(max_social_accounts, 3),
  max_posts_per_month       = COALESCE(max_posts_per_month, 30),
  max_posts_per_day         = COALESCE(max_posts_per_day, 2),
  max_media_uploads_per_day = COALESCE(max_media_uploads_per_day, 20)
WHERE slug = 'free';
```

Same shape for `pro` (30/500/30/-1) and `business` (-1/-1/-1/-1). Step 6's replay check
becomes two cases: (a) edit `max_social_accounts` to 99 while `max_posts_per_day` is NULL,
replay, assert 99 survives **and** day is now seeded; (b) populate day, NULL accounts,
replay, assert accounts is seeded.

*A6 — owner-scoped read policy.* The public policy on `subscription_plans` is
`(is_active = true)` — verified on prod. A subscriber on a deactivated plan cannot read
their own entitlements, while the arbiter still can. Add:

```sql
CREATE POLICY "Users can view their own active plan"
  ON public.subscription_plans FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_subscriptions us
    WHERE us.user_id = auth.uid() AND us.status = 'active' AND us.plan_id = subscription_plans.id
  ));
```

The existing active-only public policy is unchanged.

---

### Task 2: The arbiter — `effective_user_quotas()`

**Files:**
- Create: `supabase/migrations/20260823140100_effective_user_quotas.sql`

**Interfaces:**
- Consumes: the four columns from Task 1, plus `subscription_plans.profile_limit`.
- Produces: `public.effective_user_quotas(p_user_id uuid) RETURNS TABLE (max_profiles integer, max_social_accounts integer, max_posts_per_month integer, max_posts_per_day integer, max_media_uploads_per_day integer)`. Exactly one row, always. Tasks 3 and 4 call it.

- [ ] **Step 1: Write the failing assertions**

Save as `/tmp/t2.sql`:

```sql
DO $$
DECLARE
  u uuid := '22222222-2222-2222-2222-222222222222';
  v record;
BEGIN
  -- fixture: a user with no subscription and no override
  INSERT INTO auth.users (id, instance_id, aud, role, email)
  VALUES (u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','t2@t.io')
  ON CONFLICT (id) DO NOTHING;
  -- handle_new_user_quota already created the row; clear it to test inheritance
  UPDATE user_quotas SET max_posts_per_day = NULL, max_profiles = NULL,
    max_social_accounts = NULL, max_posts_per_month = NULL,
    max_media_uploads_per_day = NULL WHERE user_id = u;

  SELECT * INTO v FROM effective_user_quotas(u);
  ASSERT v.max_posts_per_day = 2,  'no sub + no override must inherit free 2/day';
  ASSERT v.max_profiles = 2,       'no sub + no override must inherit free 2 profiles';

  -- an override lowers
  UPDATE user_quotas SET max_posts_per_day = 1 WHERE user_id = u;
  SELECT * INTO v FROM effective_user_quotas(u);
  ASSERT v.max_posts_per_day = 1, 'override must win and may lower';

  -- an override raises
  UPDATE user_quotas SET max_posts_per_day = 999 WHERE user_id = u;
  SELECT * INTO v FROM effective_user_quotas(u);
  ASSERT v.max_posts_per_day = 999, 'override must win and may raise';

  -- unlimited propagates from the plan
  UPDATE user_quotas SET max_posts_per_day = NULL WHERE user_id = u;
  INSERT INTO user_subscriptions (user_id, plan_id, status)
  SELECT u, id, 'active' FROM subscription_plans WHERE slug='business';
  SELECT * INTO v FROM effective_user_quotas(u);
  ASSERT v.max_posts_per_day = -1, 'business plan must give unlimited';

  -- a user with no user_quotas row at all still resolves
  DELETE FROM user_quotas WHERE user_id = u;
  SELECT * INTO v FROM effective_user_quotas(u);
  ASSERT v.max_posts_per_day = -1, 'missing quota row must still resolve the plan';

  RAISE NOTICE 'TASK2 PASS';
END $$;
```

- [ ] **Step 2: Run it to verify it fails**

Expected: `ERROR: function effective_user_quotas(uuid) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- The single arbiter for "what is this user allowed to do".
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R2).
--
-- Resolution, per column:  user override -> plan entitlement -> free literal.
--
-- NULL in user_quotas.max_* means INHERIT. A non-null value is a deliberate
-- admin override and wins outright, in both directions - it may lower a user
-- below their plan, which is how an abusive account gets capped.
--
-- The trailing free literals are a last-resort guard for a missing or unseeded
-- 'free' plan row. They are unreachable in normal operation and are the ONLY
-- hardcoded quota numbers left in the system.

CREATE OR REPLACE FUNCTION public.effective_user_quotas(p_user_id uuid)
RETURNS TABLE (
  max_profiles              integer,
  max_social_accounts       integer,
  max_posts_per_month       integer,
  max_posts_per_day         integer,
  max_media_uploads_per_day integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH plan AS (
    SELECT sp.profile_limit, sp.max_social_accounts, sp.max_posts_per_month,
           sp.max_posts_per_day, sp.max_media_uploads_per_day
    FROM public.subscription_plans sp
    WHERE sp.id = (
      SELECT us.plan_id FROM public.user_subscriptions us
      WHERE us.user_id = p_user_id AND us.status = 'active'
      ORDER BY us.current_period_end DESC NULLS LAST
      LIMIT 1
    )
    UNION ALL
    -- Fallback branch: no active subscription -> the free plan row.
    SELECT sp.profile_limit, sp.max_social_accounts, sp.max_posts_per_month,
           sp.max_posts_per_day, sp.max_media_uploads_per_day
    FROM public.subscription_plans sp
    WHERE sp.slug = 'free'
      AND NOT EXISTS (
        SELECT 1 FROM public.user_subscriptions us
        WHERE us.user_id = p_user_id AND us.status = 'active'
      )
    LIMIT 1
  ),
  override AS (
    SELECT uq.max_profiles, uq.max_social_accounts, uq.max_posts_per_month,
           uq.max_posts_per_day, uq.max_media_uploads_per_day
    FROM public.user_quotas uq
    WHERE uq.user_id = p_user_id
  )
  SELECT
    COALESCE((SELECT o.max_profiles FROM override o),
             (SELECT p.profile_limit FROM plan p), 2),
    COALESCE((SELECT o.max_social_accounts FROM override o),
             (SELECT p.max_social_accounts FROM plan p), 3),
    COALESCE((SELECT o.max_posts_per_month FROM override o),
             (SELECT p.max_posts_per_month FROM plan p), 30),
    COALESCE((SELECT o.max_posts_per_day FROM override o),
             (SELECT p.max_posts_per_day FROM plan p), 2),
    COALESCE((SELECT o.max_media_uploads_per_day FROM override o),
             (SELECT p.max_media_uploads_per_day FROM plan p), 20);
$$;

COMMENT ON FUNCTION public.effective_user_quotas(uuid) IS
  'Single source of truth for a user''s limits: override -> plan -> free literal. -1 = unlimited.';

REVOKE ALL ON FUNCTION public.effective_user_quotas(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_user_quotas(uuid) TO authenticated, service_role;
```

- [ ] **Step 4: Apply and re-run the assertions**

Expected: `NOTICE: TASK2 PASS`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(db): add effective_user_quotas arbiter" -- supabase/migrations/20260823140100_effective_user_quotas.sql
```

---

**Round-1 amendments (BINDING).**

*A14 — grant to `service_role` only.* Replace the GRANT line with:

```sql
REVOKE ALL ON FUNCTION public.effective_user_quotas(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_user_quotas(uuid) TO service_role;
```

Rationale: no client path calls this RPC, and the SQL readers that do are
`SECURITY DEFINER` executing as the definer, so they need no grant. Granting
`authenticated` would let any user read any other user's limits by passing their uuid
(ARCHITECTURE.md §23 requires caller/resource scope validation). Revoking is safer than
an `auth.uid()` guard, which would break the post trigger — that runs with
`auth.uid()` NULL.

*A5 — deterministic subscription selection.* The active-subscription subquery must read:

```sql
      ORDER BY us.current_period_end DESC NULLS LAST, us.created_at DESC, us.id DESC
```

There is no uniqueness constraint on active subscriptions (verified: 0 duplicates today,
but nothing prevents them). Without the full tie-breaker two active rows with equal or
NULL `current_period_end` select nondeterministically, letting the arbiter and the
backfill disagree.

*A13 — added assertions.* Add to `/tmp/t2.sql`: a user whose plan row has NULL columns
resolves to the free literals; and `SELECT count(*) FROM effective_user_quotas(u)` is
exactly 1 for a user with no subscription, one subscription, and two active subscriptions.

---

### Task 3: Quota RPCs resolve through the arbiter

**Files:**
- Create: `supabase/migrations/20260823140200_quota_readers_use_arbiter.sql`

**Interfaces:**
- Consumes: `effective_user_quotas(uuid)` from Task 2.
- Produces: `can_create_post(uuid)` and `can_upload_media(uuid)`, both with unchanged signatures.
- **Not in this task:** `enforce_post_quota_on_insert()` is rewritten entirely in Task 4. Do not touch it here — two tasks issuing `CREATE OR REPLACE` for one function makes review order-dependent.

- [ ] **Step 1: Write the failing assertions**

Save as `/tmp/t3.sql`:

```sql
DO $$
DECLARE
  u uuid := '33333333-3333-3333-3333-333333333333';
  ok boolean;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email)
  VALUES (u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t3@t.io')
  ON CONFLICT (id) DO NOTHING;
  UPDATE user_quotas SET max_posts_per_day=NULL, max_posts_per_month=NULL,
    max_media_uploads_per_day=NULL, media_uploads_today=0,
    media_daily_reset_date = now() + interval '1 day' WHERE user_id=u;

  -- Pro plan, no override: the 3rd post of the day must be allowed
  INSERT INTO user_subscriptions (user_id, plan_id, status)
  SELECT u, id, 'active' FROM subscription_plans WHERE slug='pro';
  INSERT INTO posts (user_id, caption) VALUES (u,'a'),(u,'b');
  SELECT can_create_post(u) INTO ok;
  ASSERT ok, 'pro user must not be blocked at 2 posts/day';

  -- an override of 1 blocks even a Business user
  UPDATE user_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE slug='business')
    WHERE user_id=u;
  UPDATE user_quotas SET max_posts_per_day=1 WHERE user_id=u;
  SELECT can_create_post(u) INTO ok;
  ASSERT NOT ok, 'override of 1 must block a business user';

  -- can_upload_media resolves the plan when the override is NULL
  UPDATE user_quotas SET max_media_uploads_per_day=NULL, media_uploads_today=99 WHERE user_id=u;
  SELECT can_upload_media(u) INTO ok;
  ASSERT ok, 'business plan gives unlimited uploads';

  RAISE NOTICE 'TASK3 PASS';
END $$;
```

- [ ] **Step 2: Run it to verify it fails**

Expected: `ASSERT` failure on `pro user must not be blocked at 2 posts/day` — today's `can_create_post` reads `user_quotas` directly, finds NULL, and `COALESCE`s to the free literal 2.

- [ ] **Step 3: Write the migration**

```sql
-- Route every quota READER through the arbiter.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R4).
--
-- Behaviour preserved exactly: admin bypass, -1 = unlimited, real-usage COUNT(*)
-- recount (counters drift), and the POST_QUOTA_* error codes the frontend
-- matches on. The ONLY change is where the two numbers come from.

CREATE OR REPLACE FUNCTION public.can_create_post(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_posts_today integer;
  v_posts_month integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  SELECT e.max_posts_per_day, e.max_posts_per_month
  INTO v_max_day, v_max_month
  FROM public.effective_user_quotas(p_user_id) e;

  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = p_user_id AND created_at >= date_trunc('day', now());

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = p_user_id AND created_at >= date_trunc('month', now());

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RETURN false;
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.can_create_post(uuid) IS
  'True if under daily/monthly post limits from effective_user_quotas(). Admins always true.';

CREATE OR REPLACE FUNCTION public.can_upload_media(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_uploads integer;
  v_max_uploads integer;
  v_reset_date timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  SELECT e.max_media_uploads_per_day INTO v_max_uploads
  FROM public.effective_user_quotas(p_user_id) e;

  IF v_max_uploads = -1 THEN
    RETURN true;
  END IF;

  SELECT uq.media_uploads_today, uq.media_daily_reset_date
  INTO v_current_uploads, v_reset_date
  FROM public.user_quotas uq
  WHERE uq.user_id = p_user_id;

  -- No counter row yet, or the daily window has rolled over: nothing consumed.
  IF NOT FOUND OR v_reset_date IS NULL OR v_reset_date <= now() THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_current_uploads, 0) < v_max_uploads;
END;
$$;

COMMENT ON FUNCTION public.can_upload_media(uuid) IS
  'True if under the daily media upload limit from effective_user_quotas(). Admins always true.';
```

- [ ] **Step 4: Apply and re-run**

Expected: `NOTICE: TASK3 PASS`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(db): resolve post and media quota checks through the arbiter" -- supabase/migrations/20260823140200_quota_readers_use_arbiter.sql
```

---

**Round-1 amendments (BINDING).**

*A2 — `increment_media_uploads()` joins this task.* It is **not** counter-only: it selects
`max_media_uploads_per_day` and enforces it. With a NULL override both `v_max_uploads = -1`
and `v_current_uploads >= v_max_uploads` evaluate to NULL, so it increments forever — an
unlimited upload bypass. Its missing-row branch also hardcodes `max_media_uploads_per_day = 20`,
re-creating the override this work removes.

Rewrite it in this migration: resolve the limit via `effective_user_quotas()`, insert
missing rows with NULL limits, and keep the reset-window and increment behaviour identical.

Add assertions to `/tmp/t3.sql`:
- a user with a NULL override on the free plan is blocked by `increment_media_uploads`
  once `media_uploads_today` reaches the plan's 20 (today it would increment past it);
- the missing-row branch leaves `max_media_uploads_per_day` NULL;
- a Business-plan user is never blocked.

---

### Task 4: Writers stop writing limits

**Files:**
- Create: `supabase/migrations/20260823140300_quota_writers_clear_overrides.sql`

**Interfaces:**
- Consumes: `effective_user_quotas(uuid)` from Task 2.
- Produces: `handle_new_user_quota()`, `set_user_quotas_for_plan(uuid, text)` and `enforce_post_quota_on_insert()`, all with unchanged signatures. `set_user_quotas_for_plan` keeps its `p_plan_slug` parameter — `handle_subscription_change()` passes it — but no longer reads it.

- [ ] **Step 1: Write the failing assertions**

Save as `/tmp/t4.sql`:

```sql
DO $$
DECLARE
  u uuid := '44444444-4444-4444-4444-444444444444';
  v record;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email)
  VALUES (u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t4@t.io')
  ON CONFLICT (id) DO NOTHING;

  -- handle_new_user_quota must seed a counter row with NO limits
  SELECT * INTO v FROM user_quotas WHERE user_id=u;
  ASSERT v.max_profiles IS NULL,        'signup must not write max_profiles';
  ASSERT v.max_social_accounts IS NULL, 'signup must not write max_social_accounts';
  ASSERT v.max_posts_per_month IS NULL, 'signup must not write max_posts_per_month';

  -- set_user_quotas_for_plan must CLEAR, not write
  UPDATE user_quotas SET max_posts_per_day=7 WHERE user_id=u;
  PERFORM set_user_quotas_for_plan(u, 'pro');
  SELECT * INTO v FROM user_quotas WHERE user_id=u;
  ASSERT v.max_posts_per_day IS NULL, 'plan change must clear the override to inherit';

  -- the post trigger must seed NULL limits for a user with no row
  DELETE FROM user_quotas WHERE user_id=u;
  INSERT INTO posts (user_id, caption) VALUES (u,'first');
  SELECT * INTO v FROM user_quotas WHERE user_id=u;
  ASSERT v.max_posts_per_day IS NULL, 'post trigger must not write free literals';
  ASSERT v.posts_today = 1,           'post trigger must still count';

  RAISE NOTICE 'TASK4 PASS';
END $$;
```

- [ ] **Step 2: Run it to verify it fails**

Expected: `ASSERT` failure on `signup must not write max_profiles` — today `handle_new_user_quota` writes `1`.

- [ ] **Step 3: Write the migration**

```sql
-- Stop every quota WRITER from writing limits.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R4).
--
-- These three functions held copies 6, 7 and 8 of the plan table. Copy 7
-- (handle_new_user_quota: 1 profile / 4 accounts) and copy 8
-- (set_user_quotas_for_plan: free = 1 post/day) wrote numbers that appear in no
-- TypeScript source, which is why the live data disagreed with the dashboard.
--
-- After this migration a user_quotas row is a COUNTER row: usage + reset dates +
-- an optional deliberate override. Entitlements come from the plan.

CREATE OR REPLACE FUNCTION public.handle_new_user_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Limits are deliberately NULL: inherit from subscription_plans.
  INSERT INTO public.user_quotas (user_id, posts_this_month, quota_reset_date)
  VALUES (NEW.id, 0, (date_trunc('month', now()) + interval '1 month')::timestamptz)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Signature preserved: handle_subscription_change() calls this with the slug.
-- p_plan_slug is now unused - clearing the override makes the user inherit
-- whichever plan they are on, so the slug is redundant.
CREATE OR REPLACE FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_quotas (user_id, updated_at)
  VALUES (p_user_id, now())
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day         = NULL,
    max_posts_per_month       = NULL,
    max_profiles              = NULL,
    max_social_accounts       = NULL,
    max_media_uploads_per_day = NULL,
    updated_at                = now();
END;
$$;

COMMENT ON FUNCTION public.set_user_quotas_for_plan(uuid, text) IS
  'Clears per-user overrides so the user inherits their plan. p_plan_slug retained for caller compatibility and intentionally unused.';

CREATE OR REPLACE FUNCTION public.enforce_post_quota_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_posts_today integer;
  v_posts_month integer;
  v_next_day timestamptz := date_trunc('day', now()) + interval '1 day';
  v_next_month timestamptz := date_trunc('month', now()) + interval '1 month';
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'POST_QUOTA_DENIED: user_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF public.has_role(NEW.user_id, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  -- The row exists to be locked and to hold counters. Limits stay NULL.
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, posts_today, quota_reset_date, daily_reset_date
  ) VALUES (
    NEW.user_id, 0, 0, v_next_month, v_next_day
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize concurrent inserts for this user.
  PERFORM 1 FROM public.user_quotas WHERE user_id = NEW.user_id FOR UPDATE;

  SELECT e.max_posts_per_day, e.max_posts_per_month
  INTO v_max_day, v_max_month
  FROM public.effective_user_quotas(NEW.user_id) e;

  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = NEW.user_id AND created_at >= date_trunc('day', now());

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = NEW.user_id AND created_at >= date_trunc('month', now());

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RAISE EXCEPTION 'POST_QUOTA_DAILY_EXCEEDED: Daily post limit of % reached. Upgrade your plan or try again tomorrow.', v_max_day
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RAISE EXCEPTION 'POST_QUOTA_MONTHLY_EXCEEDED: Monthly post limit of % reached. Upgrade your plan or wait until next month.', v_max_month
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.user_quotas
  SET posts_today       = v_posts_today + 1,
      posts_this_month  = v_posts_month + 1,
      daily_reset_date  = v_next_day,
      quota_reset_date  = v_next_month,
      updated_at        = now()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;
```

- [ ] **Step 4: Apply and re-run**

Expected: `NOTICE: TASK4 PASS`.

- [ ] **Step 5: Re-run Task 3's assertions to check for regression**

Run `/tmp/t3.sql` again. Expected: `NOTICE: TASK3 PASS` still.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(db): quota writers clear overrides instead of writing plan values" -- supabase/migrations/20260823140300_quota_writers_clear_overrides.sql
```

---

**Round-1 amendments (BINDING).**

*A1 — name all five columns explicitly.* Task 1 drops the `user_quotas` defaults, but
every INSERT in this migration must still name all five limit columns with `NULL`. The
dropped default is the fix; the explicit NULL documents intent and survives a future
default being re-added. For example, in `handle_new_user_quota()`:

```sql
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, quota_reset_date,
    max_profiles, max_social_accounts, max_posts_per_month,
    max_posts_per_day, max_media_uploads_per_day
  )
  VALUES (
    NEW.id, 0, (date_trunc('month', now()) + interval '1 month')::timestamptz,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
```

Apply the same explicit-NULL form to the INSERT inside `enforce_post_quota_on_insert()`
and to `set_user_quotas_for_plan()`.

**Without this and A1's `DROP DEFAULT`, this task's own assertions fail** — Postgres
would fill the omitted columns with 2/4/20/2/20.

---

### Task 5: Capability-preserving backfill

**Files:**
- Create: `supabase/migrations/20260823140400_backfill_user_quota_overrides.sql`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: 66 live `user_quotas` rows with limits NULLed except where strictly more permissive than the plan.

- [ ] **Step 1: Write the failing assertions**

Save as `/tmp/t5.sql`. This reproduces all five live buckets from spec §2:

```sql
DO $$
DECLARE
  free_a uuid := '5000000a-0000-0000-0000-000000000000'; -- 46-row bucket
  free_b uuid := '5000000b-0000-0000-0000-000000000000'; -- 12-row bucket
  pro_u  uuid := '5000000c-0000-0000-0000-000000000000';
  admin_u uuid := '5000000d-0000-0000-0000-000000000000';
  v record;
BEGIN
  RAISE NOTICE 'expects fixtures seeded by step 2';

  SELECT * INTO v FROM user_quotas WHERE user_id=free_a;
  ASSERT v.max_posts_per_day IS NULL,      'free_a day must inherit';
  ASSERT v.max_profiles IS NULL,           'free_a profiles 1 must inherit (rises to 2)';
  ASSERT v.max_social_accounts = 4,        'free_a accounts 4 is more permissive - keep';

  SELECT * INTO v FROM user_quotas WHERE user_id=free_b;
  ASSERT v.max_posts_per_day IS NULL,      'free_b day 1 must inherit (rises to 2)';
  ASSERT v.max_social_accounts IS NULL,    'free_b accounts 3 equals plan - inherit';

  SELECT * INTO v FROM user_quotas WHERE user_id=pro_u;
  ASSERT v.max_posts_per_day IS NULL,      'pro row identical to plan - inherit';
  ASSERT v.max_posts_per_month IS NULL,    'pro month identical to plan - inherit';

  SELECT * INTO v FROM user_quotas WHERE user_id=admin_u;
  ASSERT v.max_posts_per_day = -1,         'admin unlimited is more permissive - keep';
  ASSERT v.max_profiles = -1,              'admin unlimited profiles - keep';

  RAISE NOTICE 'TASK5 PASS';
END $$;
```

- [ ] **Step 2: Seed the five live buckets as fixtures**

One `-c` per statement — a single batch rolls back entirely on any error.

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "INSERT INTO auth.users (id,instance_id,aud,role,email) VALUES ('5000000a-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@t.io'),('5000000b-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@t.io'),('5000000c-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','authenticated','authenticated','c@t.io'),('5000000d-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','authenticated','authenticated','d@t.io') ON CONFLICT DO NOTHING"
```

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "UPDATE user_quotas SET max_posts_per_day=2,max_posts_per_month=30,max_profiles=1,max_social_accounts=4,max_media_uploads_per_day=20 WHERE user_id='5000000a-0000-0000-0000-000000000000'"
```

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "UPDATE user_quotas SET max_posts_per_day=1,max_posts_per_month=30,max_profiles=2,max_social_accounts=3,max_media_uploads_per_day=20 WHERE user_id='5000000b-0000-0000-0000-000000000000'"
```

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "UPDATE user_quotas SET max_posts_per_day=30,max_posts_per_month=500,max_profiles=15,max_social_accounts=30,max_media_uploads_per_day=-1 WHERE user_id='5000000c-0000-0000-0000-000000000000'; INSERT INTO user_subscriptions (user_id,plan_id,status) SELECT '5000000c-0000-0000-0000-000000000000',id,'active' FROM subscription_plans WHERE slug='pro'"
```

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d quota_rehearsal -c "UPDATE user_quotas SET max_posts_per_day=-1,max_posts_per_month=-1,max_profiles=-1,max_social_accounts=-1,max_media_uploads_per_day=-1 WHERE user_id='5000000d-0000-0000-0000-000000000000'"
```

- [ ] **Step 3: Run the assertions to verify they fail**

Expected: `ASSERT` failure on `free_a day must inherit` — nothing has NULLed anything yet.

- [ ] **Step 4: Write the migration**

```sql
-- Capability-preserving backfill of user_quotas overrides.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R3).
--
-- THE INVARIANT: no user's effective limit may decrease.
--
-- Stated as an invariant, not a list of default values, deliberately. Eight
-- different code paths wrote these columns with four different "free" tuples
-- (see spec section 1.2), so a value-list rule would miss buckets - notably the
-- 46 rows holding max_profiles=1, which a naive rule would preserve as an
-- override BELOW the free plan's 2, silently capping every free user.
--
-- Rule: NULL a column unless the stored value is strictly MORE permissive than
-- what the plan resolves to. -1 is the most permissive value of all.

WITH resolved AS (
  SELECT
    uq.user_id,
    uq.max_profiles              AS u_profiles,
    uq.max_social_accounts       AS u_accounts,
    uq.max_posts_per_month       AS u_month,
    uq.max_posts_per_day         AS u_day,
    uq.max_media_uploads_per_day AS u_uploads,
    sp.profile_limit             AS p_profiles,
    sp.max_social_accounts       AS p_accounts,
    sp.max_posts_per_month       AS p_month,
    sp.max_posts_per_day         AS p_day,
    sp.max_media_uploads_per_day AS p_uploads
  FROM public.user_quotas uq
  LEFT JOIN LATERAL (
    SELECT s.plan_id FROM public.user_subscriptions s
    WHERE s.user_id = uq.user_id AND s.status = 'active'
    ORDER BY s.current_period_end DESC NULLS LAST
    LIMIT 1
  ) sub ON true
  LEFT JOIN public.subscription_plans sp
    ON sp.id = COALESCE(sub.plan_id,
                        (SELECT id FROM public.subscription_plans WHERE slug='free'))
)
UPDATE public.user_quotas uq
SET
  max_profiles = CASE
    WHEN r.u_profiles IS NULL THEN NULL
    WHEN r.u_profiles = -1 AND r.p_profiles <> -1 THEN r.u_profiles
    WHEN r.p_profiles = -1 THEN NULL
    WHEN r.u_profiles > r.p_profiles THEN r.u_profiles
    ELSE NULL END,
  max_social_accounts = CASE
    WHEN r.u_accounts IS NULL THEN NULL
    WHEN r.u_accounts = -1 AND r.p_accounts <> -1 THEN r.u_accounts
    WHEN r.p_accounts = -1 THEN NULL
    WHEN r.u_accounts > r.p_accounts THEN r.u_accounts
    ELSE NULL END,
  max_posts_per_month = CASE
    WHEN r.u_month IS NULL THEN NULL
    WHEN r.u_month = -1 AND r.p_month <> -1 THEN r.u_month
    WHEN r.p_month = -1 THEN NULL
    WHEN r.u_month > r.p_month THEN r.u_month
    ELSE NULL END,
  max_posts_per_day = CASE
    WHEN r.u_day IS NULL THEN NULL
    WHEN r.u_day = -1 AND r.p_day <> -1 THEN r.u_day
    WHEN r.p_day = -1 THEN NULL
    WHEN r.u_day > r.p_day THEN r.u_day
    ELSE NULL END,
  max_media_uploads_per_day = CASE
    WHEN r.u_uploads IS NULL THEN NULL
    WHEN r.u_uploads = -1 AND r.p_uploads <> -1 THEN r.u_uploads
    WHEN r.p_uploads = -1 THEN NULL
    WHEN r.u_uploads > r.p_uploads THEN r.u_uploads
    ELSE NULL END,
  updated_at = now()
FROM resolved r
WHERE r.user_id = uq.user_id;
```

- [ ] **Step 5: Apply and re-run**

Expected: `NOTICE: TASK5 PASS`.

- [ ] **Step 6: Assert the invariant holds for every fixture**

```sql
DO $$
DECLARE row_ record; e record;
BEGIN
  FOR row_ IN SELECT user_id FROM user_quotas LOOP
    SELECT * INTO e FROM effective_user_quotas(row_.user_id);
    ASSERT e.max_posts_per_day = -1 OR e.max_posts_per_day >= 1,
      'effective daily limit went below 1 for ' || row_.user_id;
  END LOOP;
  RAISE NOTICE 'INVARIANT PASS';
END $$;
```

- [ ] **Step 7: Destroy the rehearsal database**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -c "DROP DATABASE IF EXISTS quota_rehearsal"
```

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(db): capability-preserving backfill of user_quotas overrides" -- supabase/migrations/20260823140400_backfill_user_quota_overrides.sql
```

---

**Round-1 amendments (BINDING).**

*A4 - compare against plan-or-literal, never a raw nullable column.* This supersedes any
"keep the override when the plan is NULL" rule. In the `resolved` CTE, wrap every plan
column so it mirrors `effective_user_quotas()` exactly:

```sql
    COALESCE(sp.profile_limit, 2)              AS p_profiles,
    COALESCE(sp.max_social_accounts, 3)        AS p_accounts,
    COALESCE(sp.max_posts_per_month, 30)       AS p_month,
    COALESCE(sp.max_posts_per_day, 2)          AS p_day,
    COALESCE(sp.max_media_uploads_per_day, 20) AS p_uploads
```

Why this is a blocker without it: with a missing `free` row every `sp.*` is NULL, so for
the admin's `-1` row branch 2 (`u = -1 AND p <> -1`), branch 3 (`p = -1`) and branch 4
(`u > p`) are all NULL, the ladder falls to `ELSE NULL`, and the arbiter then resolves
that user down to the finite free literals. Task 1 only UPDATEs a free row - it never
creates one.

*A5 - same deterministic ordering as the arbiter.* The `LEFT JOIN LATERAL` subquery must
use `ORDER BY s.current_period_end DESC NULLS LAST, s.created_at DESC, s.id DESC`.
Divergence here is exactly how the backfill and the arbiter come to disagree.

*A5 - pre-migration assertion.* Add as the migration's first statement a DO block that
ASSERTs `NOT EXISTS (SELECT 1 FROM public.user_subscriptions WHERE status = 'active'
GROUP BY user_id HAVING count(*) > 1)` with the message
'duplicate active subscriptions must be resolved before backfilling'.

*A13 - the invariant test must compare before against after.* The Step 6 assertion
(`= -1 OR >= 1`) cannot fail on a decrease from 999 to 2. Replace it with a snapshot
taken BEFORE the backfill UPDATE:

```sql
CREATE TEMP TABLE quota_snapshot AS
SELECT uq.user_id, e.* FROM public.user_quotas uq,
       LATERAL public.effective_user_quotas(uq.user_id) e;
```

and, AFTER it, a DO block looping over `quota_snapshot` that re-resolves each user and
ASSERTs, for every one of the five columns, that the new value is `-1` OR
(the old value was not `-1` AND the new value is >= the old value). Message:
'<column> limit decreased for ' || r.user_id. The invariant covers every column, not
just the daily one.

*A13 - add the missing Business fixture.* Step 2 seeds four users; add a fifth on the
Business plan with an active subscription so the `business` bucket is exercised, and
assert every column for every fixture rather than a selected few.

---

### Task 6: Regenerate database types

**Files:**
- Modify: `src/integrations/supabase/types.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `Database["public"]["Tables"]["subscription_plans"]["Row"]` gains the four columns; `Functions` gains `effective_user_quotas`. Tasks 7-9 depend on these types compiling.

- [ ] **Step 1: Add the four columns to the `subscription_plans` Row, Insert and Update blocks**

The migrations are not applied to production yet, so the CLI cannot generate these. Hand-edit, matching the existing nullable style at `types.ts:3968`:

```typescript
          max_media_uploads_per_day: number | null
          max_posts_per_day: number | null
          max_posts_per_month: number | null
          max_social_accounts: number | null
```

Add to all three blocks (`Row`, `Insert`, `Update`), with `?` on the Insert and Update variants, keeping the existing alphabetical ordering.

- [ ] **Step 2: Add the function signature to the `Functions` block**

```typescript
      effective_user_quotas: {
        Args: { p_user_id: string }
        Returns: {
          max_profiles: number
          max_social_accounts: number
          max_posts_per_month: number
          max_posts_per_day: number
          max_media_uploads_per_day: number
        }[]
      }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(types): add plan quota columns and effective_user_quotas" -- src/integrations/supabase/types.ts
```

---

### Task 7: Client resolution in `useQuotas`

**Files:**
- Modify: `src/hooks/useQuotas.tsx` (delete `PLAN_QUOTAS` at lines 29-51 and `pickMax` at lines 82-95)
- Create: `src/hooks/__tests__/useQuotas.resolution.test.ts`

**Interfaces:**
- Consumes: `subscription_plans` columns from Task 1, types from Task 6.
- Produces: exported `resolvePlanLimits(planRow, overrideRow)` — a pure function, so the resolution order is testable without rendering. Signature:

```typescript
export interface QuotaLimits {
  max_profiles: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  max_posts_per_day: number;
  max_media_uploads_per_day: number;
}
export function resolvePlanLimits(
  plan: Partial<QuotaLimits> & { profile_limit?: number | null } | null,
  override: Partial<QuotaLimits> | null,
): QuotaLimits
```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { FREE_TIER_FALLBACK, resolvePlanLimits } from "../useQuotas";

describe("resolvePlanLimits", () => {
  const proPlan = {
    profile_limit: 15,
    max_social_accounts: 30,
    max_posts_per_month: 500,
    max_posts_per_day: 30,
    max_media_uploads_per_day: -1,
  };

  it("inherits the plan when the override is null", () => {
    expect(resolvePlanLimits(proPlan, null).max_posts_per_day).toBe(30);
  });

  it("inherits the plan when an override column is null", () => {
    expect(
      resolvePlanLimits(proPlan, { max_posts_per_day: null as unknown as number }).max_posts_per_day,
    ).toBe(30);
  });

  it("lets an override raise the plan", () => {
    expect(resolvePlanLimits(proPlan, { max_posts_per_day: 999 }).max_posts_per_day).toBe(999);
  });

  it("lets an override lower the plan", () => {
    expect(resolvePlanLimits(proPlan, { max_posts_per_day: 1 }).max_posts_per_day).toBe(1);
  });

  it("maps profile_limit onto max_profiles", () => {
    expect(resolvePlanLimits(proPlan, null).max_profiles).toBe(15);
  });

  it("falls back to the free tier when the plan query returned nothing", () => {
    expect(resolvePlanLimits(null, null)).toEqual(FREE_TIER_FALLBACK);
  });

  it("keeps -1 as unlimited rather than treating it as a small number", () => {
    expect(resolvePlanLimits(proPlan, null).max_media_uploads_per_day).toBe(-1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/hooks/__tests__/useQuotas.resolution.test.ts`
Expected: FAIL — `resolvePlanLimits` is not exported from `../useQuotas`.

- [ ] **Step 3: Replace `PLAN_QUOTAS` and `pickMax` with the resolver**

Delete the `PLAN_QUOTAS` constant (lines 29-51) and the `pickMax` helper plus the `planLimits` ternary (lines 82-95). Insert:

```typescript
/** Last-resort limits, used ONLY when the subscription_plans query fails.
 *  The database's effective_user_quotas() holds the same numbers; these two
 *  must stay in sync so an outage never enforces something the DB disagrees with. */
export const FREE_TIER_FALLBACK: QuotaLimits = {
  max_profiles: 2,
  max_social_accounts: 3,
  max_posts_per_month: 30,
  max_posts_per_day: 2,
  max_media_uploads_per_day: 20,
};

export interface QuotaLimits {
  max_profiles: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  max_posts_per_day: number;
  max_media_uploads_per_day: number;
}

type PlanRow = (Partial<QuotaLimits> & { profile_limit?: number | null }) | null;

/** Mirrors the SQL arbiter effective_user_quotas(): override -> plan -> fallback,
 *  resolved per column. A null override column means inherit, NOT zero. */
export function resolvePlanLimits(plan: PlanRow, override: Partial<QuotaLimits> | null): QuotaLimits {
  const pick = (o: number | null | undefined, p: number | null | undefined, f: number) =>
    o ?? p ?? f;
  return {
    max_profiles: pick(override?.max_profiles, plan?.profile_limit, FREE_TIER_FALLBACK.max_profiles),
    max_social_accounts: pick(override?.max_social_accounts, plan?.max_social_accounts, FREE_TIER_FALLBACK.max_social_accounts),
    max_posts_per_month: pick(override?.max_posts_per_month, plan?.max_posts_per_month, FREE_TIER_FALLBACK.max_posts_per_month),
    max_posts_per_day: pick(override?.max_posts_per_day, plan?.max_posts_per_day, FREE_TIER_FALLBACK.max_posts_per_day),
    max_media_uploads_per_day: pick(override?.max_media_uploads_per_day, plan?.max_media_uploads_per_day, FREE_TIER_FALLBACK.max_media_uploads_per_day),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/__tests__/useQuotas.resolution.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the hook to the new plan query**

**Keep the existing `dbQuotaLimits` query (lines 66-80) exactly as it is** — it reads the
per-user override row and is the second argument to `resolvePlanLimits`. Deleting it
would make every user inherit the plan with no override path, breaking spec R2.

Delete only `basePlanLimits` and the `planLimits` ternary, and replace them with:

```typescript
  const { data: planRow } = useQuery({
    queryKey: ["plan-entitlements", effectivePlanSlug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("profile_limit, max_social_accounts, max_posts_per_month, max_posts_per_day, max_media_uploads_per_day")
        .eq("slug", effectivePlanSlug)
        .maybeSingle();
      if (error) {
        console.error("Error fetching plan entitlements:", error);
        return null;
      }
      return data;
    },
    staleTime: 60_000,
  });

  const planLimits = resolvePlanLimits(planRow ?? null, dbQuotaLimits ?? null);
```

A dedicated query is required rather than reusing `useSubscription`: that hook
returns `dbSubscription: null` for a user with no subscription row, so it never
carries a plan row for free users — the majority.

- [ ] **Step 6: Run the full suite for regressions**

Run: `npm test`
Expected: PASS. Baseline before this work is 474 passed / 0 failed; the 7 new tests bring it to 481.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(quotas): resolve client limits from subscription_plans" -- src/hooks/useQuotas.tsx src/hooks/__tests__/useQuotas.resolution.test.ts
```

---

**Round-1 amendments (BINDING).**

*A11 - the denial message must use the resolved limit.* `useQuotas.tsx:365-385` re-reads
`user_quotas.max_media_uploads_per_day` to build its message. After the backfill that is
normally NULL, so a Free plan edited to 10 uploads blocks at 10 but tells the user
"daily limit of 20". Replace that query with the already-resolved `maxMediaUploads`, and
delete the now-dead `user_quotas` read.

Add a test asserting the message quotes the resolved plan value, not `20`.

---

### Task 8: Plan-quota adapter and admin page

**Files:**
- Create: `src/hooks/usePlanQuotas.tsx`
- Create: `src/hooks/__tests__/usePlanQuotas.test.tsx`
- Modify: `src/pages/admin/AdminPlanQuotas.tsx`

**Interfaces:**
- Consumes: Task 1 columns, Task 6 types.
- Produces: `usePlanQuotas()` returning `{ quotas: PlanQuota[], isLoading: boolean, updateQuota: UseMutationResult }`, where

```typescript
export interface PlanQuota {
  id: string;
  plan_slug: string;
  plan_name: string;
  profile_limit: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  max_posts_per_day: number;
  max_media_uploads_per_day: number;
}
```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const selectMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...a: unknown[]) => selectMock(...a) },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { usePlanQuotas } from "../usePlanQuotas";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

describe("usePlanQuotas", () => {
  beforeEach(() => selectMock.mockReset());

  it("reads plans from subscription_plans, not app_settings", async () => {
    selectMock.mockReturnValue({
      select: () => ({
        order: () => Promise.resolve({
          data: [{
            id: "p1", slug: "free", name: "Free", profile_limit: 2,
            max_social_accounts: 3, max_posts_per_month: 30,
            max_posts_per_day: 2, max_media_uploads_per_day: 20,
          }],
          error: null,
        }),
      }),
    });

    const { result } = renderHook(() => usePlanQuotas(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(selectMock).toHaveBeenCalledWith("subscription_plans");
    expect(selectMock).not.toHaveBeenCalledWith("app_settings");
    expect(result.current.quotas[0].max_posts_per_day).toBe(2);
    expect(result.current.quotas[0].plan_slug).toBe("free");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/hooks/__tests__/usePlanQuotas.test.tsx`
Expected: FAIL — cannot resolve `../usePlanQuotas`.

- [ ] **Step 3: Write the hook**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface PlanQuota {
  id: string;
  plan_slug: string;
  plan_name: string;
  profile_limit: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  max_posts_per_day: number;
  max_media_uploads_per_day: number;
}

/** Owns every Supabase call for plan entitlements. ARCHITECTURE.md section 11
 *  forbids raw queries inside pages; AdminPlanQuotas consumes this instead. */
export function usePlanQuotas() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: quotas = [], isLoading } = useQuery({
    queryKey: ["plan-quotas"],
    queryFn: async (): Promise<PlanQuota[]> => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("id, slug, name, profile_limit, max_social_accounts, max_posts_per_month, max_posts_per_day, max_media_uploads_per_day")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        plan_slug: row.slug,
        plan_name: row.name,
        profile_limit: row.profile_limit ?? 0,
        max_social_accounts: row.max_social_accounts ?? 0,
        max_posts_per_month: row.max_posts_per_month ?? 0,
        max_posts_per_day: row.max_posts_per_day ?? 0,
        max_media_uploads_per_day: row.max_media_uploads_per_day ?? 0,
      }));
    },
  });

  const updateQuota = useMutation({
    mutationFn: async (plan: PlanQuota) => {
      const { error } = await supabase
        .from("subscription_plans")
        .update({
          profile_limit: plan.profile_limit,
          max_social_accounts: plan.max_social_accounts,
          max_posts_per_month: plan.max_posts_per_month,
          max_posts_per_day: plan.max_posts_per_day,
          max_media_uploads_per_day: plan.max_media_uploads_per_day,
          updated_at: new Date().toISOString(),
        })
        .eq("id", plan.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan-quotas"] });
      queryClient.invalidateQueries({ queryKey: ["plan-entitlements"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-plans"] });
      toast({ title: "Quotas updated", description: "Plan quotas saved. Users inherit them immediately." });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update quotas",
        variant: "destructive",
      });
    },
  });

  return { quotas, isLoading, updateQuota };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/__tests__/usePlanQuotas.test.tsx`
Expected: PASS.

- [ ] **Step 5: Repoint `AdminPlanQuotas.tsx`**

Delete the `DEFAULT_QUOTAS` constant (lines 39-66), both `useQuery`/`useMutation` blocks and all four `app_settings` calls. Replace with `const { quotas, isLoading, updateQuota } = usePlanQuotas();`. Rename the form's `max_profiles` field to `profile_limit` so it writes the canonical column, and label it "Social Profiles (shared with Plans page)". Keep the existing table and dialog markup.

- [ ] **Step 6: Verify no raw Supabase query remains in the page**

Run: `grep -n "supabase\." src/pages/admin/AdminPlanQuotas.tsx`
Expected: no output.

- [ ] **Step 7: Run typecheck and the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(admin): plan quotas page edits subscription_plans" -- src/hooks/usePlanQuotas.tsx src/hooks/__tests__/usePlanQuotas.test.tsx src/pages/admin/AdminPlanQuotas.tsx
```

---

**Round-1 amendments (BINDING).**

*A10 - preserve NULL; never persist a coerced zero.* The `?? 0` coalescing in the mapper
turns a deliberately-NULL plan column into a hard `0` limit as soon as an admin opens and
saves the plan - converting free-fallback behaviour into a zero-capability plan. Type the
`PlanQuota` numeric fields as `number | null`, keep NULL through the form, and send NULL
(not 0) on save. Render NULL as an empty input whose placeholder names the fallback value.

*A12 - rewrite the "Important Notes" markup* (`AdminPlanQuotas.tsx:320-330`). It currently
tells admins that changes require Sync Quotas and that edge-function values must match the
database. Both become false: plan edits take effect immediately, and Task 10 changes
`sync-user-quotas` to *clear* per-user overrides. Following the retained instruction would
erase deliberate grants. Replace with the NULL-inheritance semantics and an explicit
warning that the sync action clears per-user overrides.

*A13 - test the mutation, not just the read.* The Step 1 test only exercises reading. Add
a test that `updateQuota` issues an `update` against `subscription_plans` with the edited
values, and that a NULL field is sent as `null`, not `0`.

---

### Task 9: Admin cross-links and rate-limit tier visibility

**Files:**
- Modify: `src/pages/admin/AdminPlans.tsx:229-230, 384-388`
- Modify: `src/pages/admin/AdminRateLimits.tsx`
- Modify: `src/pages/admin/__tests__/AdminRateLimits.labels.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces: exported `TIER_ENFORCING_ENDPOINTS: readonly string[]` and `endpointEnforcesTierLimits(endpoint: string): boolean` from `AdminRateLimits.tsx`, alongside the existing `ENDPOINT_LABELS` / `groupByEndpointCategory` exports.

- [ ] **Step 1: Write the failing test**

Append to `src/pages/admin/__tests__/AdminRateLimits.labels.test.ts`:

```typescript
import { endpointEnforcesTierLimits } from "../AdminRateLimits";

describe("endpointEnforcesTierLimits", () => {
  it("is true for the AI endpoints that read tier_rate_limits", () => {
    expect(endpointEnforcesTierLimits("generate-caption")).toBe(true);
    expect(endpointEnforcesTierLimits("generate-image")).toBe(true);
  });

  it("is true for n8n endpoints once the resolver consults tiers", () => {
    expect(endpointEnforcesTierLimits("/api/v1/post")).toBe(true);
  });

  it("is false for generate-hashtags, which has no rate limiting code", () => {
    expect(endpointEnforcesTierLimits("generate-hashtags")).toBe(false);
  });

  it("is false for post-create, which has a row but no consumer", () => {
    expect(endpointEnforcesTierLimits("post-create")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/admin/__tests__/AdminRateLimits.labels.test.ts`
Expected: FAIL — `endpointEnforcesTierLimits` is not exported.

- [ ] **Step 3: Add the predicate and use it**

```typescript
/** Endpoints whose runtime actually consults tier_rate_limits. generate-hashtags
 *  and post-create own rows but have no enforcement code, so showing them a tier
 *  control would promise a limit nothing reads. */
export const TIER_ENFORCING_ENDPOINTS = [
  "generate-caption",
  "generate-image",
  "/api/v1/post",
  "/api/v1/upload-media",
  "/api/v1/posts",
  "/api/v1/accounts",
  "/api/v1/webhooks",
  "/api/v1/media",
  "/api/v1/messages/reply",
  "/api/v1/comments/reply",
  "/api/v1/comments/hide",
  "/api/v1/comments/delete",
] as const;

export function endpointEnforcesTierLimits(endpoint: string): boolean {
  return (TIER_ENFORCING_ENDPOINTS as readonly string[]).includes(endpoint);
}
```

Filter the tier tab's endpoint list through `endpointEnforcesTierLimits`, and render a muted note for excluded endpoints: `"No tier enforcement for this endpoint — global limit only."`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/admin/__tests__/AdminRateLimits.labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Label the shared profile field on AdminPlans**

At both the create form (line 229) and the edit dialog (line 384), change the field label to `Social Profiles` and add helper text below it:

```tsx
<p className="text-xs text-muted-foreground">
  Shared with the Plan Quotas page — editing here changes both.
</p>
```

- [ ] **Step 6: Run typecheck and the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(admin): hide unenforced tier controls and label the shared profile field" -- src/pages/admin/AdminPlans.tsx src/pages/admin/AdminRateLimits.tsx src/pages/admin/__tests__/AdminRateLimits.labels.test.ts
```

---

**Round-1 amendments (BINDING).**

*A9 - disable the daily field for hourly-only endpoints.* Task 11 enforces only
`max_requests_per_hour` for n8n endpoints, but the existing tier UI renders and saves both
hourly and daily inputs. An admin could tune a daily cap that never fires. Add:

```typescript
/** Endpoints whose runtime enforces ONLY max_requests_per_hour. The daily column exists
 *  on the row but has no consumer for these, so the field is disabled rather than shown
 *  as an editable limit. */
export function endpointEnforcesDailyTierLimit(endpoint: string): boolean {
  return endpoint === "generate-caption" || endpoint === "generate-image";
}
```

Disable the daily input where this returns false and render "Hourly only - the daily value
is not enforced for this endpoint." Add a test for both branches.

---

### Task 10: Edge functions stop writing plan values

**Files:**
- Modify: `supabase/functions/stripe-webhook/index.ts:20-46, 299-320, 397-414, 458-473`
- Modify: `supabase/functions/sync-user-quotas/index.ts:26-48, 238-245`
- Modify: `supabase/functions/backfill-subscription/index.ts:19-45, 217-225`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: no exports. Behavioural contract: these functions never write a non-null value into any `user_quotas.max_*` column.

- [ ] **Step 1: Add the shared constant to each file**

Replace each file's `PLAN_QUOTAS` constant with:

```typescript
// Limits live on subscription_plans and resolve through effective_user_quotas().
// Writing concrete numbers here would convert every subscriber into a permanent
// override at their plan's values as of that moment, and later edits on
// /admin/plan-quotas would never reach a paying user.
const CLEARED_QUOTA_OVERRIDES = {
  max_profiles: null,
  max_social_accounts: null,
  max_posts_per_month: null,
  max_posts_per_day: null,
  max_media_uploads_per_day: null,
} as const;
```

- [ ] **Step 2: Replace every write site**

In `stripe-webhook/index.ts`, substitute `CLEARED_QUOTA_OVERRIDES` for `quotas` at line 299 (`const quotas = PLAN_QUOTAS[...]` becomes `const quotas = CLEARED_QUOTA_OVERRIDES`), for `PLAN_QUOTAS[newPlanSlug]` at lines 407 and 414, and for `PLAN_QUOTAS.free` at lines 466 and 473. At line 397, **keep** the `if` statement and narrow its condition from `if (newPlanSlug && PLAN_QUOTAS[newPlanSlug])` to `if (newPlanSlug)` — the block it guards must still run on a plan change; only the `PLAN_QUOTAS` half of the condition becomes meaningless.

Apply the same substitution at `sync-user-quotas/index.ts:238-245` and `backfill-subscription/index.ts:217-225`.

- [ ] **Step 3: Verify no copy survives**

Run: `grep -rn "PLAN_QUOTAS" supabase/functions/ src/`
Expected: no output.

- [ ] **Step 4: Typecheck the edge functions**

Run: `deno check supabase/functions/stripe-webhook/index.ts supabase/functions/sync-user-quotas/index.ts supabase/functions/backfill-subscription/index.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(quotas): edge functions clear overrides instead of writing plan values" -- supabase/functions/stripe-webhook/index.ts supabase/functions/sync-user-quotas/index.ts supabase/functions/backfill-subscription/index.ts
```

---

**Round-1 amendments (BINDING) - this task grows substantially.**

*A3 - the webhook never writes `plan_id`.* Verified at `stripe-webhook/index.ts:386-394`:
the update writes `status`, both period columns and `cancel_at_period_end`, and nothing
else. Today that is masked because the webhook also writes the new plan's concrete numbers
into `user_quotas`. Remove that write without fixing `plan_id` and **a user who upgrades
inherits their old plan** - a regression against current behaviour. Required:

1. Resolve the new plan's `id` from `newPlanSlug`
   (`select id from subscription_plans where slug = newPlanSlug`).
2. Include `plan_id` in the `user_subscriptions` update **only when the plan actually
   changed** - compare against the stored `plan_id` first.
3. Clear the override columns **only** on create, real plan change, or cancellation. The
   retained `if (newPlanSlug)` from Ruling 3 fires on every ordinary
   `customer.subscription.updated` event (renewals, payment-method changes) and would
   erase deliberate admin grants, contradicting spec R4a.

*A3 - invalid cancellation status.* The deletion path writes `"canceled"`.
`user_subscriptions_status_check` permits `active | cancelled | expired | past_due` -
verified on prod. Write `"cancelled"`. The same applies to `status: subscription.status`
at line 389, which forwards Stripe values (`incomplete`, `trialing`, `unpaid`) the
constraint rejects: map Stripe status to a permitted value explicitly.

*A3 - stop discarding database errors.* Every `await supabase...` in these paths currently
drops its `{ error }`. Destructure and log it; a silently failing update is how this class
of bug survived. Do not throw - ARCHITECTURE.md section 16 forbids turning these into 5xx.

Add a step verifying the Stripe-status-to-permitted-value mapping.

---

### Task 11: Tier resolution in `n8n-api`

**Files:**
- Modify: `supabase/functions/n8n-api/rateLimitConfig.ts`
- Modify: `supabase/functions/n8n-api/rateLimitConfig.test.ts`
- Modify: `supabase/functions/n8n-api/index.ts` (wire the two new deps)

**Interfaces:**
- Consumes: nothing from earlier tasks — independent of the quota work.
- Produces: `RateLimitDeps` gains `fetchPlanSlug: () => Promise<string | null>` and `fetchTierLimit: (planSlug: string, endpointKey: string) => Promise<TierLimitRow | null>`. `ResolvedRateLimit["source"]` gains `'tier_limit'`. New exports `TierLimitRow`, `fetchPlanSlug(supabase, userId)`, `fetchTierLimit(supabase, planSlug, endpointKey)`.

**Decision this task locks in:** a tier row carries `max_requests_per_hour` **and** `max_requests_per_day`, but `checkRateLimit` counts one window per request. This resolver uses `max_requests_per_hour` with a 60-minute window and **does not enforce the daily half**. That is stated in the code comment and surfaced in the admin UI note from Task 9, so the page never implies a cap that is not enforced.

- [ ] **Step 1: Write the failing tests**

Append to `rateLimitConfig.test.ts`:

```typescript
Deno.test("resolveRateLimit prefers a user override over a tier row", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve({ max_requests: 5, window_minutes: 60, expires_at: null }),
    fetchPlanSlug: () => Promise.resolve("pro"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 999, max_requests_per_day: 9999, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve(null),
  });
  assertEquals(result.requests, 5);
  assertEquals(result.source, "user_override");
});

Deno.test("resolveRateLimit prefers a tier row over the global setting", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 12, max_requests_per_day: 100, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 12);
  assertEquals(result.windowMs, 60 * 60 * 1000);
  assertEquals(result.source, "tier_limit");
});

Deno.test("resolveRateLimit skips an inactive tier row and falls through", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 12, max_requests_per_day: 100, is_active: false }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "global_setting");
});

Deno.test("resolveRateLimit skips a malformed tier row", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 0, max_requests_per_day: 100, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "global_setting");
});

Deno.test("resolveRateLimit degrades to the fallback map when the plan lookup throws", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.reject(new Error("db down")),
    fetchTierLimit: () => Promise.resolve(null),
    fetchGlobalSetting: () => Promise.resolve(null),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "fallback");
});

Deno.test("resolveRateLimit skips the tier step when the user has no plan", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve(null),
    fetchTierLimit: () => { throw new Error("must not be called"); },
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.source, "global_setting");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-all supabase/functions/n8n-api/rateLimitConfig.test.ts`
Expected: FAIL — `fetchPlanSlug` is not a property of `RateLimitDeps`.

- [ ] **Step 3: Extend the resolver**

Add the row type and widen the union:

```typescript
/** A `tier_rate_limits` row, as selected by {@link fetchTierLimit}. */
export interface TierLimitRow {
  max_requests_per_hour: number | null;
  max_requests_per_day: number | null;
  is_active: boolean | null;
}
```

Change `source` to `'user_override' | 'tier_limit' | 'global_setting' | 'fallback'` and add both deps to `RateLimitDeps`. Insert between the override and global blocks in `resolveRateLimit`:

```typescript
  // Tier limits are per (plan, endpoint). Only max_requests_per_hour is
  // enforced: checkRateLimit counts one window per request, so the daily half
  // of the row has no consumer. The admin UI says so rather than implying a
  // cap that never fires.
  try {
    const planSlug = await deps.fetchPlanSlug();
    if (planSlug) {
      const tier = await deps.fetchTierLimit(planSlug, endpointKey);
      if (
        tier && tier.is_active !== false &&
        typeof tier.max_requests_per_hour === 'number' &&
        Number.isFinite(tier.max_requests_per_hour) &&
        tier.max_requests_per_hour > 0
      ) {
        return {
          requests: tier.max_requests_per_hour,
          windowMs: 60 * 60 * 1000,
          enforced: true,
          source: 'tier_limit',
        };
      }
    }
  } catch (error) {
    console.error(`[n8n-api] tier_rate_limits lookup failed for ${endpointKey}:`, error);
  }
```

Add the two Supabase adapters:

```typescript
export async function fetchPlanSlug(supabase: any, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('subscription_plans(slug)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`user_subscriptions lookup failed: ${error.message}`);
  return data?.subscription_plans?.slug ?? null;
}

export async function fetchTierLimit(
  supabase: any,
  planSlug: string,
  endpointKey: string,
): Promise<TierLimitRow | null> {
  const { data, error } = await supabase
    .from('tier_rate_limits')
    .select('max_requests_per_hour, max_requests_per_day, is_active')
    .eq('plan_slug', planSlug)
    .eq('endpoint', endpointKey)
    .maybeSingle();
  if (error) throw new Error(`tier_rate_limits lookup failed: ${error.message}`);
  return data ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-all supabase/functions/n8n-api/`
Expected: PASS, all existing tests plus 6 new.

- [ ] **Step 5: Wire the deps at the call site in `index.ts`**

Find where `resolveRateLimit` is called and add both functions to the deps object, matching the existing `fetchUserOverride` / `fetchGlobalSetting` closure style.

- [ ] **Step 6: Typecheck**

Run: `deno check supabase/functions/n8n-api/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(n8n-api): resolve tier rate limits between user override and global" -- supabase/functions/n8n-api/rateLimitConfig.ts supabase/functions/n8n-api/rateLimitConfig.test.ts supabase/functions/n8n-api/index.ts
```

---

**Round-1 amendments (BINDING).**

*A7 - a caller with no subscription is a Free user, not a plan-less one.* Most free users
have no `user_subscriptions` row at all (66 users against 7 active subscriptions), so
returning NULL skips the tier step for exactly the population tier limits are meant to
constrain - contradicting spec acceptance criterion 7. `fetchPlanSlug` must resolve to
`'free'`:

```typescript
  return data?.subscription_plans?.slug ?? 'free';
```

**Invert the Step 1 test** "skips the tier step when the user has no plan" - it encodes the
wrong behaviour as a requirement. Replace with: a caller with no active subscription
resolves `'free'`, and a Free `tier_rate_limits` row outranks the global setting. Keep a
separate test that a *throwing* plan lookup degrades to the global setting.

*A8 - seed the n8n tier rows.* All nine existing `tier_rate_limits` rows are AI endpoints;
`AdminRateLimits` has no insert path, so acceptance criterion 7 cannot pass from the
planned deployment state. Add a migration
`supabase/migrations/20260823140500_seed_n8n_tier_rate_limits.sql` inserting rows for the
ten `/api/v1/*` endpoints across `free`, `pro` and `business`, with
`ON CONFLICT (plan_slug, endpoint) DO NOTHING` so a replay is inert. Free values sit below
the corresponding `rate_limit_settings` global; pro and business above it. State the chosen
numbers in the migration comment.

---

### Task 12: Guard pass and final gates

**Files:** none modified unless a guard finds something.

**Interfaces:**
- Consumes: Tasks 1-11.
- Produces: a green gate set, ready for the spec §6 deployment sequence.

- [ ] **Step 1: Run `clean-code-guard` on changed production code**

Scope: the five migrations, `useQuotas.tsx`, `usePlanQuotas.tsx`, the three admin pages, the four edge functions.

- [ ] **Step 2: Run `test-guard` on changed and added tests**

Scope: `useQuotas.resolution.test.ts`, `usePlanQuotas.test.tsx`, `AdminRateLimits.labels.test.ts`, `rateLimitConfig.test.ts`.

- [ ] **Step 3: Run every gate**

```bash
npx tsc --noEmit
npm test
npm run build
deno test --allow-all supabase/functions/n8n-api/
```

Expected: all green. Frontend suite at 481+ passed / 0 failed.

- [ ] **Step 4: Confirm no hardcoded copy survives**

```bash
grep -rn "PLAN_QUOTAS\|DEFAULT_QUOTAS" src/ supabase/functions/
```

Expected: no output. The only remaining hardcoded numbers are `FREE_TIER_FALLBACK` in `useQuotas.tsx` and the trailing literals inside `effective_user_quotas()`, which are documented as the query-failure guard.

- [ ] **Step 5: Fix anything the guards raised, then re-run step 3**

- [ ] **Step 6: Commit any guard fixes**

```bash
git commit -m "chore: address guard findings for unified plan quotas" -- <files>
```

- [ ] **Step 7: Report readiness for deployment**

Deployment is **not** part of this plan. Report to the user that the branch is ready and that spec §6 must be followed in order: migrations on prod first, then the four edge functions, then merge. Merging first breaks every dashboard, because `useQuotas` queries columns that would not yet exist.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| R1 plan columns | 1 |
| R2 arbiter | 2 |
| R3 backfill | 5 |
| R4 readers + writers | 3, 4 |
| R4a edge functions | 10 |
| R5 client resolution | 7 |
| R6 adapter hook | 8 |
| R7 admin UI | 8, 9 |
| R8 n8n tier | 11 |
| R9 generated types | 6 |
| §7 acceptance 1-10 | verified across 1-12; criteria 1, 2, 7 need the post-deploy live check in §6 |
| §8 test plan | 2, 3, 4, 5 (SQL), 7, 8, 9 (vitest), 11 (deno) |

**Placeholder scan:** none. Every code step carries the actual code; every command is exact and was run against the live container during planning.

**Type consistency:** `QuotaLimits` (Task 7) is used by `resolvePlanLimits` only. `PlanQuota` (Task 8) is the admin-facing shape and deliberately differs — it carries `id`, `plan_slug` and `plan_name`. `TierLimitRow` (Task 11) matches the `tier_rate_limits` column names exactly. `effective_user_quotas` returns `profile_limit` mapped onto `max_profiles`, consistently in both the SQL (Task 2) and the TypeScript resolver (Task 7).

**Known gap, deliberately left:** acceptance criteria 1, 2 and 7 are live-behaviour checks that cannot run before deployment. They are listed in spec §6 as the completion gate, not skipped.
