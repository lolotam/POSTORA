# supabase/tests — Postgres integration harness

`scripts/db-harness.sh` proves database changes against a production-shaped
database.

> The `Postgres baseline plus delta` job in `.github/workflows/ci.yml` runs
> this harness. A configured job is not proof of successful hosted execution:
> inspect the final revision's actual checks before merging. Run the harness
> locally against an isolated database as well when changing migrations or suites.

## What it does

The migration history is **not replayable from scratch** — 12 of 253
migrations can only ever succeed against the production database (finding
below). So the harness does not replay history. It:

1. creates a fresh throwaway database,
2. restores `baseline_schema.sql` — a committed, schema-only pg_dump of the
   production schemas (`public`, `auth`, `storage`, `realtime`),
3. applies **only** migrations strictly newer than the baseline marker,
4. runs the SQL suites:

| Suite | Notes |
|---|---|
| `partner_api_test.sql` | partner API behaviour; rolls itself back |
| `partner_api_tenancy_negative.sql` | 32 negative-tenancy assertions; must run as superuser (it `SET ROLE`s away to make its grant checks meaningful); self-cleaning |
| `partner_api_credential_lifecycle.sql` | key lifecycle RPCs (create/rotate/revoke) and their audit trail; self-cleaning |
| `partner_api_dispatch_intents.sql` | D13 dispatch-intent state machine: tenancy, CHECKs, natural key, transition guard, key-survival, grant surface; must run as superuser (SET ROLE grant checks); self-cleaning |
| `partner_hub_admin.sql` | Admin Partner Hub readers, admin key lifecycle in foreign workspaces, ledger columns; self-cleaning |
| `log_system_event.sql` | consent-log RPC: actor binding, service allow-list, grant surface; self-cleaning |
| `whatsapp_workspace_crm.sql` | pgTAP; rolls itself back |
| `import_whatsapp_contacts_to_workspace.sql` | pgTAP; rolls itself back |
| `instagram_capabilities.sql` | capability generations, credential access and stale-response fencing; rolls back |
| `facebook_user_credential_bindings.sql` | protected User-token authority, ownership, account connection versions, detach/rebind fencing and grant surface; rolls back |
| `instagram_tracking_schema.sql` | tracking quotas, snapshots, retention and soft removal; rolls back |
| `instagram_durable_collection_jobs.sql` | durable claims, context and generation fences, checkpoints, completion truth and lease expiry; rolls back |
| `meta_pending_selection_secret_boundary.sql` | pending OAuth stash browser denial and service-owned picker query compatibility; rolls back |
| `meta_oauth_attempt_lifecycle.sql` | captured OAuth authority, callback claims, atomic selection and replay/ownership refusals; rolls back |
| `meta_account_refresh_lifecycle.sql` | coherent Meta refresh captures, atomic direct/shared token writes and fenced health/event transitions; rolls back |
| `meta_oauth_identity_alias.sql` | atomic direct Instagram messaging alias validation, conversion, metadata confinement and replay; rolls back |
| `meta_page_token_reconciliation.sql` | selected operational Page-token reconciliation from a captured unchanged User grant, protected identity agreement and sibling/reauth preservation; rolls back |
| `competitor_collection_results.sql` | atomic competitor result write, watchlist publication, weekly retry gate, context rules and result fences; rolls back |
| `competitor_capture_coverage.sql` | the v2 competitor result write: coverage evidence stored atomically with the snapshots, the v2 fences, the malformed-coverage refusals, same-day idempotency, generation supersession, stale-worker refusal, unknown coverage for a legacy v1 capture, bounded completion vs full inventory, and the role boundary; rolls back |
| `competitor_tracking_report.sql` | the owner-only competitor report reader: the grant surface, the strict request shape, the owner boundary and the identical not-found refusal, the active and removed lists, the quota consistency, the bounded keyset cursor (20/50, limit+1, sub-millisecond ties, concurrent insertion, invalid and cross-filter cursors), the S = 3 days baseline edges, the observation cap, the latest-per-media selection with its bounded cohort baseline, the coverage and job projection without lease or context, and the capped-scan incompleteness; rolls back |
| `competitor_retention.sql` | the bounded inactive-history cleanup: the 90-day eligibility clock to the microsecond, the removal-marker clock, the ownership boundary, the default-off switch, the dry run, the bounded slice, the child-first deletion protocol, the live-lease skip and the role boundary; rolls back |
| `competitor_retention_cron.sql` | the inactive hourly schedule: applying the schedule definition twice leaves exactly one inactive job named `competitor-retention` at `20 * * * *`, the command resolves the shared secret at run time and carries no literal credential, and every other job is left exactly as it was; rolls back |
| `instagram_collection_rollout_controls.sql` | the rollout admission authority (R1): the default-off policy and the strict policy schema, the master switch read first and alone, the private policy row and the service permit RPC against the browser roles, the evaluator's ownership and pin rules, the enqueue refusals and the mixed service batch, the claim passes with an eligible job behind more than 500 excluded rows, the pinned-viewer negatives, the write fences, the provider permit unions and the bounded audit rows; rolls back |
| `instagram_collection_daily_dispatch.sql` | the durable daily dispatch (R2): the sweep table and its states, the service-only daily page RPC, the twenty five / fifty page ceilings, more than twenty five owners and more than one thousand competitors paged through the real statement, the duplicate that keeps its generation, the exclusion that wins at insert, the weekly retry gate, the truthful pending / completed / expired states, the disabled master and the unreadable configuration, the transaction atomicity and the midnight rollover; rolls back |
| `instagram_collection_cron.sql` | the four inactive collection schedules (C1): applying the schedule definition twice leaves exactly one inactive job per name and no fifth job, the exact UTC expressions, the exact bodies the registered routes accept, the runtime secret lookup with no literal credential in the stored command, the sixty second HTTP bound, the re-application that pauses an activated schedule again, the three missing-prerequisite failures that install nothing, the atomic installation, the secret rotation with a disposable request recorder, and every other job left exactly as it was; rolls back |
| `meta_owned_analytics_history.sql` | owned Facebook/Threads history and additive Instagram provenance; its executable assertions define the implemented C2 coverage, while multi-session race evidence is recorded separately |
| `meta_owned_analytics_claim_fairness.sql` | real Facebook/Threads admission, claim and partial completion across two owners; equal-due work yields to an unvisited account while earlier due dates retain priority; rolls back |
| `meta_owned_analytics_worker_admission.sql` | service-only admission credential reads, default-off and target scope, derived owner, separate Page/User tokens, full expected-authority equality and Threads rotation; no invented permissions/jobs; rolls back |
| `meta_owned_analytics_worker_progress.sql` | durable daily dispatch across more than 50 targets/two owners, atomic non-force enqueue/cursor progress, current grant renewal, UUID normalization, complete-round restart, stale day/policy/position refusal and visible account refusals; rolls back |

