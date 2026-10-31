-- ============================================================================
-- supabase/tests/instagram_durable_collection_jobs_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. scripts/db-harness.sh does not run it. A single
-- connection cannot prove that two workers cannot claim the same job, and
-- the sequential checks in instagram_durable_collection_jobs.sql are not that
-- proof. This file must not be described as if they were.
--
-- DISPOSABLE DATABASES ONLY. The prepare path COMMITS a synthetic owner.
-- Do not point DB_URL at a shared database or at production. The script
-- refuses to run unless psql was given -v disposable=1. There is no
-- --cleanup switch; psql does not have one.
--
-- WHAT THE TWO SESSIONS ACTUALLY PROVE
--
--   1. EXCLUSIVE CLAIM. Session A holds the claim in an OPEN transaction,
--      which holds the account row lock (taken before the job). Session B
--      calls the same claim function. B tries that account NOWAIT and skips
--      it, so B must receive ZERO rows for A's job and must not block until
--      A's hold ends. lock_timeout on the probe turns a mistaken wait into
--      a fast failure.
--
--   2. A FORCE SUPERSEDES A LIVE CLAIM. Session B forces the job. The
--      generation advances, the lease is cleared and the old claim token
--      stops working: session A's write must then be refused with
--      IG_COLLECTION_CLAIM_STALE, and no snapshot may land.
--
--   3. PARENT LOCK COUPLING. After the job is claimed and committed:
--      Session A locks the account row, sleeps, then either releases,
--      bumps credential_generation, deactivates the account, or sets the
--      lease expiry to the wall clock, and commits.
--      Session B's progress call blocks on that account lock (the fence
--      takes it before the job) and then rechecks with clock_timestamp().
--      release: the progress commits (positive control).
--      generation: IG_COLLECTION_CREDENTIAL_CHANGED and no checkpoint.
--      deactivate: IG_COLLECTION_TARGET_INACTIVE and no checkpoint.
--      lease: IG_COLLECTION_CLAIM_STALE. B's now() is still before the
--      expiry A wrote, so a frozen now() would accept the write.
--
--   4. SIBLING CLAIM. positive_prepare adds a second account. positive_hold
--      locks only the first account. positive_claim must skip that job and
--      claim the sibling. This is the positive concurrent control: a busy
--      parent does not stall an unrelated target.
--
--   5. SHARED BUCKET VERSUS THE LEASE. throttle_seed claims the prepared
--      job and stores a bucket at usage 1, with the lease ending
--      lease_seconds from that commit. throttle_hold locks that bucket row
--      and sleeps. throttle_write then calls the job-scoped throttle RPC,
--      which has to wait for the bucket before it can park the job.
--      expect=ok (release while the lease is still live) parks the retry
--      and stores usage 99. expect=stale (release after the lease is past)
--      raises IG_COLLECTION_CLAIM_STALE and leaves usage 1, status leased
--      and the lease timestamp in place. The hold is selected before the
--      plain hold_seconds branch, so it may also pass hold_seconds.
--
-- Both sessions stay on the default READ COMMITTED, which is PostgREST's
-- level. Do not SET TRANSACTION ISOLATION LEVEL.
--
-- HOW TO REHEARSE
--
--   0. Prepare. Run ONCE against the disposable database:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -f supabase/tests/instagram_durable_collection_jobs_race_fixture.sql
--
--      Creates owner 0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a with one
--      Instagram account, its capability row, and one queued collection job.
--
--   1. SESSION A, in the background, holding the claim open:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v hold_seconds=20 \
--          -f supabase/tests/instagram_durable_collection_jobs_race_fixture.sql
--
--      It claims the job, prints the claim token, holds the transaction
--      open for hold_seconds, then commits.
--
--   2. SESSION B, WHILE SESSION A IS STILL HOLDING:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -f supabase/tests/instagram_durable_collection_jobs_race_fixture.sql
--
--      It probes the claim. The probe must report zero claimed jobs. A
--      non-zero count means two workers can hold the same job, and the
--      durable queue is broken.
--
--   3. After session A has committed, the stale writer:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -f supabase/tests/instagram_durable_collection_jobs_race_fixture.sql
--
--      It forces the job and then tries to write with the retired claim.
--      The write must be refused with IG_COLLECTION_CLAIM_STALE and no
--      snapshot row may exist.
--
--   4. Cleanup. Run it even when the rehearsal failed part way:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--          -f supabase/tests/instagram_durable_collection_jobs_race_fixture.sql
--
-- A PASS of the rehearsal is all of:
--
--   * Session B's probe reported zero claimed jobs while session A held
--     the claim.
--   * The forced write was refused with IG_COLLECTION_CLAIM_STALE.
--   * No snapshot row for the raced media id exists.
--   * Cleanup removed the synthetic owner and everything hanging off it.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
BEGIN;
DELETE FROM public.instagram_collection_jobs
 WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
