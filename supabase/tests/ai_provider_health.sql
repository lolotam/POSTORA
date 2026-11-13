-- ============================================================================
-- ai_provider_health.sql
--
-- Proof for 20261113180000_ai_provider_health.sql (spec
-- 2026-11-13-ai-providers-test-and-sync-design.md §6.6, §6.9):
--
--   public.ai_provider_health                    (latest status per credential kind)
--   public.record_ai_provider_health             (writes the result, keeps previous_status)
--   public.claim_ai_provider_health_notifications (two-phase alert claim)
--   public.mark_ai_provider_health_notified      (closes the claim)
--   public.ai_models.auth_method                 (models are keyed by credential kind)
--   the four guarded pg_cron entries 'ai-provider-health-1..4'
--
-- Run with psql AS A SUPERUSER against a THROWAWAY database with every
-- migration applied. NEVER against production: it writes rows.
--
--   psql "$HARNESS_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/ai_provider_health.sql
--
-- HOW IT PROVES THINGS
--   * Header, transaction and assert style follow ai_provider_oauth.sql:
--     every expected refusal sits in its own BEGIN/EXCEPTION block, every
--     failure RAISES with a FAIL: prefix, and an accepted write that should
--     have been refused exits psql non-zero via ON_ERROR_STOP.
--   * The service-role RPCs are called as the superuser the harness runs as.
--   * RLS impersonation is SET ROLE (statement level; role changes are not
--     allowed inside DO blocks).
--   * Self-cleaning: the fixture provider rows this suite creates are removed
--     before AND after, and only the ones it created. A provider that already
--     existed (production shape) is left exactly as it was.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== ai_provider_health: start ==='

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after, so a crashed earlier run cannot wedge this one)
-- ---------------------------------------------------------------------------
DELETE FROM public.ai_provider_health_alerts WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_provider_health_completions WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_provider_health WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_models WHERE model_id = 'health-fixture-model';

-- The provider rows are fixtures. Only the ones this suite creates are
-- removed at the end; a provider that already existed (production shape) is
-- left exactly as it was.
CREATE TEMP TABLE aph_created_providers (provider_code text PRIMARY KEY);

DO $aph_seed_providers$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider_code = 'claude') THEN
    INSERT INTO public.ai_providers
      (provider_code, name, api_endpoint, api_key_env_var, api_type,
       supports_streaming, is_active)
    VALUES
      ('claude', 'Anthropic API', 'https://api.anthropic.com/v1',
       'ANTHROPIC_API_KEY', 'anthropic', true, false)
    ON CONFLICT (provider_code) DO NOTHING;
    INSERT INTO aph_created_providers (provider_code) VALUES ('claude')
      ON CONFLICT DO NOTHING;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider_code = 'openai') THEN
    INSERT INTO public.ai_providers
      (provider_code, name, api_endpoint, api_key_env_var, api_type,
       supports_streaming, is_active)
    VALUES
      ('openai', 'OpenAI', 'https://api.openai.com/v1',
       'OPENAI_API_KEY', 'openai', true, false)
    ON CONFLICT (provider_code) DO NOTHING;
    INSERT INTO aph_created_providers (provider_code) VALUES ('openai')
      ON CONFLICT DO NOTHING;
  END IF;
END $aph_seed_providers$;

-- ===========================================================================
-- 1. A normal signed-in user sees no row and may not write one.
--    SET ROLE at statement level: role changes are not allowed inside DO
--    blocks. The RLS policy is admin-only, so the count is zero; the RPC is
--    REVOKEd from authenticated, so the call is refused outright.
-- ===========================================================================
\echo '--- as authenticated: table is empty and the RPC is refused ---'
-- Positive control first: denial must hide an existing row for a real user JWT.
INSERT INTO auth.users(id, email) VALUES ('a4140000-0000-4000-8000-000000000001', 'health-reader@example.invalid') ON CONFLICT DO NOTHING;
INSERT INTO public.ai_provider_health(provider_code, auth_method, status) VALUES ('claude','api_key','connected');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_provider_health WHERE provider_code = 'claude') THEN
    RAISE EXCEPTION 'FAIL: missing health RLS positive control';
  END IF;
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a4140000-0000-4000-8000-000000000001', false);
DO $aph_auth_table$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.ai_provider_health;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: authenticated read % ai_provider_health rows, expected 0', v_count;
  END IF;
