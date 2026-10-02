-- supabase/tests/agent_procedures.sql
BEGIN;
DO $$
BEGIN
  ASSERT (SELECT data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ai_threads' AND column_name='procedure_state') = 'jsonb',
    'P1 procedure_state is jsonb';
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ai_threads' AND column_name='procedure_state') = 'YES',
    'P2 procedure_state is nullable';
  ASSERT public.ai_agent_test_expected_valid('{"intent":"booking"}'::jsonb), 'P3 booking accepted';
  ASSERT public.ai_agent_test_expected_valid('{"intent":"pricing"}'::jsonb), 'P4 existing intent still accepted';
  ASSERT NOT public.ai_agent_test_expected_valid('{"intent":"weather"}'::jsonb), 'P5 unknown intent rejected';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname='ai_agent_test_expected_valid') = 1, 'P6 no overload added';
  -- customer_language (migration 20261003130000): nullable, ar|en only.
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ai_threads' AND column_name='customer_language') = 'YES',
    'P7 customer_language is nullable';
END $$;
DO $$
DECLARE
  u uuid;
BEGIN
  SELECT id INTO u FROM auth.users LIMIT 1;
  IF u IS NULL THEN
    INSERT INTO auth.users (id, email) VALUES ('c7c7c7c7-7777-4777-8777-cccccccccccc', 'lang@example.invalid')
    RETURNING id INTO u;
  END IF;
  INSERT INTO public.ai_threads (user_id, platform, conversation_id, customer_language)
  VALUES (u, 'whatsapp', 'p8-language-ok', 'ar');
  BEGIN
    INSERT INTO public.ai_threads (user_id, platform, conversation_id, customer_language)
    VALUES (u, 'whatsapp', 'p8-language-bad', 'fr');
    RAISE EXCEPTION 'P8 failed: customer_language accepted fr' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
ROLLBACK;
\echo '=== agent_procedures: ALL CHECKS PASSED ==='
