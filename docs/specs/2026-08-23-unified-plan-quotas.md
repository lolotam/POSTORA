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
- Plan *assignment* is unchanged: which plan a user is on, Stripe price IDs, and
  the checkout flow are untouched. `stripe-webhook` is modified only to stop
  writing quota numbers (R4a).

---

## 1. Problem

Four separate defects, one root cause: plan entitlements have no single home.

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

### 1.2 Eight hardcoded copies of the same table, kept in sync by overwrite

The plan numbers are duplicated verbatim in **eight** places — five in
TypeScript, three in SQL:

| # | Copy | Location | Free values it writes |
|---|---|---|---|
| 1 | Client resolution | `src/hooks/useQuotas.tsx:29-51` (`PLAN_QUOTAS`) | 2/3/30/2/20 |
| 2 | Admin page defaults | `src/pages/admin/AdminPlanQuotas.tsx:39-66` (`DEFAULT_QUOTAS`) | 2/3/30/2/20 |
| 3 | Stripe events | `supabase/functions/stripe-webhook/index.ts:20-46` | 2/3/30/2/20 |
| 4 | Manual re-sync | `supabase/functions/sync-user-quotas/index.ts:26-48` | 2/3/30/2/20 |
| 5 | Backfill utility | `supabase/functions/backfill-subscription/index.ts:19-45` | 2/3/30/2/20 |
| 6 | Post trigger | `enforce_post_quota_on_insert()` | 2/3/30/2/20 |
| 7 | Signup trigger | `handle_new_user_quota()` on `auth.users` | **1 profile / 4 accounts** / 30 |
| 8 | Subscription trigger | `set_user_quotas_for_plan()`, called by `handle_subscription_change()` on `user_subscriptions` | **1 post/day** / 30 / 2 / 3 / 20 |

Columns are `profiles/accounts/month/day/uploads`.

**Copies 7 and 8 explain every anomaly in the live data of §2.**
`handle_new_user_quota` writes `max_profiles=1, max_social_accounts=4` at
signup — that is the 46-row bucket. `set_user_quotas_for_plan` declares free as
`max_posts_per_day = 1` — that is the 12-row legacy bucket. Neither value
appears in any TypeScript copy, so the frontend has been showing numbers the
database never agreed with.

`stripe-webhook` writes `PLAN_QUOTAS[planSlug]` wholesale into `user_quotas` on
subscription create, plan change, and cancellation, and `handle_subscription_change`
does the same from a database trigger. That is how the 7 current paying users
hold correct rows. Two consequences:

- **An admin's deliberate per-user grant is destroyed by the next Stripe event
  for that user** — the webhook `update`s the whole quota object, not a diff.
- Editing a plan's numbers requires changing eight copies across five files and
  three database functions, then redeploying three edge functions. Nothing on
  `/admin/plan-quotas` participates.

The copies have already drifted from each other: all five TypeScript copies
declare free `max_social_accounts = 3`, while copy 7 writes `4` — which is what
46 live free users actually hold (§2).

**This is why R4a exists.** Under NULL-means-inherit, a webhook that keeps
writing concrete values would hand every subscriber an explicit override equal
to their plan at that moment — later plan edits would then never reach a single
paying user, silently defeating this entire change.

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
§3 R3 states the rule that avoids this.

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

All three limit **readers** resolve through `effective_user_quotas(user_id)`
instead of selecting `user_quotas.max_*` directly:

- `can_create_post()`
- `enforce_post_quota_on_insert()`
- `can_upload_media()`

Admin bypass, the `-1` unlimited check, the real-usage `COUNT(*)` recount, and
the `POST_QUOTA_*` error codes are all unchanged.

All three limit **writers** stop writing limits (copies 6, 7, 8 of §1.2):

- `enforce_post_quota_on_insert()` — inserts NULL limits, as above.
- `handle_new_user_quota()` — inserts NULL limits; it exists to create the
  counter row at signup, not to decide entitlements.
- `set_user_quotas_for_plan(p_user_id, p_plan_slug)` — rewritten to **clear**
  the five override columns to NULL rather than write plan values, so a
  subscription change makes the user inherit their new plan. Its signature is
  preserved because `handle_subscription_change()` calls it; the `p_plan_slug`
  argument becomes unused and is documented as retained for compatibility.

`increment_media_uploads()`, `reserve_ai_generation_quota()` and
`release_ai_generation_quota()` touch counters only and are not modified.

### R4a — Edge functions stop writing plan values

`stripe-webhook`, `sync-user-quotas` and `backfill-subscription` each hold a
`PLAN_QUOTAS` constant and `update`/`insert` it wholesale into `user_quotas`
(copies 3, 4, 5 of §1.2). All three:

- delete their `PLAN_QUOTAS` constant;
- write `{ max_profiles: null, max_social_accounts: null, max_posts_per_month: null,
  max_posts_per_day: null, max_media_uploads_per_day: null }` in place of the
  plan object, so the user inherits from `subscription_plans`;
- keep every other field they write (counters, reset dates, `user_id`) unchanged.