The harness's `SUITES` array is the complete executable inventory; the table
above highlights selected suites, not the entire list. No existing suite may
be excluded to make a rehearsal pass.

Owned Meta history races run automatically after that harness in CI through
`scripts/ci/test-meta-owned-analytics-races.py`. The runner requires an explicitly
labelled disposable container and a database ending in `_harness`, and observes
actual blocked sessions before asserting the concurrent outcomes. Its runtime
report, rather than a single-session suite or fixture prose, is the race evidence.
The PostgreSQL fixture must start with `-c cron.launch_active_jobs=off`; CI sets
this before baseline restoration. The runner refuses an enabled launcher before
opening its mutation sessions, so historical cron rows cannot run during races.

These fixtures are explicitly classified as **manual multi-session rehearsals**,
not omitted test suites: `partner_api_race_fixture.sql`,
`instagram_tracking_schema_race_fixture.sql`,
`facebook_user_credential_bindings_race_fixture.sql`,
`instagram_durable_collection_jobs_race_fixture.sql`,
`meta_oauth_attempt_lifecycle_race_fixture.sql`,
`meta_account_refresh_lifecycle_race_fixture.sql`,
`meta_oauth_identity_alias_race_fixture.sql`,
`meta_page_token_reconciliation_race_fixture.sql`,
`competitor_retention_race_fixture.sql` and
`instagram_collection_rollout_race_fixture.sql` and
`instagram_collection_daily_dispatch_race_fixture.sql`. Their headers document
setup, interleavings, expected outcomes and cleanup. A single-session harness
pass does not prove concurrency. Run the applicable fixtures separately against
the same isolated candidate and record both sessions' results. Never run them
against production; the Instagram credential/job fixtures require
`-v disposable=1` because setup commits synthetic records.

