# Competitor tracking and retention — release runbook

**Scope:** the four migrations of Task 8 (M1–M4) and the two Edge Functions that
depend on them (`competitor-tracking-report`, `competitor-retention`).

**What this runbook is NOT:** it is not a release authorization and it does not
perform anything by itself. Every step below is executed BY HAND, in the stated
order, by the owner of the release. A migration that is applied but not verified,
or a function that is deployed but not booted, is not a deployed migration and
not a deployed function.

**Related documents**

| Document | What it owns |
|---|---|
| [`docs/plans/2026-10-30-competitor-ui-and-retention.md`](../plans/2026-10-30-competitor-ui-and-retention.md) | The implementation sequence and the validation commands V1–V6 |
| [`docs/specs/2026-10-30-competitor-ui-and-retention.md`](../specs/2026-10-30-competitor-ui-and-retention.md) | The contract: §5 the read boundary, §6 the analytics, §7 the retention and concurrency rules |
| [`docs/runbooks/deploy-edge-function.md`](deploy-edge-function.md) | HOW a function is deployed and booted on this self-hosted stack |
| [`docs/journeys/2026-10-30-competitor-ui-and-retention.md`](../journeys/2026-10-30-competitor-ui-and-retention.md) | What is actually proven so far, and what is still open |

---

## 0. The order, in one screen

```
1. rehearse M1 → M2 → M3 → M4 on a DISPOSABLE database      (never production)
2. apply M1, M2, M3, M4 to production AS supabase_admin      (manual, BEFORE the merge)
3. verify the catalog, the ACLs and the switch                     (§2, §3, §4)
4. deploy the two Edge Functions and prove they boot         (§6)
5. run a DRY RUN of the retention and read the numbers       (§7)
6. merge the frontend / the function changes                 (the orchestrator's call)
7. activation is a SEPARATE, LATER approval                  (§8)
```

**Why the migrations come first.** The automatic edge deploy runs every two
minutes against `origin/main`. A merge that carries both a migration and a
function that needs the new schema deploys the function within two minutes,
against the OLD database: the function boots fine and only fails when it
touches the missing object, so neither the health check nor the boot probe
sees it. The migration therefore has to be applied and verified BEFORE the
merge. This is the same rule `CLAUDE.md` states for the whole repository.

---

## 1. The migration inventory

All four files live in `supabase/migrations/`. The names are exact; a renamed
file invalidates this runbook and the plan's inventory together.

| ID | Exact file | What it adds | Owner |
|---|---|---|---|
| **M1** | `supabase/migrations/20261030100000_competitor_capture_coverage.sql` | `public.competitor_capture_coverage` (one row per `(watchlist_id, captured_on)`), its two indexes, and `public.persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)` | `supabase_admin` |
| **M2** | `supabase/migrations/20261030110000_competitor_tracking_report.sql` | `public.read_own_competitor_tracking_report(jsonb)` and its three read indexes | `supabase_admin` |
| **M3** | `supabase/migrations/20261030120000_competitor_retention.sql` | `idx_competitor_watchlist_retention_eligible`, the `competitor_retention_enabled` setting, and `public.run_competitor_retention_batch(integer,integer,boolean)` | `supabase_admin` |
| **M4** | `supabase/migrations/20261030130000_competitor_retention_cron.sql` | ONE cron job `competitor-retention`, installed **inactive** | `supabase_admin` |

**Apply as `supabase_admin`.** `postgres` is not a superuser on this stack, and a
`REVOKE` by a non-owner is a WARNING that changes nothing: the migration would
look applied while the ACLs stayed wide open.

**M1 keeps the v1 writer callable.** `persist_competitor_collection_result_v2`
is a NEW function; the v1 writer keeps its signature and its behaviour, so a
collector that is still on v1 is not broken by M1.

**M2 does not change any existing function, return type or grant.** It adds a
reader and three indexes. The existing owner quota RPC
`read_own_competitor_quota()` and the owner report are untouched.

**M3 preserves the remove/reactivate RPCs.** The owner path still flips
`is_active` and stamps `removed_at`; it never deletes a row. The physical
deletion is the retention batch, and it is service-only.

