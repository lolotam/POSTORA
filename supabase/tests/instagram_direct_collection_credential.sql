-- ============================================================================
-- supabase/tests/instagram_direct_collection_credential.sql
-- Migration 20261029160000_instagram_direct_collection_credential.sql.
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   E1  the grant surface: the reader is service-only, the browser roles
--       cannot execute it at all, and the function accepts NO account or
--       owner selector.
--   E2  the service success: the projection is exactly the eight accepted
--       keys, the owner and the target come from the fenced job, a known
--       expiry is carried and an unknown one is an explicit null.
--   E3  the browser roles are refused with SQLSTATE 42501.
--   E4  the refusals: a wrong claim token, a wrong job generation, an
--       expired lease, a page-linked capability, a stale expected
--       generation, a generation that moved after the claim, an inactive
--       account, a deleted account and a missing operational token.
--   E5  the read mutates nothing: the account, the capability and the job
--       rows are byte-identical before and after.
--   E6  no refusal text ever carries the operational token.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something. The service role bypasses RLS, so
-- the ownership checks and the composite foreign keys are the only thing
-- under test there.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- The rollout fixture.
--
-- R1 (20261031090000_instagram_collection_rollout_controls.sql) made the
-- rollout admission a default-off gate. This suite exercises the fenced
-- direct credential reader, not the rollout, so it installs an explicit
-- synthetic policy that admits every otherwise eligible target. The
-- transaction rolls back, so nothing survives the suite.
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic harness master switch.'),
  ('collection_instagram_rollout_policy',
   '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb,
   'Synthetic harness rollout policy: every otherwise eligible target.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_d        : the owner of the direct accounts
-- u_other    : another owner, whose account must never be readable
-- acct_d     : the main direct account (a known expiry)
-- acct_dn    : a direct account with an UNKNOWN expiry
-- acct_dnt   : a direct account with no operational token
-- acct_din   : a direct account that is deactivated after the claim
-- acct_ddel  : a direct account that is deleted after the claim
-- acct_p     : a page-linked account (never a direct one)
-- acct_f     : the other owner's account
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_d        uuid := 'd1000000-0000-4000-8000-000000000001';
  u_other    uuid := 'd1000000-0000-4000-8000-000000000002';
  acct_d     uuid := 'd2000000-0000-4000-8000-000000000001';
  acct_dn    uuid := 'd2000000-0000-4000-8000-000000000002';
  acct_dnt   uuid := 'd2000000-0000-4000-8000-000000000003';
  acct_din   uuid := 'd2000000-0000-4000-8000-000000000004';
  acct_ddel  uuid := 'd2000000-0000-4000-8000-000000000005';
  acct_p     uuid := 'd2000000-0000-4000-8000-000000000006';
  acct_f     uuid := 'd2000000-0000-4000-8000-000000000007';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_d,     'igdirect-owner-'   || u_d::text     || '@example.invalid'),
    (u_other, 'igdirect-other-'   || u_other::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, token_expires_at, is_active, ig_auth_type)
  VALUES
    (acct_d,    u_d, 'instagram', 'ig-direct-1', 'igdirect_1', 'direct-token-1',
     '2026-11-28T12:00:00+00:00', true, 'business_login'),
    (acct_dn,   u_d, 'instagram', 'ig-direct-2', 'igdirect_2', 'direct-token-2',
     NULL, true, 'business_login'),
    (acct_dnt,  u_d, 'instagram', 'ig-direct-3', 'igdirect_3', '',
     NULL, true, 'business_login'),
    (acct_din,  u_d, 'instagram', 'ig-direct-4', 'igdirect_4', 'direct-token-4',
     NULL, true, 'business_login'),
    (acct_ddel, u_d, 'instagram', 'ig-direct-5', 'igdirect_5', 'direct-token-5',
     NULL, true, 'business_login'),
    (acct_p,    u_d, 'instagram', 'ig-page-1', 'igdirect_p', 'page-token-1',
     NULL, true, 'facebook_page'),
    (acct_f,    u_other, 'instagram', 'ig-foreign-1', 'igdirect_f', 'foreign-token-1',
     NULL, true, 'business_login');

  -- The trusted capabilities. The credential generation is the fence the
  -- durable work is bound to.
  INSERT INTO public.instagram_account_capabilities
    (social_account_id, user_id, platform, login_kind, permission_read_state,
     granted_scopes, scopes_read_at, credential_generation)
  VALUES
    (acct_d,    u_d, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 7),
    (acct_dn,   u_d, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 7),
    (acct_dnt,  u_d, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 7),
    (acct_din,  u_d, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 7),
    (acct_ddel, u_d, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 7),
    (acct_p,    u_d, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights'],
     now(), 7),
    (acct_f,    u_other, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 7);

  -- One owner job per account under test.
  INSERT INTO public.instagram_collection_jobs
    (user_id, target_kind, target_id, social_account_id, captured_on)
  VALUES
    (u_d, 'owner', acct_d,    acct_d,    current_date),
    (u_d, 'owner', acct_dn,   acct_dn,   current_date),
    (u_d, 'owner', acct_dnt,  acct_dnt,  current_date),
    (u_d, 'owner', acct_din,  acct_din,  current_date),
    (u_d, 'owner', acct_ddel, acct_ddel, current_date),
    (u_d, 'owner', acct_p,    acct_p,    current_date);