### The rollout controls race fixture

`instagram_collection_rollout_race_fixture.sql` rehearses the six
concurrency races of the rollout admission: enqueue versus exclusion, claim
versus exclusion, attachment versus viewer removal, result write versus
exclusion, reconnect versus permit, and both lock acquisition orders. It
commits synthetic rows **and** a policy change, so it refuses to run without
`-v disposable=1`, and its cleanup step removes the synthetic rows and puts
the default (off) policy back.

Three sessions are needed: the holder (A), the probe (B) and the observer.
The observer is what proves the wait — it reads `pg_stat_activity` while the
other session is blocked.

```bash
# against the disposable container of the rollout validation
DB_URL='postgres://supabase_admin:postgres@localhost:5432/instagram_rollout_harness'

# 1. prepare (commits the synthetic owner, the accounts and the policy)
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
  -f supabase/tests/instagram_collection_rollout_race_fixture.sql

# 2. two interactive sessions against the SAME database
psql "$DB_URL"   # session A
psql "$DB_URL"   # session B

# 3. in session A, hold the exclusion open (the transaction stays open)
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v exclude=1 -v hold_seconds=20 \
  -f supabase/tests/instagram_collection_rollout_race_fixture.sql

# 4. while A still holds it, probe from session B
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v enqueue=1 \
  -f supabase/tests/instagram_collection_rollout_race_fixture.sql

# 5. after A commits, assert and clean up
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v assert=1 \
  -f supabase/tests/instagram_collection_rollout_race_fixture.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
  -f supabase/tests/instagram_collection_rollout_race_fixture.sql
```

The exact statements of every race, the lock waits to observe, the expected
rows and the assertions are in the fixture's own header. One point the
header states and the rehearsal shows: the rollout readers take **no** row
lock on `app_settings`, so a policy writer never waits on an account lock
and the established `account -> watchlist -> job` order is never inverted.

### The daily dispatch race fixture

`instagram_collection_daily_dispatch_race_fixture.sql` rehearses the
concurrency races of the durable daily dispatch: a concurrent start and
resume, a failure before and after the commit, a lost reply, a current-day
replay and reopen, the midnight rollover, a target that becomes eligible
mid-sweep, and the no-progress page. It commits synthetic rows **and** a
policy change, so it refuses to run without `-v disposable=1`, and its
cleanup step removes the synthetic rows and puts the default (off) policy
back.

Three sessions are needed: the holder (A), the probe (B) and the observer.
The observer is what proves the wait — it reads `pg_stat_activity` while the
other session is blocked.

```bash
# against the disposable container of the rollout validation
DB_URL='postgres://supabase_admin:postgres@localhost:5432/instagram_rollout_harness'

# 1. prepare (commits the synthetic owner, the accounts and the policy)
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
  -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql

# 2. two interactive sessions against the SAME database
psql "$DB_URL"   # session A
psql "$DB_URL"   # session B

# 3. in session A, hold today's sweep row open (the transaction stays open)
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v hold_sweep=1 -v hold_seconds=6 \
  -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql

# 4. while A still holds it, probe from session B
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v probe_page=1 \
  -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql

# 5. the observer prints the lock waits of the other sessions
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v observe=1 \
  -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql

# 6. assert and clean up
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v assert=1 \
  -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
  -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
```