**M4 never activates itself.** Re-applying the file re-asserts the schedule,
the command and `active := false`. It also FAILS loudly (an exception naming
the missing prerequisite) when `pg_cron`, `pg_net` or `public.get_cron_secret()`
is absent: a schedule that was not installed must never look like one that was.

### 1.1 The dry rehearsal, before production

The plan's V3 runs the migrations against a disposable PostgreSQL container with
no published port and no network:

```bash
docker run -d --name postora-task8-sql --network none \
  -e POSTGRES_PASSWORD=postgres -v "$PWD:/repo:ro" \
  supabase/postgres:17.6.1.158 \
  -c cron.database_name=competitor_ui_harness \
  -c shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault
docker inspect --format '{{.State.Health.Status}}' postora-task8-sql
# continue only after "healthy"
docker exec -e HARNESS_DB_NAME=competitor_ui_harness postora-task8-sql \
  bash -c "cd /repo && bash scripts/db-harness.sh 'postgres://supabase_admin:postgres@localhost:5432/postgres'"
```

`postgres` there is an intentionally disposable fixture password, not a
production credential. The harness replays the committed baseline plus the
newer migrations, and the SQL suites
(`supabase/tests/competitor_capture_coverage.sql`,
`supabase/tests/competitor_tracking_report.sql`,
`supabase/tests/competitor_retention.sql`,
`supabase/tests/competitor_retention_cron.sql`) plus the MANUAL two-session
race fixture (`supabase/tests/competitor_retention_race_fixture.sql`) are
part of that rehearsal. The race fixture is a manual suite: it needs two
`psql` sessions and a real lock wait, so it is never "run" by a single
command.

---

## 2. Catalog verification

Run each of these AS `supabase_admin` after applying M1–M4. The expected
results are stated next to every query; a different result is a reason to stop,
not to continue.

**2.1 The three functions exist with the exact signatures**

```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer,
       p.proconfig AS settings
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'persist_competitor_collection_result_v2',
     'read_own_competitor_tracking_report',
     'run_competitor_retention_batch')
 ORDER BY p.proname;
```

Expected exactly three rows:

| proname | arguments | security_definer | settings |
|---|---|---|---|
| `persist_competitor_collection_result_v2` | `uuid, uuid, bigint, jsonb` | `true` | `search_path=...` |
| `read_own_competitor_tracking_report` | `jsonb` | `true` | `search_path=public, pg_temp`, `TimeZone=UTC` |
| `run_competitor_retention_batch` | `integer, integer, boolean` | `true` | `search_path=public, pg_temp` |

A `security_definer` function WITHOUT a fixed `search_path` is a finding: stop
and fix the migration, do not continue.

**2.2 The table and the six indexes exist**

```sql
SELECT to_regclass('public.competitor_capture_coverage') AS coverage_table;

SELECT indexname
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN (
     'idx_competitor_capture_coverage_owner_captured',
     'idx_competitor_capture_coverage_watchlist_captured',
     'idx_competitor_watchlist_owner_state_created',
     'idx_competitor_profile_snapshots_watchlist_user_captured_at',
     'idx_competitor_media_snapshots_watchlist_user_media_captured',
     'idx_competitor_watchlist_retention_eligible')
 ORDER BY indexname;
```

Expected: the first query returns `competitor_capture_coverage` (not NULL), the
second returns exactly six rows.

**2.3 The M4 job exists, exactly once, inactive**

```sql
SELECT count(*) AS job_count
  FROM cron.job
 WHERE jobname = 'competitor-retention';

SELECT jobid, jobname, schedule, active, command
  FROM cron.job
 WHERE jobname = 'competitor-retention';
```

Expected: `job_count = 1`, and one row with `schedule = '20 * * * *'` and
`active = false`. The `command` must contain `get_cron_secret()` and must NOT
contain a literal credential: it is a template, not a secret.

If `pg_cron` or `pg_net` is missing, M4 raised an exception and NOTHING was
installed. That is the intended behaviour: report "not installed", never
"installed".

---

## 3. ACL verification

This stack carries `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS`, so the
`REVOKE`s in the migrations are load-bearing. "REVOKE FROM PUBLIC" alone would
leave every role holding EXECUTE.

**3.1 The report reader: authenticated only**