DELETE FROM public.instagram_collection_request_throttles
 WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
DELETE FROM public.instagram_provider_throttle_buckets
 WHERE bucket_key IN (
   '0000000000000000000000000000000000000000000000000000000000000000',
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
DELETE FROM public.instagram_account_capabilities
 WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
DELETE FROM public.ig_media_insight_snapshots
 WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
DELETE FROM public.social_accounts
 WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
    OR id = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
DO $cleanup_roles$
BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    DELETE FROM public.user_roles
     WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  END IF;
END
$cleanup_roles$;
DELETE FROM auth.users
 WHERE id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

-- The rollout fixture goes back to the default. The prepare step turned
-- the collection on and a collection gate left open is not a thing this
-- fixture may leave behind.
DELETE FROM public.app_settings
 WHERE key = 'collection_instagram_insights_enabled';
UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: cleaned synthetic owner ==='
\elif :{?probe}
-- SESSION B. Runs while session A holds the claim. Must report zero, and
-- must not wait out A's hold: a busy parent is skipped, not queued behind.
SET lock_timeout = '3s';
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT count(*)::integer AS claimed_by_probe
  FROM public.claim_instagram_collection_jobs('owner', 25) AS c
 WHERE c ->> 'job_id' = (
         SELECT j.id::text
           FROM public.instagram_collection_jobs AS j
          WHERE j.user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
            AND j.target_kind = 'owner');

ROLLBACK;
\echo '=== instagram_durable_collection_jobs race fixture: probe done (claimed_by_probe must be 0) ==='
\elif :{?stale_write}
-- SESSION B, after session A committed. The force supersedes the live claim
-- and the retired token must stop working.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $stale$
DECLARE
  v_job     uuid;
  v_token   uuid;
  v_gen     bigint;
  v_before  integer;
BEGIN
  SELECT j.id, j.lease_token, j.job_generation
    INTO v_job, v_token, v_gen
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
     AND j.target_kind = 'owner';

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'race fixture: no job to force';
  END IF;

  -- The force retires the live claim.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      'mode', 'force')));

  IF (SELECT job_generation FROM public.instagram_collection_jobs WHERE id = v_job) <> v_gen + 1 THEN
    RAISE EXCEPTION 'race fixture: the force did not bump the generation';
  END IF;

  -- The retired worker tries to land its snapshot.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ig-race-stale',
          'published_at', '2026-10-20T10:00:00Z',
          'status', 'ok',
          'metrics', jsonb_build_object('views', 1)))));
    RAISE EXCEPTION 'race fixture FAILED: the retired claim wrote a snapshot';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'race fixture expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_before
    FROM public.ig_media_insight_snapshots
   WHERE ig_media_id = 'ig-race-stale';

  IF v_before <> 0 THEN
    RAISE EXCEPTION 'race fixture FAILED: the refused write left a snapshot behind';
  END IF;

  RAISE NOTICE 'race fixture: the retired claim was refused and left no snapshot';
END
$stale$;