The exact statements of every race, the lock waits to observe, the expected
rows and the assertions are in the fixture's own header. One point the
header states and the rehearsal shows: the daily page serialises on the
SWEEP ROW, so two dispatchers of the same kind and day cannot interleave
inside one sweep, and the sweep row is never confused with the account
lock order the workers use.

### The competitor retention race fixture

`competitor_retention_race_fixture.sql` rehearses the five concurrency races
of the bounded inactive-history cleanup: the reactivation holding the parent
lock, the cleanup holding the parent lock, the collector's commit against the
cleanup, two retention runs, and the expired worker after the cleanup. It
commits synthetic rows and it turns `competitor_retention_enabled` **on**, so
it refuses to run without `-v disposable=1` and its cleanup step puts the
switch back to `false`.

Three sessions are needed: two racers and one observer. The observer is what
proves the wait — it reads `pg_stat_activity` while the other session is
blocked.

```bash
# against the disposable container of the Task 8 validation
DB_URL='postgres://supabase_admin:postgres@localhost:5432/partner_api_harness'

# 1. prepare (commits the synthetic owner and the six tracked competitors)
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
  -f supabase/tests/competitor_retention_race_fixture.sql

# 2. three interactive sessions against the SAME database
psql "$DB_URL"   # session A
psql "$DB_URL"   # session B
psql "$DB_URL"   # the observer

# 3. in the observer session itself, define the probe (the definition is in
#    the fixture header) and call it there while a racer is blocked; it is a
#    pg_temp function, so a separate `psql -c` process cannot see it
#      observer=> SELECT * FROM pg_temp.crt_probe();

# 4. cleanup (removes the synthetic rows and switches retention off again)
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
  -f supabase/tests/competitor_retention_race_fixture.sql
```

The exact statements of every race, the lock waits to observe, the expected
rows and the assertions are in the fixture's own header. Note what the
cleanup's `FOR UPDATE SKIP LOCKED` means for the rehearsal: a **second
cleanup never waits** (it skips the locked candidate), so races 1 and 4 are
rehearsed as lock *skips* and races 2 and 3 as lock *waits*. A rehearsal
that expected a wait where the design produces a skip would be asserting the
wrong thing.

## The competitor retention cron suite

`competitor_retention_cron.sql` proves the schedule of migration M4
(`supabase/migrations/20261030130000_competitor_retention_cron.sql`). It
re-applies **the migration file itself** with `\ir`, twice, inside one
transaction, and then asserts that the database holds exactly one job named
`competitor-retention`, that it runs at `20 * * * *`, that it is **inactive**,
that its command resolves the shared secret through
`public.get_cron_secret()` instead of carrying a literal credential, and that
every other job is untouched.

Two things it deliberately does **not** do:

- it never activates the job. The job is installed inactive, and a
  re-application keeps it inactive: enabling it is a separate, authorized
  action taken by hand after the migration is verified and the retention
  function has booted;
- it never touches the retention switch. `competitor_retention_enabled`
  stays `false`, so nothing can be deleted even if the job were activated.

The suite rolls back, so the job rows it creates do not survive it. The job
the migration phase created is committed and stays, inactive, for inspection.

The migration FAILS LOUDLY when `pg_cron`, `pg_net` or
`public.get_cron_secret()` is missing, rather than reporting a schedule that
was never installed. A harness database without pg_cron therefore fails at
the migration step, with the name of the missing prerequisite in the error —
which is the intended outcome, not a harness defect. The `cron.*` server flags
in "Running locally" below are what make pg_cron usable at all.

## The Instagram collection cron suite

