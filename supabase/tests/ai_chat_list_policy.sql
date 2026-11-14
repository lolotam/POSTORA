\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.chat_assert(ok boolean, description text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Chat assertion failed: %', description; END IF; END $$;
CREATE FUNCTION pg_temp.chat_direct_refused() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.system_settings(key,value) VALUES ('default_ai_model_chat','{"provider_code":"claude","model_id":"draft"}')
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;

SELECT pg_temp.chat_assert(NOT has_function_privilege('authenticated', 'public.write_ai_chat_tier(text,jsonb,jsonb)', 'EXECUTE'), 'no direct RPC for authenticated');
SELECT pg_temp.chat_assert(NOT has_function_privilege('anon', 'public.write_ai_chat_tier(text,jsonb,jsonb)', 'EXECUTE'), 'no anon RPC');
SELECT pg_temp.chat_assert(has_function_privilege('service_role', 'public.write_ai_chat_tier(text,jsonb,jsonb)', 'EXECUTE'), 'service RPC grant');
DELETE FROM public.system_settings WHERE key = ANY(ARRAY['default_ai_model_chat','default_ai_model_chat_fallback','default_ai_model_chat_fallback_2']);
INSERT INTO auth.users(id,email) VALUES ('41111111-1111-4111-8111-111111111111','chat-policy@example.invalid');
INSERT INTO public.user_roles(user_id,role) VALUES ('41111111-1111-4111-8111-111111111111','admin') ON CONFLICT DO NOTHING;
SELECT set_config('request.jwt.claim.sub','41111111-1111-4111-8111-111111111111',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
UPDATE public.system_settings SET value = 'false'::jsonb WHERE key='feature_ai_text_auth_lists';
SET LOCAL ROLE authenticated;
SELECT pg_temp.chat_assert(NOT pg_temp.chat_direct_refused(), 'legacy admin writer works while flag off');
RESET ROLE;
UPDATE public.system_settings SET value = 'true'::jsonb WHERE key='feature_ai_text_auth_lists';
SET LOCAL ROLE authenticated;
SELECT pg_temp.chat_assert(pg_temp.chat_direct_refused(), 'flag on blocks direct admin write');
RESET ROLE;
DELETE FROM public.system_settings WHERE key='default_ai_model_chat';
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
SELECT pg_temp.chat_assert(public.write_ai_chat_tier('default_ai_model_chat','{"provider_code":"claude","model_id":"same","auth_method":"oauth"}','{}'), 'Auth save');
SELECT pg_temp.chat_assert(NOT public.write_ai_chat_tier('default_ai_model_chat','{"provider_code":"claude","model_id":"stale"}','{}'), 'stale snapshot refused');
SELECT pg_temp.chat_assert(public.write_ai_chat_tier('default_ai_model_chat','{"provider_code":"claude","model_id":"same"}', '{"default_ai_model_chat":{"provider_code":"claude","model_id":"same","auth_method":"oauth"}}'), 'API replaces Auth without discriminator');
SELECT pg_temp.chat_assert((SELECT value FROM public.system_settings WHERE key='default_ai_model_chat') = '{"provider_code":"claude","model_id":"same"}'::jsonb, 'old API shape retained');
DO $$ BEGIN
  BEGIN
    PERFORM public.write_ai_chat_tier('default_ai_model_chat_fallback_2','{"provider_code":"claude","model_id":"same"}', '{"default_ai_model_chat":{"provider_code":"claude","model_id":"same"}}');
    RAISE EXCEPTION 'Expected chain refusal';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Invalid Chat chain' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
\echo 'ai_chat_list_policy: ALL CHECKS PASSED'