```sql
SELECT has_function_privilege('anon',        'public.read_own_competitor_tracking_report(jsonb)', 'EXECUTE') AS anon_may_execute,
       has_function_privilege('authenticated','public.read_own_competitor_tracking_report(jsonb)', 'EXECUTE') AS authenticated_may_execute,
       has_function_privilege('service_role', 'public.read_own_competitor_tracking_report(jsonb)', 'EXECUTE') AS service_role_may_execute;
```

Expected: `anon_may_execute = false`, `authenticated_may_execute = true`,
`service_role_may_execute = false`.

The service role is revoked ON PURPOSE. The reader derives the owner from
`auth.uid()`, so it must run as the CALLER: the Edge function forwards the
verified user's bearer, and a service-role call would have no user to scope to.

**3.2 The retention batch: service only**

```sql
SELECT has_function_privilege('anon',        'public.run_competitor_retention_batch(integer,integer,boolean)', 'EXECUTE') AS anon_may_execute,
       has_function_privilege('authenticated','public.run_competitor_retention_batch(integer,integer,boolean)', 'EXECUTE') AS authenticated_may_execute,
       has_function_privilege('service_role', 'public.run_competitor_retention_batch(integer,integer,boolean)', 'EXECUTE') AS service_role_may_execute;
```

Expected: `false`, `false`, `true`.

**3.3 The coverage writer: service only**

```sql
SELECT has_function_privilege('anon',        'public.persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)', 'EXECUTE') AS anon_may_execute,
       has_function_privilege('authenticated','public.persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)', 'EXECUTE') AS authenticated_may_execute,
       has_function_privilege('service_role', 'public.persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)', 'EXECUTE') AS service_role_may_execute;
```

Expected: `false`, `false`, `true`.

**3.4 The coverage table**

```sql
SELECT has_table_privilege('anon',        'public.competitor_capture_coverage', 'SELECT') AS anon_may_select,
       has_table_privilege('anon',        'public.competitor_capture_coverage', 'INSERT,UPDATE,DELETE') AS anon_may_write,
       has_table_privilege('authenticated','public.competitor_capture_coverage', 'SELECT') AS authenticated_may_select,
       has_table_privilege('authenticated','public.competitor_capture_coverage', 'INSERT,UPDATE,DELETE') AS authenticated_may_write,
       has_table_privilege('service_role', 'public.competitor_capture_coverage', 'SELECT,INSERT,UPDATE,DELETE') AS service_role_may_write;
```

Expected: the browser roles may SELECT and may NOT write; the service role may
write. The owner SELECT is additionally narrowed to the owner's own rows by the
table's RLS policies.

---

## 4. The switch

`public.app_settings['competitor_retention_enabled']` is the master switch. It
is SERVER-CONTROLLED: it is a row an administrator maintains, never a caller
argument. The value is a JSON boolean.

```sql
SELECT key, value, jsonb_typeof(value) AS value_type, description
  FROM public.app_settings
 WHERE key = 'competitor_retention_enabled';
```

Expected after M3: exactly one row, `value = false`, `value_type = boolean`.

The four states the cleanup distinguishes:

| State | Value | Effect |
|---|---|---|
| `disabled` | `false` | Nothing is mutated. The backlog is still counted. |
| `enabled` | `true` | The cleanup may mutate. |
| `missing` | the row is absent | Nothing is mutated. Fails closed. |
| `malformed` | not a JSON boolean | Nothing is mutated. Fails closed. |

A missing or malformed switch is LOUD, not silent: the batch reports the state
in `switch_state`, so an operator can tell "the cleanup is off" apart from
"the switch could not be read".

**The RPC checks the switch too.** Bypassing the Edge wrapper cannot enable the
cleanup: `run_competitor_retention_batch` refuses to mutate anything while the
switch is off, missing or malformed.

---

## 5. What the eligibility is, exactly

```
is_active = false
AND removed_at IS NOT NULL
AND removed_at <= server_now - interval '2160 hours'
```

`2160 hours` is 90 elapsed days, and the clock is the SERVER's `now()` — there
is no owner argument, no cutoff argument and no time argument anywhere in the
batch. Exactly 90 days is eligible; 89 days and 90 days minus one microsecond
are not. Eligibility is a predicate, not a promise of deletion at an exact
second.

