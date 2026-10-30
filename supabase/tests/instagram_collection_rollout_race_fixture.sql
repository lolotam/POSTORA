-- ============================================================================
-- supabase/tests/instagram_collection_rollout_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. scripts/db-harness.sh does not run it, and it is
-- listed in the harness EXCLUDED_FROM_SUITES. A single connection cannot
-- prove what two sessions do to each other, and the sequential checks in
-- instagram_collection_rollout_controls.sql are not that proof. This file
-- must not be described as if they were.
--
-- DISPOSABLE DATABASES ONLY. The prepare path COMMITS synthetic rows and
-- the exclusion path COMMITS a policy change. Do not point DB_URL at a
-- shared database or at production. The script refuses to run unless psql
-- was given -v disposable=1.
--
-- THE SYNTHETIC FIXTURES
--
--   owner      0b0b0000-0000-4000-8000-000000000001
--   account    0b0b0000-0000-4000-8000-000000000011  the approved one
--   account    0b0b0000-0000-4000-8000-000000000012  the excluded sibling
--   viewer     0b0b0000-0000-4000-8000-000000000013  the pinned viewer
--   viewer     0b0b0000-0000-4000-8000-000000000014  the viewer the repin moves to
--   watchlist  0b0b0000-0000-4000-8000-000000000021  pinned to the viewer above
--   job        0b0b0000-0000-4000-8000-000000000041  owner job, LEASED, token 031
--   job        0b0b0000-0000-4000-8000-000000000042  owner job, QUEUED (the claim probe)
--   job        0b0b0000-0000-4000-8000-000000000043  competitor job, LEASED, token 033
--
--   The two LEASED jobs carry a KNOWN claim token, so a probe can be
--   replayed AFTER the exclusion commits. That is what proves the write
--   fence and the permit refuse a target that became excluded while the
--   claim was already taken.
--
-- WHAT THE TWO SESSIONS PROVE
--
--   RACE 1 - ENQUEUE VERSUS EXCLUSION.
--     Session A opens a transaction and updates the rollout policy so the
--     owner account is no longer approved. It does NOT commit.
--     Session B enqueues that account.
--     OBSERVED: B does NOT wait. The policy read is a plain SELECT, so it
--     never blocks on the row lock A holds, and B sees the last COMMITTED
--     policy: the account is still approved, so the enqueue is accepted.
--     That is the honest in-flight story, not a bug: the exclusion is
--     not in force until it commits.
--     After A commits, the same enqueue is REFUSED with
--     collection_not_eligible.
--
--   RACE 2 - CLAIM VERSUS EXCLUSION.
--     Session A holds the same uncommitted exclusion. Session B claims.
--     OBSERVED: B does not wait. The claim reads the policy before its
--     candidate scan, so it admits the job that the uncommitted exclusion
--     has not removed yet.
--     After A commits, the claim returns NOTHING for that target: the
--     excluded job is not claimed, and its attempts, its generation and
--     its timestamps are unchanged.
--
--   RACE 3 - ATTACHMENT VERSUS VIEWER REMOVAL.
--     Session A holds an uncommitted policy change that repins the
--     watchlist to another viewer. Session B attaches the previously
--     approved viewer.
--     OBSERVED: B does not wait. The attachment sees the last COMMITTED
--     pin, so it succeeds.
--     After A commits, the attachment of the old viewer is refused. On a
--     job that already carries the old viewer the refusal is
--     IG_COLLECTION_NOT_ELIGIBLE (the bound viewer is no longer an
--     approved one); on a job with no bound viewer yet it is
--     IG_COLLECTION_VIEWER_NOT_APPROVED. There is no substitution path:
--     the pin is not a preference, and the approved viewer is never
--     swapped for another one automatically.
--
--   RACE 4 - RESULT WRITE VERSUS EXCLUSION.
--     Session A holds the uncommitted exclusion. Session B writes the
--     result of the already claimed job.
--     OBSERVED: B does not wait and the write lands, because the
--     exclusion has not committed.
--     After A commits, the same write is refused with
--     IG_COLLECTION_NOT_ELIGIBLE and NOTHING lands: no snapshot, no
--     operation row, no checkpoint, no success timestamp.
--
--   RACE 5 - RECONNECT VERSUS PERMIT.
--     Session A holds an uncommitted credential generation bump (the
--     reconnect). Session B asks for a provider permit.
--     OBSERVED: B does not wait. The permit reads the live fenced job, so
--     it sees the last COMMITTED generation and the permit is granted.
--     After A commits, the same permit is refused with
--     credential_changed: the captured generation is no longer the live
--     one.
--
--   RACE 6 - BOTH LOCK ACQUISITION ORDERS.
--     The established order is social_accounts FOR UPDATE (id order), then
--     the advisories, then competitor_watchlist, then the job row.
--     Session A holds the ACCOUNT row lock. Session B performs a fenced
--     write and therefore waits on that account lock. Session C is the
--     POLICY WRITER: it updates the rollout policy.
--     OBSERVED: B waits on the account row lock (wait_event_type =
--     'Lock'). C does NOT wait at all: the policy writer touches only
--     app_settings, and the rollout readers take NO row lock on it, so
--     there is no settings -> account inversion and no deadlock. After A
--     commits, B completes.
--
-- THE AUTHORIZATION INSTANT
--
--   The authorization instant is the last SQL permit immediately
--   preceding the provider request. A policy change observed BEFORE that
--   instant produces zero requests. A change observed AFTER it may leave
--   one already-authorized request per active transport in flight, and
--   that request's result can no longer persist, because every write
--   goes through the same fence. Nothing here cancels an HTTP call that
--   was already sent, and nothing here claims to.
--
-- HOW TO REHEARSE
--
--   0. Prepare. Run ONCE against the disposable database:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--
--   1. For every race, open the sessions against the SAME database:
--
--        psql "$DB_URL"   # session A (the holder)
--        psql "$DB_URL"   # session B (the probe)
--        psql "$DB_URL"   # the observer, for the waits
--
--   2. In session A, hold the exclusion open (the transaction stays OPEN):
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v exclude=1 \
--          -v hold_seconds=20 -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--
--   3. While session A still holds it, probe from session B:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v enqueue=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v claim=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v attach=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v attach_new=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v write=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v permit=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--
--   4. The observer prints the lock waits of the other sessions:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v observe=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--
--   5. After session A commits, run the SAME probe again. The refusal is
--      the second half of the proof:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v enqueue=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--
--   6. Cleanup. Run it even when the rehearsal failed part way:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--          -f supabase/tests/instagram_collection_rollout_race_fixture.sql
--
--   A PASS of the rehearsal is all of:
--   * no probe waited on the policy row (races 1 to 5),
--   * after the exclusion commits, the enqueue, the claim, the attachment,
--     the write and the permit are refused,
--   * the refused write left no snapshot, no operation row, no checkpoint
--     and no success timestamp,
--   * in race 6 the fenced write waited on the ACCOUNT row lock and the
--     policy writer did not wait at all,
--   * cleanup removed the synthetic rows and put the default policy back.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows and a policy change. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
-- ---------------------------------------------------------------------------
-- CLEANUP. Runs even when the rehearsal failed half way.
-- ---------------------------------------------------------------------------
BEGIN;