END $aph_auth_table$;

DO $aph_auth_rpc$
BEGIN
  BEGIN
    PERFORM public.record_ai_provider_health('claude','api_key','connected',NULL,0,0,0,10,NULL);
    RAISE EXCEPTION 'FAIL: authenticated EXECUTE of record_ai_provider_health was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: no EXECUTE grant for authenticated
  END;
END $aph_auth_rpc$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
DELETE FROM public.ai_provider_health WHERE provider_code = 'claude';
DELETE FROM auth.users WHERE id = 'a4140000-0000-4000-8000-000000000001';

-- ===========================================================================
-- 2. The first result of a provider has no previous status.
-- ===========================================================================
\echo '--- record: the first result has no previous status ---'
DO $aph_record_first$
DECLARE
  v_status text;
  v_previous text;
  v_added integer;
BEGIN
  PERFORM public.record_ai_provider_health(
    'claude', 'api_key', 'connected', NULL, 3, 1, 0, 42,
    '11111111-1111-1111-1111-111111111111'::uuid);

  SELECT status, previous_status, models_added
    INTO v_status, v_previous, v_added
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';

  IF v_status IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'FAIL: status is %, expected connected', v_status;
  END IF;
  IF v_previous IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: previous_status is %, expected NULL on the first result', v_previous;
  END IF;
  IF v_added IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL: models_added is %, expected 3', v_added;
  END IF;
END $aph_record_first$;

-- ===========================================================================
-- 3. The next result keeps the status it replaced. This is what makes the
--    degradation alert a transition instead of a level.
-- ===========================================================================
\echo '--- record: the second result keeps the previous status ---'
DO $aph_record_second$
DECLARE
  v_status text;
  v_previous text;
  v_reason text;
BEGIN
  PERFORM public.record_ai_provider_health(
    'claude', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 50,
    '11111111-1111-1111-1111-111111111111'::uuid);

  SELECT status, previous_status, reason
    INTO v_status, v_previous, v_reason
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';

  IF v_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'FAIL: status is %, expected failed', v_status;
  END IF;
  IF v_previous IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'FAIL: previous_status is %, expected connected', v_previous;
  END IF;
  IF v_reason IS DISTINCT FROM 'Rate limit exceeded' THEN
    RAISE EXCEPTION 'FAIL: reason is %, expected the sanitized sentence', v_reason;
  END IF;
END $aph_record_second$;

-- ===========================================================================
-- 4. The claim returns the degraded row exactly once. A second claim with a
--    different token finds nothing: the row is already claimed.
-- ===========================================================================
\echo '--- claim: the degraded row is claimed once ---'
DO $aph_claim$
DECLARE
  v_rows integer;
  v_provider text;
  v_auth text;
  v_status text;
  v_reason text;
  v_previous text;
BEGIN
  SELECT count(*), min(provider_code), min(auth_method), min(status),
         min(reason), min(previous_status)
    INTO v_rows, v_provider, v_auth, v_status, v_reason, v_previous
    FROM public.claim_ai_provider_health_notifications(
      '22222222-2222-2222-2222-222222222222'::uuid);

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the claim returned % rows, expected 1', v_rows;
  END IF;
  IF v_provider IS DISTINCT FROM 'claude' THEN
    RAISE EXCEPTION 'FAIL: the claimed provider is %, expected claude', v_provider;
  END IF;
  IF v_auth IS DISTINCT FROM 'api_key' THEN
    RAISE EXCEPTION 'FAIL: the claimed auth_method is %, expected api_key', v_auth;
  END IF;
  IF v_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'FAIL: the claimed status is %, expected failed', v_status;
  END IF;
  IF v_reason IS DISTINCT FROM 'Rate limit exceeded' THEN
    RAISE EXCEPTION 'FAIL: the claimed reason is %, expected the sanitized sentence', v_reason;
  END IF;
  IF v_previous IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'FAIL: the claimed previous_status is %, expected connected', v_previous;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.claim_ai_provider_health_notifications(
      '33333333-3333-3333-3333-333333333333'::uuid);
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: a second claim returned % rows, expected 0', v_rows;
  END IF;
END $aph_claim$;

