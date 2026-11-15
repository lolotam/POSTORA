\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.override_assert(ok boolean, description text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Override assertion failed: %', description; END IF; END $$;
SELECT pg_temp.override_assert(NOT has_function_privilege('authenticated','public.write_ai_model_override(uuid,jsonb,jsonb,uuid)','EXECUTE'),'browser cannot call writer');
SELECT pg_temp.override_assert(NOT has_function_privilege('anon','public.write_ai_model_override(uuid,jsonb,jsonb,uuid)','EXECUTE'),'anon cannot call writer');
SELECT pg_temp.override_assert(has_function_privilege('service_role','public.write_ai_model_override(uuid,jsonb,jsonb,uuid)','EXECUTE'),'service can call writer');
INSERT INTO auth.users(id,email) VALUES('55555555-5555-4555-8555-555555555551','override-admin@example.invalid'),
('55555555-5555-4555-8555-555555555552','override-user@example.invalid');
INSERT INTO public.user_roles(user_id,role) VALUES('55555555-5555-4555-8555-555555555551','admin') ON CONFLICT DO NOTHING;
UPDATE public.system_settings SET value='true'::jsonb WHERE key IN ('feature_ai_text_auth_lists','feature_ai_provider_oauth');
INSERT INTO public.ai_providers(provider_code,name,api_endpoint,api_key_env_var,api_type,is_active)
VALUES('phase5_fixture','Phase 5','https://example.invalid','TEST_FIXTURE','openai',true);
INSERT INTO public.ai_models(provider_id,model_id,name,capabilities,is_active,auth_method)
SELECT id,'api-model','API',ARRAY['chat'],true,'api_key' FROM public.ai_providers WHERE provider_code='phase5_fixture';
INSERT INTO public.ai_providers(provider_code,name,api_endpoint,api_key_env_var,api_type,is_active)
VALUES('openrouter','OpenRouter','https://example.invalid','TEST_FIXTURE','openai',true)
ON CONFLICT(provider_code) DO UPDATE SET is_active=true;
INSERT INTO public.ai_provider_oauth_connections(oauth_provider,provider_code,status)
VALUES('openrouter','openrouter','connected') ON CONFLICT(oauth_provider) DO UPDATE SET status='connected';

-- Real legacy insertion: no auth column or marker supplied.
INSERT INTO public.user_ai_model_overrides(user_id,provider,model)
VALUES('55555555-5555-4555-8555-555555555552','phase5_fixture','api-model');
SELECT pg_temp.override_assert((SELECT auth_method='api_key' FROM public.user_ai_model_overrides WHERE user_id='55555555-5555-4555-8555-555555555552'),'legacy defaults API');
SELECT set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555552',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    INSERT INTO public.user_ai_model_overrides(user_id,provider,model,auth_method)
    VALUES('55555555-5555-4555-8555-555555555552','openrouter','same-model','oauth');
    RAISE EXCEPTION 'Expected direct non-admin denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.write_ai_model_override('55555555-5555-4555-8555-555555555552',NULL,NULL,'55555555-5555-4555-8555-555555555551');
    RAISE EXCEPTION 'Expected browser RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
SELECT pg_temp.override_assert(public.write_ai_model_override('55555555-5555-4555-8555-555555555552',
  '{"provider_code":"openrouter","model_id":"same-model","auth_method":"oauth"}',
  (SELECT to_jsonb(o) FROM public.user_ai_model_overrides o WHERE user_id='55555555-5555-4555-8555-555555555552'),
  '55555555-5555-4555-8555-555555555551'),'auth aware round trip');
SELECT pg_temp.override_assert((SELECT auth_method='oauth' FROM public.user_ai_model_overrides WHERE user_id='55555555-5555-4555-8555-555555555552'),'OAuth persisted');
SELECT pg_temp.override_assert(NOT public.write_ai_model_override('55555555-5555-4555-8555-555555555552',NULL,NULL,'55555555-5555-4555-8555-555555555551'),'stale CAS refused');

-- Same transaction after writer: marker must be restored, not leak to legacy.
INSERT INTO public.user_ai_model_overrides(user_id,provider,model)
VALUES('55555555-5555-4555-8555-555555555552','openrouter','same-model')
ON CONFLICT(user_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model;
SELECT pg_temp.override_assert((SELECT auth_method='api_key' FROM public.user_ai_model_overrides WHERE user_id='55555555-5555-4555-8555-555555555552'),'same-model legacy upsert resets API');
SELECT public.write_ai_model_override('55555555-5555-4555-8555-555555555552','{"provider_code":"openrouter","model_id":"same-model","auth_method":"oauth"}',
  (SELECT to_jsonb(o) FROM public.user_ai_model_overrides o WHERE user_id='55555555-5555-4555-8555-555555555552'),'55555555-5555-4555-8555-555555555551');
INSERT INTO public.user_ai_model_overrides(user_id,provider,model)
VALUES('55555555-5555-4555-8555-555555555552','phase5_fixture','api-model')
ON CONFLICT(user_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model;
SELECT pg_temp.override_assert((SELECT auth_method='api_key' AND provider='phase5_fixture' FROM public.user_ai_model_overrides WHERE user_id='55555555-5555-4555-8555-555555555552'),'A to B legacy upsert resets API');
-- Even an explicit unmarked OAuth update must be API.
UPDATE public.user_ai_model_overrides SET auth_method='oauth' WHERE user_id='55555555-5555-4555-8555-555555555552';
SELECT pg_temp.override_assert((SELECT auth_method='api_key' FROM public.user_ai_model_overrides WHERE user_id='55555555-5555-4555-8555-555555555552'),'direct service write cannot select OAuth');
DO $$ DECLARE bad jsonb; BEGIN
  FOREACH bad IN ARRAY ARRAY['"typo"'::jsonb,'null'::jsonb,'42'::jsonb] LOOP
    BEGIN
      PERFORM public.write_ai_model_override('55555555-5555-4555-8555-555555555552',
        jsonb_build_object('provider_code','phase5_fixture','model_id','api-model','auth_method',bad),
        (SELECT to_jsonb(o) FROM public.user_ai_model_overrides o WHERE user_id='55555555-5555-4555-8555-555555555552'),'55555555-5555-4555-8555-555555555551');
      RAISE EXCEPTION 'Expected strict discriminator denial';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Invalid override selection' THEN RAISE; END IF; END;
  END LOOP;
END $$;
SELECT pg_temp.override_assert(public.write_ai_model_override('55555555-5555-4555-8555-555555555552',NULL,
  (SELECT to_jsonb(o) FROM public.user_ai_model_overrides o WHERE user_id='55555555-5555-4555-8555-555555555552'),'55555555-5555-4555-8555-555555555551'),'CAS delete');
RESET ROLE;
ROLLBACK;
\echo 'ai_text_override_auth: ALL CHECKS PASSED'