DROP FUNCTION IF EXISTS public.igrollout_race_waits();

DELETE FROM public.instagram_collection_jobs
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_request_throttles
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_operations
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.ig_media_insight_snapshots
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_account_capabilities
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.competitor_watchlist
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.social_accounts
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM auth.users
 WHERE id = '0b0b0000-0000-4000-8000-000000000001';

-- The rollout fixture goes back to the default. The prepare step turned
-- the collection on and a collection gate left open is not a thing this
-- fixture may leave behind.
DELETE FROM public.app_settings
 WHERE key = 'collection_instagram_insights_enabled';
UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

COMMIT;
\echo '=== instagram_collection_rollout race fixture: cleaned synthetic owner, policy back to default ==='

\elif :{?prepare}
-- ---------------------------------------------------------------------------
-- PREPARE. Commits the synthetic fixtures.
-- ---------------------------------------------------------------------------
BEGIN;

DELETE FROM public.competitor_watchlist
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_jobs
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_request_throttles
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_operations
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.ig_media_insight_snapshots
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_account_capabilities
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM public.social_accounts
 WHERE user_id = '0b0b0000-0000-4000-8000-000000000001';
DELETE FROM auth.users
 WHERE id = '0b0b0000-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, email)
VALUES ('0b0b0000-0000-4000-8000-000000000001', 'igrollout-race@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
VALUES
  ('0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-approved', 'igrollout_approved', 'race-token-approved', 'facebook_page'),
  ('0b0b0000-0000-4000-8000-000000000012', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-other', 'igrollout_other', 'race-token-other', 'facebook_page'),
  ('0b0b0000-0000-4000-8000-000000000013', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-viewer', 'igrollout_viewer', 'race-token-viewer', 'facebook_page'),
  ('0b0b0000-0000-4000-8000-000000000014', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-viewer-b', 'igrollout_viewer_b', 'race-token-viewer-b', 'facebook_page')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.instagram_account_capabilities
  (social_account_id, user_id, platform, login_kind, permission_read_state,
   granted_scopes, scopes_read_at, credential_generation)
VALUES
  ('0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_manage_insights'], now(), 1),
  ('0b0b0000-0000-4000-8000-000000000012', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_manage_insights'], now(), 1),
  ('0b0b0000-0000-4000-8000-000000000013', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_manage_insights'], now(), 1),
  ('0b0b0000-0000-4000-8000-000000000014', '0b0b0000-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_manage_insights'], now(), 1)
ON CONFLICT (social_account_id) DO NOTHING;

INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
VALUES ('0b0b0000-0000-4000-8000-000000000021', '0b0b0000-0000-4000-8000-000000000001',
        'instagram', 'igrollout_comp')
ON CONFLICT (id) DO NOTHING;

-- The observer. It reports the LOCK waits of the other sessions, which is
-- the only way to prove that a session waited rather than inferring it
-- from a delay.
CREATE OR REPLACE FUNCTION public.igrollout_race_waits()
RETURNS TABLE (
  pid        integer,
  state      text,
  wait_type  text,
  wait_event text,
  blocked_by integer,
  query      text
)
LANGUAGE sql
VOLATILE
SET search_path = public
AS $function$
  SELECT a.pid,
         a.state,
         a.wait_event_type,
         a.wait_event,
         (SELECT unnest(pg_blocking_pids(a.pid)) LIMIT 1),
         left(a.query, 160)
    FROM pg_stat_activity AS a
   WHERE a.datname = current_database()
     AND a.pid <> pg_backend_pid()
     AND a.wait_event_type IS NOT NULL
   ORDER BY a.pid;
$function$;

-- The collection is on and the policy approves exactly the one account
-- and the one watchlist, pinned to the one viewer.
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic race-fixture master switch.'),
  ('collection_instagram_rollout_policy',
   '{"version":1,"owners":{"mode":"allowlist","account_ids":["0b0b0000-0000-4000-8000-000000000011"]},"competitors":{"mode":"allowlist","targets":[{"watchlist_id":"0b0b0000-0000-4000-8000-000000000021","viewer_social_account_id":"0b0b0000-0000-4000-8000-000000000013"}]}}'::jsonb,
   'Synthetic race-fixture rollout policy: one approved account and one pinned watchlist and viewer.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

-- The LEASED owner job. Its claim token is KNOWN, so the write and the
-- permit probes can be replayed after the exclusion commits. Its
-- connection context is bound, so the write fence reaches the context
-- check and not only the admission check.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, social_account_id, captured_on,
   job_generation, status, due_at, lease_token, lease_expires_at,
   context_viewer_social_account_id, context_credential_generation, context_login_kind)
VALUES
  ('0b0b0000-0000-4000-8000-000000000041', '0b0b0000-0000-4000-8000-000000000001', 'owner',
   '0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000011',
   current_date - 1, 1, 'leased', now() - interval '1 minute',
   '0b0b0000-0000-4000-8000-000000000031', now() + interval '1 hour',
   '0b0b0000-0000-4000-8000-000000000011', 1, 'page_linked');

-- The QUEUED owner job. The claim probe takes it.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, social_account_id, captured_on,
   job_generation, status, due_at)
VALUES
  ('0b0b0000-0000-4000-8000-000000000042', '0b0b0000-0000-4000-8000-000000000001', 'owner',
   '0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000011',
   current_date, 1, 'queued', now() - interval '1 minute');

-- A SECOND queued owner job. The claim probe takes the first one, so the
-- second one is still claimable AFTER the exclusion commits. It is what
-- proves that the committed exclusion, and not the live lease, is what
-- keeps the claim away.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, social_account_id, captured_on,
   job_generation, status, due_at)
VALUES
  ('0b0b0000-0000-4000-8000-000000000044', '0b0b0000-0000-4000-8000-000000000001', 'owner',
   '0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000011',
   current_date - 2, 1, 'queued', now() - interval '1 minute');

-- A THIRD queued owner job that no probe claims. After the exclusion
-- commits, this one must still be queued with no attempts: the committed
-- exclusion is what keeps the claim away, and the exclusion never touches
-- the job itself.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, social_account_id, captured_on,
   job_generation, status, due_at)
VALUES
  ('0b0b0000-0000-4000-8000-000000000045', '0b0b0000-0000-4000-8000-000000000001', 'owner',
   '0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000011',
   current_date - 3, 1, 'queued', now() - interval '1 minute');

-- A FOURTH queued owner job, older than the others. The claim probe
-- takes the first three, so this one is the untouched control: after the
-- exclusion commits, the claim inside the assertions must leave it
-- exactly as it is.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, social_account_id, captured_on,
   job_generation, status, due_at)