-- ===========================================================================
-- 5. Marking the claim notified closes it for good: the row is not claimed
--    again, so a provider that stays broken does not alert every day.
--    The mark names one row: a send that failed for one provider must not
--    close the alert of the others, so the claim token alone is not enough.
-- ===========================================================================
\echo '--- mark notified: the claim is closed ---'
DO $aph_mark$
DECLARE
  v_notified timestamptz;
  v_token uuid;
  v_rows integer;
  v_pending boolean;
BEGIN
  PERFORM public.mark_ai_provider_health_notified(
    '22222222-2222-2222-2222-222222222222'::uuid, 'claude', 'api_key');

  SELECT notified_at, claim_token, alert_pending
    INTO v_notified, v_token, v_pending
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';

  IF v_notified IS NULL THEN
    RAISE EXCEPTION 'FAIL: notified_at is NULL after mark_ai_provider_health_notified';
  END IF;
  IF v_token IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: claim_token is % after mark_ai_provider_health_notified, expected NULL', v_token;
  END IF;
  IF v_pending THEN
    RAISE EXCEPTION 'FAIL: alert_pending is still true after the alert was sent';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.claim_ai_provider_health_notifications(
      '44444444-4444-4444-4444-444444444444'::uuid);
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: a claim after notify returned % rows, expected 0', v_rows;
  END IF;
END $aph_mark$;

-- ===========================================================================
-- 6. Only a connected -> degraded transition is claimable. A provider that
--    was already broken stays un-notified.
-- ===========================================================================
\echo '--- claim: only a connected -> degraded transition is claimable ---'
DO $aph_claim_transition$
DECLARE
  v_rows integer;
BEGIN
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT count(*) INTO v_rows
    FROM public.claim_ai_provider_health_notifications(
      '66666666-6666-6666-6666-666666666666'::uuid)
   WHERE provider_code = 'openai';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: a provider that was never connected was claimed (% rows)', v_rows;
  END IF;
END $aph_claim_transition$;

-- ===========================================================================
-- 7. Models are keyed by credential kind: ai_models.auth_method exists,
--    defaults to 'api_key', and the same (provider_id, model_id) may exist
--    once per credential kind.
-- ===========================================================================
\echo '--- ai_models: the catalogue is keyed by credential kind ---'
DO $aph_models$
DECLARE
  v_provider_id uuid;
  v_rows integer;
BEGIN
  SELECT id INTO v_provider_id
    FROM public.ai_providers WHERE provider_code = 'claude';
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: the claude provider fixture is missing';
  END IF;

  INSERT INTO public.ai_models
    (provider_id, model_id, name, capabilities, is_active)
  VALUES
    (v_provider_id, 'health-fixture-model', 'Health fixture (api key)', '{chat}', true);

  INSERT INTO public.ai_models
    (provider_id, model_id, name, capabilities, is_active, auth_method)
  VALUES
    (v_provider_id, 'health-fixture-model', 'Health fixture (oauth)', '{chat}', true, 'oauth');

  SELECT count(*) INTO v_rows
    FROM public.ai_models
   WHERE provider_id = v_provider_id AND model_id = 'health-fixture-model';
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: % rows share (provider_id, model_id), expected 2', v_rows;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.ai_models
   WHERE provider_id = v_provider_id
     AND model_id = 'health-fixture-model'
     AND auth_method = 'api_key';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: % api_key rows for the fixture model, expected 1', v_rows;
  END IF;

  SELECT count(*) INTO v_rows FROM public.ai_models WHERE auth_method IS NULL;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: % ai_models rows have a NULL auth_method', v_rows;
  END IF;
END $aph_models$;

-- ===========================================================================
-- 8. The run id the runner derives is a real uuid. The column is a uuid and
--    the lease holder is a uuid, so a shape that only LOOKS like a uuid would
--    fail at the database. The string below is the exact value
--    deriveRunId('daily', 'cron', 2026-11-13T03:05:00Z) produces; the Deno
--    test in _shared/aiProviderHealth.test.ts pins the same value.
-- ===========================================================================
\echo '--- run id: the derived id is accepted by a uuid column ---'
DO $aph_run_id$
DECLARE
  v_run_id uuid;
BEGIN
  v_run_id := '357b4318-de5b-440e-8ca0-bf781a6bfc1b'::uuid;

  PERFORM public.record_ai_provider_health(
    'claude', 'api_key', 'connected', NULL, 0, 0, 0, 1, v_run_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.ai_provider_health
     WHERE provider_code = 'claude' AND auth_method = 'api_key' AND run_id = v_run_id
  ) THEN
    RAISE EXCEPTION 'FAIL: the derived run id was not stored in the uuid column';
  END IF;
