# YouTube Stage 4, follow-up PR 2: the key-integrity migration

Migration `supabase/migrations/20261124120000_youtube_stage4_key_integrity.sql`, rollback `docs/runbooks/sql/20261124120000_youtube_stage4_key_integrity_rollback.sql`. Plan: `docs/plans/2026-11-24-youtube-stage4-pr2.md` (section 7 is the release order, section 8 the rollback). Contract: spec section 7.6.

This runbook is for whoever applies the migration to production. It does not authorise the apply: a PR that carries a migration merges only after the owner's card approval.

## What the migration does

| Id | Change |
|---|---|
| K1 | Foreign key `youtube_comment_operations_intent_key_version_fkey` (`ON UPDATE RESTRICT ON DELETE RESTRICT`), CHECK `youtube_comment_operations_key_versions_check`, index `youtube_comment_operations_intent_key_version_idx`. |
| K2 | Table `youtube_comment_digest_key_watermark` (one row, the highest key version ever issued); the key guard trigger also fires on `INSERT`. |
| K3 | `youtube_comment_op_status` locks the account row `FOR SHARE` before it reads the receipt for the answer. |
| K4 | `youtube_comment_op_claim` requires the digest map. |

A status call that finds a settlement in progress waits for it while holding the account row `FOR SHARE`, so a token refresh, a disconnect or a dispatch mark on that account waits for the same settlement. Settlement transactions are one short statement each; this wait is bounded by them, not by the migration's `lock_timeout`, which applies only to the apply itself.

It is one transaction with a local `lock_timeout` of 5 s, applies twice without error, keeps the signature of every function (`CREATE OR REPLACE`, owner and grants kept) and ends with a self-check that aborts the whole apply on any miss. It does not touch the rollout key, `app_settings`, `youtube_stage4_refresh` or the three token store functions, and it inserts no row for the rollout key: Stage 4 stays dark.

**Apply as `supabase_admin`** with `ON_ERROR_STOP` on. `postgres` is not a superuser on this stack. `CREATE OR REPLACE FUNCTION` keeps the existing owner and grants; a role that does not own the function (and is not a member of its owner role) gets an error and nothing changes, so a failed apply with `must be owner of function` means the wrong role.

## Order of the release

The database goes first. A merge to `main` syncs the edge functions within about two minutes (`docs/runbooks/deploy-edge-function.md`), and the edge code of `93acd4be` already sends the digest map at all four claim sites, so it runs on the new SQL without a change; after a SQL-only rollback the new edge code runs on the old SQL.

1. Every gate green on the final head. Record the migration file's SHA-256; a later change to the file voids the approval.
2. Read-only pre-flight on production (below). Any other answer than the expected one stops the release.
3. Database snapshot on the Contabo host; record path, byte size and SHA-256.
4. Owner approval by card, naming the file, its SHA-256, the snapshot receipt and the pre-flight answers.
5. Apply from the PR head: `git show <sha>:supabase/migrations/20261124120000_youtube_stage4_key_integrity.sql`, with the role and command that applied `20261122130000`.
6. Post-apply verification (below).
7. Merge; verify the edge sync per changed file (SHA-256) and the frontend deploy.

## First-launch pre-flight (read-only, production)

These are the checks for the first apply only, before any receipt or key rotation exists. For a database that has already been rolled back, use **Re-apply after a rollback** below instead.

```sql
-- receipts: expected 0 (the rollout key is absent, so no claim can have passed the rollout check)
select count(*) from public.youtube_comment_operations;
-- key versions: expected one row, version 1, retired_at null
select version, retired_at from public.youtube_comment_digest_keys order by version;
-- rows that would break the new constraints: expected 0 and 0
select count(*) from public.youtube_comment_operations o
 where not exists (select 1 from public.youtube_comment_digest_keys k where k.version = o.intent_key_version);
select count(*) from public.youtube_comment_operations o
 where not ((o.action in ('create_thread','reply') and o.digest_key_version = o.intent_key_version)
         or (o.action in ('edit','moderate') and o.digest_key_version = 0));
-- owners of the three token store functions: expected youtube_stage4_refresh, three rows
select p.proname, pg_get_userbyid(p.proowner) from pg_proc p
 where p.proname in ('store_youtube_refreshed_token','store_youtube_refreshed_token_with_lease','store_youtube_refreshed_token_with_lease_neutral');
-- the rollout key: expected absent
select count(*) from public.app_settings where key = 'youtube_comments_stage4_rollout';
-- names the migration creates: on this FIRST apply both constraints are absent,
-- and both regclass values are NULL
select conname from pg_constraint where conname in ('youtube_comment_operations_key_versions_check','youtube_comment_operations_intent_key_version_fkey');
select to_regclass('public.youtube_comment_digest_key_watermark'), to_regclass('public.youtube_comment_operations_intent_key_version_idx');
-- Postgres major: equal to the CI image (17)
show server_version;
```

