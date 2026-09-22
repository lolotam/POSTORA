-- ============================================================================
-- log_system_event.sql — consent-log RPC authorization (20260922140000)
--
-- Proves: (1) a signed-in caller's event lands with the actor's own id and the
-- fixed source/category; (2) a caller-supplied p_user_id is ignored, so one
-- account cannot attribute an event to another; (3) any service other than
-- 'oauth-consent' is refused; (4) a caller with no user identity — anon, or
-- the service key, which carries no `sub` — is refused; (5) p_details survives
-- into metadata and p_error_code/p_error_message are folded in rather than
-- dropped; (6) only `authenticated` holds EXECUTE.
--
-- Regression guard for the original defect: the function inserted into
-- `service`, `details`, `error_code` and `error_message`, none of which exist
-- on system_logs, so every call raised 42703 and the consent trail recorded
-- nothing. Assertion L1 fails against that body.
--
-- Run with psql AS A SUPERUSER against a throwaway database with every
-- migration applied. NEVER against production.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== log_system_event: start ==='

CREATE TEMP TABLE lse_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO lse_ids VALUES
  ('actor',    '15e00000-15e0-4000-8000-000000000001'),
  ('stranger', '15e00000-15e0-4000-8000-000000000002');

CREATE OR REPLACE FUNCTION pg_temp.lse_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_us uuid[] := ARRAY(SELECT id FROM lse_ids);
BEGIN
  DELETE FROM public.system_logs WHERE user_id = ANY(v_us);
  DELETE FROM public.user_roles WHERE user_id = ANY(v_us);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.lse_cleanup();

CREATE OR REPLACE FUNCTION pg_temp.lse_act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.lse_must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

-- Runs the RPC and reports whether it refused, so a test can assert refusal
-- without the failure aborting the suite.
CREATE OR REPLACE FUNCTION pg_temp.lse_refused(p_service TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.log_system_event('info', p_service, 'refusal probe');
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;

INSERT INTO auth.users (id, email) VALUES
  ((SELECT id FROM lse_ids WHERE k='actor'),    'lse-actor@example.invalid'),
  ((SELECT id FROM lse_ids WHERE k='stranger'), 'lse-stranger@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- L1/L2/L5: a signed-in caller logs one event, naming the stranger as the
-- subject and supplying an error code. The row must carry the ACTOR.
-- ---------------------------------------------------------------------------
DO $l1$
DECLARE
  v_actor    uuid := (SELECT id FROM lse_ids WHERE k='actor');
  v_stranger uuid := (SELECT id FROM lse_ids WHERE k='stranger');
  v_log_id   uuid;
  v_row      public.system_logs;
BEGIN
  PERFORM pg_temp.lse_act_as(v_actor);

  v_log_id := public.log_system_event(
    'info', 'oauth-consent', 'OAuth authorization approved',
    '{"client_name":"Acme"}'::jsonb,
    'consent_probe', 'probe detail',
    v_stranger  -- deliberately foreign; must be ignored
  );

  SELECT * INTO v_row FROM public.system_logs WHERE id = v_log_id;

  PERFORM pg_temp.lse_must(v_row.id IS NOT NULL,
    'L1 the event was not written at all');
  PERFORM pg_temp.lse_must(v_row.user_id = v_actor,
    'L2 the row is attributed to the caller-supplied id, not the actor');
  PERFORM pg_temp.lse_must(v_row.source = 'oauth-consent' AND v_row.category = 'auth',
    'L1 source/category were not forced');
  PERFORM pg_temp.lse_must(v_row.level = 'info'
    AND v_row.message = 'OAuth authorization approved',
    'L1 level or message did not survive');
  PERFORM pg_temp.lse_must(v_row.metadata->>'client_name' = 'Acme',
    'L5 p_details did not reach metadata');
  PERFORM pg_temp.lse_must(v_row.metadata->>'error_code' = 'consent_probe'
    AND v_row.metadata->>'error_message' = 'probe detail',
    'L5 p_error_code/p_error_message were dropped');
END $l1$;

-- ---------------------------------------------------------------------------
-- L3: any other service is refused, including the one process-post used to
-- pass. L4: no user identity is refused.
-- ---------------------------------------------------------------------------
DO $l3$
DECLARE
  v_actor uuid := (SELECT id FROM lse_ids WHERE k='actor');
BEGIN
  PERFORM pg_temp.lse_act_as(v_actor);
  PERFORM pg_temp.lse_must(pg_temp.lse_refused('process-post'),
    'L3 a foreign service was accepted');
  PERFORM pg_temp.lse_must(pg_temp.lse_refused('auth-webhook'),
    'L3 a foreign service was accepted');

  PERFORM pg_temp.lse_act_as(NULL);
  PERFORM pg_temp.lse_must(pg_temp.lse_refused('oauth-consent'),
    'L4 a caller with no user identity was accepted');
END $l3$;

-- ---------------------------------------------------------------------------
-- L6: grant surface. anon lost EXECUTE in 20260922090000; service_role lost it
-- in 20260922140000 once process-post stopped calling it.
-- ---------------------------------------------------------------------------
DO $l6$
DECLARE
  v_sig constant text :=
    'public.log_system_event(text, text, text, jsonb, text, text, uuid)';
BEGIN
  PERFORM pg_temp.lse_must(
    has_function_privilege('authenticated', v_sig, 'EXECUTE'),
    'L6 authenticated cannot execute; the consent flow cannot log');
  PERFORM pg_temp.lse_must(
    NOT has_function_privilege('anon', v_sig, 'EXECUTE'),
    'L6 anon can execute');
  PERFORM pg_temp.lse_must(
    NOT has_function_privilege('service_role', v_sig, 'EXECUTE'),
    'L6 service_role can execute');
  PERFORM pg_temp.lse_must(
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'log_system_event') = 1,
    'L6 log_system_event is overloaded');
END $l6$;

SELECT pg_temp.lse_act_as(NULL);
SELECT pg_temp.lse_cleanup();

\echo '=== log_system_event: ALL CHECKS PASSED ==='