VALUES
  ('0b0b0000-0000-4000-8000-000000000046', '0b0b0000-0000-4000-8000-000000000001', 'owner',
   '0b0b0000-0000-4000-8000-000000000011', '0b0b0000-0000-4000-8000-000000000011',
   current_date - 4, 1, 'queued', now() - interval '1 minute');

-- The LEASED competitor job. Its claim token is KNOWN, so the attachment
-- probe can be replayed after the repin commits.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, watchlist_id, captured_on,
   job_generation, status, due_at, lease_token, lease_expires_at)
VALUES
  ('0b0b0000-0000-4000-8000-000000000043', '0b0b0000-0000-4000-8000-000000000001', 'competitor',
   '0b0b0000-0000-4000-8000-000000000021', '0b0b0000-0000-4000-8000-000000000021',
   current_date - 1, 1, 'leased', now() - interval '1 minute',
   '0b0b0000-0000-4000-8000-000000000033', now() + interval '1 hour');

-- A SECOND leased competitor job that no probe ever attaches. After the
-- repin commits, attaching the OLD viewer to it is refused with
-- IG_COLLECTION_VIEWER_NOT_APPROVED: the job has no bound viewer yet, so
-- the refusal is the PIN's, not the bound viewer's.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, watchlist_id, captured_on,
   job_generation, status, due_at, lease_token, lease_expires_at)
