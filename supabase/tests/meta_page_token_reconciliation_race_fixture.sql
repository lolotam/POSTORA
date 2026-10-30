-- ===========================================================================
-- supabase/tests/meta_page_token_reconciliation_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. One connection cannot prove a lock order, a bounded
-- refusal, a late capture deadline, a late User-grant expiry or a
-- concurrent consumption. The sequential suite is not that proof.
--
-- The harness refuses any tests/*.sql file that is not named in SUITES,
-- ISOLATED_SUITES or EXCLUDED_FROM_SUITES. This file is a manual
-- multi-session rehearsal, not a suite: scripts/db-harness.sh classifies it
-- in EXCLUDED_FROM_SUITES. Run it separately with real concurrent sessions.
--
-- DISPOSABLE DATABASES ONLY. The prepare mode COMMITS synthetic rows.
-- Re-run with -v disposable=1. There is no --cleanup switch; psql does not
-- have one, so the cleanup mode is invoked with -v cleanup=1.
--
-- WHAT THIS PREPARES
--
--   One owner with one workspace, one page-linked Instagram account (the
--   reconciliation target), one page-linked Instagram sibling and one
--   Facebook Page on the SAME shared Facebook User grant, plus one queued
--   durable Instagram collection job for the target account.
--
--   The coordination is a SEQUENCE, not a table: a sequence's nextval is
--   visible to other sessions IMMEDIATELY, while an uncommitted row update
--   is not. A driver that used a table would have to wait for a commit it is
--   trying to avoid, which is exactly the deadlock these controls look for.
--
--   public.mpr_race_signal()             advances the coordination sequence
--   public.mpr_race_wait_for(n, seconds)  blocks until the sequence reached n
--   public.mpr_race_wait_observations()   lists the locks other sessions are
--                                        currently WAITING for, which is how
--                                        a real PostgreSQL lock wait is
--                                        observed rather than assumed
--   public.mpr_race_prepare()            builds the synthetic owner, the
--                                        grant, the accounts and the job
--   public.mpr_race_capture(account)     takes a real capture with the real
--                                        begin RPC and returns its id
--   public.mpr_race_hold_account(id)     holds the account row lock
--   public.mpr_race_hold_credential(id)  holds the credential row lock
--   public.mpr_race_hold_capture(id)      holds the capture row lock
--   public.mpr_race_hold_capability(id)  holds the IG capability row, unchanged
--   public.mpr_race_hold_fence(id)       holds the FB connection-fence row,
--                                        unchanged
--   public.mpr_race_expire_capture(id)   expires a capture in place
--   public.mpr_race_move_generation(id)  moves an Instagram capability fence
--   public.mpr_race_move_connection(id)  moves a binding and connection fence
--   public.mpr_race_state()              the nonsecret state under test
--
-- THE CONTROLS AND THE REAL SESSIONS THEY NEED
--
--   C1  RECONNECT. Session A takes the capture. Session B moves the
--       binding connection version (a reconnect). Session A's reconciliation
--       must be refused with MAR04 and must write nothing.
--
--   C2  DETACH AND REBIND. Session B unbinds and rebinds the target, which
--       burns the captured connection version through the surviving
--       high-water fence. Session A's reconciliation must be refused with
--       MAR04.
--
--   C3  MEMBERSHIP. Session B removes a sibling from the grant, or adds a
--       new member to it, after the capture. Session A's reconciliation must
--       be refused with MAR04 and the lock set must not be expanded.
--
--   C4  USER ROTATION. Session B rotates the User secret and advances the
--       credential revision after the capture. Session A's reconciliation
--       must be refused with MAR04: the captured grant moved.
--
--   C5  TARGET DELETION AND DEACTIVATION. Session B deletes or deactivates
--       the target after the capture. Session A's reconciliation must be
--       refused with MAR02 (gone) or MAR03 (inactive), and must not
--       reactivate it.
--
--   C6  ADMISSION CONTENTION. Session A holds the account row lock. The
--       writer takes that row NOWAIT, so it must be refused with MAR05 in
--       bounded time and must not wait out A's hold. This is not a
--       post-admission wait. A clock delay alone does not prove which lock
--       was involved; read pg_locks if a refusal is in doubt. A bounded
--       NOWAIT refusal is not evidence that every later lock is NOWAIT.
--
--   C7  COMPETING CONSUMPTION. Session B consumes the capture with the
--       accepted shared-grant success writer, or with the accepted failure
--       writer. Session A's reconciliation must then be refused with MAR04,
--       and the reverse order must be refused too.
--
--   C8  ADMISSION-TIME CAPTURE DEADLINE. The capture is expired, or the
--       driver sleeps until near_capture_deadline has passed, and ONLY THEN
--       invokes the writer. The reconciliation must be refused with MAR04
--       and must commit nothing. This proves the check at admission. It
--       does not prove a wait inside the writer, and it must not be
--       reported as one.
--
--   C9  ADMISSION-TIME USER-GRANT EXPIRY. The captured User grant has a
--       KNOWN expiry a few seconds ahead. The driver sleeps past that
--       expiry and only then invokes the writer. The reconciliation must
--       be refused with MAR07 and must commit nothing. Same honest limit
--       as C8: the sleep is before the call, not during a lock wait.
--
--   C10 BEFORE-DEADLINE POSITIVE, NO CONTENTION. The write happens while
--       the capture is still live and the User expiry is still in the
--       future, with nobody holding the capability or fence row. The
--       reconciliation must apply: derived token, unknown expiry, one
--       generation advance and a completed capture.
--
--   C12 POST-ADMISSION CAPABILITY WAIT, BEFORE DEADLINE. Session H locks
--       the selected Instagram capability row with hold_capability and does
--       not change it. Session W invokes the writer and blocks in the
--       generation UPDATE, after admission and after the account write.
--       Session O must observe an ungranted Lock, the blocking pid and the
--       writer's transaction id before H commits. H holds for about six
--       seconds and releases while the capture and the User expiry are
--       still live. W then commits: generation advanced once, capture
--       completed. Elapsed time without that observation is not this case.
--
--   C13 CAPTURE DEADLINE DURING THE CAPABILITY WAIT. Same sessions as C12,
--       but near_capture_deadline is four seconds and H holds for six. The
--       writer is already blocked when the deadline passes. After H
--       releases, W is refused with MAR04 and the transaction rolls back
--       the token, the expiry, the fence and the capture.
--
--   C14 USER EXPIRY DURING THE CAPABILITY WAIT. Same shape, with
--       near_expiry at four seconds. After the release, W is refused with
--       MAR07 and rolls back fully.
--
--   C15 CAPTURE DEADLINE DURING THE FACEBOOK FENCE WAIT. Session H locks
--       the selected Facebook connection-fence row with hold_fence and does
--       not change it. Session W's Facebook reconciliation blocks in that
--       fence UPDATE. The same four-second deadline and six-second hold
--       refuse with MAR04 and roll back.
--
--   C16 USER EXPIRY DURING THE FACEBOOK FENCE WAIT. The C15 sessions with
--       near_expiry at four seconds. MAR07 and a full rollback.
--
--   C11 DURABLE JOB FENCING. Session A claims the queued durable collection
--       job, which captures the target's capability generation. Session B
--       reconciles the target, which advances that generation. Session A's
--       progress write must then be refused with
--       IG_COLLECTION_CREDENTIAL_CHANGED and must leave no checkpoint.
--
-- Admission locks are bounded NOWAIT. The generation UPDATE and the
-- connection-fence UPDATE can wait. C8 and C9 stay; they are not C12..C16.
--
-- Both sessions stay on the default READ COMMITTED, which is PostgREST's
-- level. Do not SET TRANSACTION ISOLATION LEVEL.
--
-- HOW TO REHEARSE
--
--   0. Prepare. Run ONCE against the disposable database:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -f supabase/tests/meta_page_token_reconciliation_race_fixture.sql
--
--   1. Take a capture and keep its id:
--
--        CAP=$(psql "$DB_URL" -At -v ON_ERROR_STOP=1 -v disposable=1 \
--          -v capture=1 \
--          -f supabase/tests/meta_page_token_reconciliation_race_fixture.sql \
--          | grep -o '[0-9a-f-]\{36\}' | head -1)
--
--   2. SESSION A, in the background, holding the account lock open:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -v hold_account=1 -v hold_seconds=20 -v capture_id="$CAP" \
--          -f supabase/tests/meta_page_token_reconciliation_race_fixture.sql
--
--   3. SESSION B, WHILE SESSION A IS STILL HOLDING:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -v capture_id="$CAP" \
--          -f supabase/tests/meta_page_token_reconciliation_race_fixture.sql
--
--   4. Cleanup. Run it even when the rehearsal failed part way:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--          -f supabase/tests/meta_page_token_reconciliation_race_fixture.sql
--
-- POST-ADMISSION WAIT (C12). Three sessions overlap. Do not sleep before
-- starting the writer and then call that a wait. The observer must be
-- running while the writer is blocked; a synchronous observer that never
-- lets the writer start proves nothing.
--
--   CAP=$(psql ... -v disposable=1 -v capture=1 -f this_file | ...)
--   # Session H, about six seconds, does not modify the row:
--   psql ... -v disposable=1 -v hold_capability=1 -v hold_seconds=6 -f this_file
--   # Session W, started only after H has printed its locked row:
--   psql ... -v disposable=1 -v reconcile=1 -v capture_id="$CAP" -f this_file
--   # Session O, overlapping W, until an ungranted lock is printed:
--   psql ... -v disposable=1 -v observe=1 -f this_file
--
-- The observation is empty until a real ungranted Lock is visible. It
-- includes the waiter pid, the blocking pid, the waiter transaction id and
-- granted=false. The observer reads pg_stat_activity afresh on every poll
-- (pg_stat_clear_snapshot); a STABLE snapshot would keep seeing the first
-- sample. C13 and C14 add -v near_capture_deadline=1 or -v near_expiry=1
-- with -v expiry_seconds=4 BEFORE H and W, and H still holds for six
-- seconds. C15 and C16 use -v capture_facebook=1, -v hold_fence=1 and
-- -v reconcile_facebook=1. C8 and C9 are the older pattern: the same
-- deadline modes, then a sleep, and only then the writer. Label them as
-- admission-time expiry.
--
-- The driver that runs the sessions lives outside the repository, in the
-- delivery evidence directory. This file is the reusable fixture it needs.
--
-- psql does not substitute variables inside a dollar-quoted body, so the
-- capture id is handed to the bodies through a transaction-local setting.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
BEGIN;

DROP FUNCTION IF EXISTS public.mpr_race_state();
DROP FUNCTION IF EXISTS public.mpr_race_move_connection(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_move_generation(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_expire_capture(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_hold_fence(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_hold_capability(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_hold_capture(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_hold_credential(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_hold_account(UUID);
DROP FUNCTION IF EXISTS public.mpr_race_capture(UUID, TEXT);
DROP FUNCTION IF EXISTS public.mpr_race_prepare();
DROP FUNCTION IF EXISTS public.mpr_race_wait_observations_until(INTEGER);
DROP FUNCTION IF EXISTS public.mpr_race_wait_observations();
DROP FUNCTION IF EXISTS public.mpr_race_wait_for(BIGINT, INTEGER);
DROP FUNCTION IF EXISTS public.mpr_race_signal();
DROP TABLE IF EXISTS public.mpr_race_gate;
DROP SEQUENCE IF EXISTS public.mpr_race_seq;

-- The synthetic owner cascades to its accounts, its capability records, its
-- credential, its bindings, its capture rows, its collection jobs and its
-- outbox rows.
DELETE FROM auth.users WHERE id = 'f4ac0001-0000-4000-8000-000000000001';

-- The rollout fixture goes back to the default. The prepare step turned
-- the collection on and a collection gate left open is not a thing this
-- fixture may leave behind.
DELETE FROM public.app_settings
 WHERE key = 'collection_instagram_insights_enabled';
UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: cleaned synthetic owner ==='
\elif :{?observe}
-- Prints the locks other sessions are currently WAITING for. A wait that is
-- observed in pg_locks is a real PostgreSQL lock wait; a wait that is
-- merely inferred from a delay is not evidence.
BEGIN;
SELECT public.mpr_race_wait_observations_until(5) AS observed_waits;
COMMIT;
\elif :{?signal}
BEGIN;
SELECT public.mpr_race_signal() AS sequence_value;
COMMIT;
\elif :{?hold_account}
-- SESSION A. Holds the account row lock in the caller's transaction. A
-- second session that tries the same account must be refused in bounded
-- time rather than wait, and must write nothing.
BEGIN;
SELECT public.mpr_race_hold_account('f4ac0201-0000-4000-8000-000000000021') AS held;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: account hold released ==='
\elif :{?hold_credential}
-- SESSION A. Holds the shared credential row lock.
BEGIN;
SELECT public.mpr_race_hold_credential('f4ac0301-0000-4000-8000-000000000031') AS held;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: credential hold released ==='
\elif :{?hold_capture}
-- SESSION A. Holds the capture row lock. The writer takes that row NOWAIT,
-- so it must refuse rather than wait.
BEGIN;
SELECT public.mpr_race_hold_capture(:'capture_id'::uuid) AS held;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: capture hold released ==='
\elif :{?hold_capability}
-- SESSION H. Holds the selected Instagram capability row and does not
-- change it. Admission does not take this row. The writer's generation
-- UPDATE waits here. This is a post-admission wait, not C6.
BEGIN;
SELECT public.mpr_race_hold_capability('f4ac0201-0000-4000-8000-000000000021') AS held;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: capability hold released ==='
\elif :{?hold_fence}
-- SESSION H. Holds the selected Facebook connection-fence row and does not
-- change it. The writer's fence UPDATE waits on this row after the binding
-- update. This is a post-admission wait, not an admission NOWAIT.
BEGIN;
SELECT public.mpr_race_hold_fence('f4ac0201-0000-4000-8000-000000000023') AS held;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: fence hold released ==='
\elif :{?capture}
-- Takes a real capture with the real begin RPC and prints its id. The
-- capture is committed, so another session can consume it.
BEGIN;
SELECT public.mpr_race_capture(
  'f4ac0201-0000-4000-8000-000000000021', 'facebook_user_token') AS capture;
COMMIT;
\elif :{?capture_facebook}
-- Takes a real capture for the Facebook Page of the same grant.
BEGIN;
SELECT public.mpr_race_capture(
  'f4ac0201-0000-4000-8000-000000000023', 'facebook_user_token') AS capture;
COMMIT;
\elif :{?reconcile}
-- The reconciliation itself. The writer is service-only, so the session
-- asserts the service role the way the rest of the stack does.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('mpr.capture_id', :'capture_id', true);
SELECT public.mpr_race_state() AS state_before;
DO $reconcile$
DECLARE
  v_result JSONB;
BEGIN
  v_result := public.write_meta_page_reconciliation_success(
    'f4ac0001-0000-4000-8000-000000000001',
    jsonb_build_object(
      'capture_id', current_setting('mpr.capture_id')::UUID,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'mpr-race-derived-token',
        'facebook_page_id', 'mpr-race-page',
        'instagram_user_id', 'mpr-race-ig-1',
        'token_expires_at', NULL)));
  RAISE NOTICE 'reconciliation applied: %', v_result ->> 'applied';
END
$reconcile$;
SELECT public.mpr_race_state() AS state_after;
SELECT c.status AS capture_status
  FROM public.meta_account_refresh_captures AS c
 WHERE c.id = current_setting('mpr.capture_id')::UUID;
COMMIT;
\elif :{?reconcile_facebook}
-- The reconciliation of the Facebook Page. Its Instagram identity is an
-- explicit JSON null and its reported generation is null.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('mpr.capture_id', :'capture_id', true);
DO $reconcile_fb$
DECLARE
  v_result JSONB;
BEGIN
  v_result := public.write_meta_page_reconciliation_success(
    'f4ac0001-0000-4000-8000-000000000001',
    jsonb_build_object(
      'capture_id', current_setting('mpr.capture_id')::UUID,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'mpr-race-derived-fb-token',
        'facebook_page_id', 'mpr-race-fb-1',
        'instagram_user_id', NULL,
        'token_expires_at', NULL)));
  RAISE NOTICE 'facebook reconciliation applied: %', v_result ->> 'applied';
END
$reconcile_fb$;
SELECT public.mpr_race_state() AS state_after;
COMMIT;
\elif :{?reconnect}
-- A reconnect moves the binding and connection fence. The captured version
-- is then stale.
BEGIN;
SELECT public.mpr_race_move_connection('f4ac0201-0000-4000-8000-000000000021') AS moved;
COMMIT;
\elif :{?rebind}
-- A detach and rebind of the same account on the same grant. The surviving
-- high-water fence burns the captured connection version.
BEGIN;
DELETE FROM public.facebook_user_credential_bindings
 WHERE social_account_id = 'f4ac0201-0000-4000-8000-000000000021';
INSERT INTO public.facebook_user_credential_bindings (
  social_account_id, user_id, platform, credential_id,
  verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
  evidence_source, connection_version
) VALUES (
  'f4ac0201-0000-4000-8000-000000000021',
  'f4ac0001-0000-4000-8000-000000000001',
  'instagram', 'f4ac0301-0000-4000-8000-000000000031',
  'mpr-race-fb-user', 'mpr-race-page', 'mpr-race-ig-1',
  'oauth_exchange',
  (SELECT f.connection_version
     FROM public.facebook_user_credential_connection_fences AS f
    WHERE f.social_account_id = 'f4ac0201-0000-4000-8000-000000000021'));
COMMIT;
\elif :{?membership_remove}
-- A sibling leaves the grant after the capture.
BEGIN;
DELETE FROM public.facebook_user_credential_bindings
 WHERE social_account_id = 'f4ac0201-0000-4000-8000-000000000022';
COMMIT;
\elif :{?membership_add}
-- A new member joins the grant after the capture.
BEGIN;
INSERT INTO public.facebook_user_credential_bindings (
  social_account_id, user_id, platform, credential_id,
  verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
  evidence_source, connection_version
) VALUES (
  'f4ac0201-0000-4000-8000-000000000024', 'f4ac0001-0000-4000-8000-000000000001',
  'instagram', 'f4ac0301-0000-4000-8000-000000000031',
  'mpr-race-fb-user', 'mpr-race-page', 'mpr-race-ig-3',
  'oauth_exchange', 1);
COMMIT;
\elif :{?rotate_user}
-- The shared User grant rotates under the captured revision.
BEGIN;
UPDATE public.facebook_user_credentials
   SET token = 'mpr-race-rotated-user-token',
       revision = revision + 1,
       provenance_source = 'token_refresh',
       provenance_captured_at = clock_timestamp()
 WHERE id = 'f4ac0301-0000-4000-8000-000000000031';
COMMIT;
\elif :{?deactivate}
-- The target stops being usable.
BEGIN;
UPDATE public.social_accounts SET is_active = false
 WHERE id = 'f4ac0201-0000-4000-8000-000000000021';
COMMIT;
\elif :{?delete_account}
-- The target is gone.
BEGIN;
DELETE FROM public.social_accounts
 WHERE id = 'f4ac0201-0000-4000-8000-000000000021';
COMMIT;
\elif :{?expire_capture}
-- The capture deadline passes.
BEGIN;
SELECT public.mpr_race_expire_capture(:'capture_id'::uuid) AS expired;
COMMIT;
\elif :{?near_capture_deadline}
-- The capture deadline is moved a few seconds ahead. The captured_at value
-- is left alone, because the capture's own CHECK requires expires_at >
-- captured_at. Sleeping until this instant and only then starting the
-- writer is C8, an admission-time expiry test. Starting the writer first,
-- while hold_capability or hold_fence still blocks it, is C13 or C15.
BEGIN;
UPDATE public.meta_account_refresh_captures
   SET expires_at = clock_timestamp() + make_interval(secs => :expiry_seconds)
 WHERE id = :'capture_id'::uuid;
COMMIT;
\elif :{?near_expiry}
-- The captured User grant gets a KNOWN expiry a few seconds ahead. This is
-- the separate late-expiry guard: it is not the capture deadline. Sleeping
-- past it before the writer starts is C9. Holding the capability or fence
-- row across it while the writer is blocked is C14 or C16.
BEGIN;
UPDATE public.facebook_user_credentials
   SET token_expires_at = clock_timestamp() + make_interval(secs => :expiry_seconds)
 WHERE id = 'f4ac0301-0000-4000-8000-000000000031';
COMMIT;
\elif :{?consume_success}
-- The accepted shared-grant success writer consumes the capture first.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('mpr.capture_id', :'capture_id', true);
DO $consume_success$
DECLARE
  v_result JSONB;
BEGIN
  v_result := public.write_meta_account_refresh_success(
    'f4ac0001-0000-4000-8000-000000000001',
    jsonb_build_object(
      'capture_id', current_setting('mpr.capture_id')::UUID,
      'operation', 'facebook_user_token',
      'fields', jsonb_build_object('token', 'mpr-race-rotated-user-token')));
  RAISE NOTICE 'accepted success writer applied: %', v_result ->> 'applied';
END
$consume_success$;
COMMIT;
\elif :{?consume_failure}
-- The accepted failure writer consumes the capture first.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('mpr.capture_id', :'capture_id', true);
DO $consume_failure$
DECLARE
  v_result JSONB;
BEGIN
  v_result := public.record_meta_refresh_failure(
    'f4ac0001-0000-4000-8000-000000000001',
    jsonb_build_object(
      'capture_id', current_setting('mpr.capture_id')::UUID,
      'social_account_id', 'f4ac0201-0000-4000-8000-000000000021',
      'error_category', 'provider_transient'));
  RAISE NOTICE 'accepted failure writer applied: %', v_result ->> 'applied';
END
$consume_failure$;
COMMIT;
\elif :{?job_claim}
-- SESSION A of the durable job control. Claims the queued owner job, which
-- captures the target's capability generation.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT c ->> 'job_id'         AS job_id,
       c ->> 'claim_token'    AS claim_token,
       c ->> 'job_generation' AS job_generation
  FROM public.claim_instagram_collection_jobs('owner', 25) AS c
 WHERE c ->> 'social_account_id' = 'f4ac0201-0000-4000-8000-000000000021';
COMMIT;
\elif :{?job_progress}
-- SESSION A, after session B reconciled the target. The progress write must
-- be refused and must leave no checkpoint.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
DO $job_progress$
DECLARE
  v_job   uuid;
  v_token uuid;
  v_gen   bigint;
  v_checkpoints integer;
BEGIN
  SELECT j.id, j.lease_token, j.job_generation
    INTO v_job, v_token, v_gen
    FROM public.instagram_collection_jobs AS j
   WHERE j.social_account_id = 'f4ac0201-0000-4000-8000-000000000021';

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'race fixture: no claimed job';
  END IF;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 9));
    RAISE EXCEPTION 'race fixture FAILED: the fenced job wrote a checkpoint';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'race fixture expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_checkpoints
    FROM public.instagram_collection_job_checkpoints
   WHERE job_id = v_job AND inventory_pages_fetched = 9;
  IF v_checkpoints <> 0 THEN
    RAISE EXCEPTION 'race fixture FAILED: the refused progress left a checkpoint';
  END IF;

  RAISE NOTICE 'the fenced durable job was refused and left no checkpoint';
END
$job_progress$;
COMMIT;
\elif :{?state}
BEGIN;
SELECT public.mpr_race_state() AS state;
COMMIT;
\else
BEGIN;

-- The service role is asserted the way the rest of the stack asserts it, so
-- the durable-job helpers accept the synthetic owner.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

-- The coordination primitives.
CREATE SEQUENCE IF NOT EXISTS public.mpr_race_seq;
CREATE TABLE IF NOT EXISTS public.mpr_race_gate (
  id      integer PRIMARY KEY,
  note    text
);
INSERT INTO public.mpr_race_gate (id, note)
VALUES (1, 'meta page token reconciliation race control')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mpr_race_signal()
RETURNS BIGINT
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT nextval('public.mpr_race_seq');
$function$;

-- Blocks until the coordination sequence reached the target, or the timeout
-- expires. Returns the value it saw, so a driver can prove it really
-- waited rather than assuming it did.
CREATE OR REPLACE FUNCTION public.mpr_race_wait_for(
  p_target BIGINT,
  p_timeout_seconds INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_seen BIGINT := 0;
  v_deadline TIMESTAMPTZ := clock_timestamp() + make_interval(secs => p_timeout_seconds);
BEGIN
  LOOP
    SELECT last_value INTO v_seen FROM public.mpr_race_seq;
    IF v_seen >= p_target THEN
      RETURN v_seen;
    END IF;
    IF clock_timestamp() >= v_deadline THEN
      RETURN v_seen;
    END IF;
    PERFORM pg_sleep(0.02);
  END LOOP;
END;
$function$;

-- The locks other sessions are currently WAITING for. A wait that is
-- observed in pg_locks is a real PostgreSQL lock wait; a wait that is
-- merely inferred from a delay is not evidence.
--
-- pg_stat_activity keeps a transaction-scoped snapshot. A STABLE function,
-- or a loop that reads it once, would keep reporting the first sample and
-- miss a lock that appears later. Clear that snapshot on every read.
-- VOLATILE so the call is not folded away. The text carries the waiter pid,
-- the blocking pid, the waiter transaction id and granted=false.
CREATE OR REPLACE FUNCTION public.mpr_race_wait_observations()
RETURNS TABLE (observation TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  PERFORM pg_stat_clear_snapshot();
  RETURN QUERY
  SELECT COALESCE(
    string_agg(
      format('%s|blocked_by=%s|xid=%s|%s|%s|granted=%s',
             a.pid,
             coalesce((pg_blocking_pids(a.pid))[1]::TEXT, '?'),
             coalesce(a.backend_xid::TEXT, '?'),
             a.wait_event_type,
             coalesce(c.relname, l.locktype::text),
             CASE WHEN l.granted THEN 'true' ELSE 'false' END),
      ';' ORDER BY a.pid, l.locktype, c.relname),
    'none')
    FROM pg_locks AS l
    JOIN pg_stat_activity AS a
      ON a.pid = l.pid
    LEFT JOIN pg_class AS c
      ON c.oid = l.relation
   WHERE NOT l.granted
     AND a.wait_event_type = 'Lock'
     AND a.datname = current_database()
     AND a.pid <> pg_backend_pid();
END;
$function$;

-- The polling form waits for the wait to APPEAR rather than sampling once.
CREATE OR REPLACE FUNCTION public.mpr_race_wait_observations_until(
  p_timeout_seconds INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_observation TEXT := 'none';
  v_deadline TIMESTAMPTZ := clock_timestamp() + make_interval(secs => p_timeout_seconds);
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    SELECT o.observation INTO v_observation
      FROM public.mpr_race_wait_observations() AS o;
    EXIT WHEN v_observation IS DISTINCT FROM 'none';
    EXIT WHEN clock_timestamp() >= v_deadline;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RETURN v_observation;
END;
$function$;

-- The synthetic owner, its workspace, its accounts, its shared grant and its
-- durable collection job.
CREATE OR REPLACE FUNCTION public.mpr_race_prepare()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_user CONSTANT uuid := 'f4ac0001-0000-4000-8000-000000000001';
  v_workspace CONSTANT uuid := 'f4ac0101-0000-4000-8000-000000000011';
  v_target CONSTANT uuid := 'f4ac0201-0000-4000-8000-000000000021';
  v_sibling CONSTANT uuid := 'f4ac0201-0000-4000-8000-000000000022';
  v_facebook CONSTANT uuid := 'f4ac0201-0000-4000-8000-000000000023';
  v_newcomer CONSTANT uuid := 'f4ac0201-0000-4000-8000-000000000024';
  v_credential CONSTANT uuid := 'f4ac0301-0000-4000-8000-000000000031';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_user, 'mpr-race@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id, is_personal)
  VALUES (v_workspace, 'mpr-race-ws', v_user, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_accounts (
    id, user_id, workspace_id, platform, platform_user_id, platform_username,
    access_token, refresh_token, token_expires_at, is_active
  ) VALUES
    (v_target, v_user, v_workspace, 'instagram', 'mpr-race-ig-1', 'mpr_race_ig_1',
     'mpr-race-page-token', 'mpr-race-page-refresh', '2099-01-02T00:00:00Z', true),
    (v_sibling, v_user, v_workspace, 'instagram', 'mpr-race-ig-2', 'mpr_race_ig_2',
     'mpr-race-sibling-token', NULL, '2099-01-03T00:00:00Z', true),
    (v_facebook, v_user, v_workspace, 'facebook', 'mpr-race-fb-1', 'mpr_race_fb_1',
     'mpr-race-fb-token', NULL, NULL, true),
    (v_newcomer, v_user, v_workspace, 'instagram', 'mpr-race-ig-3', 'mpr_race_ig_3',
     'mpr-race-newcomer-token', NULL, '2099-01-04T00:00:00Z', true)
  ON CONFLICT (id) DO UPDATE
    SET workspace_id = EXCLUDED.workspace_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_expires_at = EXCLUDED.token_expires_at,
        is_active = true,
        needs_reauth = false,
        failure_count = 0,
        last_refresh_error = NULL,
        last_alert_sent_at = NULL,
        last_refresh_attempt_at = NULL;

  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, token_expires_at, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES (
    v_credential, v_user, 'mpr-race-user-token', 1, 'active', '2099-02-01T00:00:00Z',
    'mpr-race-fb-user', 'oauth_exchange', '2026-01-01T00:00:00Z'
  ) ON CONFLICT (id) DO UPDATE
    SET token = EXCLUDED.token,
        revision = 1,
        lifecycle = 'active',
        token_expires_at = EXCLUDED.token_expires_at,
        provider_user_id = EXCLUDED.provider_user_id;

  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
    evidence_source, connection_version
  ) VALUES
    (v_target, v_user, 'instagram', v_credential,
     'mpr-race-fb-user', 'mpr-race-page', 'mpr-race-ig-1', 'oauth_exchange', 1),
    (v_sibling, v_user, 'instagram', v_credential,
     'mpr-race-fb-user', 'mpr-race-page', 'mpr-race-ig-2', 'oauth_exchange', 1),
    (v_facebook, v_user, 'facebook', v_credential,
     'mpr-race-fb-user', NULL, NULL, 'oauth_exchange', 1)
  ON CONFLICT (social_account_id) DO UPDATE
    SET credential_id = EXCLUDED.credential_id,
        verified_facebook_user_id = EXCLUDED.verified_facebook_user_id,
        verified_facebook_page_id = EXCLUDED.verified_facebook_page_id,
        verified_instagram_user_id = EXCLUDED.verified_instagram_user_id,
        connection_version = 1;

  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES
    (v_target, v_user, 'instagram', 1),
    (v_sibling, v_user, 'instagram', 1),
    (v_facebook, v_user, 'facebook', 1)
  ON CONFLICT (social_account_id) DO UPDATE
    SET connection_version = 1;

  INSERT INTO public.instagram_account_capabilities (
    social_account_id, user_id, platform, login_kind, permission_read_state,
    granted_scopes, scopes_read_at, credential_generation
  ) VALUES
    (v_target, v_user, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights'], '2026-01-01T00:00:00Z', 2),
    (v_sibling, v_user, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
    (v_newcomer, v_user, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 1)
  ON CONFLICT (social_account_id) DO UPDATE
    SET credential_generation = EXCLUDED.credential_generation,
        permission_read_state = EXCLUDED.permission_read_state,
        granted_scopes = EXCLUDED.granted_scopes,
        scopes_read_at = EXCLUDED.scopes_read_at;

  DELETE FROM public.instagram_collection_jobs WHERE user_id = v_user;

  -- The rollout fixture. R1 (20261030150000) made the collection admission
  -- a default-off gate, so the rehearsal needs an explicit synthetic
  -- policy. The cleanup puts the default back.
  INSERT INTO public.app_settings (key, value, description)
  VALUES
    ('collection_instagram_insights_enabled', 'true'::jsonb,
     'Synthetic race-fixture master switch.'),
    ('collection_instagram_rollout_policy',
     '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb,
     'Synthetic race-fixture rollout policy: every otherwise eligible target.')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  PERFORM public.enqueue_instagram_collection_jobs_service(
    v_user,
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', v_target,
      'mode', 'normal')));

  RETURN jsonb_build_object(
    'user_id', v_user,
    'workspace_id', v_workspace,
    'target_account_id', v_target,
    'sibling_account_id', v_sibling,
    'facebook_account_id', v_facebook,
    'newcomer_account_id', v_newcomer,
    'credential_id', v_credential);
END;
$function$;

-- Takes a real capture with the real begin RPC. The capture is committed, so
-- another session can consume it.
CREATE OR REPLACE FUNCTION public.mpr_race_capture(
  p_social_account_id UUID,
  p_operation TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_owner CONSTANT uuid := 'f4ac0001-0000-4000-8000-000000000001';
  v_result JSONB;
BEGIN
  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', p_social_account_id,
      'operation', p_operation))));
  RETURN jsonb_build_object(
    'capture_id', v_result ->> 'capture_id',
    'operation', v_result ->> 'operation',
    'captured_at', v_result ->> 'captured_at',
    'expires_at', v_result ->> 'expires_at');
END;
$function$;

-- Holds the account row lock in the caller's transaction.
CREATE OR REPLACE FUNCTION public.mpr_race_hold_account(
  p_social_account_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_locked TEXT;
BEGIN
  SELECT 'locked:' || sa.id::TEXT INTO v_locked
    FROM public.social_accounts AS sa
   WHERE sa.id = p_social_account_id
     FOR UPDATE;
  RETURN coalesce(v_locked, 'missing');
END;
$function$;

-- Holds the shared credential row lock.
CREATE OR REPLACE FUNCTION public.mpr_race_hold_credential(
  p_credential_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_locked TEXT;
BEGIN
  SELECT 'locked:' || c.id::TEXT INTO v_locked
    FROM public.facebook_user_credentials AS c
   WHERE c.id = p_credential_id
     FOR UPDATE;
  RETURN coalesce(v_locked, 'missing');
END;
$function$;

-- Holds the selected Instagram capability row without changing it. The
-- writer's generation UPDATE waits on this lock. Admission does not.
CREATE OR REPLACE FUNCTION public.mpr_race_hold_capability(
  p_social_account_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_locked TEXT;
BEGIN
  SELECT 'locked:' || c.social_account_id::TEXT
         || ':generation:' || c.credential_generation::TEXT
    INTO v_locked
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     FOR UPDATE;
  IF v_locked IS NULL THEN
    RETURN 'missing';
  END IF;
  -- stderr, so a driver sees the lock before pg_sleep in the caller.
  -- pg_backend_pid() is this holder, which the observer's blocked_by must name.
  RAISE NOTICE 'HOLDER_READY pid=% %', pg_backend_pid(), v_locked;
  RETURN v_locked;
END;
$function$;

-- Holds the selected Facebook connection-fence row without changing it.
-- The writer's fence UPDATE waits here. The binding row is a different lock.
CREATE OR REPLACE FUNCTION public.mpr_race_hold_fence(
  p_social_account_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_locked TEXT;
BEGIN
  SELECT 'locked:' || f.social_account_id::TEXT
         || ':fence:' || f.connection_version::TEXT
    INTO v_locked
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = p_social_account_id
     FOR UPDATE;
  IF v_locked IS NULL THEN
    RETURN 'missing';
  END IF;
  RAISE NOTICE 'HOLDER_READY pid=% %', pg_backend_pid(), v_locked;
  RETURN v_locked;
END;
$function$;

-- Holds the capture row lock. The writer takes that row NOWAIT.
CREATE OR REPLACE FUNCTION public.mpr_race_hold_capture(
  p_capture_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_locked TEXT;
BEGIN
  SELECT 'locked:' || c.id::TEXT INTO v_locked
    FROM public.meta_account_refresh_captures AS c
   WHERE c.id = p_capture_id
     FOR UPDATE;
  RETURN coalesce(v_locked, 'missing');
END;
$function$;

-- Expires a capture in place, so a commit that arrives after the deadline is
-- refused rather than accepted.
CREATE OR REPLACE FUNCTION public.mpr_race_expire_capture(
  p_capture_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  UPDATE public.meta_account_refresh_captures
     SET captured_at = clock_timestamp() - INTERVAL '1 hour',
         expires_at = clock_timestamp() - INTERVAL '1 minute'
   WHERE id = p_capture_id;
  RETURN 'expired';
END;
$function$;

-- Moves an Instagram capability fence, which is what a reconnect, a revoke
-- or a direct <-> page conversion does underneath a captured result.
CREATE OR REPLACE FUNCTION public.mpr_race_move_generation(
  p_social_account_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_next BIGINT;
BEGIN
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = p_social_account_id
  RETURNING credential_generation INTO v_next;
  RETURN coalesce('generation:' || v_next::TEXT, 'missing');
END;
$function$;

-- Moves the binding and the connection fence of one account, which is what
-- a reconnect or a rebind does underneath a captured result.
CREATE OR REPLACE FUNCTION public.mpr_race_move_connection(
  p_social_account_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_next BIGINT;
BEGIN
  UPDATE public.facebook_user_credential_bindings
     SET connection_version = connection_version + 1
   WHERE social_account_id = p_social_account_id
  RETURNING connection_version INTO v_next;

  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = connection_version + 1
   WHERE social_account_id = p_social_account_id;

  RETURN coalesce('connection:' || v_next::TEXT, 'missing');
END;
$function$;

-- The nonsecret state under test. It never prints a token value: it prints
-- whether the operational token is the derived one, and the versions.
CREATE OR REPLACE FUNCTION public.mpr_race_state()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT jsonb_build_object(
    'target_token_is_derived',
      (SELECT sa.access_token = 'mpr-race-derived-token'
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'target_token_is_still_captured',
      (SELECT sa.access_token = 'mpr-race-page-token'
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'target_expiry_is_unknown',
      (SELECT sa.token_expires_at IS NULL
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'target_failure_count',
      (SELECT sa.failure_count
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'target_last_refresh_error_is_null',
      (SELECT sa.last_refresh_error IS NULL
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'target_is_active',
      (SELECT sa.is_active
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'target_generation',
      (SELECT c.credential_generation
         FROM public.instagram_account_capabilities AS c
        WHERE c.social_account_id = 'f4ac0201-0000-4000-8000-000000000021'),
    'sibling_generation',
      (SELECT c.credential_generation
         FROM public.instagram_account_capabilities AS c
        WHERE c.social_account_id = 'f4ac0201-0000-4000-8000-000000000022'),
    'facebook_binding_version',
      (SELECT b.connection_version
         FROM public.facebook_user_credential_bindings AS b
        WHERE b.social_account_id = 'f4ac0201-0000-4000-8000-000000000023'),
    'credential_revision',
      (SELECT c.revision
         FROM public.facebook_user_credentials AS c
        WHERE c.id = 'f4ac0301-0000-4000-8000-000000000031'),
    'credential_expiry_is_unchanged',
      (SELECT c.token_expires_at = '2099-02-01T00:00:00Z'::TIMESTAMPTZ
         FROM public.facebook_user_credentials AS c
        WHERE c.id = 'f4ac0301-0000-4000-8000-000000000031'),
    'facebook_fence_version',
      (SELECT f.connection_version
         FROM public.facebook_user_credential_connection_fences AS f
        WHERE f.social_account_id = 'f4ac0201-0000-4000-8000-000000000023'),
    'facebook_token_is_original',
      (SELECT sa.access_token = 'mpr-race-fb-token'
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000023'),
    'facebook_token_is_derived',
      (SELECT sa.access_token = 'mpr-race-derived-fb-token'
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000023'),
    'user_token_is_original',
      (SELECT c.token = 'mpr-race-user-token'
         FROM public.facebook_user_credentials AS c
        WHERE c.id = 'f4ac0301-0000-4000-8000-000000000031'),
    'target_expiry_is_original',
      (SELECT sa.token_expires_at = '2099-01-02T00:00:00Z'::TIMESTAMPTZ
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000021'),
    'sibling_token_is_original',
      (SELECT sa.access_token = 'mpr-race-sibling-token'
         FROM public.social_accounts AS sa
        WHERE sa.id = 'f4ac0201-0000-4000-8000-000000000022')
  );
$function$;

-- The synthetic rows are committed by this mode, so the driver can use them
-- from any session.
SELECT public.mpr_race_prepare();

COMMIT;
\echo '=== meta_page_token_reconciliation race fixture: prepared synthetic owner ==='
\endif