An ACTIVE row is never a candidate, whatever its age. A repeated removal or a
label edit does not move the clock; a reactivation clears it and a later
removal starts a new one.

---

## 6. The Edge Functions

### 6.1 The manifest

| Function | Files | `verify_jwt` | Who may call it |
|---|---|---|---|
| `competitor-tracking-report` | `index.ts`, `handler.ts`, `contracts.ts`, `reportStore.ts`, `assemble.ts`, `growth.ts`, `weeklyInventory.ts` | **`true`** | A signed-in owner. A service credential is recognised and REFUSED (403). |
| `competitor-retention` | `index.ts`, `handler.ts`, `run.ts`, `deps.ts` | **`false`** | `verifyCronOrAdmin`: the shared `CRON_SECRET` (header `x-cron-secret` or `Authorization: Bearer`), the service-role key, or a signed-in ADMIN's JWT. An ordinary user and an anonymous caller are refused. |

Both registrations are in `supabase/config.toml`:

```toml
[functions.competitor-retention]
verify_jwt = false

[functions.competitor-tracking-report]
verify_jwt = true
```

`competitor-retention` has `verify_jwt = false` because a cron call carries the
shared secret, not a user JWT; the function verifies that authority ITSELF.
`competitor-tracking-report` has `verify_jwt = true` because it resolves the
owner from the verified identity and refuses a service credential.

### 6.2 The shared modules both functions import

These live in `supabase/functions/_shared/` and must be present on the volume:

| Module | Used by |
|---|---|
| `_shared/auth-helper.ts` | `competitor-tracking-report` (`authenticateCaller`, `timingSafeTokenEqual`) |
| `_shared/cors.ts` | both (`restrictedCorsHeaders`) |
| `_shared/errorSanitizer.ts` | both (`sanitizeErrorMessage`) |
| `_shared/logging.ts` | both (`logToDatabase`, `redactSensitive`) |
| `_shared/outlierScore.ts` | `competitor-tracking-report` (`assemble.ts`, `contracts.ts`) |
| `_shared/cron-auth.ts` | `competitor-retention` (`verifyCronOrAdmin`) |

**Before copying a shared module over the volume, check who imports what you
are about to remove.** A `_shared` export that the volume has and git does not
will take the whole `functions` service into a boot crash-loop:

```bash
grep -rl "<symbol>" --include=*.ts "$VOL"
```

### 6.3 The deploy, with the SHA256 proof and the boot check

This is the procedure of [`docs/runbooks/deploy-edge-function.md`](deploy-edge-function.md),
repeated here for this manifest. The constants:

```bash
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
```

**Step 1 — copy the files out of git, not out of a working tree.**
`/root/postora-runtime` is routinely dirty and behind `main`; `git show` reads
the committed content and ignores the working tree.

```bash
cd /root/postora-runtime
git fetch origin "+refs/heads/main:refs/remotes/origin/main"
for f in index handler contracts reportStore assemble growth weeklyInventory; do
  git show "origin/main:supabase/functions/competitor-tracking-report/$f.ts" \
    > "$VOL/competitor-tracking-report/$f.ts"
done
for f in index handler run deps; do
  git show "origin/main:supabase/functions/competitor-retention/$f.ts" \
    > "$VOL/competitor-retention/$f.ts"
done
```

**Step 2 — prove the copy landed.** The two hashes on each line must match.
`git show` writes LF, so the hashes compare directly:

```bash
for f in index handler contracts reportStore assemble growth weeklyInventory; do
  echo "report/$f git=$(git show "origin/main:supabase/functions/competitor-tracking-report/$f.ts" | sha256sum | cut -d' ' -f1) vol=$(sha256sum "$VOL/competitor-tracking-report/$f.ts" | cut -d' ' -f1)"
done
for f in index handler run deps; do
  echo "retention/$f git=$(git show "origin/main:supabase/functions/competitor-retention/$f.ts" | sha256sum | cut -d' ' -f1) vol=$(sha256sum "$VOL/competitor-retention/$f.ts" | cut -d' ' -f1)"
done
```

If a hash differs, the copy did not land. Re-run Step 1. If a file was written
from a Windows checkout it carries CRLF and the hash differs even when the
content is identical — compare with `tr -d '\r' < file | sha256sum`.