VALUES
  ('0b0b0000-0000-4000-8000-000000000047', '0b0b0000-0000-4000-8000-000000000001', 'competitor',
   '0b0b0000-0000-4000-8000-000000000021', '0b0b0000-0000-4000-8000-000000000021',
   current_date - 2, 1, 'leased', now() - interval '1 minute',
   '0b0b0000-0000-4000-8000-000000000037', now() + interval '1 hour');

COMMIT;
\echo '=== instagram_collection_rollout race fixture: prepared ==='
\echo 'owner           : 0b0b0000-0000-4000-8000-000000000001'
\echo 'approved account: 0b0b0000-0000-4000-8000-000000000011'
\echo 'excluded account: 0b0b0000-0000-4000-8000-000000000012'
\echo 'pinned viewer   : 0b0b0000-0000-4000-8000-000000000013'
\echo 'repin viewer    : 0b0b0000-0000-4000-8000-000000000014'
\echo 'watchlist       : 0b0b0000-0000-4000-8000-000000000021'
\echo 'leased owner job: 0b0b0000-0000-4000-8000-000000000041 (token ...031)'
\echo 'queued owner job: 0b0b0000-0000-4000-8000-000000000042'
\echo 'leased comp job : 0b0b0000-0000-4000-8000-000000000043 (token ...033)'