END $aph_run_id$;

-- ===========================================================================
-- 9. The status CHECK refuses a status nobody defined.
-- ===========================================================================
\echo '--- checks: the status and the auth_method are constrained ---'
DO $aph_checks$
BEGIN
  BEGIN
    INSERT INTO public.ai_provider_health (provider_code, auth_method, status)
    VALUES ('claude', 'api_key', 'bogus');
    RAISE EXCEPTION 'FAIL: a bogus status INSERT was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  BEGIN
    INSERT INTO public.ai_provider_health (provider_code, auth_method, status)
    VALUES ('claude', 'saml', 'connected');
    RAISE EXCEPTION 'FAIL: a bogus auth_method INSERT was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;
END $aph_checks$;

-- ===========================================================================
-- 10. The daily schedule is four guarded pg_cron entries. The assertion is
--    skipped when pg_cron is not installed, so the suite passes on a database
--    without it.
-- ===========================================================================
\echo '--- cron: four daily entries ---'
DO $aph_cron$
DECLARE
  v_jobs integer;
  v_names text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is not installed; the cron assertion is skipped';
    RETURN;
  END IF;

  SELECT count(*), string_agg(jobname, ',' ORDER BY jobname)
    INTO v_jobs, v_names
    FROM cron.job
   WHERE jobname LIKE 'ai-provider-health%';
  IF v_jobs <> 4 THEN
    RAISE EXCEPTION 'FAIL: % ai-provider-health cron jobs (%), expected 4',
      v_jobs, coalesce(v_names, 'none');
  END IF;
END $aph_cron$;

-- Execute the actual scheduled bodies against a local URL fixture. Substitute
-- only the HTTP boundary: the no-URL guard and URL construction run unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_cron_functions_base_url() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('postora.test_functions_url', true), '') $$;
DO $aph_cron_url$
DECLARE v_command text; v_test text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
  FOR v_command IN SELECT command FROM cron.job WHERE jobname LIKE 'ai-provider-health-%' LOOP
    IF v_command NOT LIKE '%public.get_cron_functions_base_url()%'
       OR v_command NOT LIKE '%url := v_url%'
       OR v_command LIKE '%api.postora.cloud%' THEN
      RAISE EXCEPTION 'FAIL: cron sends credentials to a literal host';
    END IF;
    IF v_command !~ 'timeout_milliseconds[[:space:]]*:=[[:space:]]*50000' THEN
      RAISE EXCEPTION 'FAIL: cron HTTP timeout does not cover handler deadline';
    END IF;
    PERFORM set_config('postora.test_functions_url', '', true);
    v_test := regexp_replace(v_command, 'PERFORM net.http_post\([^;]+;',
      'RAISE EXCEPTION ''FAIL: missing URL did not skip HTTP'';');
    EXECUTE v_test;
    PERFORM set_config('postora.test_functions_url', 'https://staging.example.test/', true);
    v_test := regexp_replace(v_command, 'PERFORM net.http_post\([^;]+;',
      'IF v_url IS DISTINCT FROM ''https://staging.example.test/functions/v1/ai-provider-health'' THEN RAISE EXCEPTION ''FAIL: cron URL does not follow the environment''; END IF;');
    EXECUTE v_test;
  END LOOP;
END $aph_cron_url$;
ROLLBACK;

-- ===========================================================================
-- 11. A provider that is re-checked while it is STILL broken keeps its
--     pending alert. The claim used to look at previous_status, and the
--     re-check overwrote previous_status with 'failed', so the pending
--     alert was lost before anyone was told. The pending flag is durable.
-- ===========================================================================
\echo '--- claim: a re-check of a still-broken provider keeps the alert ---'
DO $aph_pending_survives$
DECLARE
  v_rows integer;
  v_pending boolean;