**Step 3 — restart the functions service.** `restart`, NOT `up -d`: the sources
are a bind mount, so `up -d` prints "Running" and keeps serving the old code.

```bash
cd "$STACK" && docker compose restart functions
docker compose logs --tail=40 functions | tail -20
```

**Step 4 — the boot check.** A function whose module fails to load answers 5xx
only on its own path, so each function is probed on its own path. Both of these
functions answer their own preflight with **204** (`competitor-tracking-report`
returns 204 from the handler; `competitor-retention` returns 204 from
`preflight()` with `Access-Control-Allow-Methods: POST, OPTIONS`). The Kong
gateway may answer the preflight before the function is reached, in which case
the code is whatever the gateway's CORS policy returns — **200** on the other
functions of this stack. What must NOT happen is **404** (the function is not
mounted) or **5xx** (the module failed to load):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://api.postora.cloud/functions/v1/competitor-tracking-report
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://api.postora.cloud/functions/v1/competitor-retention
```

Record the two codes in the release notes. `204` or `200` is the pass; `404`
and `5xx` are the stop.

**Step 5 — the behaviour checks.** Each probe proves something DIFFERENT, and
the release notes must say which one answered.

`competitor-retention` (`verify_jwt = false`): the request reaches the
function. A **GET** is refused with **405** and `Allow: POST, OPTIONS` — and
that is a STRONG proof, because only a live function can answer it. It needs
no credential:

```bash
curl -s -i -X GET https://api.postora.cloud/functions/v1/competitor-retention | head -20
# expect: HTTP/1.1 405 ... Allow: POST, OPTIONS
```

`competitor-tracking-report` (`verify_jwt = true`): the GATEWAY verifies the
JWT before the request reaches the function, so an unauthenticated POST is
refused with **401** by the gateway. That 401 is the expected answer and it
is NOT a health signal for the function — the gateway answered it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"list","state":"active"}' \
  https://api.postora.cloud/functions/v1/competitor-tracking-report
# expect: 401 (the gateway refuses it; the function is not reached)
```

The health proof for that function is the OPTIONS probe of Step 4 plus the
function's own log line, and the first REAL request from a signed-in owner
after the merge:

```bash
cd "$STACK" && docker compose logs --tail=200 functions | grep competitor-tracking-report
```

**A function that is copied but not booted is NOT deployed.** If the retention
GET answers 404 or 5xx, stop and read `docker compose logs functions`.

---

## 7. The retention run, and what its numbers mean

### 7.1 The caps

| Cap | Value | Where it is enforced |
|---|---|---|
| One invocation's wall-clock budget | **40 seconds** | `RETENTION_BUDGET_MS` in `supabase/functions/competitor-retention/run.ts` |
| Parents processed per invocation, across ALL of its slices | **50** | `RETENTION_PARENT_LIMIT` |
| Child rows deleted per invocation, across ALL of its slices | **500** | `RETENTION_CHILD_LIMIT` |
| One database call | **5 seconds** | `RETENTION_DEPENDENCY_TIMEOUT_MS` |
| Remaining budget required before a NEW slice may start | **6 seconds** | `RETENTION_MIN_REMAINING_MS` |

The caps are OVERALL, not per slice. Every slice is asked for the REMAINING
budget, never for a fresh one, so an hourly job can never drain an unbounded
backlog. The SQL refuses a slice outside its own bounds rather than clamping it
(it raises `COMPETITOR_RETENTION_LIMIT_INVALID`, SQLSTATE `22023`): a silent
clamp would make the reported counts a lie.

The report read boundary has its own, separate budget: **15 seconds** in total
with **one second** reserved for the audit, and **5 seconds** per dependency,
a body ceiling of **4 KiB**, a default page size of **20** and a maximum of
**50** (`supabase/functions/competitor-tracking-report/contracts.ts`).

### 7.2 The dry run comes first

A dry run performs the SAME bounded reads and mutates nothing. It stays
available while the switch is off.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"dry_run":true}' \
  https://api.postora.cloud/functions/v1/competitor-retention