The pre-check inside the migration refuses a violating row with a message of its own. The harness cannot test that branch (migrations apply before any suite can seed a violating row), so its verification is code review plus the two violating-shape queries above.

## First-launch post-apply verification (read-only)

These are the first-apply checks; the watermark expectation of 1 does not apply to a re-apply after rotation.

- the foreign key is validated: `select convalidated from pg_constraint where conname = 'youtube_comment_operations_intent_key_version_fkey'` is true; the CHECK exists and is validated;
- the guard trigger fires on `INSERT`: `select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_youtube_comment_digest_keys_guard'` reads `BEFORE INSERT OR DELETE OR UPDATE`;
- the watermark is 1 (production has only version 1): `select last_version from public.youtube_comment_digest_key_watermark`;
- `EXECUTE` on the claim and the status is granted to `service_role` only (no `PUBLIC`, `anon`, `authenticated`);
- the three token store functions keep their owner; the rollout key is still absent; each of the six channels still answers `rollout_missing`;
- a claim called with a `NULL` map inside a transaction that is rolled back answers `invalid_request`.

## Re-apply after a rollback

Use this section instead of the first-launch checks when the rollback kept the watermark table and receipts or rotated key versions may exist. Compare the watermark table and value with the rollback receipt before proceeding; a missing table, a changed value or any K1 object still present stops the re-apply.

### Re-apply pre-flight (read-only, production)

```sql
-- Receipts MAY be non-zero after go-live: record the count, do not require zero.
select count(*) from public.youtube_comment_operations;
-- Rotated versions are allowed: record every surviving version for the watermark check
-- (at least one active row with retired_at is null must still exist).
select version, retired_at from public.youtube_comment_digest_keys order by version;
-- Both K1 violation queries must still return zero.
select count(*) from public.youtube_comment_operations o
 where not exists (select 1 from public.youtube_comment_digest_keys k where k.version = o.intent_key_version);
select count(*) from public.youtube_comment_operations o
 where not ((o.action in ('create_thread','reply') and o.digest_key_version = o.intent_key_version)
         or (o.action in ('edit','moderate') and o.digest_key_version = 0));
-- The rollback receipt says the watermark was kept: expected regclass non-NULL,
-- then confirm last_version equals the value recorded by that receipt.
select to_regclass('public.youtube_comment_digest_key_watermark');
select last_version from public.youtube_comment_digest_key_watermark;
-- K1 FK and CHECK: expected no rows. K1 index: expected NULL.
select conname from pg_constraint
 where conname in ('youtube_comment_operations_key_versions_check','youtube_comment_operations_intent_key_version_fkey');
select to_regclass('public.youtube_comment_operations_intent_key_version_idx');
-- Owners: expected youtube_stage4_refresh on all three rows.
select p.proname, pg_get_userbyid(p.proowner) from pg_proc p
 where p.proname in ('store_youtube_refreshed_token','store_youtube_refreshed_token_with_lease','store_youtube_refreshed_token_with_lease_neutral');
-- Postgres major: expected 17, matching the CI image.
show server_version;
```

### Re-apply post-apply verification (read-only)

- Both K1 constraints exist and are validated: `select conname, convalidated from pg_constraint where conname in ('youtube_comment_operations_key_versions_check','youtube_comment_operations_intent_key_version_fkey')` returns two rows, both true.
- The K1 index exists: `select to_regclass('public.youtube_comment_operations_intent_key_version_idx')` is non-NULL.
- `select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_youtube_comment_digest_keys_guard'` reads `BEFORE INSERT OR DELETE OR UPDATE`.
- `EXECUTE` on the claim and status functions is granted to `service_role` only (no `PUBLIC`, `anon` or `authenticated`).
- The three token store functions keep their owner (`youtube_stage4_refresh`).
- A claim called with a `NULL` digest map inside a transaction that is rolled back answers `invalid_request`.
- Replace `NULL` in the `receipt` CTE below with the watermark recorded **before** the rollback. The query must return `watermark_ok = true`; this proves the new watermark covers that receipt, the highest surviving key version and every surviving receipt reference.

