-- Disposable harness only: execute the actual maintenance script against the
-- migrated schema, including both retirement branches and an overlapping OAuth row.
\set ON_ERROR_STOP on
CREATE TEMP TABLE refresh_before AS SELECT * FROM public.ai_models;
CREATE TEMP TABLE refresh_providers AS SELECT * FROM public.ai_providers;
INSERT INTO public.ai_providers(provider_code,name,api_endpoint,api_key_env_var)
 VALUES('xai','xAI','https://api.x.ai/v1','XAI_API_KEY') ON CONFLICT DO NOTHING;
INSERT INTO public.ai_models(provider_id,model_id,name,auth_method,is_active)
 SELECT id,'grok-2','OAuth retired-name fixture','oauth',true FROM public.ai_providers WHERE provider_code='xai'
 ON CONFLICT(provider_id,model_id,auth_method) DO UPDATE SET is_active=true;
DO $$ BEGIN
 IF to_regclass('public.default_models') IS NOT NULL THEN
   ALTER TABLE public.default_models RENAME TO refresh_saved_defaults;
 END IF;
END $$;
\ir ../manual-sql/20260625_refresh_ai_catalog.sql
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.ai_models WHERE model_id='grok-2' AND auth_method='oauth' AND is_active) THEN
   RAISE EXCEPTION 'FAIL: no-defaults retirement changed OAuth catalogue';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.ai_models m JOIN public.ai_providers p ON p.id=m.provider_id
   WHERE p.provider_code='xai' AND m.model_id='grok-image-3' AND m.auth_method='api_key') THEN
   RAISE EXCEPTION 'FAIL: xAI image insert did not supply auth_method';
 END IF;
END $$;
CREATE TABLE public.default_models(model_id text);
\ir ../manual-sql/20260625_refresh_ai_catalog.sql
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.ai_models WHERE model_id='grok-2' AND auth_method='oauth' AND is_active) THEN
   RAISE EXCEPTION 'FAIL: defaults retirement changed OAuth catalogue';
 END IF;
END $$;
DROP TABLE public.default_models;
DO $$ BEGIN
 IF to_regclass('public.refresh_saved_defaults') IS NOT NULL THEN
   ALTER TABLE public.refresh_saved_defaults RENAME TO default_models;
 END IF;
END $$;
DELETE FROM public.ai_models m WHERE NOT EXISTS (SELECT 1 FROM refresh_before b WHERE b.id=m.id);
UPDATE public.ai_models m SET is_active=b.is_active FROM refresh_before b WHERE m.id=b.id;
DELETE FROM public.ai_providers p WHERE NOT EXISTS (SELECT 1 FROM refresh_providers b WHERE b.id=p.id);
\echo '=== ai_model_catalog_refresh: ALL CHECKS PASSED ==='
