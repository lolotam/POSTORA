\set ON_ERROR_STOP on
\echo '=== ai_model_catalog_expand: start ==='

DELETE FROM public.ai_models WHERE model_id = 'expand-fixture-model';
CREATE TEMP TABLE ame_created_providers (provider_code text PRIMARY KEY);

DO $ame_seed_provider$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider_code = 'claude') THEN
    INSERT INTO public.ai_providers
      (provider_code, name, api_endpoint, api_key_env_var, api_type,
       supports_streaming, is_active)
    VALUES
      ('claude', 'Anthropic API', 'https://api.anthropic.com/v1',
       'ANTHROPIC_API_KEY', 'anthropic', true, false);
    INSERT INTO ame_created_providers (provider_code) VALUES ('claude');
  END IF;
END $ame_seed_provider$;

DO $ame_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'ai_models'
       AND c.contype = 'u'
       AND c.conname = 'ai_models_provider_id_model_id_key'
  ) THEN
    RAISE EXCEPTION 'FAIL: EXPAND dropped the legacy two-column constraint';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'ai_models_provider_model_auth_method_key'
       AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'FAIL: EXPAND did not create the three-column unique index';
  END IF;
END $ame_constraints$;

DO $ame_old_writer$
DECLARE
  v_provider_id uuid;
  v_name text;
BEGIN
  SELECT id INTO v_provider_id FROM public.ai_providers WHERE provider_code = 'claude';

  INSERT INTO public.ai_models
    (provider_id, model_id, name, capabilities, is_active)
  VALUES
    (v_provider_id, 'expand-fixture-model', 'Old writer', '{chat}', true)
  ON CONFLICT (provider_id, model_id) DO UPDATE SET name = EXCLUDED.name;

  UPDATE public.ai_models SET name = 'Old writer retry'
   WHERE provider_id = v_provider_id AND model_id = 'expand-fixture-model';

  INSERT INTO public.ai_models
    (provider_id, model_id, name, capabilities, is_active)
  VALUES
    (v_provider_id, 'expand-fixture-model', 'Old writer upsert', '{chat}', true)
  ON CONFLICT (provider_id, model_id) DO UPDATE SET name = EXCLUDED.name;

  SELECT name INTO v_name
    FROM public.ai_models
   WHERE provider_id = v_provider_id AND model_id = 'expand-fixture-model';
  IF v_name IS DISTINCT FROM 'Old writer upsert' THEN
    RAISE EXCEPTION 'FAIL: the deployed two-column upsert did not update the row';
  END IF;
END $ame_old_writer$;

DELETE FROM public.ai_models WHERE model_id = 'expand-fixture-model';
DELETE FROM public.ai_providers
 WHERE provider_code IN (SELECT provider_code FROM ame_created_providers);

\echo '=== ai_model_catalog_expand: ALL CHECKS PASSED ==='
