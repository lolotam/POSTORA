\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.triage_assert(ok boolean, description text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Triage assertion failed: %', description; END IF; END $$;
CREATE FUNCTION pg_temp.triage_direct_refused() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.system_settings(key,value) VALUES('default_ai_model_agent_triage','{"provider_code":"openrouter","model_id":"typesafe/jev-1.13"}')
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
SELECT pg_temp.triage_assert(NOT has_function_privilege('authenticated','public.write_ai_triage_tier(text,jsonb,jsonb)','EXECUTE'),'no browser RPC');
SELECT pg_temp.triage_assert(NOT has_function_privilege('anon','public.write_ai_triage_tier(text,jsonb,jsonb)','EXECUTE'),'no anon RPC');
SELECT pg_temp.triage_assert(has_function_privilege('service_role','public.write_ai_triage_tier(text,jsonb,jsonb)','EXECUTE'),'service RPC grant');
DELETE FROM public.system_settings WHERE key LIKE 'default_ai_model_agent_triage%';
INSERT INTO auth.users(id,email) VALUES('43333333-3333-4333-8333-333333333333','triage-policy@example.invalid');
INSERT INTO public.user_roles(user_id,role) VALUES('43333333-3333-4333-8333-333333333333','admin') ON CONFLICT DO NOTHING;
SELECT set_config('request.jwt.claim.sub','43333333-3333-4333-8333-333333333333',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
UPDATE public.system_settings SET value='false'::jsonb WHERE key='feature_ai_text_auth_lists';
SET LOCAL ROLE authenticated;
SELECT pg_temp.triage_assert(NOT pg_temp.triage_direct_refused(),'legacy writer works with flag off');
RESET ROLE;
UPDATE public.system_settings SET value='true'::jsonb WHERE key='feature_ai_text_auth_lists';
SET LOCAL ROLE authenticated;
SELECT pg_temp.triage_assert(pg_temp.triage_direct_refused(),'enabled policy blocks direct admin writes');
RESET ROLE;
DELETE FROM public.system_settings WHERE key='default_ai_model_agent_triage';
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
SELECT pg_temp.triage_assert(public.write_ai_triage_tier('default_ai_model_agent_triage','{"provider_code":"claude","model_id":"same","auth_method":"oauth"}','{}'),'Claude-only Auth supports cap');
SELECT pg_temp.triage_assert(NOT public.write_ai_triage_tier('default_ai_model_agent_triage','{"provider_code":"claude","model_id":"stale","auth_method":"oauth"}','{}'),'whole-chain CAS rejects stale expectation');
DO $$ BEGIN
  BEGIN
    PERFORM public.write_ai_triage_tier('default_ai_model_agent_triage','{"provider_code":"openai","model_id":"codex","auth_method":"oauth"}',
      '{"default_ai_model_agent_triage":{"provider_code":"claude","model_id":"same","auth_method":"oauth"}}');
    RAISE EXCEPTION 'Expected cap refusal';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'oauth_max_tokens_unsupported' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.write_ai_triage_tier('default_ai_model_agent_triage_fallback_2','{"provider_code":"openrouter","model_id":"typesafe/jev-1.13"}',
      '{"default_ai_model_agent_triage":{"provider_code":"claude","model_id":"same","auth_method":"oauth"}}');
    RAISE EXCEPTION 'Expected chain refusal';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Invalid Triage chain' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
UPDATE public.system_settings SET value=to_jsonb('{"provider_code":"claude","model_id":"same","auth_method":"oauth","extension":{"kept":true}}'::text) WHERE key='default_ai_model_agent_triage';
SET LOCAL ROLE service_role;
SELECT pg_temp.triage_assert(public.write_ai_triage_tier('default_ai_model_agent_triage_fallback','{"provider_code":"openrouter","model_id":"typesafe/jev-1.13"}',
  (SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key LIKE 'default_ai_model_agent_triage%')),'legacy string sibling accepted');
SELECT pg_temp.triage_assert(jsonb_typeof((SELECT value FROM public.system_settings WHERE key='default_ai_model_agent_triage'))='string','raw sibling and extension retained');
SELECT pg_temp.triage_assert((SELECT value FROM public.system_settings WHERE key='default_ai_model_agent_triage_fallback')='{"provider_code":"openrouter","model_id":"typesafe/jev-1.13"}'::jsonb,'API two-key shape');
SELECT pg_temp.triage_assert(NOT public.write_ai_triage_tier('default_ai_model_agent_triage_fallback','{"provider_code":"openrouter","model_id":"changed"}',
  jsonb_build_object('default_ai_model_agent_triage',(SELECT value FROM public.system_settings WHERE key='default_ai_model_agent_triage'))),'sibling insertion invalidates whole-chain expectation');
ROLLBACK;
\echo 'ai_triage_list_policy: ALL CHECKS PASSED'