END
$fixtures$;

-- The claim context of every owner job under test, shared by the sections
-- that continue its work. A live lease is never handed out twice, so the
-- sections that read reuse the claim taken here.
CREATE TEMP TABLE igdirect_claim_ctx (
  label      text PRIMARY KEY,
  job_id     uuid NOT NULL,
  token      uuid NOT NULL,
  generation bigint NOT NULL
) ON COMMIT DROP;

-- ===========================================================================
-- E1 - the grant surface.
-- ===========================================================================
DO $e1$
DECLARE
  v_count integer;
  v_args  text[];
  v_types text[];
BEGIN
  ASSERT has_function_privilege('service_role',
           'public.read_instagram_direct_collection_credential(uuid,uuid,bigint,bigint)', 'EXECUTE'),
    'E1 the service role can read the direct credential';
  ASSERT NOT has_function_privilege('authenticated',
           'public.read_instagram_direct_collection_credential(uuid,uuid,bigint,bigint)', 'EXECUTE'),
    'E1 authenticated cannot read the direct credential';
  ASSERT NOT has_function_privilege('anon',
           'public.read_instagram_direct_collection_credential(uuid,uuid,bigint,bigint)', 'EXECUTE'),
    'E1 anon cannot read the direct credential';

  -- There is exactly one overload, and it takes four arguments. The
  -- catalogue is read directly: information_schema names a routine
  -- "<name>_<oid>", which is not a stable contract.
  ASSERT (SELECT count(*) = 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname = 'read_instagram_direct_collection_credential'),
    'E1 there is exactly one reader';

  SELECT p.pronargs, p.proargnames
    INTO v_count, v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'read_instagram_direct_collection_credential';

  ASSERT v_count = 4,
    'E1 the reader takes four arguments, got ' || v_count::text;

  -- The arguments are the job, the claim token, the job generation and the
  -- expected credential generation.
  ASSERT v_args = ARRAY['p_job_id', 'p_claim_token', 'p_job_generation',
                          'p_expected_credential_generation'],
    'E1 the reader names the claim contract arguments, got ' || v_args::text;

  -- And there is NO account and NO owner selector, so the caller cannot
  -- redirect the read at another account.
  ASSERT NOT EXISTS (
    SELECT 1 FROM unnest(v_args) AS a(name)
     WHERE name LIKE '%user%'
        OR name LIKE '%account%'
        OR name LIKE '%owner%'),
    'E1 the reader accepts no account or owner selector';

  -- The argument types are the claim contract's own types.
  SELECT array_agg(format_type(u.oid, NULL) ORDER BY u.ord)
    INTO v_types
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(oid, ord)
   WHERE n.nspname = 'public'
     AND p.proname = 'read_instagram_direct_collection_credential';

  ASSERT v_types = ARRAY['uuid', 'uuid', 'bigint', 'bigint'],
    'E1 the argument types are the claim contract types, got ' || v_types::text;
END
$e1$;

-- ===========================================================================
-- E2 - the service success.
-- ===========================================================================
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

