-- ===========================================================================
-- supabase/tests/meta_oauth_identity_alias_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. One connection cannot prove lock order, stale
-- refusal, a genuine wait or an expiry during a lock wait. The sequential
-- suite is not that proof.
--
-- The harness refuses any tests/*.sql file that is not named in SUITES,
-- ISOLATED_SUITES or EXCLUDED_FROM_SUITES. This file matches
-- meta_oauth_attempt_lifecycle_race_fixture.sql: a manual two-session
-- rehearsal, not a suite. scripts/db-harness.sh explicitly classifies it
-- in EXCLUDED_FROM_SUITES; run it separately with real concurrent
-- sessions.
--
-- DISPOSABLE DATABASES ONLY. The prepare mode COMMITS synthetic rows.
-- Re-run with -v disposable=1. There is no --cleanup switch; psql does
-- not have one, so the cleanup mode is invoked with -v cleanup=1.
--
-- WHAT THIS PREPARES
--
--   One owner with one social profile and a set of Instagram and Facebook
--   Page accounts in every classification the alias rules distinguish:
--   a direct account with the legacy alias, a page-linked account, a
--   direct account without an alias, a Facebook Page, a direct Instagram
--   companion of that page and an unselected sibling.
--
--   The coordination is a SEQUENCE, not a table: a sequence's nextval is
--   visible to other sessions IMMEDIATELY, while an uncommitted row
--   update is not. A driver that used a table would have to wait for a
--   commit it is trying to avoid, which is exactly the deadlock the
--   controls are looking for. The sequence therefore gives a
--   deterministic handshake with no sleep-based race.
--
--   public.mia_race_signal()              advances the coordination
--                                          sequence
--   public.mia_race_wait_for(n)            blocks until the sequence
--                                          reached n
--   public.mia_race_wait_observations()    lists the locks other sessions
--                                          are currently WAITING for,
--                                          which is how a real PostgreSQL
--                                          lock wait is observed rather
--                                          than assumed
--   public.mia_race_prepare_direct_attempt(...)
--   public.mia_race_prepare_page_attempt(...)
--                                          build a selection-ready
--                                          attempt with its stash, so a
--                                          driver only has to run the
--                                          commit
--
-- HOW TO REHEARSE
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--     -f supabase/tests/meta_oauth_identity_alias_race_fixture.sql
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--     -f supabase/tests/meta_oauth_identity_alias_race_fixture.sql
--
-- The driver that runs the two sessions lives outside the repository, in
-- the delivery evidence directory. This file is the reusable fixture it
-- needs.
-- ============================================================================

\if :{?disposable}
\else
-- psql ignores a numeric \quit argument and exits 0. This guard sets
-- ON_ERROR_STOP itself and raises, so the script exits nonzero even when
-- the caller did not pass ON_ERROR_STOP. No fixture write follows.
\set ON_ERROR_STOP on
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
DO $mia_refuse$
BEGIN
  RAISE EXCEPTION 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
    USING ERRCODE = 'P0001';
END
$mia_refuse$;
\endif

\if :{?cleanup}
BEGIN;

DROP FUNCTION IF EXISTS public.mia_race_wait_observations();
DROP FUNCTION IF EXISTS public.mia_race_wait_observations_until(INTEGER);
DROP FUNCTION IF EXISTS public.mia_race_prepare_direct_attempt(TEXT, TEXT, UUID, INTEGER);
DROP FUNCTION IF EXISTS public.mia_race_prepare_page_attempt(TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.mia_race_wait_for(BIGINT, INTEGER);
DROP FUNCTION IF EXISTS public.mia_race_signal();
DROP TABLE IF EXISTS public.mia_race_gate;
DROP SEQUENCE IF EXISTS public.mia_race_seq;

-- The synthetic owner cascades to its accounts, its capability records,
-- its attempts, its receipts and its stashes.
DELETE FROM auth.users WHERE id = '0ec00001-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id = '0ec00002-0000-4000-8000-000000000002';

COMMIT;
\echo '=== meta_oauth_identity_alias race fixture: cleaned synthetic owner ==='
\else
BEGIN;

-- The coordination primitives.
CREATE SEQUENCE IF NOT EXISTS public.mia_race_seq;
CREATE TABLE IF NOT EXISTS public.mia_race_gate (
  id      integer PRIMARY KEY,
  note    text
);
INSERT INTO public.mia_race_gate (id, note)
VALUES (1, 'meta oauth identity alias race control')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mia_race_signal()
RETURNS BIGINT
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT nextval('public.mia_race_seq');
$function$;

-- Blocks until the coordination sequence reached the target, or the
-- timeout expires. Returns the value it saw, so a driver can prove it
-- really waited rather than assuming it did.
CREATE OR REPLACE FUNCTION public.mia_race_wait_for(
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
    SELECT last_value INTO v_seen FROM public.mia_race_seq;
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
CREATE OR REPLACE FUNCTION public.mia_race_wait_observations()
RETURNS TABLE (observation TEXT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COALESCE(
    string_agg(
      format('%s|blocked_by=%s|%s|%s|granted=%s',
             a.pid,
             coalesce((pg_blocking_pids(a.pid))[1]::TEXT, '?'),
             a.wait_event_type,
             coalesce(c.relname, l.locktype::text),
             l.granted),
      ';' ORDER BY a.pid, l.locktype, c.relname),
    'none')
    FROM pg_locks AS l
    JOIN pg_stat_activity AS a
      ON a.pid = l.pid
    LEFT JOIN pg_class AS c
      ON c.oid = l.relation
   WHERE NOT l.granted
     AND a.datname = current_database()
     AND a.pid <> pg_backend_pid();
$function$;

-- The polling form waits for the wait to APPEAR rather than sampling once.
CREATE OR REPLACE FUNCTION public.mia_race_wait_observations_until(
  p_timeout_seconds INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_observation TEXT := 'none';
  v_deadline TIMESTAMPTZ := clock_timestamp() + make_interval(secs => p_timeout_seconds);
BEGIN
  LOOP
    SELECT o.observation INTO v_observation
      FROM public.mia_race_wait_observations() AS o;
    EXIT WHEN v_observation IS DISTINCT FROM 'none';
    EXIT WHEN clock_timestamp() >= v_deadline;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RETURN v_observation;
END;
$function$;

-- The synthetic owner and its accounts.
DO $mia_fixtures$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  u_other uuid := '0ec00002-0000-4000-8000-000000000002';
  t_old   timestamptz := '2026-10-01 00:00:00+00'::timestamptz;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_owner, 'miaf-owner-' || u_owner::text || '@example.invalid'),
    (u_other, 'miaf-other-' || u_other::text || '@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_profiles (id, user_id, name)
  VALUES ('0ec10001-0000-4000-8000-000000000011', u_owner, 'MIAF Owner Profile')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, account_metadata, ig_auth_type, connected_at, updated_at
  ) VALUES
    -- a DIRECT account that carries the legacy alias
    ('0ec20001-0000-4000-8000-000000000021', u_owner, 'instagram',
     'miaf-app-scoped-id', 'miaf_direct', 'synthetic-not-a-live-secret', true,
     '{"ig_user_id":"miaf-app-scoped-id","ig_igid":"legacy-alias-value","legacy":"kept"}'::jsonb,
     'business_login', t_old, t_old),
    -- a PAGE-LINKED account
    ('0ec20001-0000-4000-8000-000000000022', u_owner, 'instagram',
     'miaf-linked', 'miaf_linked', 'synthetic-not-a-live-secret', true,
     '{"ig_user_id":"miaf-linked","legacy":"kept"}'::jsonb,
     'facebook_page', t_old, t_old),
    -- a DIRECT account without an alias
    ('0ec20001-0000-4000-8000-000000000023', u_owner, 'instagram',
     'miaf-noalias', 'miaf_noalias', 'synthetic-not-a-live-secret', true,
     NULL, 'business_login', t_old, t_old),
    -- a Facebook Page
    ('0ec20001-0000-4000-8000-000000000024', u_owner, 'facebook',
     'miaf-page', 'miaf_page', 'synthetic-not-a-live-secret', true,
     '{"legacy":"page"}'::jsonb, 'facebook_page', t_old, t_old),
    -- a DIRECT Instagram companion of that page
    ('0ec20001-0000-4000-8000-000000000025', u_owner, 'instagram',
     'miaf-companion', 'miaf_companion', 'synthetic-not-a-live-secret', true,
     '{"ig_user_id":"miaf-companion","ig_igid":"legacy-companion-alias","legacy":"kept"}'::jsonb,
     'business_login', t_old, t_old),
    -- an unselected sibling
    ('0ec20001-0000-4000-8000-000000000026', u_owner, 'instagram',
     'miaf-sibling', 'miaf_sibling', 'synthetic-not-a-live-secret', true,
     '{"sibling":"kept"}'::jsonb, 'facebook_page', t_old, t_old)
  ON CONFLICT (id) DO NOTHING;

  -- Protected previous kind. Display ig_auth_type is not this authority.
  -- Generation 0 is the accepted create token. A later writer must CAS the
  -- live generation; rewriting the same kind at generation 0 still matches.
  PERFORM public.write_instagram_account_capability(
    '0ec20001-0000-4000-8000-000000000021', u_owner,
    '{"login_kind":"direct","permission_read_state":"unknown","expected_credential_generation":0}'::jsonb);
  PERFORM public.write_instagram_account_capability(
    '0ec20001-0000-4000-8000-000000000022', u_owner,
    '{"login_kind":"page_linked","permission_read_state":"unknown","expected_credential_generation":0}'::jsonb);
  PERFORM public.write_instagram_account_capability(
    '0ec20001-0000-4000-8000-000000000023', u_owner,
    '{"login_kind":"direct","permission_read_state":"unknown","expected_credential_generation":0}'::jsonb);
  PERFORM public.write_instagram_account_capability(
    '0ec20001-0000-4000-8000-000000000025', u_owner,
    '{"login_kind":"direct","permission_read_state":"unknown","expected_credential_generation":0}'::jsonb);
  PERFORM public.write_instagram_account_capability(
    '0ec20001-0000-4000-8000-000000000026', u_owner,
    '{"login_kind":"page_linked","permission_read_state":"unknown","expected_credential_generation":0}'::jsonb);
END
$mia_fixtures$;

-- Builds a selection-ready DIRECT attempt whose candidate carries the
-- verified alias, through the REAL begin, claim and complete RPCs. A
-- driver only has to run the commit.
--
--   p_alias       the messaging scoped alias, or NULL to assert none
--   p_target      the owned account to reconnect, or NULL for a new one
--   p_expires_in  the operational token TTL, used by the late-expiry
--                 control
CREATE OR REPLACE FUNCTION public.mia_race_prepare_direct_attempt(
  p_ig_user_id TEXT,
  p_alias TEXT,
  p_target_social_account_id UUID,
  p_expires_in INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_candidate JSONB;
BEGIN
  IF p_target_social_account_id IS NULL THEN
    v_result := public.begin_meta_oauth_attempt(v_owner, jsonb_build_object(
      'flow', 'instagram_direct', 'intent', 'connect_new'));
  ELSE
    v_result := public.begin_meta_oauth_attempt(v_owner, jsonb_build_object(
      'flow', 'instagram_direct', 'intent', 'reconnect',
      'target_social_account_id', p_target_social_account_id));
  END IF;
  v_attempt := (v_result ->> 'attempt_id')::UUID;

  v_result := public.claim_meta_oauth_callback(v_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce',
    'flow', 'instagram_direct'));

  v_candidate := jsonb_build_object('ig_user_id', p_ig_user_id);
  IF p_alias IS NOT NULL THEN
    v_candidate := v_candidate || jsonb_build_object('ig_igid', p_alias);
  END IF;

  v_result := public.complete_meta_oauth_callback(v_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(v_candidate),
      'user_token', 'synthetic-not-a-live-secret',
      'expires_in', p_expires_in)));

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'pending_selection_id', (v_result ->> 'pending_selection_id')::UUID,
    'selection_key', 'instagram_direct:ig:' || p_ig_user_id);
END;
$function$;

-- Builds a selection-ready PAGE-LINKED attempt, the conversion direction
-- that has to remove an obsolete alias.
CREATE OR REPLACE FUNCTION public.mia_race_prepare_page_attempt(
  p_ig_user_id TEXT,
  p_facebook_page_id TEXT,
  p_facebook_user_id TEXT,
  p_target_social_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
BEGIN
  IF p_target_social_account_id IS NULL THEN
    v_result := public.begin_meta_oauth_attempt(v_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  ELSE
    v_result := public.begin_meta_oauth_attempt(v_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'reconnect',
      'target_social_account_id', p_target_social_account_id));
  END IF;
  v_attempt := (v_result ->> 'attempt_id')::UUID;

  v_result := public.claim_meta_oauth_callback(v_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce',
    'flow', 'instagram_page_linked'));

  v_result := public.complete_meta_oauth_callback(v_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', p_ig_user_id,
        'ig_username', 'miaf_' || p_ig_user_id,
        'facebook_page_id', p_facebook_page_id,
        'facebook_user_id', p_facebook_user_id,
        'page_access_token', 'synthetic-not-a-live-secret')),
      'user_token', 'synthetic-not-a-live-secret',
      'expires_in', 5184000)));

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'pending_selection_id', (v_result ->> 'pending_selection_id')::UUID,
    'selection_key', 'instagram_page_linked:ig:' || p_ig_user_id);
END;
$function$;

COMMIT;
\echo '=== meta_oauth_identity_alias race fixture: prepared synthetic owner ==='
\endif
