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

It is one transaction with a local `lock_timeout` of 5 s, applies twice without error, keeps the signature of every function (`CREATE OR REPLACE`, owner and grants kept) and ends with a self-check that aborts the whole apply on any miss. It does not touch the rollout key, `app_settings`, `youtube_stage4_refresh` or the three token store functions, and it inserts no row for the rollout key: Stage 4 stays dark.

**Apply as `supabase_admin`** with `ON_ERROR_STOP` on. `postgres` is not a superuser on this stack, and a `CREATE OR REPLACE` by a non-owner would change the function owner.

## Order of the release

The database goes first. A merge to `main` syncs the edge functions within about two minutes (`docs/runbooks/deploy-edge-function.md`), and the edge code of `93acd4be` already sends the digest map at all four claim sites, so it runs on the new SQL without a change; after a SQL-only rollback the new edge code runs on the old SQL.

1. Every gate green on the final head. Record the migration file's SHA-256; a later change to the file voids the approval.
2. Read-only pre-flight on production (below). Any other answer than the expected one stops the release.
3. Database snapshot on the Contabo host; record path, byte size and SHA-256.
4. Owner approval by card, naming the file, its SHA-256, the snapshot receipt and the pre-flight answers.
5. Apply from the PR head: `git show <sha>:supabase/migrations/20261124120000_youtube_stage4_key_integrity.sql`, with the role and command that applied `20261122130000`.
6. Post-apply verification (below).
7. Merge; verify the edge sync per changed file (SHA-256) and the frontend deploy.

## Pre-flight (read-only, production)

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
-- names the migration creates: expected none exist
select conname from pg_constraint where conname in ('youtube_comment_operations_key_versions_check','youtube_comment_operations_intent_key_version_fkey');
select to_regclass('public.youtube_comment_digest_key_watermark'), to_regclass('public.youtube_comment_operations_intent_key_version_idx');
-- Postgres major: equal to the CI image (17)
show server_version;
```

The pre-check inside the migration refuses a violating row with a message of its own. The harness cannot test that branch (migrations apply before any suite can seed a violating row), so its verification is code review plus the two violating-shape queries above.

## Post-apply verification (read-only)

- the foreign key is validated: `select convalidated from pg_constraint where conname = 'youtube_comment_operations_intent_key_version_fkey'` is true; the CHECK exists and is validated;
- the guard trigger fires on `INSERT`: `select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_youtube_comment_digest_keys_guard'` reads `BEFORE INSERT OR DELETE OR UPDATE`;
- the watermark is 1 (production has only version 1): `select last_version from public.youtube_comment_digest_key_watermark`;
- `EXECUTE` on the claim and the status is granted to `service_role` only (no `PUBLIC`, `anon`, `authenticated`);
- the three token store functions keep their owner; the rollout key is still absent; each of the six channels still answers `rollout_missing`;
- a claim called with a `NULL` map inside a transaction that is rolled back answers `invalid_request`.

## Rollback

Edge and frontend: revert the merge commit on `main`; the sync and the deploy follow on their own. The three parts roll back independently.

Database: apply `docs/runbooks/sql/20261124120000_youtube_stage4_key_integrity_rollback.sql` as `supabase_admin` with `ON_ERROR_STOP` on. It is one transaction that restores the three function bodies of `20261122130000` (copied verbatim), recreates the guard trigger as `BEFORE UPDATE OR DELETE`, drops the foreign key, the CHECK and the index, and drops the watermark table. It changes no receipt and no key. The rollback script is rehearsed in CI-style on the harness database: after it, `md5(pg_get_functiondef(...))` of the claim, the status and the guard equals the value before the migration, and the forward migration applies again.

**Note the watermark before a rollback**: `select last_version from public.youtube_comment_digest_key_watermark`. Dropping the table forgets which version numbers were issued and deleted; a later re-apply seeds the watermark from the versions that still exist, which is only a lower bound. With one key version in production and no deletion so far, nothing is lost today.

After go-live the same script stays safe: rolling the foreign key back only returns the delete guard to its trigger form. The ownership of the token store functions (`youtube_stage4_refresh`, recorded in #470 as `supabase_admin` before `20261122130000`) is not part of this rollback.

## Behaviour worth knowing

- The status read now takes a share lock on the account row for the length of one short call, once a receipt is known to exist. It briefly blocks a token refresh write, a disconnect or a mark on the same account. With no receipts in production, it is never taken before go-live.
- A receipt that vanishes between the plain existence read and the lock (the 30-day prune, an owner cascade) answers `not_found`.
- `INSERT ... ON CONFLICT DO NOTHING` on an existing key version now raises, because a `BEFORE INSERT` trigger runs before conflict detection. The only such statement was the version 1 seed of `20261122130000`, which never runs again.
- Key versions stay deletable (when no receipt references them) but are never reused; to add a version, use `watermark + 1` or higher.
