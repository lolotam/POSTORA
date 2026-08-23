# Spec — Unify plan quotas under a database source of truth

Date: 2026-08-23
Branch: `feat/unified-plan-quotas`

**Goal:** every plan entitlement a user is subject to resolves from
`subscription_plans`, so an admin edit on `/admin/plan-quotas` changes real
enforcement in the client, the database trigger, and the API — and a new paid
subscriber inherits their plan's limits without a manual step.

**Completion gates** (the goal does *not* close on merge): merged to `main`
**and** the migration applied on prod **and** `n8n-api` redeployed **and** a live
edit on `/admin/plan-quotas` observably changes what a non-admin user may do.
Merging `main` auto-deploys the frontend only.

## Deliberately NOT in scope (stated to bound the goal honestly)

- `generate-hashtags` has a `rate_limit_settings` row, three `tier_rate_limits`
  rows, and **no rate-limiting code at all**. This change does not make it
  enforce.
- `user_quotas.max_ai_generations_per_day` / `ai_generations_today` are dead
  columns — nothing in `src/**` or `supabase/functions/**` reads them. Left alone.
- `supabase/functions/_shared/rate-limiter.ts` and
  `supabase/functions/ecommerce-whatsapp-api/index.ts` keep their own hardcoded
  limits.
- Stripe / billing does not learn about quotas here. Plan assignment is unchanged.

---

## 1. Problem

Three separate defects, one root cause: plan entitlements have no single home.

### 1.1 `/admin/plan-quotas` is write-only

`src/pages/admin/AdminPlanQuotas.tsx` reads and writes `app_settings` where
`key = 'plan_quotas'` (lines 90, 117, 131, 138). A repo-wide search for that key
returns those four lines and nothing else. The page shows a success toast and
changes nothing.

Live state confirmed on prod (`ssh-contabo-mcp`, 2026-08-23):

```text
app_settings where key='plan_quotas': 0 rows
```

Zero rows — the page has never completed a save. **There is no admin-tuned data
to preserve**, so the new home can be chosen freely.

### 1.2 The database enforces free-tier limits on paying users

`enforce_post_quota_on_insert()` (migration `20260804120000_enforce_post_quotas.sql`,
lines 108-131) auto-inserts a `user_quotas` row with hardcoded free values
(`max_profiles=2, max_social_accounts=3, max_posts_per_month=30,
max_posts_per_day=2, max_media_uploads_per_day=20`) for **every** user, then
enforces that row. Nothing re-syncs it when a user subscribes.

All 7 current paying users happen to hold correct rows, set by hand:

```text
business | -1 | -1   (x3)
pro      | 30 | 500  (x4)
```

So the defect is latent, not active. The **next** paid signup is capped at 2
posts/day by the trigger while `useQuotas` shows them 30 — a silent, confusing
failure at exactly the moment a customer starts paying.

### 1.3 The client and the database disagree by construction

`src/hooks/useQuotas.tsx` resolves limits from a hardcoded `PLAN_QUOTAS` map
(lines 34-50) combined with `user_quotas` via `pickMax` (lines 88-95, most
permissive wins). The database resolves them from `user_quotas` alone. The two
can never be made to agree by editing either one.

### 1.4 The same number lives on two admin screens

`profile_limit` is edited at `/admin/plans`; `max_profiles` is edited at
`/admin/plan-quotas`.

---

## 2. Live data (verified before designing the backfill)

`user_quotas` holds 66 rows in five distinct shapes:

```text
plan     | day | month | prof | accts | uploads | count
---------+-----+-------+------+-------+---------+------
none     |   2 |    30 |    1 |     4 |      20 |    46
none     |   1 |    30 |    2 |     3 |      20 |    12
pro      |  30 |   500 |   15 |    30 |      -1 |     4
business |  -1 |    -1 |   -1 |    -1 |      -1 |     3
none     |  -1 |    -1 |   -1 |    -1 |      -1 |     1
```

