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

The harness's `SUITES` array is the complete executable inventory; the table
above highlights selected suites, not the entire list. No existing suite may
be excluded to make a rehearsal pass.

These fixtures are explicitly classified as **manual multi-session rehearsals**,
not omitted test suites: `partner_api_race_fixture.sql`,
`instagram_tracking_schema_race_fixture.sql`,
`facebook_user_credential_bindings_race_fixture.sql`, and
`instagram_durable_collection_jobs_race_fixture.sql`. Their headers document
setup, interleavings, expected outcomes and cleanup. A single-session harness
pass does not prove concurrency. Run the applicable fixtures separately against
the same isolated candidate and record both sessions' results. Never run them
against production; the Instagram credential/job fixtures require
`-v disposable=1` because setup commits synthetic records.

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