\elif :{?exclude}
-- ---------------------------------------------------------------------------
-- SESSION A - the exclusion. The transaction stays OPEN, so the change is
-- not in force until it commits.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 20
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

-- The exclusion: the approved account leaves the owners list, and the
-- competitors population goes off. The row lock on app_settings is held
-- until this transaction commits.
UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"allowlist","account_ids":["0b0b0000-0000-4000-8000-000000000012"]},"competitors":{"mode":"off","targets":[]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_rollout race fixture: exclusion committed ==='

\elif :{?repin}
-- ---------------------------------------------------------------------------
-- SESSION A - the viewer removal. The pin moves to another viewer and the
-- transaction stays OPEN.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 20
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"allowlist","account_ids":["0b0b0000-0000-4000-8000-000000000011"]},"competitors":{"mode":"allowlist","targets":[{"watchlist_id":"0b0b0000-0000-4000-8000-000000000021","viewer_social_account_id":"0b0b0000-0000-4000-8000-000000000014"}]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_rollout race fixture: repin committed ==='

\elif :{?reconnect}
-- ---------------------------------------------------------------------------
-- SESSION A - the reconnect. The live credential generation moves on and
-- the transaction stays OPEN.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 20
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

UPDATE public.instagram_account_capabilities
   SET credential_generation = credential_generation + 1
 WHERE social_account_id = '0b0b0000-0000-4000-8000-000000000011';

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_rollout race fixture: reconnect committed ==='

\elif :{?hold_account}
-- ---------------------------------------------------------------------------
-- SESSION A - the account lock. The established order takes the account
-- row FIRST, before the watchlist and before the job.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 20
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT 1
  FROM public.social_accounts
 WHERE id = '0b0b0000-0000-4000-8000-000000000011'
   FOR UPDATE;

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_rollout race fixture: account lock released ==='

\elif :{?policy_write}
-- ---------------------------------------------------------------------------
-- SESSION C - the policy writer. It touches app_settings and NOTHING
-- else, so it never waits on an account lock: there is no
-- settings -> account inversion.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 5
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

UPDATE public.app_settings
   SET value = value
 WHERE key = 'collection_instagram_rollout_policy';

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_rollout race fixture: policy writer finished ==='

\elif :{?enqueue}
-- ---------------------------------------------------------------------------
-- SESSION B - the enqueue probe. It must not wait on the policy row.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '0b0b0000-0000-4000-8000-000000000001', true);

SELECT public.enqueue_instagram_collection_job(
  'owner', '0b0b0000-0000-4000-8000-000000000011', 'normal') AS enqueue_result;

COMMIT;

\elif :{?claim}
-- ---------------------------------------------------------------------------
-- SESSION B - the claim probe. It must not wait on the policy row.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT c.value ->> 'job_id' AS job_id,
       c.value ->> 'target_kind' AS target_kind,
       c.value ->> 'target_id' AS target_id,
       c.value ->> 'job_generation' AS job_generation
  FROM public.claim_instagram_collection_jobs('owner', 25) AS c(value);