ROLLBACK;
\echo '=== instagram_durable_collection_jobs race fixture: stale write refused ==='
\elif :{?coupling_claim}
-- Claim the prepared job and commit, so another session can block on its
-- account lock and then call a result RPC.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT c ->> 'job_id' AS job_id,
       c ->> 'claim_token' AS claim_token,
       c ->> 'job_generation' AS job_generation
  FROM public.claim_instagram_collection_jobs('owner', 25) AS c
 WHERE c ->> 'social_account_id' = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: claim committed ==='
\elif :{?coupling_hold}
-- SESSION A of the coupling probe. Holds the account lock across the sleep,
-- then applies the requested superseding change and commits.
BEGIN;
SELECT 1
  FROM public.social_accounts
 WHERE id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
   FOR UPDATE;
SELECT pg_sleep(:hold_seconds);
\if :{?supersede_generation}
UPDATE public.instagram_account_capabilities
   SET credential_generation = credential_generation + 1
 WHERE social_account_id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
\elif :{?supersede_deactivate}
UPDATE public.social_accounts
   SET is_active = false
 WHERE id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
\elif :{?supersede_lease}
UPDATE public.instagram_collection_jobs
   SET lease_expires_at = clock_timestamp()
 WHERE social_account_id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
\endif
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: account hold released ==='
\elif :{?coupling_progress}
-- SESSION B. Blocks inside the result fence until session A commits, then
-- the outcome must match `expect`.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
-- psql does not substitute :'expect' inside a dollar-quoted body.
SELECT set_config('race.expect', :'expect', true);
DO $coupling_progress$
DECLARE
  v_job uuid;
  v_token uuid;
  v_gen bigint;
  v_expect text := current_setting('race.expect');
  v_pages integer;
BEGIN
  SELECT j.id, j.lease_token, j.job_generation
    INTO v_job, v_token, v_gen
    FROM public.instagram_collection_jobs AS j
   WHERE j.social_account_id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

  IF v_expect = 'ok' THEN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 4));
    SELECT inventory_pages_fetched INTO v_pages
      FROM public.instagram_collection_job_checkpoints
     WHERE job_id = v_job AND job_generation = v_gen;
    IF v_pages IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION 'coupling positive control did not record pages 4';
    END IF;
    RAISE NOTICE 'coupling positive control recorded the checkpoint';
  ELSE
    BEGIN
      PERFORM public.record_instagram_collection_job_progress(
        v_job, v_token, v_gen,
        jsonb_build_object('kind', 'inventory', 'pages_fetched', 9));
      RAISE EXCEPTION 'coupling FAILED: the blocked writer committed pages 9';
    EXCEPTION WHEN others THEN
      IF v_expect = 'credential' AND SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
        RAISE EXCEPTION 'coupling expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
      ELSIF v_expect = 'inactive' AND SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
        RAISE EXCEPTION 'coupling expected IG_COLLECTION_TARGET_INACTIVE, got: %', SQLERRM;
      ELSIF v_expect = 'stale' AND SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
        RAISE EXCEPTION 'coupling expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
      ELSIF v_expect NOT IN ('credential', 'inactive', 'stale') THEN
        RAISE EXCEPTION 'coupling unknown expect %', v_expect;
      END IF;
    END;
    IF (SELECT count(*) FROM public.instagram_collection_job_checkpoints
         WHERE job_id = v_job AND inventory_pages_fetched = 9) <> 0 THEN
      RAISE EXCEPTION 'coupling FAILED: the refused progress left a checkpoint';
    END IF;
    IF (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_job) IS NOT NULL THEN
      RAISE EXCEPTION 'coupling FAILED: the refused progress advanced success';
    END IF;
    RAISE NOTICE 'coupling refusal held: %', v_expect;
  END IF;
END
$coupling_progress$;
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: coupling progress finished ==='
\elif :{?positive_prepare}
BEGIN;
INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
VALUES
  ('0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
   '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
   'instagram', 'ig-race-2', 'igjobs_race_2', 'race-token-2', 'facebook_page')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.instagram_account_capabilities
  (social_account_id, user_id, platform, login_kind, permission_read_state,
   granted_scopes, scopes_read_at, credential_generation)
