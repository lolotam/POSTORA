-- supabase/tests/whatsapp_number_mismatch.sql
-- WhatsApp account continuity, PR-A follow-up: migration 20261004100200 (atomic
-- number_mismatch flag set / clear). One transaction, synthetic fixtures, labelled
-- ASSERTs, ROLLBACK, sentinel last.
BEGIN;

DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-1111-4111-8111-a7a7a7a7a7a7';
  u_b uuid := 'b8b8b8b8-2222-4222-8222-b8b8b8b8b8b8';
  ws_a uuid := 'a7a7a7a7-aaaa-4111-8111-a7a7a7a7a7a7';
  ws_b uuid := 'b8b8b8b8-aaaa-4222-8222-b8b8b8b8b8b8';
  acc uuid := 'a7a7a7a7-0001-4111-8111-a7a7a7a7a7a7';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'mismatch-a-' || u_a::text || '@example.invalid'),
    (u_b, 'mismatch-b-' || u_b::text || '@example.invalid');
  INSERT INTO public.workspaces (id, name, owner_id) VALUES (ws_a, 'mm a', u_a), (ws_b, 'mm b', u_b);
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata)
  VALUES (acc, u_a, 'whatsapp', '96566600001', '', ws_a, true, 'evolution_qr', '{"automation_handler":"internal"}');

  -- N1: flag sets the key and deactivates, keeping other keys.
  ASSERT public.flag_whatsapp_number_mismatch(acc) = true, 'N1 flag applied';
  ASSERT (SELECT NOT is_active AND (account_metadata->>'number_mismatch')::boolean
                 AND account_metadata->>'automation_handler' = 'internal'
            FROM public.social_accounts WHERE id = acc), 'N1 inactive, flagged, other keys kept';

  -- N2: a concurrent-style write to another key between flag and clear survives the clear.
  PERFORM public.note_undelivered_store_event(acc);
  ASSERT public.clear_whatsapp_number_mismatch(acc, u_b, NULL) = false, 'N2 another user cannot clear';
  ASSERT public.clear_whatsapp_number_mismatch(acc, NULL, ws_b) = false, 'N2 another workspace cannot clear';
  ASSERT public.clear_whatsapp_number_mismatch(acc, u_a, NULL) = true, 'N2 the owner clears';
  ASSERT (SELECT NOT (account_metadata ? 'number_mismatch') AND account_metadata ? 'undelivered_store_events'
            FROM public.social_accounts WHERE id = acc), 'N2 only the mismatch key is removed';
  ASSERT public.clear_whatsapp_number_mismatch(acc, u_a, NULL) = false, 'N2 clearing twice is a no-op';

  -- N3: the workspace scope works for the partner path; an unscoped call is refused.
  PERFORM public.flag_whatsapp_number_mismatch(acc);
  ASSERT public.clear_whatsapp_number_mismatch(acc, NULL, ws_a) = true, 'N3 workspace-scoped clear';
  BEGIN
    PERFORM public.clear_whatsapp_number_mismatch(acc, NULL, NULL);
    RAISE EXCEPTION 'N3 failed: unscoped clear accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- N4: grants.
  ASSERT NOT has_function_privilege('authenticated', 'public.flag_whatsapp_number_mismatch(uuid)', 'EXECUTE'), 'N4 flag not browser-callable';
  ASSERT NOT has_function_privilege('authenticated', 'public.clear_whatsapp_number_mismatch(uuid,uuid,uuid)', 'EXECUTE'), 'N4 clear not browser-callable';
  ASSERT NOT has_function_privilege('anon', 'public.clear_whatsapp_number_mismatch(uuid,uuid,uuid)', 'EXECUTE'), 'N4 clear not anon-callable';
END $$;

ROLLBACK;

\echo '=== whatsapp_number_mismatch: ALL CHECKS PASSED ==='
