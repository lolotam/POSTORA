-- supabase/tests/whatsapp_account_continuity.sql
-- WhatsApp account continuity (spec 2026-10-01). PR-D slice: migration
-- 20261004100000 (setup summary, undelivered-store-event flag, alert-email
-- mark). One transaction, synthetic fixtures, labelled ASSERTs, expected
-- refusals in nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last.
-- No secrets and no real accounts. Assumes the migration is applied.
BEGIN;

DO $$
DECLARE
  u_a uuid := 'c1c1c1c1-1111-4111-8111-cccccccccccc';
  u_b uuid := 'd2d2d2d2-2222-4222-8222-dddddddddddd';
  ws_a uuid := 'c1c1c1c1-aaaa-4111-8111-cccccccccccc';
  ws_b uuid := 'd2d2d2d2-aaaa-4222-8222-dddddddddddd';
  acc_a1 uuid := 'c1c1c1c1-0001-4111-8111-cccccccccccc';
  acc_a2 uuid := 'c1c1c1c1-0002-4111-8111-cccccccccccc';
  acc_b1 uuid := 'd2d2d2d2-0001-4222-8222-dddddddddddd';
  tool_a uuid := 'c1c1c1c1-0003-4111-8111-cccccccccccc';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'wa-continuity-a-' || u_a::text || '@example.invalid'),
    (u_b, 'wa-continuity-b-' || u_b::text || '@example.invalid');
  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (ws_a, 'continuity workspace a', u_a),
    (ws_b, 'continuity workspace b', u_b);
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata)
  VALUES
    (acc_a1, u_a, 'whatsapp', '96500000001', '', ws_a, true, 'evolution_qr', '{"automation_handler":"internal"}'),
    (acc_a2, u_a, 'whatsapp', '96500000002', '', ws_a, false, 'evolution_qr', '{}'),
    (acc_b1, u_b, 'whatsapp', '96500000003', '', ws_b, true, 'evolution_qr', '{}');
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id)
  VALUES (u_a, 'whatsapp', acc_a1);
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (tool_a, u_a, 'woo_store', 'continuity fixture', 'woocommerce', acc_a1, 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (user_id, social_account_id, connector_id, secret_id)
  VALUES (u_a, acc_a1, tool_a, gen_random_uuid());
  INSERT INTO public.app_settings (key, value) VALUES
    ('n8n_webhook_' || u_a::text || '_1', jsonb_build_object('social_account_id', acc_a1::text)),
    -- Underscores replaced: LIKE would match this key; the literal prefix must not.
    ('n8nXwebhookX' || u_a::text || 'X1', jsonb_build_object('social_account_id', acc_a1::text));
END $$;

-- S3, S4, S7 (grant surface), checked before any role switch.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.get_whatsapp_account_setup_summary(uuid)', 'EXECUTE'),
    'S3 anon cannot run the setup summary';
  ASSERT has_function_privilege('authenticated', 'public.get_whatsapp_account_setup_summary(uuid)', 'EXECUTE'),
    'S3 authenticated can run the setup summary';
  ASSERT NOT has_function_privilege('authenticated', 'public.note_undelivered_store_event(uuid)', 'EXECUTE'),
    'S4 authenticated cannot raise the undelivered flag';
  ASSERT NOT has_function_privilege('anon', 'public.note_undelivered_store_event(uuid)', 'EXECUTE'),
    'S4 anon cannot raise the undelivered flag';
  ASSERT NOT has_function_privilege('authenticated', 'public.clear_undelivered_store_events(uuid)', 'EXECUTE'),
    'S4 authenticated cannot clear the undelivered flag';
  ASSERT NOT has_function_privilege('authenticated', 'public.mark_undelivered_alert_emailed(uuid, text)', 'EXECUTE'),
    'S7 authenticated cannot mark the alert emailed';
  ASSERT has_function_privilege('service_role', 'public.mark_undelivered_alert_emailed(uuid, text)', 'EXECUTE'),
    'S7 service_role can mark the alert emailed';
END $$;

-- S5, S6, S7 (behaviour), as the migration owner (service-role path).
DO $$
DECLARE
  acc uuid := 'c1c1c1c1-0001-4111-8111-cccccccccccc';
  v_since text;
  v_last1 text;
BEGIN
  PERFORM public.note_undelivered_store_event(acc);
  SELECT account_metadata->'undelivered_store_events'->>'since',
         account_metadata->'undelivered_store_events'->>'last_at'
    INTO v_since, v_last1
    FROM public.social_accounts WHERE id = acc;
  ASSERT v_since IS NOT NULL, 'S5 first note sets since';
  PERFORM pg_sleep(0.01);
  PERFORM public.note_undelivered_store_event(acc);
  ASSERT (SELECT account_metadata->'undelivered_store_events'->>'since' FROM public.social_accounts WHERE id = acc) = v_since,
    'S5 a second note keeps since';
  ASSERT NOT (SELECT account_metadata->'undelivered_store_events' ? 'count' FROM public.social_accounts WHERE id = acc),
    'S5 the flag carries no retry count';
  ASSERT (SELECT account_metadata->>'automation_handler' FROM public.social_accounts WHERE id = acc) = 'internal',
    'S5 other metadata keys survive';

  ASSERT public.mark_undelivered_alert_emailed(acc, 'not-the-since') = false,
    'S7 a stale since marks nothing';
  ASSERT NOT (SELECT account_metadata ? 'undelivered_alert_email_at' FROM public.social_accounts WHERE id = acc),
    'S7 nothing written for a stale since';
  ASSERT public.mark_undelivered_alert_emailed(acc, v_since) = true,
    'S7 the current since marks the alert';
  ASSERT (SELECT account_metadata ? 'undelivered_alert_email_at' FROM public.social_accounts WHERE id = acc),
    'S7 the email timestamp is written';

  PERFORM public.clear_undelivered_store_events(acc);
  ASSERT NOT (SELECT account_metadata ? 'undelivered_store_events' FROM public.social_accounts WHERE id = acc),
    'S6 clear removes the flag';
  ASSERT (SELECT account_metadata->>'automation_handler' FROM public.social_accounts WHERE id = acc) = 'internal',
    'S6 clear keeps other metadata keys';
END $$;

-- S9: an expired hold clears the incident only once nothing is still waiting.
-- S10: the alert email is reserved before sending; a fresh claim blocks a second run.
DO $$
DECLARE
  u_a uuid := 'c1c1c1c1-1111-4111-8111-cccccccccccc';
  acc uuid := 'c1c1c1c1-0001-4111-8111-cccccccccccc';
  v_bind uuid;
  v_tool uuid := 'c1c1c1c1-0003-4111-8111-cccccccccccc';
  v_event uuid;
  v_since text;
BEGIN
  SELECT id INTO v_bind FROM public.store_webhook_bindings WHERE social_account_id = acc;
  INSERT INTO public.store_events (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status, due_at)
  VALUES (u_a, acc, v_tool, v_bind, 'cod_confirm', 'continuity-1', '{"order_id":"1"}', 'pending', now())
  RETURNING id INTO v_event;
  PERFORM public.note_undelivered_store_event(acc);

  ASSERT public.clear_undelivered_if_none_held(acc) = false, 'S9 a pending event keeps the incident open';
  ASSERT (SELECT account_metadata ? 'undelivered_store_events' FROM public.social_accounts WHERE id = acc),
    'S9 the flag survives while an order is held';
  UPDATE public.store_events SET status = 'skipped', skip_reason = 'account_disconnected', processed_at = now()
   WHERE id = v_event;
  ASSERT public.clear_undelivered_if_none_held(acc) = true, 'S9 nothing held: the incident clears';
  ASSERT NOT (SELECT account_metadata ? 'undelivered_store_events' FROM public.social_accounts WHERE id = acc),
    'S9 the flag is gone after the last hold expires';
  ASSERT NOT has_function_privilege('authenticated', 'public.clear_undelivered_if_none_held(uuid)', 'EXECUTE'),
    'S9 authenticated cannot clear an incident';

  PERFORM public.note_undelivered_store_event(acc);
  SELECT account_metadata->'undelivered_store_events'->>'since' INTO v_since FROM public.social_accounts WHERE id = acc;
  ASSERT public.claim_undelivered_alert_email(acc, v_since) = true, 'S10 the first run reserves the email';
  ASSERT public.claim_undelivered_alert_email(acc, v_since) = false, 'S10 a concurrent run cannot reserve it again';
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(account_metadata, '{undelivered_alert_claimed_at}', to_jsonb((now() - interval '31 minutes')::text))
   WHERE id = acc;
  ASSERT public.claim_undelivered_alert_email(acc, v_since) = true, 'S10 a lapsed claim (failed send) can be retaken';
  ASSERT public.mark_undelivered_alert_emailed(acc, v_since) = true, 'S10 a successful send marks the incident';
  ASSERT public.claim_undelivered_alert_email(acc, v_since) = false, 'S10 an emailed incident is never claimed again';
  ASSERT public.claim_undelivered_alert_email(acc, 'other-since') = false, 'S10 a stale since claims nothing';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_undelivered_alert_email(uuid, text)', 'EXECUTE'),
    'S10 authenticated cannot claim the alert email';
  PERFORM public.clear_undelivered_store_events(acc);
  ASSERT NOT (SELECT account_metadata ?| ARRAY['undelivered_store_events', 'undelivered_alert_email_at', 'undelivered_alert_claimed_at']
                FROM public.social_accounts WHERE id = acc),
    'S10 clear removes every incident key';
END $$;

-- S1, S2, S8: the browser surface as user A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'c1c1c1c1-1111-4111-8111-cccccccccccc', 'role', 'authenticated')::text, true);

DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.get_whatsapp_account_setup_summary('c1c1c1c1-0001-4111-8111-cccccccccccc');
  ASSERT (v->>'agent_config')::int = 1, 'S1 summary counts the agent config';
  ASSERT (v->>'connectors')::int = 1, 'S1 summary counts the connector';
  ASSERT (v->>'store_bindings')::int = 1, 'S1 summary counts the store binding';
  ASSERT (v->>'knowledge_sources')::int = 0, 'S1 summary counts zero knowledge sources';
  ASSERT v->'automation_handlers' = '["automation_handler"]'::jsonb, 'S1 summary lists set automation handlers';
  ASSERT (v->>'n8n_subscriptions')::int = 1, 'S8 only the literal n8n_webhook_<user>_ prefix is counted';

  v := public.get_whatsapp_account_setup_summary('c1c1c1c1-0002-4111-8111-cccccccccccc');
  ASSERT (v->>'agent_config')::int = 0 AND (v->>'connectors')::int = 0, 'S1 an empty account summarises to zeros';

  BEGIN
    PERFORM public.get_whatsapp_account_setup_summary('d2d2d2d2-0001-4222-8222-dddddddddddd');
    RAISE EXCEPTION 'S2 failed: another user''s summary was returned' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501', 'S2 another user''s account is refused with 42501';
  END;
END $$;

ROLLBACK;

\echo '=== whatsapp_account_continuity: ALL CHECKS PASSED ==='