`instagram_collection_cron.sql` proves the schedules of migration C1
(`supabase/migrations/20261031092000_instagram_collection_cron.sql`). It
re-applies **the migration file itself** with `\ir`, twice, inside one
transaction, and then asserts that the database holds exactly four jobs -
`instagram-insights-enqueue-daily` at `30 0 * * *`,
`competitor-snapshot-enqueue-daily` at `0 1 * * *`,
`instagram-insights-drain` and `competitor-snapshot-drain` at `*/2 * * * *` -
that all four are **inactive**, that each stored command calls the right
registered route with exactly the body that route's strict schema accepts
(the competitor's daily body is the durable `dispatch:"durable"` branch),
that each command resolves the shared secret through
`public.get_cron_secret()` at run time instead of carrying a literal
credential, that each bounds `net.http_post` to sixty seconds or less, and
that every other job is left exactly as it was.

Four things it deliberately does **not** do:

- it never activates a job. The jobs are installed inactive, and a
  re-application keeps them inactive: the suite even activates one
  synthetically and proves that the next application pauses it again.
  Enabling a schedule is a separate, authorized action taken by hand after
  the migration is verified and both functions have booted;
- it never touches the collection switches. Neither
  `collection_instagram_insights_enabled` nor
  `collection_instagram_rollout_policy` is read into a decision or
  written, and the suite asserts that both are byte-identical before and
  after the definition is applied;
- it never sends anything. The rotation proof replaces
  `public.get_cron_secret()` with a disposable reader and `net.http_post()`
  with a recorder that keeps the request instead of sending it, executes the
  stored commands exactly as they are stored, and asserts that a rotated
  secret is picked up by the next dispatch with no re-application in
  between. The disposable value is generated in the database, is never
  printed, and is never asserted in a message;
- it never weakens a precondition. A missing `pg_cron`, a missing `pg_net`
  and a missing `public.get_cron_secret()` are each removed in their own
  fixture, the definition is applied, and the application must fail with an
  explicit exception and install nothing. Each removal is undone with a
  savepoint, so the shared harness dependencies are back before the next
  fixture runs.

The suite rolls back, so the job rows it creates do not survive it. The four
jobs the migration phase created are committed and stay, inactive, for
inspection. Before the first application it seeds a stale, active
`instagram-insights-drain` and a duplicate of it under another owner, so the
reconciliation must rewrite the one and remove the other.

A missing prerequisite fails the migration step the same way as the retention
schedule above.

## Running locally

The target server must be the `supabase/postgres` image (its cluster-wide
Supabase roles are what the baseline's GRANTs resolve against):

```bash
docker run -d --name pg-harness -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  supabase/postgres:17.6.1.158 \
  -c cron.database_name=partner_api_harness \
  -c shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault

# connect as supabase_admin (the image's superuser — 'postgres' is not one
# in this image and cannot touch the auth schema)
DB_URL='postgres://supabase_admin:postgres@localhost:5432/postgres' \
  HARNESS_DB_NAME=partner_api_harness \
  bash scripts/db-harness.sh
```

The Contabo host (`ssh-contabo-mcp`) already has that exact image pulled and
runs Linux, which avoids both the multi-gigabyte pull and the CRLF handling a
Windows checkout needs:

```bash
git -C /root/postora-runtime fetch origin <ref>
rm -rf /root/hg && mkdir /root/hg
git -C /root/postora-runtime archive FETCH_HEAD | tar -x -C /root/hg
docker run -d --name hg17 -e POSTGRES_PASSWORD=harness -v /root/hg:/repo \
  supabase/postgres:17.6.1.158 \
  -c cron.database_name=partner_api_harness -c shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault
# wait for HEALTHCHECK to report healthy, then:
docker exec -e HARNESS_DB_NAME=partner_api_harness hg17 bash -c \
  "cd /repo && bash scripts/db-harness.sh 'postgres://supabase_admin@localhost:5432/postgres'"
```

The `cron.*` flags exist so a migration that schedules jobs can be tested;
pg_cron only loads in the database named by `cron.database_name`. The
script refuses production-looking database names, but it still drops and
creates a database: point it only at servers you are willing to lose.

## The baseline contract

The first line of `baseline_schema.sql` is a three-field header, all required:

```
-- BASELINE_MIGRATION: <newest migration in the dump>.sql  BASELINE_COUNT: <n>  BASELINE_SUM: <sha256>
```

The harness verifies `BASELINE_COUNT` (how many migrations sort at or below
the marker) and `BASELINE_SUM` (a sha256 of their exact filenames). Both are
mandatory — an optional checksum is no checksum, since deleting the field
would quietly restore the count-only guard that a swap defeats.

It cannot verify the marker itself. See "Regenerating the baseline" below for
why, and what is done about it instead.

### Regenerating the baseline

Run the script. Do not hand-write the header.

```bash
I_CONFIRM_ALL_MIGRATIONS_APPLIED=yes \
  PRODUCTION_URL='postgres://user:pass@host:5432/postgres' \
  bash scripts/regenerate-baseline.sh
```

Commit the new baseline **together with the migrations it now includes**.

**The confirmation flag is not ceremony.** The script writes a marker claiming
the dump contains every migration in `supabase/migrations/`, and nothing can
verify that: this project has **no migration ledger** — no
`supabase_migrations.schema_migrations`, only Supabase's own service tables for
auth, storage and realtime. Migrations are applied by hand. If a local
migration is not applied to the database being dumped, the harness skips it
permanently and can pass having never tested it. The flag turns a silent
assumption into a stated one.

The script also refuses to overwrite the baseline with a truncated dump, and
runs a credential pattern scan — which is a **tripwire, not a clearance**. A
schema-only dump still carries function bodies, defaults and comments; no
pattern list certifies it clean, and the file is about to enter a git history.
Read the diff before pushing.

You do **not** need to regenerate merely because you added a migration — the
harness applies anything newer than the marker on top. Regenerate when you want
future runs to stop re-proving a settled batch.

## The limitation — read this

The baseline is a **snapshot**. The harness proves that *new* migrations
apply cleanly to *today's* production shape, and that the suites pass on the
result. It proves **nothing** about whether the historical migration
sequence replays — it demonstrably does not.

Finding (2026-08): replaying all 253 migrations against a fresh
`supabase/postgres:17.6.1.158` applies 113 cleanly and then fails on 12,
which are not environment problems:

- **`20260323202049` inserts `ai_models` rows with a hardcoded
  `provider_id` `'44bee76d-…'`** — a UUID generated by hand in production
  that no migration ever creates. (Its same-day sibling `20260323201022`
  does it correctly, by looking the provider up by `provider_code`.) This
  also means **a staging environment cannot be built from migrations alone.**
- `#140`, `#167`, `#176` — seed rows referencing production users/posts no
  migration creates (FK violations on `social_accounts.user_id`,
  `platform_posts.post_id`, `user_subscriptions.user_id`).
- `20260329014509` — calls `public.render_email_template(text, jsonb)`,
  which no migration defines.
- `#243`–`#247`, `#249` — the `ai_knowledge_source_accounts` /
  `embedding_bge_m3` / `social_account_id` cluster (partly cascades of the
  above).

Migrations are immutable — all 253 are applied in production — so none of
this is fixable by editing history. The baseline is the answer.

## Why the prep step looks fussy

Four things in `db-harness.sh`'s prep exist because the harness failed without
them, each in a way that pointed somewhere unhelpful. If you are tempted to
simplify that block, this is what you would be undoing:

| Prep line | Without it | Why |
|---|---|---|
| `vector` created in **`public`**, not `extensions` | `type public.vector does not exist` | Production has `vector` in `public` (the others are in `extensions`), and an extension's schema is baked into every type name the dump emits |
| `vector` created **after** `DROP SCHEMA public CASCADE`, in step 4 | `drop cascades to extension vector`, then the same error | The drop takes the extension with it, so creating it earlier in prep is wasted |
| stub role `supabase_realtime_admin` | `role "supabase_realtime_admin" does not exist` | The dump GRANTs to it; the image creates every other role but this one, which Realtime creates at runtime |
| `GRANT USAGE ON SCHEMA extensions` | `function lives_ok(unknown, unknown) does not exist` | The most misleading of the four: pgTAP **was** installed. The schema had no ACL, so it went invisible the moment a suite `SET ROLE`d away from superuser — which the pgTAP suites and the tenancy suite both do deliberately |

The pattern: the harness has to match production's *grants and schema
placement*, not just its tables. Each fix above was derived by querying
production and copying what was there — not by trying things until it went
green. A harness that diverges from production can fail for reasons unrelated
to your change, or, worse, pass on a schema that production would reject.

## Is the harness actually a gate?

Verified by mutation, 2026-08-30: a deliberately invalid migration placed
newer than the baseline marker makes the run exit 1 and name the file. A
green harness that has never been seen to fail is not evidence of anything —
if you change the harness substantially, break something on purpose and
confirm it still fails.

## What a suite must emit

The harness proves **completion**, not merely that something passed. An
intermediate `ok` shows only that a suite reached its first assertion — a suite
truncated after test one exits 0 and emits one, which is exactly what a passing
run looks like. So each suite must prove it reached the end, one of two ways:

| Suite kind | Completion proof |
|---|---|
| pgTAP (`whatsapp_workspace_crm.sql`, `import_whatsapp_contacts_to_workspace.sql`) | a `1..N` plan, with exactly N numbered test points observed |
| NOTICE-based (`partner_api_test.sql`, `partner_api_tenancy_negative.sql`) | **`ALL CHECKS PASSED` as the last non-blank line of stdout** |

**If you add a suite with no TAP plan, end it with an `\echo` line containing
`ALL CHECKS PASSED`** or the harness will refuse it — deliberately, because
there would otherwise be no way to distinguish a complete run from a truncated
one.

It must be the **last** line, not merely present. Searching for the phrase
anywhere was itself a false green: `assert_eq` prints its label as a NOTICE, so
a test described as "… ALL CHECKS PASSED …" satisfied a substring search and the
suite could then be truncated and still pass. Only stdout is checked — `$BOTH`
is stdout and stderr concatenated, not interleaved in time, so its last line is
whatever stderr happened to print last and proves nothing about ordering.

The plan check also rejects: more points than planned, a second `1..N` line
(pgTAP itself refuses a second `plan()` call, so two means the output is not one
TAP stream), and `Bail out!` regardless of preceding passes. `1..0` is a valid
empty plan and counts as complete.

## Known limitations

### What the TAP parsing does not do

The harness reads TAP with awk, not a full TAP consumer. Eight adversarial
review rounds established that no *reachable* false green remains with the four
suites and the CI invocation in this repository. These remain theoretically
possible and were judged not worth a full parser — each needs hand-crafted
output that pgTAP does not emit:

- Point numbers are **counted, not validated**. Duplicated, reused or gapped
  numbers could be crafted to match the plan count.
- The point pattern is loose: `ok 1garbage` is accepted as a point.
- Ordinary query output deliberately shaped like a plan and points could
  fabricate a complete-looking stream.
- No-plan completion is a **source convention**. A future suite could emit the
  sentinel early and then do work that prints nothing to stdout.
- For pgTAP suites, "complete" means all N planned points were *observed* — not
  that `finish()` literally executed. Truncating after the final point cannot
  hide an unexecuted assertion, and the open transaction rolls back when psql
  exits, so this is a naming precision rather than a gap.

If a future suite is not pgTAP and not NOTICE-based, revisit this rather than
assuming the conventions above still hold.

### Other deliberate trades



Recorded rather than fixed, because each is a deliberate trade:

- **`host=` in a URI query is refused**, which also rejects the legitimate
  Unix-socket form `postgresql:///db?host=/var/lib/postgresql`. The harness
  has no need for it, and the alternative — reimplementing libpq's parameter
  precedence in bash — is worse than a narrower interface.
- **Percent-encoding in the query string is refused outright** rather than
  decoded. libpq decodes query keywords before matching them, so `%64bname=`
  arrives as `dbname=`; a guard that reads the raw text is looking at a
  different string than the server will. Refusing beats guessing.
- **The marker cannot be verified**, only asserted — see above.
- **The baseline is a snapshot.** It proves new migrations apply to today's
  production shape. It proves nothing about whether history replays; it
  demonstrably does not.
- **Schema-only means no rows.** A migration whose success depends on existing
  data — a new `NOT NULL`, a uniqueness constraint, a backfill — can pass here
  against empty tables and still fail in production. Representative data is
  out of scope for this deliverable and is the obvious next improvement.
