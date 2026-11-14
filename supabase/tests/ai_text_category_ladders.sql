\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET search_path = public, extensions;
BEGIN;
CREATE FUNCTION pg_temp.text_assert(ok boolean, description text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Text ladder assertion failed: %', description; END IF; END $$;
SELECT pg_temp.text_assert(NOT has_function_privilege('authenticated','public.write_ai_text_ladder(text,jsonb,jsonb,jsonb)','EXECUTE'),'browser RPC denied');
SELECT pg_temp.text_assert(NOT has_function_privilege('anon','public.write_ai_text_ladder(text,jsonb,jsonb,jsonb)','EXECUTE'),'anon RPC denied');
SELECT pg_temp.text_assert(has_function_privilege('service_role','public.write_ai_text_ladder(text,jsonb,jsonb,jsonb)','EXECUTE'),'service RPC granted');
UPDATE public.system_settings SET value = 'true' WHERE key IN ('feature_ai_text_auth_lists','feature_ai_category_text_ladders');
DELETE FROM public.system_settings WHERE key LIKE 'default_ai_model_caption%' OR key LIKE 'default_ai_model_hashtags%';
SELECT pg_temp.text_assert(public.write_ai_text_ladder('hashtags','{"default_ai_model_hashtags":{"provider_code":"claude","model_id":"same","auth_method":"oauth","extension":true}}','{}','{}'),'create primary');
SELECT pg_temp.text_assert(NOT public.write_ai_text_ladder('hashtags','{}','{}','{}'),'stale snapshot refused');
DO $$ BEGIN
 BEGIN
  PERFORM public.write_ai_text_ladder('caption','{"default_ai_model_caption_fallback":{"provider_code":"claude","model_id":"orphan"}}','{}','{}');
  RAISE EXCEPTION 'Expected primary refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Text Primary required' THEN RAISE; END IF; END;
END $$;
INSERT INTO auth.users(id,email) VALUES ('42222222-2222-4222-8222-222222222222','text-policy@example.invalid');
INSERT INTO public.user_roles(user_id,role) VALUES ('42222222-2222-4222-8222-222222222222','admin') ON CONFLICT DO NOTHING;
SELECT set_config('request.jwt.claim.sub','42222222-2222-4222-8222-222222222222',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  INSERT INTO public.system_settings(key,value) VALUES ('default_ai_model_caption','{"provider_code":"claude","model_id":"bypass"}');
  RAISE EXCEPTION 'Expected direct admin denial';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;

-- Both sessions observe the same primary. The winner holds the category lock
-- until commit; the contender must then reject its stale whole-chain CAS.
UPDATE public.system_settings SET value = 'true' WHERE key IN ('feature_ai_text_auth_lists','feature_ai_category_text_ladders');
DELETE FROM public.system_settings WHERE key LIKE 'default_ai_model_caption%';
INSERT INTO public.system_settings(key,value) VALUES ('default_ai_model_caption','{"provider_code":"claude","model_id":"same"}');
CREATE FUNCTION public.test_phase2_mutation(reset_chain boolean) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE won boolean; BEGIN
 won := public.write_ai_text_ladder('caption', CASE WHEN reset_chain THEN '{}'::jsonb ELSE
 '{"default_ai_model_caption":{"provider_code":"claude","model_id":"same"},"default_ai_model_caption_fallback":{"provider_code":"claude","model_id":"fallback"}}'::jsonb END,
 '{"default_ai_model_caption":{"provider_code":"claude","model_id":"same"}}',
 COALESCE((SELECT jsonb_object_agg(key,value) FROM public.system_settings WHERE key IN ('default_ai_model_chat','default_ai_model_chat_fallback','default_ai_model_chat_fallback_2')),'{}'));
 PERFORM pg_sleep(0.3);
 RETURN won;
END $$;
SELECT dblink_connect('phase2_a', format('dbname=%s user=%s',current_database(),current_user));
SELECT dblink_connect('phase2_b', format('dbname=%s user=%s',current_database(),current_user));
SELECT dblink_send_query('phase2_a','SELECT public.test_phase2_mutation(true)');
SELECT dblink_send_query('phase2_b','SELECT public.test_phase2_mutation(false)');
CREATE TEMP TABLE phase2_outcomes(won boolean);
INSERT INTO phase2_outcomes SELECT * FROM dblink_get_result('phase2_a') AS t(won boolean);
INSERT INTO phase2_outcomes SELECT * FROM dblink_get_result('phase2_b') AS t(won boolean);
DO $$ BEGIN
 IF (SELECT count(*) FROM phase2_outcomes WHERE won) <> 1 THEN RAISE EXCEPTION 'Expected one CAS winner'; END IF;
 IF EXISTS(SELECT 1 FROM public.system_settings WHERE key='default_ai_model_caption_fallback')
    AND NOT EXISTS(SELECT 1 FROM public.system_settings WHERE key='default_ai_model_caption') THEN RAISE EXCEPTION 'Concurrent mutation left orphan fallback'; END IF;
END $$;
SELECT dblink_disconnect('phase2_a');
SELECT dblink_disconnect('phase2_b');
DROP FUNCTION public.test_phase2_mutation(boolean);
DELETE FROM public.system_settings WHERE key LIKE 'default_ai_model_caption%';
UPDATE public.system_settings SET value = 'false' WHERE key IN ('feature_ai_text_auth_lists','feature_ai_category_text_ladders');
\echo 'ai_text_category_ladders: ALL CHECKS PASSED'