Column defaults on `user_quotas` are `max_profiles=2, max_social_accounts=4,
max_posts_per_day=2, max_posts_per_month=20, max_media_uploads_per_day=20`.

**Consequence for the backfill.** No single "free default" literal exists — the
46-row bucket holds `max_profiles=1` and `max_social_accounts=4`, matching
neither the column defaults nor the trigger's literals. A rule of the form
"NULL it if it equals the known default" would therefore leave 46 rows pinned at
`max_profiles=1`, *below* the free plan's 2, silently capping every free user.
§4.3 states the rule that avoids this.

The lone `none | -1 …` row is the admin account (`dr.vet.waleedtam@gmail.com`),
which must keep its unlimited grant.

---

## 3. Requirements

### R1 — Plan entitlements on `subscription_plans`

Add four nullable integer columns. `profile_limit` **stays** as the canonical
fifth — it is read by the public pricing page (`src/components/pricing/PlanCard.tsx:71`,
`PlanComparison.tsx:26`), `useSubscription.tsx:112`, `useSubscriptionPlans.tsx:11`
and `AdminUsers.tsx:540`; renaming it is a six-file breaking change for no
functional gain.

```sql
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS max_social_accounts       integer,
  ADD COLUMN IF NOT EXISTS max_posts_per_month       integer,
  ADD COLUMN IF NOT EXISTS max_posts_per_day         integer,
  ADD COLUMN IF NOT EXISTS max_media_uploads_per_day integer;
```

Seeded values, guarded `WHERE max_posts_per_day IS NULL` so a replay never
clobbers a later admin edit (the pristineness pattern established by
`20260823120000_unify_rate_limits.sql`):

```text
slug     | profile_limit | accts | month | day | uploads
---------+---------------+-------+-------+-----+--------
free     |             2 |     3 |    30 |   2 |      20
pro      |            15 |    30 |   500 |  30 |      -1
business |            -1 |    -1 |    -1 |  -1 |      -1
```

`-1` means unlimited throughout, matching existing convention.

`profile_limit` already holds 2/15/-1 on prod and is not rewritten.

**Open product decision, deliberately deferred:** free is seeded with
`max_social_accounts = 3`, matching both current code sources
(`useQuotas.tsx:35`, `AdminPlanQuotas.tsx` `DEFAULT_QUOTAS`). 46 live free users
currently hold `4`. Per R3 they keep 4 as a preserved override — nobody loses a
connected account. To later enforce 3 for everyone:
`UPDATE user_quotas SET max_social_accounts = NULL WHERE max_social_accounts = 4;`

RLS: `subscription_plans` is already publicly readable for the pricing page. The
new columns are entitlement numbers already advertised on that page, so no policy
change is required and none is made.

### R2 — `effective_user_quotas()`, the single arbiter

```sql
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
```

Resolution, per column:

```text
COALESCE(user_quotas.max_X, plan.max_X, free_literal)
```

where `plan` is the user's active `user_subscriptions` row joined to
`subscription_plans`, falling back to the `free` plan row when the user has no
active subscription. The trailing `free_literal` (2/3/30/2/20) is a last-resort
guard for the case where the `free` plan row is missing or unseeded; it is never
reached in normal operation.

`pickMax` is **deleted**. A non-null override wins outright and may raise *or*
lower a user relative to their plan — that is the point, per the approved
override rule.

Granted to `authenticated, service_role`. `SECURITY DEFINER` with a pinned
`search_path` per ARCHITECTURE.md §23; it reads only the caller-supplied
`p_user_id` and performs no writes.

### R3 — Backfill: capability-preserving

The invariant: **no user's effective limit may decrease as a result of this
migration.**

For each `user_quotas` row and each `max_*` column, set the column to `NULL`
(inherit) **unless** the stored value is strictly more permissive than the value
that column resolves to from the user's plan, where `-1` is the most permissive
value of all.

Expected outcome on the live 66 rows:

