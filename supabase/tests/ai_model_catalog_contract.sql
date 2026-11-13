-- ============================================================================
-- ai_model_catalog_contract.sql
--
-- Proof for the two halves of the ai_models catalogue rollout:
--
--   20261113180000_ai_provider_health.sql                 (EXPAND)
--     adds ai_models.auth_method and the unique index
--     (provider_id, model_id, auth_method); it KEEPS the old two-column
--     unique constraint ai_models_provider_id_model_id_key.
--
--   20261113180100_ai_model_catalog_drop_legacy_unique.sql (CONTRACT)
--     drops the old two-column unique constraint.
--
-- WHY THE PROOF IS ABOUT THE CONTRACT
-- The catalogue write path upserts on (provider_id, model_id, auth_method) after
-- the feature and on (provider_id, model_id) before it. The code that is deployed
-- answers 42P10 ("there is no unique or exclusion constraint matching the ON
-- CONFLICT specification") when the constraint it names is gone. So the two
-- migrations have to land in order, and this suite proves that the state after
-- BOTH of them is the state the new code needs:
--
--   * the three-column unique index exists and is unique
--   * the old two-column constraint is gone
--   * the same (provider_id, model_id) may exist once per credential kind
--   * the same (provider_id, model_id, auth_method) may NOT exist twice
--
-- Run with psql AS A SUPERUSER against a THROWAWAY database with every
-- migration applied. NEVER against production: it writes rows.
--
--   psql "$HARNESS_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/ai_model_catalog_contract.sql
--
-- HOW IT PROVES THINGS
--   * Every expected refusal sits in its own BEGIN/EXCEPTION block, every failure
--     RAISES with a FAIL: prefix, and an accepted write that should have been
--     refused exits psql non-zero via ON_ERROR_STOP.
--   * Self-cleaning: the model rows this suite creates are removed before AND
--     after, and only the ones it created.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== ai_model_catalog_contract: start ==='

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after, so a crashed earlier run cannot wedge this one)
-- ---------------------------------------------------------------------------
DELETE FROM public.ai_models WHERE model_id = 'contract-fixture-model';

-- The provider row is a fixture. Only the one this suite creates is removed at
-- the end; a provider that already existed (production shape) is left as it was.
CREATE TEMP TABLE amc_created_providers (provider_code text PRIMARY KEY);

DO $amc_seed_provider$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider_code = 'claude') THEN
    INSERT INTO public.ai_providers
      (provider_code, name, api_endpoint, api_key_env_var, api_type,
       supports_streaming, is_active)
    VALUES
      ('claude', 'Anthropic API', 'https://api.anthropic.com/v1',
       'ANTHROPIC_API_KEY', 'anthropic', true, false);
    INSERT INTO amc_created_providers (provider_code) VALUES ('claude');
  END IF;
END $amc_seed_provider$;

-- ===========================================================================
-- 1. The three-column unique index exists and is unique. Without it the
--    catalogue could grow two identical rows.
-- ===========================================================================
\echo '--- index: (provider_id, model_id, auth_method) is unique ---'
DO $amc_index$
DECLARE
  v_unique boolean;
  v_columns text;
BEGIN
  SELECT i.indisunique,
         string_agg(a.attname, ',' ORDER BY a.attname)
    INTO v_unique, v_columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE c.relname = 'ai_models_provider_model_auth_method_key'
   GROUP BY i.indisunique;

  IF v_unique IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: ai_models_provider_model_auth_method_key is missing or is not unique';
  END IF;
  IF v_columns IS DISTINCT FROM 'auth_method,model_id,provider_id' THEN
    RAISE EXCEPTION 'FAIL: the unique index covers (%), expected (auth_method,model_id,provider_id)', v_columns;
  END IF;
END $amc_index$;

-- ===========================================================================
-- 2. The old two-column constraint is GONE. It is the constraint that blocked
--    the OAuth row of a model that already had an API-key row, and it is the
--    constraint the deployed code upserts on: while it is there, the new code
--    would fail with 42P10 if the new index were ever dropped.
-- ===========================================================================
\echo '--- constraint: the legacy two-column constraint is gone ---'
DO $amc_constraint$
DECLARE
  v_constraints integer;
BEGIN
  SELECT count(*) INTO v_constraints
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'ai_models'
     AND c.contype = 'u'
     AND c.conname = 'ai_models_provider_id_model_id_key';

  IF v_constraints <> 0 THEN
    RAISE EXCEPTION 'FAIL: the legacy constraint ai_models_provider_id_model_id_key still exists';
  END IF;
END $amc_constraint$;

-- ===========================================================================
-- 3. The same (provider_id, model_id) may exist once per credential kind.
--    This is what the whole catalogue split is for.
-- ===========================================================================
\echo '--- rows: one model_id may exist once per credential kind ---'
DO $amc_rows$
DECLARE
  v_provider_id uuid;
  v_rows integer;
  v_same_kind integer;
BEGIN
  SELECT id INTO v_provider_id
    FROM public.ai_providers WHERE provider_code = 'claude';
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: the claude provider fixture is missing';
  END IF;

  INSERT INTO public.ai_models
    (provider_id, model_id, name, capabilities, is_active, auth_method)
  VALUES
    (v_provider_id, 'contract-fixture-model', 'Contract fixture (api key)', '{chat}', true, 'api_key');

  INSERT INTO public.ai_models
    (provider_id, model_id, name, capabilities, is_active, auth_method)
  VALUES
    (v_provider_id, 'contract-fixture-model', 'Contract fixture (oauth)', '{chat}', true, 'oauth');

  SELECT count(*) INTO v_rows
    FROM public.ai_models
   WHERE provider_id = v_provider_id AND model_id = 'contract-fixture-model';
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: % rows share (provider_id, model_id), expected 2', v_rows;
  END IF;

  -- The same credential kind may NOT exist twice: the three-column index holds.
  BEGIN
    INSERT INTO public.ai_models
      (provider_id, model_id, name, capabilities, is_active, auth_method)
    VALUES
      (v_provider_id, 'contract-fixture-model', 'Contract fixture (duplicate)', '{chat}', true, 'api_key');
    RAISE EXCEPTION 'FAIL: a duplicate (provider_id, model_id, auth_method) was ACCEPTED';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected
  END;

  SELECT count(*) INTO v_same_kind
    FROM public.ai_models
   WHERE provider_id = v_provider_id
     AND model_id = 'contract-fixture-model'
     AND auth_method = 'api_key';
  IF v_same_kind <> 1 THEN
    RAISE EXCEPTION 'FAIL: % api_key rows for the fixture model, expected 1', v_same_kind;
  END IF;
END $amc_rows$;

-- ===========================================================================
-- 4. Every row has a credential kind. A row with no kind is an API-key row,
--    but the column itself is never empty.
-- ===========================================================================
\echo '--- rows: every catalogue row has a credential kind ---'
DO $amc_auth_method$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows FROM public.ai_models WHERE auth_method IS NULL;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: % ai_models rows have a NULL auth_method', v_rows;
  END IF;
END $amc_auth_method$;

-- ---------------------------------------------------------------------------
-- Cleanup (after)
-- ---------------------------------------------------------------------------
DELETE FROM public.ai_models WHERE model_id = 'contract-fixture-model';
DELETE FROM public.ai_providers
 WHERE provider_code IN (SELECT provider_code FROM amc_created_providers);

\echo '=== ai_model_catalog_contract: ALL CHECKS PASSED ==='