**Without this requirement the change is inert for paying users.** A webhook
that keeps writing concrete numbers converts every subscriber into a permanent
explicit override at their plan's values as of that moment, and no later edit on
`/admin/plan-quotas` would ever reach them.

This also narrows the second consequence in §1.2. An admin's deliberate per-user
grant now survives every ordinary Stripe event — renewal, payment succeeded,
payment failed — because those paths no longer touch the limit columns at all.
A **plan change** still clears the grant back to inherit, which is the intended
reading: moving a user to a different plan resets what they are entitled to.
Admins re-granting after a plan change is a deliberate, visible step, not the
silent wholesale overwrite that happens today.

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

1. Apply **all** migrations `20260823140000` through `20260823140500` on prod via
   `ssh-contabo-mcp`, as one set, in filename order, verifying only after the last.

   **They must not be applied individually.** `140000` drops the `user_quotas` limit
   defaults (A1), so from that moment new signups get NULL limits — and the *current*
   `increment_media_uploads()` treats a NULL limit as unlimited. Applying `140000`
   without `140200` therefore opens an unlimited-upload window. Surfaced by the Task 1
   implementer during rehearsal.
2. Verify: `SELECT slug, profile_limit, max_posts_per_day FROM subscription_plans;`
   returns the three seeded rows.
3. Verify the backfill matches the R3 table.
4. Redeploy **four** edge functions per `docs/runbooks/deploy-edge-function.md`
   (copy into the functions volume, verify SHA256, then
   `docker compose -p postorasupabase-supabase-j8axyh up -d --no-deps functions`
   once for all four):
   - `n8n-api` (R8)
   - `stripe-webhook`, `sync-user-quotas`, `backfill-subscription` (R4a)
5. Verify no writer still sends plan values:
   `grep -rn "PLAN_QUOTAS" supabase/functions/` returns nothing.
6. **Then** merge to `main`.

`stripe-webhook` is the ordering risk inside step 4: while the migration is
applied but the old webhook is still deployed, a Stripe event would write
concrete plan values into `user_quotas` and re-create an override for that user.
The window is minutes and the fix is a one-line `UPDATE … SET max_* = NULL` for
any user whose row gained values during it. Check with:
`SELECT user_id FROM user_quotas WHERE max_posts_per_day IS NOT NULL;` — it must
return only the admin row.

---

## 7. Acceptance criteria

1. Editing Pro's monthly posts to 1000 on `/admin/plan-quotas` is visible in a
   Pro user's dashboard on next refresh, with no code change or redeploy.
2. A Pro user whose `user_quotas` limits are all NULL can create their 3rd post
   of the day — proving the trigger resolves the plan rather than the row.
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
8. After a subscription create/change/cancel event, the affected user's five
   `user_quotas.max_*` columns are NULL — no writer re-creates an override.
9. `grep -rn "PLAN_QUOTAS" supabase/functions/ src/` returns nothing.
10. Gates green: `npx tsc --noEmit`, `npm test`, `npm run build`,
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
- `handle_new_user_quota` inserts NULL limits at signup.
- `set_user_quotas_for_plan` clears the five override columns to NULL.
- `can_upload_media` resolves the plan's upload limit for a NULL override.

**Frontend** (vitest):

- `useQuotas` resolves plan → override → fallback in that order.
- `useQuotas` falls back to free literals when the plan query errors.
- `usePlanQuotas` round-trips an edit.

**Edge** (`deno test`):

- `rateLimitConfig` prefers a user override over a tier row.
- It prefers a tier row over the global setting.
- It falls through to the global setting when no tier row matches.
- It degrades to the in-memory map when the plan lookup errors.

---

## 9. Codex round-1 objections and disposition

One adversarial read-only round (codex-cli 0.147.0, thread `01a02e70`), run before any
implementation. **All 15 objections accepted; no false positives.** Five were verified
against the production database rather than accepted on reading. The amendments below
are binding and supersede the requirement text above where they conflict.

| # | Severity | Objection | Disposition |
|---|---|---|---|
| 1 | BLOCKER | Omitted INSERT columns take `user_quotas` defaults (2/4/2/20/20), not NULL | **A1** |
| 2 | BLOCKER | `increment_media_uploads()` reads the media limit; NULL makes it an unlimited bypass | **A2** |
| 3 | BLOCKER | `stripe-webhook` never writes `plan_id`; clearing overrides inherits the old plan | **A3** |
| 4 | BLOCKER | Backfill compares against nullable plan columns instead of plan-or-literal | **A4** |
| 5 | BLOCKER | No uniqueness on active subscriptions; arbiter and backfill can disagree | **A5** |
| 6 | MAJOR | `subscription_plans` public policy is `is_active = true` only | **A6** |
| 7 | BLOCKER | Free users have no subscription row, so the tier step is skipped | **A7** |
| 8 | MAJOR | No `tier_rate_limits` rows exist for n8n endpoints and no admin insert path | **A8** |
| 9 | MAJOR | UI would advertise a daily n8n cap that is never enforced | **A9** |
| 10 | MAJOR | `usePlanQuotas` maps NULL to `0` and persists zeroes on save | **A10** |
| 11 | MINOR | Media denial message reads the raw override, not the resolved limit | **A11** |
| 12 | MAJOR | Admin page "Important Notes" markup becomes false and destructive | **A12** |
| 13 | MAJOR | The invariant assertion does not compare before against after | **A13** |
| 14 | MAJOR | `SECURITY DEFINER` arbiter granted to `authenticated` leaks other users' limits | **A14** |
| 15 | MINOR | Whole-row seed guard is not idempotent per column | **A15** |