-- ONE claim for every owner job under test. A live lease is never handed
-- out twice, so every section below reuses these claims instead of
-- claiming again.
DO $claim$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO igdirect_claim_ctx (label, job_id, token, generation)
  SELECT CASE c ->> 'social_account_id'
           WHEN 'd2000000-0000-4000-8000-000000000001' THEN 'd1'
           WHEN 'd2000000-0000-4000-8000-000000000002' THEN 'd2'
           WHEN 'd2000000-0000-4000-8000-000000000003' THEN 'dnt'
           WHEN 'd2000000-0000-4000-8000-000000000004' THEN 'din'
           WHEN 'd2000000-0000-4000-8000-000000000005' THEN 'ddel'
           ELSE 'p1' END,
         (c ->> 'job_id')::uuid,
         (c ->> 'claim_token')::uuid,
         (c ->> 'job_generation')::bigint
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'social_account_id' IN (
           'd2000000-0000-4000-8000-000000000001',
           'd2000000-0000-4000-8000-000000000002',
           'd2000000-0000-4000-8000-000000000003',
           'd2000000-0000-4000-8000-000000000004',
           'd2000000-0000-4000-8000-000000000005',
           'd2000000-0000-4000-8000-000000000006');

  SELECT count(*) INTO v_count FROM igdirect_claim_ctx;
  ASSERT v_count = 6,
    'E2 every owner job under test was claimed, got ' || v_count::text;

  ASSERT (SELECT generation = 1 FROM igdirect_claim_ctx WHERE label = 'd1'),
    'E2 the claim returned the job generation';
  ASSERT (SELECT (SELECT c.credential_generation
                     FROM public.instagram_account_capabilities AS c
                    WHERE c.social_account_id = 'd2000000-0000-4000-8000-000000000001') = 7
            FROM igdirect_claim_ctx WHERE label = 'd1'),
    'E2 the claim captured the connection generation';
END
$claim$;

DO $e2$
DECLARE
  v_result jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_keys   text[];
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd1';

  v_result := public.read_instagram_direct_collection_credential(
    v_job, v_token, v_gen, 7);

  -- The projection is exactly the eight accepted keys. A refresh token or
  -- an account metadata key would be a contract violation.
  SELECT coalesce(array_agg(k ORDER BY k), '{}') INTO v_keys
    FROM jsonb_object_keys(v_result) AS k;

  ASSERT v_keys = ARRAY['access_token', 'credential_generation', 'ig_user_id',
                         'job_id', 'login_kind', 'social_account_id',
                         'token_expires_at', 'user_id'],
    'E2 the projection carries exactly the accepted keys, got ' || v_keys::text;

  ASSERT v_result ->> 'job_id' = v_job::text,
    'E2 the answer names the job';
  ASSERT v_result ->> 'user_id' = 'd1000000-0000-4000-8000-000000000001',
    'E2 the owner comes from the job';
  ASSERT v_result ->> 'social_account_id' = 'd2000000-0000-4000-8000-000000000001',
    'E2 the target comes from the job';
  ASSERT v_result ->> 'ig_user_id' = 'ig-direct-1',
    'E2 the canonical provider id is the account platform id';
  ASSERT v_result ->> 'login_kind' = 'direct',
    'E2 the trusted login kind is reported';
  ASSERT (v_result ->> 'credential_generation')::bigint = 7,
    'E2 the credential generation is reported';
  ASSERT v_result ->> 'access_token' = 'direct-token-1',
    'E2 the operational token is returned';
  ASSERT (v_result ->> 'token_expires_at')::timestamptz
         = '2026-11-28 12:00:00+00'::timestamptz,
    'E2 a known expiry is carried, got ' || coalesce(v_result ->> 'token_expires_at', '<null>');

  -- An UNKNOWN expiry is an explicit null, never a guess and never a
  -- failure.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd2';

  v_result := public.read_instagram_direct_collection_credential(
    v_job, v_token, v_gen, 7);

  ASSERT v_result ->> 'access_token' = 'direct-token-2',
    'E2 the second account reads its own token';
  ASSERT v_result -> 'token_expires_at' = 'null'::jsonb,
    'E2 an unknown expiry is an explicit null';
  ASSERT v_result ->> 'ig_user_id' = 'ig-direct-2',
    'E2 the canonical provider id belongs to the second account';
END
$e2$;

-- ===========================================================================
-- E3 - the browser roles are refused.
--
-- The privilege check fires BEFORE the function body runs, so the call
-- needs no live claim: the refusal is about the GRANT, not about the
-- claim.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $e3$
BEGIN
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      'e3000000-0000-4000-8000-000000000001'::uuid,
      'e3000000-0000-4000-8000-000000000002'::uuid,
      1, 7);
    RAISE EXCEPTION 'E3 failed: an ordinary user read a direct credential'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'E3 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$e3$;

RESET ROLE;

SET LOCAL ROLE anon;
DO $e3b$
BEGIN
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      'e3000000-0000-4000-8000-000000000001'::uuid,
      'e3000000-0000-4000-8000-000000000002'::uuid,
      1, 7);
    RAISE EXCEPTION 'E3b failed: anon read a direct credential'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'E3b a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$e3b$;

RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- ===========================================================================
-- E4 - the refusals.
-- ===========================================================================
DO $e4$
DECLARE
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd1';

  -- A wrong claim token is a stale claim.
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, gen_random_uuid(), v_gen, 7);
    RAISE EXCEPTION 'E4 failed: a wrong claim token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = '40001',
      'E4 a wrong claim token is SQLSTATE 40001, got ' || SQLSTATE;
  END;

  -- A wrong job generation is a stale claim.
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen + 1, 7);
    RAISE EXCEPTION 'E4 failed: a wrong job generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = '40001',
      'E4 a wrong job generation is SQLSTATE 40001, got ' || SQLSTATE;
  END;

  -- A missing argument is refused before anything is read.
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, NULL);
    RAISE EXCEPTION 'E4 failed: a missing expected generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = 'IDC01',
      'E4 a missing argument is SQLSTATE IDC01, got ' || SQLSTATE;
  END;

  -- A STALE expected generation refuses. The read never adopts the current
  -- authority.
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 6);
    RAISE EXCEPTION 'E4 failed: a stale expected generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = 'IDC04',
      'E4 a stale expected generation is SQLSTATE IDC04, got ' || SQLSTATE;
  END;

  -- A PAGE-LINKED account is refused: the reader serves the direct login
  -- kind only.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'p1';

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 7);
    RAISE EXCEPTION 'E4 failed: a page-linked account was read as direct'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = 'IDC03',
      'E4 a page-linked capability is SQLSTATE IDC03, got ' || SQLSTATE;
  END;

  -- A generation that MOVED after the claim is refused by the accepted
  -- fence, before the reader decides anything.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd1';

  UPDATE public.instagram_account_capabilities
     SET credential_generation = 8
   WHERE social_account_id = 'd2000000-0000-4000-8000-000000000001';

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 8);
    RAISE EXCEPTION 'E4 failed: a replaced connection was read'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = '40001',
      'E4 a replaced connection is SQLSTATE 40001, got ' || SQLSTATE;
  END;

  -- Restore the generation for the remaining controls.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = 7
   WHERE social_account_id = 'd2000000-0000-4000-8000-000000000001';

  -- An INACTIVE account is refused by the accepted fence.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'din';

  UPDATE public.social_accounts
     SET is_active = false
   WHERE id = 'd2000000-0000-4000-8000-000000000004';

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 7);
    RAISE EXCEPTION 'E4 failed: an inactive account was read'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = '22023',
      'E4 an inactive account is SQLSTATE 22023, got ' || SQLSTATE;
  END;

  -- A DELETED account takes its job with it, so there is nothing to read.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'ddel';

  DELETE FROM public.social_accounts
   WHERE id = 'd2000000-0000-4000-8000-000000000005';

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 7);
    RAISE EXCEPTION 'E4 failed: a deleted account was read'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = 'P0002',
      'E4 a deleted account is SQLSTATE P0002, got ' || SQLSTATE;
  END;

  -- A MISSING operational token is refused. It is never an empty token.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'dnt';

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 7);
    RAISE EXCEPTION 'E4 failed: a token-less account was read'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = 'IDC05',
      'E4 a missing token is SQLSTATE IDC05, got ' || SQLSTATE;
  END;

  -- An EXPIRED lease is refused.
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd2';

  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 7);
    RAISE EXCEPTION 'E4 failed: an expired lease was read'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = '40001',
      'E4 an expired lease is SQLSTATE 40001, got ' || SQLSTATE;
  END;
END
$e4$;

-- ===========================================================================
-- E5 - the read mutates nothing.
-- ===========================================================================
DO $e5$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd1';

  SELECT jsonb_build_object(
           'account', (SELECT to_jsonb(a) FROM public.social_accounts AS a
                        WHERE a.id = 'd2000000-0000-4000-8000-000000000001'),
           'capability', (SELECT to_jsonb(c) FROM public.instagram_account_capabilities AS c
                           WHERE c.social_account_id = 'd2000000-0000-4000-8000-000000000001'),
           'job', (SELECT to_jsonb(j) FROM public.instagram_collection_jobs AS j
                    WHERE j.social_account_id = 'd2000000-0000-4000-8000-000000000001')
         ) INTO v_before;

  -- A successful read through the live claim.
  PERFORM public.read_instagram_direct_collection_credential(
    v_job, v_token, v_gen, 7);

  SELECT jsonb_build_object(
           'account', (SELECT to_jsonb(a) FROM public.social_accounts AS a
                        WHERE a.id = 'd2000000-0000-4000-8000-000000000001'),
           'capability', (SELECT to_jsonb(c) FROM public.instagram_account_capabilities AS c
                           WHERE c.social_account_id = 'd2000000-0000-4000-8000-000000000001'),
           'job', (SELECT to_jsonb(j) FROM public.instagram_collection_jobs AS j
                    WHERE j.social_account_id = 'd2000000-0000-4000-8000-000000000001')
         ) INTO v_after;

  -- The read changed nothing at all: not the account, not the capability
  -- and not the job.
  ASSERT v_before = v_after,
    'E5 the read changed no row';

  -- The read touched no progress, no snapshot and no operation row.
  ASSERT (SELECT count(*) = 0 FROM public.ig_media_insight_snapshots
           WHERE social_account_id = 'd2000000-0000-4000-8000-000000000001'),
    'E5 the read wrote no media snapshot';
  ASSERT (SELECT count(*) = 0 FROM public.ig_account_insight_daily
           WHERE social_account_id = 'd2000000-0000-4000-8000-000000000001'),
    'E5 the read wrote no daily observation';
  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_operations
           WHERE job_id = v_job),
    'E5 the read wrote no operation row';
  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job),
    'E5 the read wrote no checkpoint';
  ASSERT (SELECT count(*) = 0 FROM public.meta_account_refresh_captures),
    'E5 the read started no refresh capture';