COMMIT;

\elif :{?attach}
-- ---------------------------------------------------------------------------
-- SESSION B - the attachment probe. It must not wait on the policy row.
-- The competitor job is already leased with a KNOWN token, so the probe
-- can be replayed after the repin commits.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.attach_instagram_collection_job_viewer_context(
      '0b0b0000-0000-4000-8000-000000000043',
      '0b0b0000-0000-4000-8000-000000000033',
      1,
      '0b0b0000-0000-4000-8000-000000000013');
    RAISE NOTICE 'attach probe: the pinned viewer attached';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'attach probe: refused with %', SQLERRM;
  END;
END
$probe$;

COMMIT;

\elif :{?attach_new}
-- ---------------------------------------------------------------------------
-- SESSION B - the attachment probe on a job that has NO bound viewer.
-- The refusal is then the PIN's and not the bound viewer's.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.attach_instagram_collection_job_viewer_context(
      '0b0b0000-0000-4000-8000-000000000047',
      '0b0b0000-0000-4000-8000-000000000037',
      1,
      '0b0b0000-0000-4000-8000-000000000013');
    RAISE NOTICE 'attach_new probe: the viewer attached';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'attach_new probe: refused with %', SQLERRM;
  END;
END
$probe$;

COMMIT;

\elif :{?write}
-- ---------------------------------------------------------------------------
-- SESSION B - the result write probe. It must not wait on the policy row.
-- The owner job is already leased with a KNOWN token, so the probe can be
-- replayed after the exclusion commits.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_rows integer;
BEGIN
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      '0b0b0000-0000-4000-8000-000000000041',
      '0b0b0000-0000-4000-8000-000000000031',
      1,
      jsonb_build_object('kind', 'operations', 'items', jsonb_build_array(
        jsonb_build_object('operation_key', 'media:ig-race',
                           'operation_kind', 'media', 'state', 'failed',
                           'reason_code', 'provider_error'))));
    RAISE NOTICE 'write probe: the progress write landed';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'write probe: refused with %', SQLERRM;
  END;

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_job_operations
   WHERE job_id = '0b0b0000-0000-4000-8000-000000000041';

  RAISE NOTICE 'write probe: % operation rows are visible for the job', v_rows;
END
$probe$;

COMMIT;

\elif :{?permit}
-- ---------------------------------------------------------------------------
-- SESSION B - the permit probe. It must not wait on the policy row.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_permit jsonb;
BEGIN
  v_permit := public.authorize_instagram_collection_provider_call(
    '0b0b0000-0000-4000-8000-000000000041',
    '0b0b0000-0000-4000-8000-000000000031',
    1);

  RAISE NOTICE 'permit probe: %', v_permit::text;
END
$probe$;

COMMIT;

\elif :{?observe}
-- ---------------------------------------------------------------------------
-- THE OBSERVER. It prints the LOCK waits of the other sessions.
-- ---------------------------------------------------------------------------
SELECT * FROM public.igrollout_race_waits();

\elif :{?assert}
-- ---------------------------------------------------------------------------
-- THE ASSERTIONS. Run them after the exclusion has committed.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $assert$
DECLARE
  v_result jsonb;
  v_rows   integer;
  v_before integer;
  v_after  integer;
  v_status text;
  v_attempts integer;
  v_status_before text;
  v_attempts_before integer;
  v_status_after text;
  v_attempts_after integer;
