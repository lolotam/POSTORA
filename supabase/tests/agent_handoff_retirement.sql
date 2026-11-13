-- Prove the post-deployment contract without changing the migration-first baseline.
BEGIN;
\set old_edge_workers_drained true
\ir ../../scripts/sql/retire-agent-reply-legacy.sql
DO $$
BEGIN
  ASSERT NOT has_function_privilege('service_role',
    'public.advance_agent_reply(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
    'retirement removes the live legacy transition';
  ASSERT has_function_privilege('service_role',
    'public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb)', 'EXECUTE'),
    'retirement preserves the tenant-bound transition';
END;
$$;
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.advance_agent_reply('00000000-0000-4000-8000-000000000000', 'running', 'pending');
    RAISE EXCEPTION 'retired legacy transition accepted a service-role call';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;
ROLLBACK;
\echo '=== agent_handoff_retirement: ALL CHECKS PASSED ==='
