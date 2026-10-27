-- ===========================================================================
-- supabase/tests/meta_oauth_attempt_lifecycle_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. One connection cannot prove lock order, stale
-- refusal or expiry during a lock wait. The sequential suite is not that
-- proof.
--
-- The harness refuses any tests/*.sql file that is not named in SUITES,
-- ISOLATED_SUITES or EXCLUDED_FROM_SUITES. This file matches
-- facebook_user_credential_bindings_race_fixture.sql: a manual two-session
-- rehearsal, not a suite. scripts/db-harness.sh explicitly classifies it in
-- EXCLUDED_FROM_SUITES; run it separately with real concurrent sessions.
--
-- DISPOSABLE DATABASES ONLY. The prepare mode COMMITS synthetic rows.
-- Re-run with -v disposable=1. There is no --cleanup switch; psql does not
-- have one, so the cleanup mode is invoked with -v cleanup=1.
--
-- WHAT THIS PREPARES
--
--   One owner with one social profile, one shared Facebook User credential
--   carrying two bound Instagram accounts, one inactive unbound Instagram
--   account, and the coordination primitives the two-session driver uses.
--
--   The coordination is a SEQUENCE, not a table: a sequence's nextval is
--   visible to other sessions IMMEDIATELY, while an uncommitted row update
--   is not. A driver that used a table would have to wait for a commit it
--   is trying to avoid, which is exactly the deadlock the controls are
--   looking for. The sequence therefore gives a deterministic handshake
--   with no sleep-based race.
--
--   public.moa_race_signal()      advances the coordination sequence
--   public.moa_race_wait_for(n)    blocks until the sequence reached n
--   public.moa_race_prepare_attempt(...)
--                                 builds a selection-ready attempt with its
--                                 stash, so a driver only has to run the
--                                 commit
--   public.moa_race_wait_observations()
--                                 lists the locks other sessions are
--                                 currently WAITING for, which is how a
--                                 real PostgreSQL lock wait is observed
--                                 rather than assumed
--
-- HOW TO REHEARSE
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--     -f supabase/tests/meta_oauth_attempt_lifecycle_race_fixture.sql
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--     -f supabase/tests/meta_oauth_attempt_lifecycle_race_fixture.sql
--
-- The driver that runs the two sessions lives outside the repository, in the
-- delivery evidence directory. This file is the reusable fixture it needs.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
BEGIN;

DROP FUNCTION IF EXISTS public.moa_race_wait_observations();
DROP FUNCTION IF EXISTS public.moa_race_wait_observations_until(INTEGER);
DROP FUNCTION IF EXISTS public.moa_race_prepare_attempt(uuid, text, text, text, text, text, uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.moa_race_wait_for(bigint, integer);
DROP FUNCTION IF EXISTS public.moa_race_signal();
DROP TABLE IF EXISTS public.moa_race_gate;
DROP SEQUENCE IF EXISTS public.moa_race_seq;

-- The synthetic owner cascades to its accounts, its capability records, its
-- credential, its attempt rows, its receipts and its stashes.
DELETE FROM auth.users WHERE id = 'f2ace001-0000-4000-8000-000000000001';

COMMIT;
\echo '=== meta_oauth_attempt_lifecycle race fixture: cleaned synthetic owner ==='
\else
BEGIN;

-- The coordination primitives.
CREATE SEQUENCE IF NOT EXISTS public.moa_race_seq;
CREATE TABLE IF NOT EXISTS public.moa_race_gate (
  id      integer PRIMARY KEY,
  note    text
);
INSERT INTO public.moa_race_gate (id, note)
VALUES (1, 'meta oauth attempt lifecycle race control')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.moa_race_signal()
RETURNS BIGINT
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT nextval('public.moa_race_seq');
$function$;

-- Blocks until the coordination sequence reached the target, or the timeout
-- expires. Returns the value it saw, so a driver can prove it really
-- waited rather than assuming it did.
CREATE OR REPLACE FUNCTION public.moa_race_wait_for(
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
    SELECT last_value INTO v_seen FROM public.moa_race_seq;
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
-- The locks other sessions are currently WAITING for. A wait that is
-- observed in pg_locks is a real PostgreSQL lock wait; a wait that is
-- merely inferred from a delay is not evidence.
--
-- The polling form waits for the wait to APPEAR rather than sampling once.
-- The other session signals that it is about to block, but it has not
-- necessarily reached the blocking statement yet, and a single sample would
-- then record "no wait" for a control that really did wait.
CREATE OR REPLACE FUNCTION public.moa_race_wait_observations_until(
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
      FROM public.moa_race_wait_observations() AS o;
    EXIT WHEN v_observation IS DISTINCT FROM 'none';
    EXIT WHEN clock_timestamp() >= v_deadline;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RETURN v_observation;
END;
$function$;

CREATE OR REPLACE FUNCTION public.moa_race_wait_observations()
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

-- Builds a selection-ready attempt with its stash, so a driver only has to
-- run the commit. The attempt is created with the attempt capability held,
-- exactly as complete_meta_oauth_callback would have left it.
CREATE OR REPLACE FUNCTION public.moa_race_prepare_attempt(
  p_attempt_id UUID,
  p_flow TEXT,
  p_intent TEXT,
  p_ig_user_id TEXT,
  p_ig_user_id_2 TEXT,
  p_facebook_user_id TEXT,
  p_target_social_account_id UUID,
  p_source_social_account_id UUID,
  p_picker_deadline_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_user uuid := 'f2ace001-0000-4000-8000-000000000001';
  v_profile uuid := 'f2ace101-0000-4000-8000-000000000011';
  v_now TIMESTAMPTZ := clock_timestamp();
  v_capture JSONB;
  v_candidates JSONB;
  v_pending UUID;
  v_selection_key TEXT;
BEGIN
  IF p_flow = 'instagram_direct' THEN
    v_candidates := jsonb_build_array(jsonb_build_object(
      'ig_user_id', p_ig_user_id,
      'ig_username', 'race_' || p_ig_user_id));
    v_selection_key := 'instagram_direct:ig:' || p_ig_user_id;
  ELSE
    v_candidates := jsonb_build_array(jsonb_build_object(
      'ig_user_id', p_ig_user_id,
      'ig_username', 'race_' || p_ig_user_id,
      'facebook_page_id', 'race-page-' || p_ig_user_id,
      'page_access_token', 'synthetic-not-a-live-secret',
      'facebook_user_id', p_facebook_user_id));
    v_selection_key := 'instagram_page_linked:ig:' || p_ig_user_id;
  END IF;

  IF p_ig_user_id_2 IS NOT NULL THEN
    IF p_flow = 'instagram_direct' THEN
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'ig_user_id', p_ig_user_id_2,
        'ig_username', 'race_' || p_ig_user_id_2));
    ELSE
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'ig_user_id', p_ig_user_id_2,
        'ig_username', 'race_' || p_ig_user_id_2,
        'facebook_page_id', 'race-page-' || p_ig_user_id_2,
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', p_facebook_user_id));
    END IF;
  END IF;

  -- The capture is the same shape the begin RPC writes: the explicit owned
  -- target and the complete shared grant membership.
  v_capture := jsonb_build_object('capture_version', 1, 'captured_at', '2026-10-27T12:00:00.000000Z');
  IF p_target_social_account_id IS NOT NULL THEN
    v_capture := v_capture || jsonb_build_object('target', jsonb_build_object(
      'social_account_id', p_target_social_account_id,
      'platform', 'instagram',
      'platform_user_id', p_ig_user_id,
      'binding_present', false,
      'binding_credential_id', NULL,
      'binding_connection_version', NULL,
      'fence_state', 'never_created',
      'fence_connection_version', 0,
      'credential_revision', NULL,
      'capability_present', true,
      'capability_generation', 1,
      'capability_login_kind', 'page_linked',
      'capability_permission_read_state', 'unknown'));
  END IF;
  IF p_source_social_account_id IS NOT NULL THEN
    v_capture := v_capture || jsonb_build_object(
      'source', jsonb_build_object(
        'social_account_id', p_source_social_account_id,
        'platform', 'instagram',
        'platform_user_id', 'race-ig-shared',
        'binding_present', true,
        'binding_credential_id', 'f2ace901-0000-4000-8000-000000000001',
        'binding_connection_version', 4,
        'fence_state', 'present',
        'fence_connection_version', 4,
        'credential_revision', 3,
        'capability_present', true,
        'capability_generation', 2,
        'capability_login_kind', 'page_linked',
        'capability_permission_read_state', 'unknown'),
      'grant', jsonb_build_object(
        'credential_id', 'f2ace901-0000-4000-8000-000000000001',
        'provider_user_id', 'race-fb-user',
        'credential_revision', 3,
        'members', jsonb_build_array(
          jsonb_build_object(
            'social_account_id', 'f2ace201-0000-4000-8000-000000000021',
            'platform', 'instagram',
            'connection_version', 4,
            'capability_generation', 2),
          jsonb_build_object(
            'social_account_id', 'f2ace201-0000-4000-8000-000000000022',
            'platform', 'instagram',
            'connection_version', 2,
            'capability_generation', 1))));
  END IF;

  INSERT INTO public.meta_oauth_attempts (
    id, user_id, flow, intent,
    target_social_account_id, source_social_account_id,
    intended_social_profile_id,
    capture_version, captured_at, capture, nonce_digest, status,
    callback_deadline, picker_deadline, created_at, updated_at
  ) VALUES (
    p_attempt_id, v_user, p_flow, p_intent,
    p_target_social_account_id, p_source_social_account_id,
    v_profile, 1, v_now, v_capture, md5(p_attempt_id::text) || md5(p_attempt_id::text),
    'selection_ready',
    LEAST(v_now + interval '10 minutes',
          v_now + make_interval(secs => p_picker_deadline_seconds)),
    v_now + make_interval(secs => p_picker_deadline_seconds),
    v_now, v_now
  );

  PERFORM set_config('postora.meta_oauth_attempt', p_attempt_id::TEXT, true);
  INSERT INTO public.oauth_pending_instagram_selections (
    user_id, social_profile_id, ig_candidates_json, long_lived_token,
    expires_in, created_at, expires_at, meta_oauth_attempt_id
  ) VALUES (
    v_user, v_profile, v_candidates, 'synthetic-not-a-live-secret',
    5184000, v_now,
    v_now + make_interval(secs => p_picker_deadline_seconds),
    p_attempt_id
  )
  RETURNING id INTO v_pending;
  PERFORM set_config('postora.meta_oauth_attempt', '', true);

  UPDATE public.meta_oauth_attempts
     SET pending_selection_id = v_pending
   WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'attempt_id', p_attempt_id,
    'pending_selection_id', v_pending,
    'selection_key', v_selection_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.moa_race_signal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.moa_race_wait_for(BIGINT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.moa_race_wait_observations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.moa_race_prepare_attempt(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moa_race_signal() TO service_role;
GRANT EXECUTE ON FUNCTION public.moa_race_wait_for(BIGINT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.moa_race_wait_observations() TO service_role;
GRANT EXECUTE ON FUNCTION public.moa_race_prepare_attempt(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID, INTEGER) TO service_role;

-- The synthetic owner and its world.
INSERT INTO auth.users (id, email)
VALUES ('f2ace001-0000-4000-8000-000000000001', 'moa-race@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_profiles (id, user_id, name)
VALUES ('f2ace101-0000-4000-8000-000000000011',
        'f2ace001-0000-4000-8000-000000000001', 'MOA Race Profile')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts (
  id, user_id, platform, platform_user_id, platform_username, access_token,
  is_active, social_profile_id, ig_auth_type
) VALUES
  ('f2ace201-0000-4000-8000-000000000021', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'race-ig-shared', 'race_ig_shared', 'synthetic-not-a-live-secret',
   true, 'f2ace101-0000-4000-8000-000000000011', 'facebook_page'),
  ('f2ace201-0000-4000-8000-000000000022', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'race-ig-sibling', 'race_ig_sibling', 'synthetic-not-a-live-secret',
   true, NULL, 'facebook_page'),
  ('f2ace201-0000-4000-8000-000000000023', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'race-ig-late', 'race_ig_late', 'synthetic-not-a-live-secret',
   false, NULL, 'facebook_page'),
  -- A second profile-free account. The deadline control needs an account
  -- that the profile deletion cannot cascade to, because the accepted
  -- baseline cascades a profile deletion onto every account assigned to it.
  ('f2ace201-0000-4000-8000-000000000024', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'race-ig-deadline', 'race_ig_deadline', 'synthetic-not-a-live-secret',
   false, NULL, 'facebook_page')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facebook_user_credentials (
  id, user_id, token, revision, lifecycle, provider_user_id,
  provenance_source, provenance_captured_at
) VALUES (
  'f2ace901-0000-4000-8000-000000000001',
  'f2ace001-0000-4000-8000-000000000001', 'synthetic-not-a-live-secret', 3,
  'active', 'race-fb-user', 'oauth_exchange', '2026-10-27 12:00:00+00'::timestamptz
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facebook_user_credential_bindings (
  social_account_id, user_id, platform, credential_id,
  verified_facebook_user_id, verified_facebook_page_id,
  verified_instagram_user_id, evidence_source, connection_version
) VALUES
  ('f2ace201-0000-4000-8000-000000000021', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'f2ace901-0000-4000-8000-000000000001', 'race-fb-user',
   'race-page-shared', 'race-ig-shared', 'oauth_exchange', 4),
  ('f2ace201-0000-4000-8000-000000000022', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'f2ace901-0000-4000-8000-000000000001', 'race-fb-user',
   'race-page-sibling', 'race-ig-sibling', 'oauth_exchange', 2)
ON CONFLICT (social_account_id) DO NOTHING;

INSERT INTO public.facebook_user_credential_connection_fences (
  social_account_id, user_id, platform, connection_version
) VALUES
  ('f2ace201-0000-4000-8000-000000000021', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 4),
  ('f2ace201-0000-4000-8000-000000000022', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 2)
ON CONFLICT (social_account_id) DO NOTHING;

INSERT INTO public.instagram_account_capabilities (
  social_account_id, user_id, platform, login_kind, permission_read_state,
  granted_scopes, credential_generation, credential_updated_at, generation_reason
) VALUES
  ('f2ace201-0000-4000-8000-000000000021', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 2,
   '2026-10-27 12:00:00+00'::timestamptz, 'credential_bound'),
  ('f2ace201-0000-4000-8000-000000000022', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
   '2026-10-27 12:00:00+00'::timestamptz, 'credential_bound'),
  ('f2ace201-0000-4000-8000-000000000023', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
   '2026-10-27 12:00:00+00'::timestamptz, 'credential_bound'),
  ('f2ace201-0000-4000-8000-000000000024', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
   '2026-10-27 12:00:00+00'::timestamptz, 'credential_bound');

INSERT INTO public.instagram_account_credentials (
  social_account_id, user_id, platform, credential_id
) VALUES
  ('f2ace201-0000-4000-8000-000000000021', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'f2ace901-0000-4000-8000-000000000001'),
  ('f2ace201-0000-4000-8000-000000000022', 'f2ace001-0000-4000-8000-000000000001',
   'instagram', 'f2ace901-0000-4000-8000-000000000001')
ON CONFLICT (social_account_id) DO NOTHING;

COMMIT;
\echo '=== meta_oauth_attempt_lifecycle race fixture: prepared synthetic owner and coordination primitives ==='
\endif