END
$e5$;

-- ===========================================================================
-- E6 - no refusal text ever carries the operational token.
-- ===========================================================================
DO $e6$
DECLARE
  v_job   uuid;
  v_token uuid;
  v_gen   bigint;
  v_text  text;
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igdirect_claim_ctx WHERE label = 'd1';

  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, gen_random_uuid(), v_gen, 7);
  EXCEPTION WHEN others THEN
    v_text := SQLERRM;
  END;

  ASSERT v_text IS NOT NULL, 'E6 the wrong claim token was refused';
  ASSERT position('direct-token-1' in v_text) = 0,
    'E6 the refusal text carries no operational token';

  -- And the same for a refusal that is raised by the reader itself.
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 6);
  EXCEPTION WHEN others THEN
    v_text := SQLERRM;
  END;

  ASSERT position('direct-token-1' in v_text) = 0,
    'E6 the reader refusal carries no operational token';
  ASSERT position('ig-direct-1' in v_text) = 0,
    'E6 the reader refusal quotes no account id';

  -- The stored state carries no operational token either: the token lives
  -- in the account row and nowhere else.
  ASSERT position('direct-token-1' in (SELECT to_jsonb(j)::text
                                          FROM public.instagram_collection_jobs AS j
                                         WHERE j.id = v_job)) = 0,
    'E6 the job row carries no operational token';
  ASSERT position('direct-token-1' in (SELECT to_jsonb(c)::text
                                          FROM public.instagram_account_capabilities AS c
                                         WHERE c.social_account_id = 'd2000000-0000-4000-8000-000000000001')) = 0,
    'E6 the capability row carries no operational token';
END
$e6$;

-- ===========================================================================
-- E7 - the throttle bucket accepts a DIRECT account bucket.
--
-- The shared bucket is keyed by a non-secret hash of the app and the bucket
-- identity, so a direct account - which has no protected Facebook
-- credential - is expressible: the key is a digest of the app, the account
-- and the credential generation. The accepted throttle contract needs no
-- change for it.
-- ===========================================================================
DO $e7$
DECLARE
  v_bucket text := encode(digest('instagram-login:the-app:d2000000-0000-4000-8000-000000000001:7', 'sha256'), 'hex');
  v_result jsonb;
BEGIN
  ASSERT v_bucket ~ '^[0-9a-f]{64}$',
    'E7 the direct bucket key is a 64 character lower-case hex digest';

  v_result := public.record_instagram_provider_throttle(
    v_bucket, 10, now() + interval '15 minutes', NULL, NULL, NULL);

  ASSERT v_result ->> 'bucket_key' = v_bucket,
    'E7 the throttle recorder answered for the direct bucket';
  ASSERT v_result -> 'job_id' = 'null'::jsonb,
    'E7 a bucket-scoped throttle names no job';

  ASSERT (SELECT usage_percent = 10 FROM public.instagram_provider_throttle_buckets
           WHERE bucket_key = v_bucket),
    'E7 the direct bucket row was stored';

  -- And a key that is not a digest is still refused.
  BEGIN
    PERFORM public.record_instagram_provider_throttle(
      'not-a-digest', 10, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'E7 failed: a malformed bucket key was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLSTATE = '22023',
      'E7 a malformed bucket key is SQLSTATE 22023, got ' || SQLSTATE;
  END;
END
$e7$;

SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

ROLLBACK;

\echo 'ALL CHECKS PASSED'