BEGIN
  -- claude is 'connected' at this point.
  PERFORM public.record_ai_provider_health(
    'claude', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '11111111-1111-1111-1111-111111111111'::uuid);

  SELECT alert_pending INTO v_pending
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';
  IF v_pending IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: alert_pending is % after the transition, expected true', v_pending;
  END IF;

  -- The manual "Test and sync" click records the same broken provider again
  -- before the alert was claimed.
  PERFORM public.record_ai_provider_health(
    'claude', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '11111111-1111-1111-1111-111111111111'::uuid);

  SELECT alert_pending INTO v_pending
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';
  IF v_pending IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: alert_pending is % after the re-check, expected true', v_pending;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.claim_ai_provider_health_notifications(
      '88888888-8888-8888-8888-888888888888'::uuid)
   WHERE provider_code = 'claude';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the claim returned % rows after the re-check, expected 1', v_rows;
  END IF;

  PERFORM public.mark_ai_provider_health_notified(
    '88888888-8888-8888-8888-888888888888'::uuid, 'claude', 'api_key');
END $aph_pending_survives$;

-- ===========================================================================
-- 12. Break, alert, recover, break again: the second break alerts again.
--     The claim required notified_at IS NULL and nothing ever cleared
--     notified_at, so a provider alerted once and then never again.
-- ===========================================================================
\echo '--- claim: a provider that breaks again after a recovery alerts again ---'
DO $aph_alerts_again$
DECLARE
  v_rows integer;
  v_notified timestamptz;
BEGIN
  -- openai is 'failed' and has never been connected.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'connected', NULL, 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT count(*) INTO v_rows
    FROM public.claim_ai_provider_health_notifications(
      '99999999-9999-9999-9999-999999999999'::uuid)
   WHERE provider_code = 'openai';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the first break claimed % rows, expected 1', v_rows;
  END IF;

  PERFORM public.mark_ai_provider_health_notified(
    '99999999-9999-9999-9999-999999999999'::uuid, 'openai', 'api_key');

  SELECT notified_at INTO v_notified
    FROM public.ai_provider_health
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  IF v_notified IS NULL THEN
    RAISE EXCEPTION 'FAIL: notified_at is NULL after the first alert';
  END IF;

  -- The provider recovers.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'connected', NULL, 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  -- ... and breaks again.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT count(*) INTO v_rows
    FROM public.claim_ai_provider_health_notifications(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid)
   WHERE provider_code = 'openai';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the second break claimed % rows, expected 1', v_rows;
  END IF;

  PERFORM public.mark_ai_provider_health_notified(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'openai', 'api_key');
END $aph_alerts_again$;

-- ===========================================================================
-- 13. One break, one alert id. The id is minted when the provider ENTERS a
--     broken state and stays the same while the provider is still broken, so a
--     claim that is re-claimed after a run that died mid-send carries the same
--     id and the mail provider refuses the second send. A recovery clears it and
--     the next break gets a new id: a new break is a new alert.
-- ===========================================================================
\echo '--- alert id: one id per break ---'
DO $aph_alert_id$
DECLARE
  v_first uuid;
  v_again uuid;
  v_second uuid;
  v_claimed uuid;
