-- supabase/tests/whatsapp_number_mismatch.sql
-- WhatsApp account continuity, PR-A follow-up: migration 20261004100200 (atomic
-- number_mismatch flag set / clear) and 20261004100300 (scoped flag), 20261004100400 (owned instance read/save), 20261004100410 (instance state scoped). One transaction, synthetic fixtures, labelled
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

  -- N0: the flag is scoped too: another user, workspace or instance flags nothing; an
  -- unscoped call is refused; no one-argument overload remains.
  ASSERT public.flag_whatsapp_number_mismatch(acc, u_b, NULL, NULL) = false, 'N0 another user cannot flag';
  ASSERT public.flag_whatsapp_number_mismatch(acc, NULL, ws_b, NULL) = false, 'N0 another workspace cannot flag';
  ASSERT public.flag_whatsapp_number_mismatch(acc, NULL, NULL, 'postora_not_this_one') = false, 'N0 another instance cannot flag';
  ASSERT (SELECT is_active FROM public.social_accounts WHERE id = acc), 'N0 still active after refused flags';
  BEGIN
    PERFORM public.flag_whatsapp_number_mismatch(acc, NULL, NULL, NULL);
    RAISE EXCEPTION 'N0 failed: unscoped flag accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'flag_whatsapp_number_mismatch') = 1, 'N0 exactly one flag function (no overload)';
  INSERT INTO public.whatsapp_evolution_instances (social_account_id, instance_name, jwt_key)
  VALUES (acc, 'postora_' || acc::text, 'jwt-test');
  ASSERT public.flag_whatsapp_number_mismatch(acc, NULL, NULL, 'postora_' || acc::text) = true, 'N0 the instance scope flags';
  UPDATE public.social_accounts SET is_active = true, account_metadata = account_metadata - 'number_mismatch' WHERE id = acc;

  -- N1: flag sets the key and deactivates, keeping other keys.
  ASSERT public.flag_whatsapp_number_mismatch(acc, u_a, NULL, NULL) = true, 'N1 flag applied';
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
  PERFORM public.flag_whatsapp_number_mismatch(acc, NULL, ws_a, NULL);
  ASSERT public.clear_whatsapp_number_mismatch(acc, NULL, ws_a) = true, 'N3 workspace-scoped clear';
  BEGIN
    PERFORM public.clear_whatsapp_number_mismatch(acc, NULL, NULL);
    RAISE EXCEPTION 'N3 failed: unscoped clear accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- N5: the reconnect path's instance read and QR save are owner-scoped in SQL.
  ASSERT public.get_owned_evolution_instance(acc, u_a)->>'instance_name' = 'postora_' || acc::text, 'N5 the owner reads the instance';
  ASSERT public.get_owned_evolution_instance(acc, u_b) IS NULL, 'N5 another user reads nothing';
  ASSERT public.save_owned_evolution_qr(acc, u_b, 'qr-x', 'connecting') = false, 'N5 another user saves nothing';
  ASSERT (SELECT last_qr IS DISTINCT FROM 'qr-x' FROM public.whatsapp_evolution_instances WHERE social_account_id = acc), 'N5 instance untouched by the stranger';
  ASSERT public.save_owned_evolution_qr(acc, u_a, 'qr-ok', 'connecting') = true, 'N5 the owner saves the QR';
  ASSERT (SELECT last_qr FROM public.whatsapp_evolution_instances WHERE social_account_id = acc) = 'qr-ok', 'N5 QR stored';
  ASSERT NOT has_function_privilege('authenticated', 'public.get_owned_evolution_instance(uuid,uuid)', 'EXECUTE'), 'N5 instance read not browser-callable (it carries the webhook key)';
  ASSERT NOT has_function_privilege('authenticated', 'public.save_owned_evolution_qr(uuid,uuid,text,text)', 'EXECUTE'), 'N5 QR save not browser-callable';

  -- N6: a scoped flag also marks the instance; a refused (wrong-tenant) flag marks nothing.
  UPDATE public.whatsapp_evolution_instances SET last_connection_state = 'open' WHERE social_account_id = acc;
  PERFORM public.flag_whatsapp_number_mismatch(acc, u_b, NULL, NULL);
  ASSERT (SELECT last_connection_state FROM public.whatsapp_evolution_instances WHERE social_account_id = acc) = 'open',
    'N6 a wrong-tenant flag leaves the instance state alone';
  PERFORM public.flag_whatsapp_number_mismatch(acc, u_a, NULL, NULL);
  ASSERT (SELECT last_connection_state FROM public.whatsapp_evolution_instances WHERE social_account_id = acc) = 'number_mismatch',
    'N6 the scoped flag marks the instance';
  -- N7: the poll's observed-state write is owner-scoped.
  ASSERT public.save_owned_evolution_state(acc, u_b, 'close') = false, 'N7 another user writes no state';
  ASSERT public.save_owned_evolution_state(acc, u_a, 'close') = true, 'N7 the owner writes the state';
  ASSERT (SELECT last_connection_state FROM public.whatsapp_evolution_instances WHERE social_account_id = acc) = 'close', 'N7 state stored';
  ASSERT NOT has_function_privilege('authenticated', 'public.save_owned_evolution_state(uuid,uuid,text)', 'EXECUTE'), 'N7 not browser-callable';

  -- N4: grants.
  ASSERT NOT has_function_privilege('authenticated', 'public.flag_whatsapp_number_mismatch(uuid,uuid,uuid,text)', 'EXECUTE'), 'N4 flag not browser-callable';
  ASSERT NOT has_function_privilege('authenticated', 'public.clear_whatsapp_number_mismatch(uuid,uuid,uuid)', 'EXECUTE'), 'N4 clear not browser-callable';
  ASSERT NOT has_function_privilege('anon', 'public.clear_whatsapp_number_mismatch(uuid,uuid,uuid)', 'EXECUTE'), 'N4 clear not anon-callable';
END $$;

ROLLBACK;

\echo '=== whatsapp_number_mismatch: ALL CHECKS PASSED ==='