### Verified against production before acceptance

- **#1** — `user_quotas` column defaults are `max_profiles=2, max_social_accounts=4,
  max_posts_per_day=2, max_posts_per_month=20, max_media_uploads_per_day=20`. The
  plan's own Task 4 assertions would have failed on first run.
- **#2** — `increment_media_uploads()` selects `max_media_uploads_per_day`. With NULL,
  both `v_max_uploads = -1` and `v_current_uploads >= v_max_uploads` evaluate to NULL,
  so it increments unconditionally. Its missing-row branch hardcodes `20`.
- **#3** — `stripe-webhook/index.ts:386-394` writes `status`, both period columns and
  `cancel_at_period_end`, and never `plan_id`. The `user_subscriptions_status_check`
  constraint permits `active|cancelled|expired|past_due` — not the `canceled` Stripe sends.
- **#6** — the policy is literally `(is_active = true)`. §3 R1's "no policy change is
  required and none is made" was wrong.
- **#7** — 66 users hold `user_quotas` rows against 7 active subscriptions, so most free
  users have no `user_subscriptions` row at all.

### Binding amendments

**A1** — Task 1's migration additionally issues
`ALTER TABLE public.user_quotas ALTER COLUMN <col> DROP DEFAULT` for all five limit
columns, and every rewritten INSERT names all five columns explicitly with `NULL`.
Belt and braces: the dropped default is the real fix, the explicit NULL documents intent.

**A2** — `increment_media_uploads()` joins the reader list of R4. It resolves its limit
through `effective_user_quotas()`, and its missing-row branch inserts NULL limits.

**A3** — R4a is extended. `stripe-webhook` must, in addition to clearing overrides:
resolve the new plan's `id` from `newPlanSlug` and write `plan_id` on an actual plan
change; write a status permitted by `user_subscriptions_status_check` (`cancelled`, not
`canceled`); check and log every database error instead of discarding it; and clear
overrides **only** on a create, plan change, or cancellation — not on every
`customer.subscription.updated` event, which would erase deliberate admin grants.

**A4** — The backfill COALESCEs every resolved plan column to its free literal before
the CASE ladder, mirroring `effective_user_quotas()` exactly. This supersedes the
narrower "keep the override when the plan column is NULL" rule.

**A5** — Both the arbiter and the backfill select the active subscription with
`ORDER BY current_period_end DESC NULLS LAST, created_at DESC, id DESC`. A pre-migration
assertion fails the deployment if any user holds more than one active subscription. No
uniqueness constraint is added — none is needed at 0 duplicates, and one could fail on
legacy rows.

**A6** — A new owner-scoped SELECT policy lets an authenticated user read the
`subscription_plans` row referenced by their own active subscription, regardless of
`is_active`. The existing active-only public policy is unchanged.

**A7** — `fetchPlanSlug()` resolves a caller with no active subscription to `'free'`,
not NULL. The test asserting the tier step is skipped is inverted: a Free tier row must
outrank the global setting.

**A8** — A migration seeds `tier_rate_limits` rows for the n8n endpoints across all three
plans. Without them acceptance criterion 7 cannot pass, because `AdminRateLimits` has no
insert path — it only updates rows the table already returns.

**A9** — The admin UI disables the daily field for endpoints whose runtime enforces only
the hourly value, with an explicit "hourly only" notice.

**A10** — `usePlanQuotas` preserves NULL rather than coercing to `0`, and never persists
a `0` that originated as NULL.

**A11** — The media-limit denial message uses the resolved limit, not a fresh read of
`user_quotas.max_media_uploads_per_day`.

**A12** — The admin page's "Important Notes" markup is rewritten for NULL-inheritance and
immediate effect, and warns that the sync action clears per-user overrides.

**A13** — The backfill test snapshots all five effective values for every fixture before
the migration and asserts, after it, that no value decreased under `-1`-aware
comparison. A Business fixture is added.

**A14** — `effective_user_quotas()` is granted to `service_role` only. No client path
calls it, and the SQL readers that do are `SECURITY DEFINER` executing as the definer,
so they need no grant. Revoking is safer than an `auth.uid()` guard and cannot break the
post trigger, which runs with `auth.uid()` NULL.

**A15** — Each plan column is seeded independently with
`COALESCE(<existing>, <seed>)` rather than guarding the whole row on one column, so a
partially-seeded row is repaired and an edited column is preserved.
