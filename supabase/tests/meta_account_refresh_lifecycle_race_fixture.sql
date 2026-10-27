-- ===========================================================================
-- supabase/tests/meta_account_refresh_lifecycle_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. One connection cannot prove a lock order, a bounded
-- refusal, a stale result or an expiry that happens during a real wait. The
-- sequential suite is not that proof.
--
-- The harness refuses any tests/*.sql file that is not named in SUITES,
-- ISOLATED_SUITES or EXCLUDED_FROM_SUITES. This file matches
-- meta_oauth_attempt_lifecycle_race_fixture.sql: a manual multi-session
-- rehearsal, not a suite. scripts/db-harness.sh classifies it in
-- EXCLUDED_FROM_SUITES; run it separately with real concurrent sessions.
--
-- DISPOSABLE DATABASES ONLY. The prepare mode COMMITS synthetic rows.
-- Re-run with -v disposable=1. There is no --cleanup switch; psql does not
-- have one, so the cleanup mode is invoked with -v cleanup=1.
--
-- WHAT THIS PREPARES
--
--   One owner with one workspace, one direct Instagram account, one
--   page-linked Instagram account and its shared-grant sibling, one
--   Facebook page, one shared Facebook User credential, and the
--   coordination primitives the multi-session driver uses.
--
--   The coordination is a SEQUENCE, not a table: a sequence's nextval is
--   visible to other sessions IMMEDIATELY, while an uncommitted row update
--   is not. A driver that used a table would have to wait for a commit it
--   is trying to avoid, which is exactly the deadlock the controls are
--   looking for. The sequence therefore gives a deterministic handshake
--   with no sleep-based race.
--
--   public.mar_race_signal()        advances the coordination sequence
--   public.mar_race_wait_for(n)     blocks until the sequence reached n
--   public.mar_race_wait_observations()
--                                   lists the locks other sessions are
--                                   currently WAITING for, which is how a
--                                   real PostgreSQL lock wait is observed
--                                   rather than assumed
--   public.mar_race_prepare()       builds the synthetic owner and accounts
--   public.mar_race_capture(...)    takes a real capture with the real RPC
--   public.mar_race_hold_account(...)      holds the account row lock
--   public.mar_race_hold_credential(...)   holds the credential row lock
--   public.mar_race_hold_subscription(...) holds a webhook subscription row
--   public.mar_race_expire_capture(...)    expires a capture in place
--   public.mar_race_move_generation(...)   moves an account fence
--
-- HOW TO REHEARSE
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--     -f supabase/tests/meta_account_refresh_lifecycle_race_fixture.sql
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--     -f supabase/tests/meta_account_refresh_lifecycle_race_fixture.sql
--
-- The driver that runs the sessions lives outside the repository, in the
-- delivery evidence directory. This file is the reusable fixture it needs.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
BEGIN;

DROP FUNCTION IF EXISTS public.mar_race_move_generation(UUID);
DROP FUNCTION IF EXISTS public.mar_race_expire_capture(UUID);
DROP FUNCTION IF EXISTS public.mar_race_hold_subscription(UUID);
DROP FUNCTION IF EXISTS public.mar_race_hold_credential(UUID);
DROP FUNCTION IF EXISTS public.mar_race_hold_account(UUID);
DROP FUNCTION IF EXISTS public.mar_race_capture(UUID, TEXT);
DROP FUNCTION IF EXISTS public.mar_race_prepare();
DROP FUNCTION IF EXISTS public.mar_race_wait_observations_until(INTEGER);
DROP FUNCTION IF EXISTS public.mar_race_wait_observations();
DROP FUNCTION IF EXISTS public.mar_race_wait_for(BIGINT, INTEGER);
DROP FUNCTION IF EXISTS public.mar_race_signal();
DROP TABLE IF EXISTS public.mar_race_gate;
DROP SEQUENCE IF EXISTS public.mar_race_seq;

-- The synthetic owner cascades to its accounts, its capability records, its
-- credential, its bindings, its capture rows and its outbox rows.
DELETE FROM auth.users WHERE id = 'f2bce001-0000-4000-8000-000000000001';

COMMIT;
\echo '=== meta_account_refresh_lifecycle race fixture: cleaned synthetic owner ==='
\else
BEGIN;

-- The coordination primitives.
CREATE SEQUENCE IF NOT EXISTS public.mar_race_seq;
CREATE TABLE IF NOT EXISTS public.mar_race_gate (
  id      integer PRIMARY KEY,
  note    text
);
INSERT INTO public.mar_race_gate (id, note)
VALUES (1, 'meta account refresh lifecycle race control')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mar_race_signal()
RETURNS BIGINT
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT nextval('public.mar_race_seq');
$function$;

-- Blocks until the coordination sequence reached the target, or the timeout
-- expires. Returns the value it saw, so a driver can prove it really
-- waited rather than assuming it did.
CREATE OR REPLACE FUNCTION public.mar_race_wait_for(
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
    SELECT last_value INTO v_seen FROM public.mar_race_seq;
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
CREATE OR REPLACE FUNCTION public.mar_race_wait_observations()
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
CREATE OR REPLACE FUNCTION public.mar_race_wait_observations_until(
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
      FROM public.mar_race_wait_observations() AS o;
    EXIT WHEN v_observation IS DISTINCT FROM 'none';
    EXIT WHEN clock_timestamp() >= v_deadline;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RETURN v_observation;
END;
$function$;

-- The synthetic owner, its workspace, its accounts and its shared grant.
CREATE OR REPLACE FUNCTION public.mar_race_prepare()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_user CONSTANT uuid := 'f2bce001-0000-4000-8000-000000000001';
  v_workspace CONSTANT uuid := 'f2bce101-0000-4000-8000-000000000011';
  v_direct CONSTANT uuid := 'f2bce201-0000-4000-8000-000000000021';
  v_page CONSTANT uuid := 'f2bce201-0000-4000-8000-000000000022';
  v_sibling CONSTANT uuid := 'f2bce201-0000-4000-8000-000000000023';
  v_facebook CONSTANT uuid := 'f2bce201-0000-4000-8000-000000000024';
  v_credential CONSTANT uuid := 'f2bce301-0000-4000-8000-000000000031';
  v_key uuid;
  v_webhook uuid;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_user, 'mar-race@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id, is_personal)
  VALUES (v_workspace, 'mar-race-ws', v_user, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_accounts (
    id, user_id, workspace_id, platform, platform_user_id, platform_username,
    access_token, refresh_token, token_expires_at, is_active
  ) VALUES
    (v_direct, v_user, v_workspace, 'instagram', 'race-ig-direct', 'race_ig_direct',
     'race-direct-token', 'race-direct-refresh', '2027-01-01T00:00:00Z', true),
    (v_page, v_user, v_workspace, 'instagram', 'race-ig-page', 'race_ig_page',
     'race-page-token', 'race-page-refresh', '2027-01-02T00:00:00Z', true),
    (v_sibling, v_user, v_workspace, 'instagram', 'race-ig-sibling', 'race_ig_sibling',
     'race-sibling-token', NULL, '2027-01-03T00:00:00Z', true),
    (v_facebook, v_user, v_workspace, 'facebook', 'race-fb-page', 'race_fb_page',
     'race-fb-token', NULL, NULL, true)
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
    v_credential, v_user, 'race-user-token', 1, 'active', '2027-02-01T00:00:00Z',
    'race-fb-user', 'oauth_exchange', '2026-10-01T00:00:00Z'
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
    (v_page, v_user, 'instagram', v_credential,
     'race-fb-user', 'race-page', 'race-ig-page', 'oauth_exchange', 1),
    (v_sibling, v_user, 'instagram', v_credential,
     'race-fb-user', 'race-page', 'race-ig-sibling', 'oauth_exchange', 1),
    (v_facebook, v_user, 'facebook', v_credential,
     'race-fb-user', NULL, NULL, 'oauth_exchange', 1)
  ON CONFLICT (social_account_id) DO UPDATE
    SET credential_id = EXCLUDED.credential_id,
        connection_version = 1;

  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES
    (v_page, v_user, 'instagram', 1),
    (v_sibling, v_user, 'instagram', 1),
    (v_facebook, v_user, 'facebook', 1)
  ON CONFLICT (social_account_id) DO UPDATE
    SET connection_version = 1;

  INSERT INTO public.instagram_account_capabilities (
    social_account_id, user_id, platform, login_kind, permission_read_state,
    granted_scopes, scopes_read_at, credential_generation
  ) VALUES
    (v_direct, v_user, 'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 3),
    (v_page, v_user, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic'], '2026-10-20T00:00:00Z', 2),
    (v_sibling, v_user, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic'], '2026-10-20T00:00:00Z', 2)
  ON CONFLICT (social_account_id) DO UPDATE
    SET credential_generation = EXCLUDED.credential_generation,
        permission_read_state = EXCLUDED.permission_read_state,
        granted_scopes = EXCLUDED.granted_scopes,
        scopes_read_at = EXCLUDED.scopes_read_at;

  -- A subscriber, so the failure path has a real outbox parent to lock.
  INSERT INTO public.partner_api_keys (
    workspace_id, social_account_id, key_hash, key_prefix, name, scopes
  )
  SELECT v_workspace, v_page, 'mar-race-hash', 'pk_live_marr', 'mar-race-key',
         ARRAY['webhooks:manage']
  WHERE NOT EXISTS (
    SELECT 1 FROM public.partner_api_keys WHERE key_hash = 'mar-race-hash'
  );

  SELECT id INTO v_key
    FROM public.partner_api_keys WHERE key_hash = 'mar-race-hash';

  INSERT INTO public.partner_webhooks (
    workspace_id, created_by_key_id, url, events, secret
  )
  SELECT v_workspace, v_key, 'https://hooks.example.com/mar-race',
         ARRAY['account.reauthorization_required'], 'mar-race-secret'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.partner_webhooks
     WHERE workspace_id = v_workspace
       AND url = 'https://hooks.example.com/mar-race'
  );

  SELECT id INTO v_webhook
    FROM public.partner_webhooks
   WHERE workspace_id = v_workspace
     AND url = 'https://hooks.example.com/mar-race';

  RETURN jsonb_build_object(
    'user_id', v_user,
    'workspace_id', v_workspace,
    'direct_account_id', v_direct,
    'page_account_id', v_page,
    'sibling_account_id', v_sibling,
    'facebook_account_id', v_facebook,
    'credential_id', v_credential,
    'webhook_id', v_webhook);
END;
$function$;

-- Takes a real capture with the real begin RPC. The capture is committed, so
-- another session can consume it.
CREATE OR REPLACE FUNCTION public.mar_race_capture(
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
  v_owner CONSTANT uuid := 'f2bce001-0000-4000-8000-000000000001';
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

-- Holds the account row lock in the caller's transaction. A second session
-- that tries the same account must be refused in bounded time rather than
-- wait, and must write nothing.
CREATE OR REPLACE FUNCTION public.mar_race_hold_account(
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
CREATE OR REPLACE FUNCTION public.mar_race_hold_credential(
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

-- Holds one webhook subscription row. The outbox row's foreign key parent
-- is the subscription, so this is the row a concurrent subscription delete
-- would take.
CREATE OR REPLACE FUNCTION public.mar_race_hold_subscription(
  p_workspace_id UUID
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
  SELECT 'locked:' || w.id::TEXT INTO v_locked
    FROM public.partner_webhooks AS w
   WHERE w.workspace_id = p_workspace_id
   ORDER BY w.id
   LIMIT 1
     FOR UPDATE;
  RETURN coalesce(v_locked, 'missing');
END;
$function$;

-- Expires a capture in place, so a commit that arrives after the deadline is
-- refused rather than accepted.
CREATE OR REPLACE FUNCTION public.mar_race_expire_capture(
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

-- Moves an account fence, which is what a reconnect, a revoke or a
-- direct <-> page conversion does underneath a captured result.
CREATE OR REPLACE FUNCTION public.mar_race_move_generation(
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

-- The synthetic rows are committed by this mode, so the driver can use them
-- from any session.
SELECT public.mar_race_prepare();

COMMIT;
\echo '=== meta_account_refresh_lifecycle race fixture: prepared synthetic owner ==='
\endif
