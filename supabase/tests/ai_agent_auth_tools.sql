\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.agent_assert(ok boolean, description text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Agent assertion failed: %', description; END IF; END $$;
SELECT pg_temp.agent_assert(NOT has_function_privilege('authenticated','public.write_ai_agent_tier(text,jsonb,jsonb)','EXECUTE'),'no browser RPC');
SELECT pg_temp.agent_assert(NOT has_function_privilege('anon','public.write_ai_agent_tier(text,jsonb,jsonb)','EXECUTE'),'no anon RPC');
SELECT pg_temp.agent_assert(has_function_privilege('service_role','public.write_ai_agent_tier(text,jsonb,jsonb)','EXECUTE'),'service RPC');
DELETE FROM public.system_settings WHERE key IN ('default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2');
UPDATE public.system_settings SET value='true'::jsonb WHERE key IN ('feature_ai_text_auth_lists','feature_ai_provider_oauth','feature_ai_oauth_tools_claude');
INSERT INTO public.ai_providers(id,provider_code,name,api_endpoint,api_key_env_var,api_type,is_active)
VALUES('44444444-4444-4444-8444-444444444444','phase4_fixture','Phase 4','https://example.invalid','TEST_FIXTURE','openai',true);
INSERT INTO public.ai_models(provider_id,model_id,name,capabilities,is_active,auth_method)
VALUES('44444444-4444-4444-8444-444444444444','tool-model','Tool model',ARRAY['chat','tools'],true,'api_key');
INSERT INTO auth.users(id,email) VALUES('44444444-4444-4444-8444-444444444445','agent-policy@example.invalid');
INSERT INTO public.user_roles(user_id,role) VALUES('44444444-4444-4444-8444-444444444445','admin') ON CONFLICT DO NOTHING;
SELECT set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444445',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    INSERT INTO public.system_settings(key,value) VALUES('default_ai_model_agent','{}');
    RAISE EXCEPTION 'Expected direct write refusal';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
DO $$ BEGIN
  BEGIN
    PERFORM public.write_ai_agent_tier('default_ai_model_agent','{"provider_code":"claude","model_id":"claude-sonnet-4-5","auth_method":"oauth"}','{}');
    RAISE EXCEPTION 'Expected all Auth refusal';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'oauth_api_fallback_required' THEN RAISE; END IF; END;
END $$;
SELECT pg_temp.agent_assert(public.write_ai_agent_tier('default_ai_model_agent','{"provider_code":"phase4_fixture","model_id":"tool-model"}','{}'),'seed chosen API primary');
SELECT pg_temp.agent_assert(public.write_ai_agent_tier('default_ai_model_agent_fallback','{"provider_code":"phase4_fixture","model_id":"tool-model"}',
  (SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key IN ('default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2'))),'choose later API');
SELECT pg_temp.agent_assert(public.write_ai_agent_tier('default_ai_model_agent','{"provider_code":"claude","model_id":"claude-sonnet-4-5","auth_method":"oauth"}',
  (SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key IN ('default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2'))),'Auth with chosen later API');
SELECT pg_temp.agent_assert(NOT public.write_ai_agent_tier('default_ai_model_agent','{"provider_code":"phase4_fixture","model_id":"tool-model"}','{}'),'stale whole-chain CAS');
DO $$ BEGIN
  BEGIN
    PERFORM public.write_ai_agent_tier('default_ai_model_agent_fallback','{"provider_code":"claude","model_id":"claude-sonnet-4-5","auth_method":"oauth"}',
      (SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key IN ('default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2')));
    RAISE EXCEPTION 'Expected final Auth refusal';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'oauth_api_fallback_required' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
UPDATE public.system_settings SET value='false'::jsonb WHERE key='feature_ai_oauth_tools_claude';
SET LOCAL ROLE service_role;
SELECT pg_temp.agent_assert(public.write_ai_agent_tier('default_ai_model_agent_fallback','{"provider_code":"phase4_fixture","model_id":"tool-model"}',
  (SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key IN ('default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2'))),'API recovery can be repaired with Claude tool flag off');
RESET ROLE;
UPDATE public.system_settings SET value='true'::jsonb WHERE key='feature_ai_oauth_tools_claude';
UPDATE public.ai_models SET is_active=false WHERE model_id='tool-model' AND provider_id='44444444-4444-4444-8444-444444444444';
SET LOCAL ROLE service_role;
DO $$ BEGIN
  BEGIN
    PERFORM public.write_ai_agent_tier('default_ai_model_agent','{"provider_code":"claude","model_id":"claude-sonnet-4-5","auth_method":"oauth"}',
      (SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key IN ('default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2')));
    RAISE EXCEPTION 'Expected inactive recovery refusal';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'oauth_api_fallback_required' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
\echo 'ai_agent_auth_tools: ALL CHECKS PASSED'