BEGIN
  -- Start from a known state: openai recovers.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'connected', NULL, 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  -- It breaks: the break gets an id.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT alert_id INTO v_first
    FROM public.ai_provider_health
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  IF v_first IS NULL THEN
    RAISE EXCEPTION 'FAIL: the first break has no alert_id';
  END IF;

  -- The claim carries the id of that break.
  SELECT alert_id INTO v_claimed
    FROM public.claim_ai_provider_health_notifications(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
   WHERE provider_code = 'openai';
  IF v_claimed IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'FAIL: the claim carries the alert id %, expected %', v_claimed, v_first;
  END IF;
  PERFORM public.mark_ai_provider_health_notified(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'openai', 'api_key');

  -- A re-check while it is STILL broken is the same break: the id stays.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT alert_id INTO v_again
    FROM public.ai_provider_health
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  IF v_again IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'FAIL: the re-check changed the alert id from % to %, expected the same break', v_first, v_again;
  END IF;

  -- It recovers: there is no break any more, so there is no id.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'connected', NULL, 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT alert_id INTO v_again
    FROM public.ai_provider_health
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  IF v_again IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the recovery left the alert id % behind', v_again;
  END IF;

  -- It breaks again: a NEW break gets a NEW id, so the alert is a new alert.
  PERFORM public.record_ai_provider_health(
    'openai', 'api_key', 'failed', 'Rate limit exceeded', 0, 0, 0, 10,
    '55555555-5555-5555-5555-555555555555'::uuid);

  SELECT alert_id INTO v_second
    FROM public.ai_provider_health
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  IF v_second IS NULL THEN
    RAISE EXCEPTION 'FAIL: the second break has no alert_id';
  END IF;
  IF v_second = v_first THEN
    RAISE EXCEPTION 'FAIL: the second break reuses the alert id %, expected a new one', v_first;
  END IF;

  PERFORM public.mark_ai_provider_health_notified(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'openai', 'api_key');
END $aph_alert_id$;

-- A retried claim must return the original event content even when a re-check
-- changes the live failure reason. Resend rejects a reused key with a new body.
DO $aph_retry_payload$
DECLARE
  v_first_id uuid;
  v_claim record;
BEGIN
  PERFORM public.claim_ai_provider_health_notifications('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  PERFORM public.mark_ai_provider_health_notified('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'openai', 'api_key');
  PERFORM public.record_ai_provider_health('openai', 'api_key', 'connected', NULL, 0, 0, 0, 1, NULL);
  PERFORM public.record_ai_provider_health('openai', 'api_key', 'failed', 'Original reason', NULL, NULL, NULL, 1, NULL);
  SELECT alert_id INTO v_first_id FROM public.ai_provider_health
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  PERFORM public.claim_ai_provider_health_notifications('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  UPDATE public.ai_provider_health_alerts SET claimed_at = now() - interval '11 minutes'
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  PERFORM public.record_ai_provider_health('openai', 'api_key', 'needs_relogin', 'Changed reason', NULL, NULL, NULL, 1, NULL);
  SELECT * INTO v_claim FROM public.claim_ai_provider_health_notifications('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
   WHERE provider_code = 'openai' AND auth_method = 'api_key';
  IF v_claim.alert_id IS DISTINCT FROM v_first_id OR v_claim.reason IS DISTINCT FROM 'Original reason'
     OR v_claim.status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'FAIL: the retry changed the original alert event';
  END IF;
END $aph_retry_payload$;

-- ===========================================================================
-- 14. A provider that was not synced has NO count. The recording RPC used to
--     coalesce a null count to zero, so a failed sync read back as "0 added,
--     0 updated" after a reload: a wrong claim about work that never happened.
-- ===========================================================================
\echo '--- counts: a provider that was not synced has no count ---'
DO $aph_counts_null$
DECLARE
  v_added integer;
  v_updated integer;
  v_deactivated integer;
BEGIN
  PERFORM public.record_ai_provider_health(
    'claude', 'api_key', 'failed', 'Rate limit exceeded', NULL, NULL, NULL, 10,
    '11111111-1111-1111-1111-111111111111'::uuid);

  SELECT models_added, models_updated, models_deactivated
    INTO v_added, v_updated, v_deactivated
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';

  IF v_added IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: models_added is %, expected NULL', v_added;
  END IF;
  IF v_updated IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: models_updated is %, expected NULL', v_updated;
  END IF;
  IF v_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: models_deactivated is %, expected NULL', v_deactivated;
  END IF;
END $aph_counts_null$;

-- ===========================================================================
-- 15. An authenticated admin may READ the health rows and may not WRITE
--     them. The rows are written by the edge function through the service
--     role; an admin who could UPDATE notified_at could silence an alert by
--     hand, so the table is read only for authenticated.
-- ===========================================================================
\echo '--- grants: an authenticated admin reads but cannot write ---'
DO $aph_admin_fixture$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') THEN
    INSERT INTO auth.users (id, email)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'health-admin@example.invalid');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND role = 'admin'
  ) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');
  END IF;
END $aph_admin_fixture$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false);

DO $aph_admin_grants$
DECLARE
  v_count integer;
BEGIN
  -- Positive control: the admin sees the rows.
  SELECT count(*) INTO v_count FROM public.ai_provider_health;
  IF v_count < 1 THEN
    RAISE EXCEPTION 'FAIL: an authenticated admin sees % health rows, expected at least 1', v_count;
  END IF;

  -- The write is refused: no UPDATE grant for authenticated.
  BEGIN
    UPDATE public.ai_provider_health SET notified_at = now();
    RAISE EXCEPTION 'FAIL: an authenticated admin UPDATE of notified_at was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: the table is read only for authenticated
  END;

  BEGIN
    DELETE FROM public.ai_provider_health;
    RAISE EXCEPTION 'FAIL: an authenticated admin DELETE of ai_provider_health was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
