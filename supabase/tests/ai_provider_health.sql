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
SET ROLE authenticated;
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
-- ===========================================================================
\echo '--- mark notified: the claim is closed ---'
DO $aph_mark$
DECLARE
  v_notified timestamptz;
  v_token uuid;
  v_rows integer;
BEGIN
  PERFORM public.mark_ai_provider_health_notified(
    '22222222-2222-2222-2222-222222222222'::uuid);

  SELECT notified_at, claim_token INTO v_notified, v_token
    FROM public.ai_provider_health
   WHERE provider_code = 'claude' AND auth_method = 'api_key';

  IF v_notified IS NULL THEN
    RAISE EXCEPTION 'FAIL: notified_at is NULL after mark_ai_provider_health_notified';
  END IF;
  IF v_token IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: claim_token is % after mark_ai_provider_health_notified, expected NULL', v_token;
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
  v_run_id := '13ed6566-d364-4712-8464-88a5cd647da0'::uuid;

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

-- ---------------------------------------------------------------------------
-- Trailing cleanup: everything this suite created, EXCEPT the provider rows
-- that already existed before it ran.
-- ---------------------------------------------------------------------------
DELETE FROM public.ai_provider_health WHERE provider_code IN ('claude', 'openai');
DELETE FROM public.ai_models WHERE model_id = 'health-fixture-model';

DELETE FROM public.ai_providers
 WHERE provider_code IN (SELECT provider_code FROM aph_created_providers);

DROP TABLE aph_created_providers;

\echo '=== ai_provider_health: ALL CHECKS PASSED ==='