| Bucket | Count | Result |
|---|---|---|
| `none` 2/30/1/4/20 | 46 | day, month, uploads → NULL; `max_profiles` 1 → NULL (**rises** to 2); `max_social_accounts` 4 → **kept** (more permissive than plan's 3) |
| `none` 1/30/2/3/20 | 12 | all → NULL; `max_posts_per_day` 1 → NULL (**rises** to 2) |
| `pro` 30/500/15/30/-1 | 4 | all → NULL (identical to plan) |
| `business` all -1 | 3 | all → NULL (identical to plan) |
| `none` all -1 (admin) | 1 | all **kept** (more permissive than free plan) |

Two rows-classes therefore retain overrides after backfill: the admin's
unlimited row, and 46 rows holding `max_social_accounts = 4`. Both are
deliberate and visible in `/admin/users`.

### R4 — Trigger and `can_create_post` resolve the plan

`enforce_post_quota_on_insert()` keeps its
`INSERT … ON CONFLICT (user_id) DO NOTHING` — the row is still required as a
`FOR UPDATE` lock target and counter home — but inserts **NULL** limits instead
of the free-tier literals. The row becomes purely counters + lock.

Both `enforce_post_quota_on_insert()` and `can_create_post()` read their limits
from `effective_user_quotas(user_id)` instead of selecting `user_quotas.max_*`
directly. Admin bypass, the `-1` unlimited check, the real-usage `COUNT(*)`
recount, and the `POST_QUOTA_*` error codes are all unchanged.

This is what makes a new Pro subscriber inherit 30/day with no manual step —
the fix for §1.2.

### R5 — Client resolution (`src/hooks/useQuotas.tsx`)

Delete the `PLAN_QUOTAS` constant and `pickMax`. Add one React Query fetch of the
`subscription_plans` row for `effectivePlanSlug`, then COALESCE the `user_quotas`
override over it, mirroring R2 exactly.

A dedicated query is required rather than reusing `useSubscription`: that hook
returns `dbSubscription: null` for a user with no subscription row
(`useSubscription.tsx:107`), so it never carries a plan row for free users — who
are the majority.

The hardcoded free literals survive **only** as the query-failure fallback, and
are marked as such.

### R6 — Plan-quota adapter (`src/hooks/usePlanQuotas.tsx`, new)

ARCHITECTURE.md §11 forbids new raw Supabase queries inside pages.
`AdminPlanQuotas.tsx` currently holds four. This hook owns reading and writing
the five plan entitlement columns; the page consumes it.

### R7 — Admin UI

- `AdminPlanQuotas.tsx` — repointed at `subscription_plans` through R6. Renders
  `profile_limit` as its Social Profiles field, so it and `AdminPlans` write the
  same column and the duplication of §1.4 disappears.
- `AdminPlans.tsx` — keeps its profile input (same column), gains a label noting
  the shared value and a link to the quotas page.
- `AdminRateLimits.tsx` — hide the per-tier controls for endpoints that have no
  enforcing code, so the page stops offering limits nothing reads.

### R8 — Tier resolution in `n8n-api`

`supabase/functions/n8n-api/rateLimitConfig.ts` gains a step between the user
override and the global setting: resolve the caller's plan slug, then look up
`tier_rate_limits` on `(plan_slug, endpoint)`. Injected query functions, matching
the module's existing testable-without-a-database shape.

Two consequences stated plainly:

1. This adds a **new** `user_subscriptions` → `subscription_plans` lookup per
   request. `generate-caption` gets its plan slug for free from a subscription
   gate it already runs; `n8n-api` has no such gate. No cache is added — at the
   ~16 events/day measured on 2026-08-22 the latency is irrelevant, matching the
   reasoning already recorded in `2026-08-23-unified-rate-limits.md` §4.
2. It **reverses** `2026-08-23-unified-rate-limits.md` §4, which lists "No tier
   limits for n8n endpoints" as an explicit non-goal. That was a deliberate
   scoping decision shipped this morning, now deliberately revisited. This spec
   supersedes it on that one point only.

`tier_rate_limits` currently holds 9 rows, all AI endpoints. No
`post-create` or `/api/v1/upload-media` tier rows exist, so the original brief's
instruction to delete them is a no-op and no deletion is performed.

### R9 — Generated types

`src/integrations/supabase/types.ts` is regenerated after the migration
(ARCHITECTURE.md §23: schema changes must be reflected in maintained types).

---

## 4. Ownership boundary (the rule this spec establishes)

| Question | Owner | Where |
|---|---|---|
| What does this plan buy? | Plan entitlement | `subscription_plans` |
| Does this one user get a different deal? | Per-user override | `user_quotas.max_*`, NULL = inherit |
| How much has this user consumed? | Counters | `user_quotas.posts_today`, … |
| Is this caller hammering an endpoint? | Rate limit | `rate_limit_settings` / `tier_rate_limits` / `user_rate_limits` |

Quotas are accounting balances that reset per billing period. Rate limits are
stateless per-window burst control. They are not merged, and neither is derived
from the other.

---

## 5. Non-goals

- No caching layer for the resolution queries.
- No change to which routes are rate-limited.
- No change to Stripe, plan assignment, or the pricing page's rendering.
- No new tables. Four columns and one function.

---

## 6. Deployment (order is load-bearing)

Merging to `main` auto-deploys **the frontend only**. R5 queries columns that do
not exist until the migration runs, so a merge-first sequence breaks every
dashboard.

1. Apply the migration on prod via `ssh-contabo-mcp`.
2. Verify: `SELECT slug, profile_limit, max_posts_per_day FROM subscription_plans;`
   returns the three seeded rows.
3. Verify the backfill matches the R3 table.
4. Redeploy `n8n-api` per `docs/runbooks/deploy-edge-function.md` (copy into the
   functions volume, verify SHA256, `docker compose -p postorasupabase-supabase-j8axyh
   up -d --no-deps functions`).
5. **Then** merge to `main`.

---

## 7. Acceptance criteria

1. Editing Pro's monthly posts to 1000 on `/admin/plan-quotas` is visible in a
   Pro user's dashboard on next refresh, with no code change or redeploy.
2. A user with no `user_quotas` override on the Pro plan can create a 3rd post in
   a day (today's trigger blocks at 2).
3. A user with `user_quotas.max_posts_per_day = 1` is blocked at 1 even on
   Business — override lowers, not just raises.
4. After backfill, `SELECT count(*) FROM user_quotas WHERE max_posts_per_day IS NOT NULL`
   returns 1 (the admin row).
5. No user's effective limit is lower after the migration than before, for any of
   the five columns.
6. `/admin/plan-quotas` and `/admin/plans` show the same profile number, and
   editing it on either is visible on the other.
7. A Free-tier API key exceeding the Free `tier_rate_limits` row for a
   `/api/v1/*` endpoint receives `429`.
8. Gates green: `npx tsc --noEmit`, `npm test`, `npm run build`,
   `deno test supabase/functions/n8n-api/`.

---

## 8. Test plan

**Database** (pgTAP-style assertions run through `psql` against a throwaway DB,
per the rehearsal pattern in memory — `supabase start` is broken locally):

- `effective_user_quotas` returns plan values when the override is NULL.
- It returns the override when set, both above and below the plan.
- It returns free-plan values for a user with no subscription.
- `-1` propagates as unlimited from either layer.
- The trigger admits a Pro user's 3rd daily post.
- The trigger still blocks a Free user's 3rd daily post.
- The trigger inserts NULL limits, not literals, for a brand-new user.

**Frontend** (vitest):

- `useQuotas` resolves plan → override → fallback in that order.
- `useQuotas` falls back to free literals when the plan query errors.
- `usePlanQuotas` round-trips an edit.

**Edge** (`deno test`):

- `rateLimitConfig` prefers a user override over a tier row.
- It prefers a tier row over the global setting.
- It falls through to the global setting when no tier row matches.
- It degrades to the in-memory map when the plan lookup errors.