```sql
with receipt as (
  select null::integer as pre_rollback_watermark -- replace NULL with the rollback receipt value
), bounds as (
  select
    (select coalesce(max(version), 0) from public.youtube_comment_digest_keys) as highest_surviving_key_version,
    (select coalesce(max(intent_key_version), 0) from public.youtube_comment_operations) as max_intent_key_version,
    (select coalesce(max(digest_key_version), 0) from public.youtube_comment_operations) as max_digest_key_version
)
select w.last_version, r.pre_rollback_watermark, b.*,
       r.pre_rollback_watermark is not null
       and w.last_version >= greatest(
         r.pre_rollback_watermark,
         b.highest_surviving_key_version,
         b.max_intent_key_version,
         b.max_digest_key_version
       ) as watermark_ok
  from public.youtube_comment_digest_key_watermark w
 cross join receipt r
 cross join bounds b;
```

## Rollback

Edge and frontend: revert the merge commit on `main`; the sync and the deploy follow on their own. The three parts roll back independently.

**Drain live claims first.** Turn the rollout off (remove the rollout key per the Stage 4 runbook) and wait at least 2 minutes, then run

```sql
with ddl_targets as (
  select array_remove(array[
    to_regclass('public.youtube_comment_operations'),
    to_regclass('public.youtube_comment_digest_keys'),
    to_regclass('public.youtube_comment_operations_intent_key_version_idx')
  ], null) as relations
)
select l.relation::regclass as target, l.mode, l.granted,
       a.pid, a.usename, a.application_name, a.state, a.xact_start, a.query
  from pg_locks l
  join pg_stat_activity a on a.pid = l.pid
  join ddl_targets t on l.relation = any(t.relations)
 where l.database = (select oid from pg_database where datname = current_database())
   and a.pid <> pg_backend_pid();
```

**The stop condition is zero rows: no held (`granted = true`) or waiting (`granted = false`) lock on any exact DDL target.** A count of visible receipt rows cannot show an uncommitted claim, which is why the lock view is used instead. `pg_stat_activity.query` shows only the session's last statement, not necessarily the statement that took the lock; use it with `pid`, `usename` and `application_name` only to identify the holder, and use `l.mode` to identify the lock. The rollback's own 5 s `lock_timeout` aborts it cleanly if something still holds a lock: wait for the holder to finish and retry.

Database: apply `docs/runbooks/sql/20261124120000_youtube_stage4_key_integrity_rollback.sql` as `supabase_admin` with `ON_ERROR_STOP` on. It is one transaction that restores the three function bodies of `20261122130000` (copied verbatim), recreates the guard trigger as `BEFORE UPDATE OR DELETE`, drops the foreign key, the CHECK and the index, and keeps the watermark table (the only record of deleted key versions). It changes no receipt and no key. The rollback script is rehearsed in CI-style on the harness database: after it, `md5(pg_get_functiondef(...))` of the claim, the status and the guard equals the value before the migration, and the forward migration applies again.

**While rolled back, do no key maintenance.** Insert, retire or delete no digest key version until the forward migration is applied again: the old trigger neither updates the watermark nor is backed by the foreign key, so a deletion of a referenced version or a reused number would not be refused. Record `select last_version from public.youtube_comment_digest_key_watermark` before and after the rollback in the receipt; the re-apply keeps the larger value.

After go-live, a rollback also returns the status RPC to its old form, without the account `FOR SHARE` lock (K3), so a status read can again race a rebind. Status recovery stays callable with the rollout off, so roll back only when the forward migration itself is the problem, and re-apply it as soon as possible. The ownership of the token store functions (`youtube_stage4_refresh`, recorded in #470 as `supabase_admin` before `20261122130000`) is not part of this rollback.

## Behaviour worth knowing

- The status read now takes a share lock on the account row for the length of one short call, once a receipt is known to exist. It briefly blocks a token refresh write, a disconnect or a mark on the same account. With no receipts in production, it is never taken before go-live.
- A receipt that vanishes between the plain existence read and the lock (the 30-day prune, an owner cascade) answers `not_found`.
- `INSERT ... ON CONFLICT DO NOTHING` on an existing key version now raises, because a `BEFORE INSERT` trigger runs before conflict detection. The only such statement was the version 1 seed of `20261122130000`, which never runs again.
- Key versions stay deletable (when no receipt references them) but are never reused; to add a version, use `watermark + 1` or higher.
