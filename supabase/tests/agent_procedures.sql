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
END $$;
ROLLBACK;
\echo '=== agent_procedures: ALL CHECKS PASSED ==='