```

(The secret is read on the server; it is never echoed into a command that is
copied around, and it is never written into this file.)

The expected answer, with the switch still OFF:

```json
{
  "dry_run": true,
  "slices": 1,
  "parents_processed": 0,
  "parents_deleted": 0,
  "parents_projected": 2,
  "parents_skipped_live_lease": 0,
  "parents_skipped_ineligible": 0,
  "children_counted": 37,
  "children_deleted": 0,
  "has_more": false,
  "switch_state": "disabled",
  "stop_reason": "completed",
  "failed": false
}
```

The numbers above are an ILLUSTRATION of the shape. The values that must hold
are the ones that do not depend on the data:

| Field | With the switch off and a dry run | Meaning |
|---|---|---|
| `dry_run` | `true` | The database echoed the flag it was given. A mismatch is refused as a malformed answer. |
| `parents_deleted` | `0` | A dry run deletes nothing. |
| `children_deleted` | `0` | A dry run deletes nothing. |
| `switch_state` | `disabled` (or `missing` / `malformed`) | The state of the server-controlled switch. |
| `stop_reason` | `completed` | A dry run is exactly one slice; it does not loop. |
| `failed` | `false` | A failed slice is never reported as an empty one. |
| `parents_projected` | the number of parents that WOULD be deleted | The preview. |
| `children_counted` | the number of child rows the preview covered | The preview. |

**The no-work expectation.** With nothing eligible:

| Field | Expected |
|---|---|
| `parents_processed` | `0` |
| `parents_projected` | `0` |
| `children_counted` | `0` |
| `children_deleted` | `0` |
| `has_more` | `false` |
| `stop_reason` | `completed` (with the switch on) or `switch_disabled` (with the switch off, after the preview) |

**The backlog expectation.** With more eligible work than one invocation may
take, `has_more` is `true` and the next hourly run continues where the
previous one stopped. A parent that was skipped because it holds a LIVE job
lease is reported in `parents_skipped_live_lease` and is still eligible work:
it is not lost, it is deferred.

**The live-run stop reasons.** A live run ends with exactly one of:
`completed`, `budget_exhausted` (the 50/500 budget is spent),
`time_budget` (less than six seconds left), `no_progress` (a slice considered
no parent), `switch_disabled` / `switch_missing` / `switch_malformed`,
`malformed_response`, `rpc_failed`, `dependency_timeout`. The three failure
reasons are reported with `failed: true` AND with the counts of the slices that
did finish: a partial run is progress, and hiding it would be a lie.

### 7.3 What every exit writes

Every exit — including a refusal, a timeout and a malformed answer — writes
one audit row through the shared logger, into `system_logs` with
`category = 'system'` and `source = 'competitor-retention'`:

```json
{
  "event": "retention_run",
  "outcome": "completed | stopped | failed",
  "reason": "<the stop reason>",
  "dry_run": true,
  "switch_state": "enabled | disabled | missing | malformed | unknown",
  "slices": 1,
  "parents_processed": 0,
  "parents_deleted": 0,
  "children_counted": 0,
  "children_deleted": 0,
  "has_more": false,
  "duration_ms": 12
}
```

The record carries COUNTS AND REASONS ONLY: no handle, no caption, no URL, no
id and no secret.

---

## 8. Activation — a SEPARATE approval

Nothing in §1–§7 enables anything. The cleanup stays inert until BOTH of the
following are done, under a separate, explicit approval, in this order:

**Step 1 — the switch.** The cleanup must not delete anything before the
schedule is ready to drain the backlog, and the schedule must not run before
the cleanup can be switched off again. So the SWITCH goes first:

```sql
UPDATE public.app_settings
   SET value = 'true'::jsonb,
       updated_at = now()
 WHERE key = 'competitor_retention_enabled';
```

Verify:

```sql
SELECT key, value, jsonb_typeof(value) FROM public.app_settings
 WHERE key = 'competitor_retention_enabled';
-- expect: value = true, jsonb_typeof = boolean
```

Then run one more dry run and confirm `switch_state` is now `enabled` and that
`parents_deleted` and `children_deleted` are STILL `0` (it is a dry run).

**Step 2 — the cron.** Only now is the schedule activated:

```sql
SELECT cron.alter_job(job_id => (SELECT jobid FROM cron.job WHERE jobname = 'competitor-retention'),
                       active := true);