VALUES
  ('0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
   '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
   'instagram', 'page_linked', 'ok',
   ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
   now(), 1)
ON CONFLICT (social_account_id) DO NOTHING;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.enqueue_instagram_collection_jobs_service(
  '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  jsonb_build_array(jsonb_build_object(
    'target_kind', 'owner',
    'target_id', '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
    'mode', 'normal')));
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: sibling prepared ==='
\elif :{?positive_hold}
BEGIN;
SELECT 1
  FROM public.social_accounts
 WHERE id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
   FOR UPDATE;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: sibling hold released ==='
\elif :{?positive_claim}
-- While account 1 is locked, this claim must skip that job and take the sibling.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
DO $positive_claim$
DECLARE
  v_held integer;
  v_sibling integer;
BEGIN
  SELECT count(*) FILTER (WHERE c ->> 'social_account_id' = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'),
         count(*) FILTER (WHERE c ->> 'social_account_id' = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c')
    INTO v_held, v_sibling
    FROM public.claim_instagram_collection_jobs('owner', 25) AS c;

  IF v_held <> 0 THEN
    RAISE EXCEPTION 'sibling control FAILED: the locked account was claimed';
  END IF;
  IF v_sibling <> 1 THEN
    RAISE EXCEPTION 'sibling control FAILED: the free account was not claimed (got %)', v_sibling;
  END IF;
  RAISE NOTICE 'sibling control: busy parent skipped, free target claimed';
END
$positive_claim$;
ROLLBACK;
\echo '=== instagram_durable_collection_jobs race fixture: sibling claim proved ==='
\elif :{?throttle_seed}
-- Claim the prepared job, pin the lease, and create the shared bucket row
-- the other session will lock. lease_seconds is the remaining life.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT c ->> 'job_id' AS job_id
  FROM public.claim_instagram_collection_jobs('owner', 25) AS c
 WHERE c ->> 'social_account_id' = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
UPDATE public.instagram_collection_jobs
   SET lease_expires_at = clock_timestamp() + make_interval(secs => :lease_seconds)
 WHERE social_account_id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
INSERT INTO public.instagram_provider_throttle_buckets
  (bucket_key, usage_percent, last_reported_at, updated_at)
VALUES
  ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   1, now(), now())
ON CONFLICT (bucket_key) DO UPDATE
   SET usage_percent = 1,
       throttled_until = NULL,
       updated_at = now();
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: throttle seeded ==='
\elif :{?throttle_hold}
-- Lock the shared bucket, not the job. The writer blocks here after its
-- own lease check and before it is allowed to park the job.
BEGIN;
SET application_name = 'igjobs-bucket-holder';
SELECT 1
  FROM public.instagram_provider_throttle_buckets
 WHERE bucket_key = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
   FOR UPDATE;
SELECT 'throttle-held' AS throttle_marker;
SELECT pg_sleep(:hold_seconds);
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: bucket hold released ==='
\elif :{?throttle_write}
BEGIN;
SET application_name = 'igjobs-bucket-writer';
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('race.expect', :'expect', true);
DO $throttle_write$
DECLARE
  v_job uuid;
  v_token uuid;
  v_gen bigint;
  v_expect text := current_setting('race.expect');
  v_usage integer;
  v_status text;
  v_lease timestamptz;
BEGIN
  SELECT j.id, j.lease_token, j.job_generation
    INTO v_job, v_token, v_gen
    FROM public.instagram_collection_jobs AS j
   WHERE j.social_account_id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

  IF v_expect = 'ok' THEN
    PERFORM public.record_instagram_provider_throttle(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      99, clock_timestamp() + interval '10 minutes', v_job, v_token, v_gen);
    SELECT j.status, j.lease_expires_at, b.usage_percent
      INTO v_status, v_lease, v_usage
      FROM public.instagram_collection_jobs AS j
      CROSS JOIN public.instagram_provider_throttle_buckets AS b
     WHERE j.id = v_job
       AND b.bucket_key = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    IF v_status IS DISTINCT FROM 'retry' OR v_lease IS NOT NULL OR v_usage IS DISTINCT FROM 99 THEN
      RAISE EXCEPTION 'throttle success control failed: status % lease % usage %',
        v_status, v_lease, v_usage;
    END IF;
    RAISE NOTICE 'throttle success control parked the job at usage 99';
  ELSIF v_expect = 'stale' THEN
    BEGIN
      PERFORM public.record_instagram_provider_throttle(
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        99, clock_timestamp() + interval '10 minutes', v_job, v_token, v_gen);
      RAISE EXCEPTION 'throttle FAILED: the expired lease parked the job';
    EXCEPTION WHEN others THEN
      IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
        RAISE EXCEPTION 'throttle expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
      END IF;
    END;
    SELECT j.status, j.lease_expires_at, b.usage_percent
      INTO v_status, v_lease, v_usage
      FROM public.instagram_collection_jobs AS j
      CROSS JOIN public.instagram_provider_throttle_buckets AS b
     WHERE j.id = v_job
       AND b.bucket_key = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    IF v_status IS DISTINCT FROM 'leased' OR v_lease IS NULL OR v_usage IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'throttle stale rollback failed: status % lease % usage %',
        v_status, v_lease, v_usage;
    END IF;
    RAISE NOTICE 'throttle stale refusal kept usage 1 and the lease';
  ELSE
    RAISE EXCEPTION 'throttle unknown expect %', v_expect;
  END IF;
END
$throttle_write$;
COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: throttle write finished ==='
\elif :{?hold_seconds}
-- SESSION A of the exclusive-claim proof. This branch is after coupling_hold
-- and positive_hold, because those modes also pass hold_seconds and must
-- not be captured by the claim-and-sleep session.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

CREATE TEMP TABLE race_claim ON COMMIT DROP AS
  SELECT * FROM public.claim_instagram_collection_jobs('owner', 25) AS c
 WHERE c ->> 'job_id' = (
         SELECT j.id::text
           FROM public.instagram_collection_jobs AS j
          WHERE j.user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
            AND j.target_kind = 'owner');

SELECT c ->> 'job_id'            AS job_id,
       c ->> 'claim_token'       AS claim_token,
       c ->> 'job_generation'    AS job_generation,
       c ->> 'lease_expires_at'  AS lease_expires_at
  FROM race_claim;

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: session A committed ==='
\else
-- Prepare. Commits the synthetic owner and one queued job.
-- Re-prepare resets the coupling mutations so a later scenario starts clean.
BEGIN;
INSERT INTO auth.users (id, email)
VALUES ('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', 'igjobs-race@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
VALUES
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
   '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
   'instagram', 'ig-race-1', 'igjobs_race', 'race-token', 'facebook_page')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.instagram_account_capabilities
  (social_account_id, user_id, platform, login_kind, permission_read_state,
   granted_scopes, scopes_read_at, credential_generation)
VALUES
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
   '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
   'instagram', 'page_linked', 'ok',
   ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
   now(), 1)
ON CONFLICT (social_account_id) DO NOTHING;

UPDATE public.social_accounts
   SET is_active = true, needs_reauth = false
 WHERE id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

UPDATE public.instagram_account_capabilities
   SET credential_generation = 1, login_kind = 'page_linked', permission_read_state = 'ok'
 WHERE social_account_id = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DELETE FROM public.instagram_collection_jobs
 WHERE user_id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

-- The rollout fixture. R1 (20261031090000) made the collection admission
-- a default-off gate, so the rehearsal needs an explicit synthetic policy
-- that admits the synthetic owner. The cleanup puts the default back.
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic race-fixture master switch.'),
  ('collection_instagram_rollout_policy',
   '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb,
   'Synthetic race-fixture rollout policy: every otherwise eligible target.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT public.enqueue_instagram_collection_jobs_service(
  '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  jsonb_build_array(jsonb_build_object(
    'target_kind', 'owner',
    'target_id', '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
    'mode', 'normal')));

COMMIT;
\echo '=== instagram_durable_collection_jobs race fixture: prepared (owner, account, capability, one queued job) ==='
\endif