END $aph_admin_grants$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- Run identity, logical admission, pending recovery and write fencing regressions.
-- Each block rolls its fixtures back independently of the earlier transition cases.
BEGIN;
DELETE FROM public.ai_provider_health_runs;
DO $aph_run_guards$
DECLARE
  v_daily uuid := gen_random_uuid(); v_manual uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid(); v_next uuid := gen_random_uuid();
BEGIN
  IF public.admit_ai_provider_health_run('daily', v_daily, NULL) IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'FAIL: daily admission'; END IF;
  IF public.admit_ai_provider_health_run('manual', v_manual, v_admin) IS DISTINCT FROM 'busy' THEN RAISE EXCEPTION 'FAIL: manual entered between daily chunks'; END IF;
  PERFORM public.complete_ai_provider_health_run(v_daily);
  IF public.admit_ai_provider_health_run('daily', v_daily, NULL) IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'FAIL: completed daily replay'; END IF;
  IF public.admit_ai_provider_health_run('manual', v_manual, v_admin) IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'FAIL: manual admission after daily'; END IF;
  IF public.admit_ai_provider_health_run('manual', v_manual, v_admin) IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'FAIL: manual chunk continuation'; END IF;
  IF public.admit_ai_provider_health_run('daily', gen_random_uuid(), NULL) IS DISTINCT FROM 'busy' THEN
    RAISE EXCEPTION 'FAIL: daily entered between manual chunks';
  END IF;
  UPDATE public.ai_provider_health_runs SET expires_at = now() - interval '1 second' WHERE run_id = v_manual;
  IF public.admit_ai_provider_health_run('daily', gen_random_uuid(), NULL) IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'FAIL: daily could not replace expired manual';
  END IF;
  IF public.admit_ai_provider_health_run('manual', v_manual, v_admin) IS DISTINCT FROM 'busy' THEN
    RAISE EXCEPTION 'FAIL: expired manual resumed over active daily';
  END IF;
  UPDATE public.ai_provider_health_runs SET completed_at = now() WHERE scope = 'daily';
  PERFORM public.complete_ai_provider_health_run(v_manual);
  IF public.admit_ai_provider_health_run('manual', v_next, v_admin) IS DISTINCT FROM 'cooldown' THEN RAISE EXCEPTION 'FAIL: missing per-admin cooldown'; END IF;
  UPDATE public.ai_provider_health_runs SET completed_at = now() - interval '61 seconds' WHERE run_id = v_manual;
  IF public.admit_ai_provider_health_run('manual', v_next, v_admin) IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'FAIL: cooldown never expired'; END IF;
  PERFORM public.record_ai_provider_health('claude','api_key','connected',NULL,0,0,0,1,v_daily);
  PERFORM public.record_ai_provider_health('claude','api_key','connected',NULL,0,0,0,1,v_manual);
  IF NOT EXISTS (SELECT 1 FROM public.ai_provider_health_completions WHERE run_id = v_daily AND provider_code = 'claude') THEN
    RAISE EXCEPTION 'FAIL: manual overwrote daily completion';
  END IF;
END $aph_run_guards$;
ROLLBACK;

BEGIN;
DELETE FROM public.ai_provider_health_alerts WHERE provider_code = 'openai';
UPDATE public.ai_provider_health SET alert_pending = false WHERE provider_code = 'openai';
DO $aph_recovery_outbox$
DECLARE v_first uuid; v_count int; v_claim record; v_token uuid := gen_random_uuid();
BEGIN
  PERFORM public.record_ai_provider_health('openai','api_key','connected',NULL,0,0,0,1,NULL);
  PERFORM public.record_ai_provider_health('openai','api_key','failed','Original failure',NULL,NULL,NULL,1,NULL);
  SELECT alert_id INTO v_first FROM public.ai_provider_health WHERE provider_code = 'openai' AND auth_method = 'api_key';
  PERFORM public.record_ai_provider_health('openai','api_key','connected',NULL,0,0,0,1,NULL);
  SELECT * INTO v_claim FROM public.claim_ai_provider_health_notifications(v_token) WHERE alert_id = v_first;
  IF v_claim.previous_status IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'FAIL: recovery changed original previous status';
  END IF;
  SELECT count(*) INTO v_count FROM public.ai_provider_health_alerts WHERE alert_id = v_first AND claim_token = v_token;
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL: recovery erased unsent degradation'; END IF;
  PERFORM public.record_ai_provider_health('openai','api_key','failed','Second failure',NULL,NULL,NULL,1,NULL);
  -- First send closes only its event; the second break remains pending.
  PERFORM public.mark_ai_provider_health_notified(v_token,'openai','api_key',v_first);
  SELECT * INTO v_claim FROM public.claim_ai_provider_health_notifications(gen_random_uuid()) WHERE provider_code = 'openai';
  IF v_claim.alert_id IS NULL OR v_claim.alert_id = v_first OR v_claim.reason IS DISTINCT FROM 'Second failure' THEN
    RAISE EXCEPTION 'FAIL: a later break was lost or an event payload changed';
  END IF;