```

Verify:

```sql
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'competitor-retention';
-- expect: one row, schedule = '20 * * * *', active = true
```

**The order matters in both directions.** If the cron is activated while the
switch is off, the function stops with `stop_reason = 'switch_disabled'` and
deletes nothing — safe, but it burns an hourly run for nothing. If the switch
is turned on while no schedule exists, nothing drains the backlog until an
operator calls the function by hand — also safe, but the backlog grows.

**A disabled schedule does not imply live retention works,** and an installed
schedule does not imply the cleanup works. The only evidence is a live run
whose numbers are read and understood.

---

## 9. Rollback

**The rollback never drops schema and never drops history.** It disables the
two things that can act, and nothing else.

```sql
-- 1. the schedule first: no new invocation may start
SELECT cron.alter_job(job_id => (SELECT jobid FROM cron.job WHERE jobname = 'competitor-retention'),
                       active := false);

-- 2. then the switch: no invocation may mutate anything
UPDATE public.app_settings
   SET value = 'false'::jsonb,
       updated_at = now()
 WHERE key = 'competitor_retention_enabled';
```

Verify both:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'competitor-retention';
SELECT key, value FROM public.app_settings WHERE key = 'competitor_retention_enabled';
-- expect: active = false, value = false
```

3. **Hide the UI entry** if the problem is a user-visible one: the tracked
   competitors tab is rendered by `src/features/competitor-tracking/ui/`
   through `src/pages/analytics/InstagramAnalytics.tsx`. Removing the tab
   stops the owner from reaching the feature; it does not change any data.

**What is NOT part of the rollback:**

- No `DROP TABLE`, no `DROP FUNCTION`, no `DROP INDEX`. The schema is
  additive and the history is the evidence the 90-day promise was made about.
- No `DELETE` of history by hand. The cleanup is the only thing that may
  delete, and it is the thing being switched off.
- No `git reset --hard` on the server checkout. The functions volume is a
  bind mount; `git show` reads the committed content, so the checkout does
  not need to be clean.
- No re-apply of an already applied migration. The migrations are immutable
  once applied.

**What a rollback does not undo:** rows that an ALREADY RUNNING batch deleted
are gone. The cleanup commits its slices, and a slice that commits before a
rollback stays committed. That is why the dry run and the 50/500 budget exist:
the exposure of one invocation is bounded, and it is bounded BEFORE the first
live run, not after it.

---

## 10. The concurrent races, in one paragraph

The parent row is locked `FOR UPDATE SKIP LOCKED` before anything is deleted,
and the lock order is parent → job — the same order the collection fence uses
(accounts → watchlist → job), so a collector and a cleanup cannot deadlock.

- **Reactivation wins the lock:** that slice deletes nothing, and the
  reactivation proceeds. The removal marker is cleared, so the row stops being
  a candidate.
- **The cleanup wins the lock after 90 days:** it may commit eligible
  deletions before the reactivation arrives. The reactivation then stops every
  LATER slice, but it cannot resurrect what was already deleted. This is
  exactly why the copy promises retention FOR 90 DAYS and eligibility
  afterwards — not guaranteed recovery.
- **A live job lease** stops the cleanup for that parent and is reported in
  `parents_skipped_live_lease`. An EXPIRED lease confers no write authority,
  so the abandoned work is deleted with the rest.
- **Two cleanup runs** never block each other: the second skips the parent the
  first holds.

The real two-session rehearsals (both orderings, a collector against the
cleanup, a locked candidate, an expired worker) live in
`supabase/tests/competitor_retention_race_fixture.sql` and are executed BY
HAND during the V3 rehearsal. They are not a single-command suite and no
report may claim they ran because a script exited zero.

---

## 11. What this runbook deliberately does not do

- It does not activate the cleanup or the schedule.
- It does not apply anything: every statement above is for a human to run, in
  the stated order.
- It does not prove the assembled feature. The browser journeys are mocked
  (see the journey report), and the live Meta probes and the hosted CI
  belong to parent Task 11.
- It does not touch the owner report, the quota RPCs, the remove/reactivate
  RPCs or the applied migrations of 2026-10-26/29. Those are prerequisites
  that are PRESERVED, not modified.