BEGIN
  -- The exclusion is in force now. The owner enqueue is refused.
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '0b0b0000-0000-4000-8000-000000000001', true);

  v_result := public.enqueue_instagram_collection_job(
    'owner', '0b0b0000-0000-4000-8000-000000000011', 'normal');

  IF COALESCE((v_result ->> 'refused')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ASSERT FAILED: the enqueue was not refused after the exclusion committed';
  END IF;

  IF v_result ->> 'reason_code' <> 'collection_not_eligible' THEN
    RAISE EXCEPTION 'ASSERT FAILED: the enqueue refusal carries %', v_result ->> 'reason_code';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- The claim takes nothing for the excluded target, and it changes
  -- nothing about the excluded job. The state is compared BEFORE and
  -- AFTER the claim, so a job an earlier probe legitimately claimed (while
  -- the exclusion was still uncommitted) is not mistaken for one the
  -- exclusion touched.
  SELECT status, attempts INTO v_status_before, v_attempts_before
    FROM public.instagram_collection_jobs
   WHERE id = '0b0b0000-0000-4000-8000-000000000046';

  SELECT count(*) INTO v_rows
    FROM public.claim_instagram_collection_jobs('owner', 25) AS c(value)
   WHERE c.value ->> 'target_id' = '0b0b0000-0000-4000-8000-000000000011';

  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the claim took % jobs of the excluded target', v_rows;
  END IF;

  SELECT status, attempts INTO v_status_after, v_attempts_after
    FROM public.instagram_collection_jobs
   WHERE id = '0b0b0000-0000-4000-8000-000000000046';

  IF v_status_after IS DISTINCT FROM v_status_before
     OR v_attempts_after IS DISTINCT FROM v_attempts_before THEN
    RAISE EXCEPTION 'ASSERT FAILED: the claim changed the excluded job from %/% to %/%',
      v_status_before, v_attempts_before, v_status_after, v_attempts_after;
  END IF;

  RAISE NOTICE 'assert: the excluded owner job is still % with % attempts', v_status_after, v_attempts_after;
  RAISE NOTICE 'assert: the exclusion is in force';

  -- Nothing new landed. The refused write added NO row: the operation
  -- count before the refused write and after it is the same. A write
  -- that happened BEFORE the exclusion committed is a different matter
  -- and is left alone.
  SELECT count(*) INTO v_before
    FROM public.instagram_collection_job_operations
   WHERE job_id = '0b0b0000-0000-4000-8000-000000000041';

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      '0b0b0000-0000-4000-8000-000000000041',
      '0b0b0000-0000-4000-8000-000000000031',
      1,
      jsonb_build_object('kind', 'operations', 'items', jsonb_build_array(
        jsonb_build_object('operation_key', 'media:ig-race-assert',
                           'operation_kind', 'media', 'state', 'failed',
                           'reason_code', 'provider_error'))));
    RAISE EXCEPTION 'ASSERT FAILED: the refused write landed';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'ASSERT FAILED: the write was refused with %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_after
    FROM public.instagram_collection_job_operations
   WHERE job_id = '0b0b0000-0000-4000-8000-000000000041';

  IF v_after <> v_before THEN
    RAISE EXCEPTION 'ASSERT FAILED: the refused write added % rows', v_after - v_before;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_job_checkpoints
   WHERE job_id = '0b0b0000-0000-4000-8000-000000000041';

  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % checkpoint rows survived the refused write', v_rows;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_jobs
   WHERE id = '0b0b0000-0000-4000-8000-000000000041'
     AND last_success_at IS NOT NULL;

  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % jobs advanced a success timestamp', v_rows;
  END IF;

  -- The excluded job was not parked and not touched: the exclusion never
  -- marks a target unavailable. The comparison above already proved that
  -- the claim left it exactly as it was.
  RAISE NOTICE 'assert: the excluded owner job is still % with % attempts', v_status_after, v_attempts_after;
  RAISE NOTICE 'assert: the exclusion is in force';
END
$assert$;

ROLLBACK;
\echo '=== instagram_collection_rollout race fixture: assertions passed ==='

\else
\echo 'This fixture has no default mode. Use -v prepare=1, then the probe modes, then -v assert=1, then -v cleanup=1.'
\endif