END $aph_recovery_outbox$;
ROLLBACK;

BEGIN;
DELETE FROM public.cron_run_leases WHERE job = 'ai-provider-health';
DO $aph_fencing$
DECLARE v_holder uuid := gen_random_uuid(); v_stamp text := 'health-fence-fixture';
BEGIN
  BEGIN
    PERFORM public.write_ai_health_catalog(v_holder,'[]'::jsonb,v_stamp,now());
    RAISE EXCEPTION 'FAIL: unowned catalogue write accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Health catalogue lease expired%' THEN RAISE; END IF;
  END;
  PERFORM public.acquire_cron_run_lease('ai-provider-health',v_holder,interval '2 minutes');
  PERFORM public.write_ai_health_catalog(v_holder,'[]'::jsonb,v_stamp,now());
  IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = v_stamp) THEN RAISE EXCEPTION 'FAIL: owned catalogue write refused'; END IF;
  UPDATE public.cron_run_leases SET expires_at = now() - interval '1 second' WHERE job = 'ai-provider-health';
  BEGIN
    PERFORM public.write_ai_health_catalog(v_holder,'[]'::jsonb,v_stamp,now());
    RAISE EXCEPTION 'FAIL: stale catalogue holder accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Health catalogue lease expired%' THEN RAISE; END IF;
  END;
END $aph_fencing$;
ROLLBACK;

-- The transaction cannot leave the first valid model visible when a later row
-- fails, and the timestamp must not advance for the rolled-back catalogue.
BEGIN;
DELETE FROM public.cron_run_leases WHERE job = 'ai-provider-health';
DO $aph_atomic_catalogue$
DECLARE v_holder uuid := gen_random_uuid(); v_provider uuid; v_rows jsonb;
BEGIN
  SELECT id INTO STRICT v_provider FROM public.ai_providers WHERE provider_code = 'openai';
  PERFORM public.acquire_cron_run_lease('ai-provider-health', v_holder, interval '2 minutes');
  v_rows := jsonb_build_array(
    jsonb_build_object('provider_id',v_provider,'model_id','r4-atomic-first','name','First',
      'auth_method','api_key','capabilities',jsonb_build_array('chat'),'is_active',true,'updated_at',now()),
    jsonb_build_object('provider_id',v_provider,'model_id','r4-atomic-invalid','name',NULL,
      'auth_method','api_key','capabilities',jsonb_build_array('chat'),'is_active',true,'updated_at',now()));
  BEGIN
    PERFORM public.write_ai_health_catalog(v_holder,v_rows,'r4-atomic-stamp',clock_timestamp());
    RAISE EXCEPTION 'FAIL: invalid catalogue transaction succeeded';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.ai_models WHERE model_id = 'r4-atomic-first') OR
     EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'r4-atomic-stamp') THEN
    RAISE EXCEPTION 'FAIL: a partial catalogue transaction became visible';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider_code = 'firecrawl') OR
     NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider_code = 'apify') THEN
    RAISE EXCEPTION 'FAIL: standalone service FK identities missing';
  END IF;
END $aph_atomic_catalogue$;
ROLLBACK;

-- Trailing cleanup: everything this suite created, EXCEPT the provider rows
-- that already existed before it ran.
-- ---------------------------------------------------------------------------
DELETE FROM public.ai_provider_health_alerts WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_provider_health_completions WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_provider_health WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_models WHERE model_id = 'health-fixture-model';

DELETE FROM public.user_roles WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DELETE FROM auth.users WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

DELETE FROM public.ai_providers
 WHERE provider_code IN (SELECT provider_code FROM aph_created_providers);

DROP TABLE aph_created_providers;

\echo '=== ai_provider_health: ALL CHECKS PASSED ==='
