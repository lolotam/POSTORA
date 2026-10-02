-- supabase/tests/whatsapp_account_setup_move.sql
-- WhatsApp account continuity, PR-BC: migrations 20261004110000 (store_events FKs),
-- 20261004110500 (move_whatsapp_account_setup, dismiss_whatsapp_setup_move) and
-- 20261004111000 (activation carries the setup). One transaction, synthetic fixtures,
-- labelled ASSERTs, expected refusals in nested BEGIN/EXCEPTION blocks, ROLLBACK,
-- sentinel last. No secrets, no real accounts.
--
-- Concurrency (two sessions, manual, recorded 2026-10-01): session 1 holds an open
-- transaction after move_whatsapp_account_setup(src, dst, 'auto'); session 2's
-- activate_evolution_qr_account for the same owner waits on the ':wa-setup' lock and
-- completes after session 1 commits — no 40P01. claim_store_events locks only event rows
-- (20260928120000:104-141), never account or binding rows, so the mover's event lock
-- (taken after both account rows) cannot form a cycle with it.
BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO ids VALUES
  ('u_a', 'e1e1e1e1-1111-4111-8111-eeeeeeeeeeee'),
  ('u_b', 'f2f2f2f2-2222-4222-8222-ffffffffffff'),
  ('ws_a', 'e1e1e1e1-aaaa-4111-8111-eeeeeeeeeeee'),
  ('ws_a2', 'e1e1e1e1-bbbb-4111-8111-eeeeeeeeeeee'),
  ('ws_b', 'f2f2f2f2-aaaa-4222-8222-ffffffffffff'),
  ('src', 'e1e1e1e1-0001-4111-8111-eeeeeeeeeeee'),
  ('dst', 'e1e1e1e1-0002-4111-8111-eeeeeeeeeeee'),
  ('dst_other', 'e1e1e1e1-0003-4111-8111-eeeeeeeeeeee'),
  ('dst_ws2', 'e1e1e1e1-0004-4111-8111-eeeeeeeeeeee'),
  ('acc_b', 'f2f2f2f2-0001-4222-8222-ffffffffffff'),
  ('pend', 'e1e1e1e1-0005-4111-8111-eeeeeeeeeeee'),
  ('tool_src', 'e1e1e1e1-0101-4111-8111-eeeeeeeeeeee'),
  ('tool_b', 'f2f2f2f2-0101-4222-8222-ffffffffffff'),
  ('bind_src', 'e1e1e1e1-0201-4111-8111-eeeeeeeeeeee'),
  ('bind_b', 'f2f2f2f2-0201-4222-8222-ffffffffffff'),
  ('ev_pending', 'e1e1e1e1-0301-4111-8111-eeeeeeeeeeee'),
  ('ev_sent', 'e1e1e1e1-0302-4111-8111-eeeeeeeeeeee'),
  ('src2', 'e1e1e1e1-0006-4111-8111-eeeeeeeeeeee'),
  ('dst2', 'e1e1e1e1-0007-4111-8111-eeeeeeeeeeee'),
  ('tool_src2', 'e1e1e1e1-0102-4111-8111-eeeeeeeeeeee'),
  ('bind_src2', 'e1e1e1e1-0202-4111-8111-eeeeeeeeeeee'),
  ('ks1', 'e1e1e1e1-0401-4111-8111-eeeeeeeeeeee'),
  ('ks2', 'e1e1e1e1-0402-4111-8111-eeeeeeeeeeee'),
  ('key1', 'e1e1e1e1-0501-4111-8111-eeeeeeeeeeee');
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = p $$;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (pg_temp.id('u_a'), 'setup-move-a-' || pg_temp.id('u_a')::text || '@example.invalid'),
    (pg_temp.id('u_b'), 'setup-move-b-' || pg_temp.id('u_b')::text || '@example.invalid');
  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (pg_temp.id('ws_a'), 'move ws a', pg_temp.id('u_a')),
    (pg_temp.id('ws_a2'), 'move ws a2', pg_temp.id('u_a')),
    (pg_temp.id('ws_b'), 'move ws b', pg_temp.id('u_b'));
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata)
  VALUES
    (pg_temp.id('src'), pg_temp.id('u_a'), 'whatsapp', '96500000009', '', pg_temp.id('ws_a'), false, 'evolution_qr',
       '{"automation_handler":"internal","waba_id":"waba-1"}'),
    (pg_temp.id('dst'), pg_temp.id('u_a'), 'whatsapp', '96500000099', '', pg_temp.id('ws_a'), true, 'evolution_qr', '{}'),
    (pg_temp.id('dst_other'), pg_temp.id('u_a'), 'whatsapp', '1234567890', '', pg_temp.id('ws_a'), true, 'cloud_api',
       '{"display_phone_number":"+965 5000 0077","waba_id":"waba-2"}'),
    (pg_temp.id('dst_ws2'), pg_temp.id('u_a'), 'whatsapp', '96500000088', '', pg_temp.id('ws_a2'), true, 'evolution_qr', '{}'),
    (pg_temp.id('acc_b'), pg_temp.id('u_b'), 'whatsapp', '96500000077', '', pg_temp.id('ws_b'), true, 'evolution_qr', '{}'),
    (pg_temp.id('pend'), pg_temp.id('u_a'), 'whatsapp', 'pending_' || pg_temp.id('pend')::text, '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
    (pg_temp.id('src2'), pg_temp.id('u_a'), 'whatsapp', '96500000066', '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
    (pg_temp.id('dst2'), pg_temp.id('u_a'), 'whatsapp', '96500000055', '', pg_temp.id('ws_a'), true, 'evolution_qr', '{}');

  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES
    (pg_temp.id('u_a'), 'whatsapp', pg_temp.id('src'));
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope) VALUES
    (pg_temp.id('tool_src'), pg_temp.id('u_a'), 'woo_store', 'move fixture', 'woocommerce', pg_temp.id('src'), 'whatsapp', 'account'),
    (pg_temp.id('tool_b'), pg_temp.id('u_b'), 'woo_store', 'move fixture b', 'woocommerce', pg_temp.id('acc_b'), 'whatsapp', 'account'),
    (pg_temp.id('tool_src2'), pg_temp.id('u_a'), 'woo_two', 'move fixture 2', 'woocommerce', pg_temp.id('src2'), 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id) VALUES
    (pg_temp.id('bind_src'), pg_temp.id('u_a'), pg_temp.id('src'), pg_temp.id('tool_src'), gen_random_uuid()),
    (pg_temp.id('bind_b'), pg_temp.id('u_b'), pg_temp.id('acc_b'), pg_temp.id('tool_b'), gen_random_uuid()),
    (pg_temp.id('bind_src2'), pg_temp.id('u_a'), pg_temp.id('src2'), pg_temp.id('tool_src2'), gen_random_uuid());
  INSERT INTO public.store_events (id, user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status, due_at) VALUES
    (pg_temp.id('ev_pending'), pg_temp.id('u_a'), pg_temp.id('src'), pg_temp.id('tool_src'), pg_temp.id('bind_src'),
       'cod_confirm', 'mv-1', '{"order_id":"1"}', 'pending', now()),
    (pg_temp.id('ev_sent'), pg_temp.id('u_a'), pg_temp.id('src'), pg_temp.id('tool_src'), pg_temp.id('bind_src'),
       'cod_confirm', 'mv-2', '{"order_id":"2"}', 'sent', now());
  -- src2's in-flight event (M17 only).
  INSERT INTO public.store_events (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status, due_at, claimed_at, claim_token)
  VALUES (pg_temp.id('u_a'), pg_temp.id('src2'), pg_temp.id('tool_src2'), pg_temp.id('bind_src2'),
          'cod_confirm', 'mv-3', '{"order_id":"3"}', 'claimed', now(), now(), gen_random_uuid());
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (pg_temp.id('u_a'), 'whatsapp', pg_temp.id('src2'));

  INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id, product_name)
  VALUES (pg_temp.id('u_a'), pg_temp.id('src'), pg_temp.id('tool_src'), 'wa_96500000009_96555512345', '96555512345', 101, 'P');
  INSERT INTO public.whatsapp_message_templates
    (user_id, social_account_id, template_name, template_language, template_category, template_status, components, meta_template_id)
  VALUES (pg_temp.id('u_a'), pg_temp.id('src'), 'order_update', 'ar', 'UTILITY', 'APPROVED', '[]', 'meta-1');
  INSERT INTO public.app_settings (key, value) VALUES
    ('n8n_webhook_' || pg_temp.id('u_a')::text || '_1', jsonb_build_object('social_account_id', pg_temp.id('src')::text)),
    ('n8nXwebhookX' || pg_temp.id('u_a')::text || 'X1', jsonb_build_object('social_account_id', pg_temp.id('src')::text));
END $$;

-- Knowledge sources need their source rows.
DO $$
BEGIN
  INSERT INTO public.ai_knowledge_sources (id, user_id, file_name, source_type)
  VALUES (pg_temp.id('ks1'), pg_temp.id('u_a'), 'kb one', 'profile_text'),
         (pg_temp.id('ks2'), pg_temp.id('u_a'), 'kb two', 'profile_text');
  INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id) VALUES
    (pg_temp.id('ks1'), pg_temp.id('src'), pg_temp.id('u_a')),
    (pg_temp.id('ks2'), pg_temp.id('src'), pg_temp.id('u_a'));
END $$;

-- M11 grants, M13 / M18 foreign keys.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.move_whatsapp_account_setup(uuid,uuid,text,jsonb)', 'EXECUTE'),
    'M11 anon cannot move setup';
  ASSERT NOT has_function_privilege('authenticated', 'public.move_whatsapp_account_setup(uuid,uuid,text,jsonb)', 'EXECUTE'),
    'M11 authenticated cannot move setup';
  ASSERT has_function_privilege('service_role', 'public.move_whatsapp_account_setup(uuid,uuid,text,jsonb)', 'EXECUTE'),
    'M11 service_role can move setup';
  ASSERT NOT has_function_privilege('authenticated', 'public.dismiss_whatsapp_setup_move(uuid,uuid)', 'EXECUTE'),
    'M21 authenticated cannot dismiss';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_events_binding_identity_fk'),
    'M13 the four-column binding FK is gone';

  BEGIN
    INSERT INTO public.store_events (user_id, social_account_id, connector_id, binding_id, flow, external_id, status, due_at)
    VALUES (pg_temp.id('u_a'), pg_temp.id('src'), pg_temp.id('tool_b'), pg_temp.id('bind_b'), 'cod_confirm', 'x-13', 'pending', now());
    RAISE EXCEPTION 'M13 failed: an event bound to another user''s binding was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.store_events (user_id, social_account_id, connector_id, binding_id, flow, external_id, status, due_at)
    VALUES (pg_temp.id('u_a'), pg_temp.id('acc_b'), pg_temp.id('tool_src'), pg_temp.id('bind_src'), 'cod_confirm', 'x-18', 'pending', now());
    RAISE EXCEPTION 'M18 failed: an event naming another user''s account was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- M8, M9, M10 refusals, M14 validation (all before any move).
DO $$
DECLARE
  v_state text;
BEGIN
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst_ws2'), 'auto');
    RAISE EXCEPTION 'M8 failed: cross-workspace move accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('acc_b'), 'auto');
    RAISE EXCEPTION 'M9 failed: cross-user move accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('src'), 'auto');
    RAISE EXCEPTION 'M10 failed: self move accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('pend'), 'auto');
    RAISE EXCEPTION 'M10 failed: pending destination accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive',
      '{"connectors":{"no_such_connector":"skip"}}');
    RAISE EXCEPTION 'M14 failed: unknown connector choice accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive',
      '{"agent_config":"source","connectors":{"woo_store":"skip"}}');
    RAISE EXCEPTION 'M14 failed: agent moved away from a skipped store connector' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive', '{"bogus":1}');
    RAISE EXCEPTION 'M14 failed: unknown choice key accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

-- M17 in-flight: src2 has a claimed event.
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.move_whatsapp_account_setup(pg_temp.id('src2'), pg_temp.id('dst2'), 'auto');
  ASSERT v->>'status' = 'deferred', 'M17 auto defers group S while an order is in flight: ' || v::text;
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE id = pg_temp.id('bind_src2')) = pg_temp.id('src2'),
    'M17 the binding stayed';
  ASSERT (SELECT social_account_id FROM public.ai_agent_tools WHERE id = pg_temp.id('tool_src2')) = pg_temp.id('src2'),
    'M17 the connector stayed';
  ASSERT (SELECT account_metadata->'setup_move_pending'->>'reason' FROM public.social_accounts WHERE id = pg_temp.id('dst2')) = 'store_event_in_flight',
    'M17 the destination is flagged with the reason';
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src2'), pg_temp.id('dst2'), 'interactive', '{}');
    RAISE EXCEPTION 'M17 failed: interactive move during a send accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN object_in_use THEN NULL;
  END;
END $$;

-- M1-M3 auto move to an empty destination with the same number.
DO $$
DECLARE
  v jsonb;
BEGIN
  -- Give dst the same number and WABA as src so waitlist and templates qualify.
  -- Retire src first: (user_id, platform, platform_user_id) is unique.
  UPDATE public.social_accounts SET platform_user_id = 'retired_' || pg_temp.id('src')::text,
         account_metadata = account_metadata || '{"retired_number":"96500000009"}'
   WHERE id = pg_temp.id('src');
  UPDATE public.social_accounts SET platform_user_id = '96500000009',
         account_metadata = '{"waba_id":"waba-1"}'
   WHERE id = pg_temp.id('dst');

  v := public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'auto');
  ASSERT v->>'status' = 'moved', 'M1 status moved: ' || v::text;
  ASSERT (SELECT social_account_id FROM public.ai_agent_configs WHERE user_id = pg_temp.id('u_a') AND social_account_id IN (pg_temp.id('src'), pg_temp.id('dst'))) = pg_temp.id('dst'),
    'M1 agent config on dst';
  ASSERT (SELECT social_account_id FROM public.ai_agent_tools WHERE id = pg_temp.id('tool_src')) = pg_temp.id('dst'), 'M1 connector on dst';
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE id = pg_temp.id('bind_src')) = pg_temp.id('dst'),
    'M1 binding on dst, same id';
  ASSERT (SELECT count(*) FROM public.ai_knowledge_source_accounts WHERE social_account_id = pg_temp.id('dst')) = 2, 'M1 knowledge links on dst';
  ASSERT (SELECT count(*) FROM public.stock_waitlist WHERE social_account_id = pg_temp.id('dst')) = 1, 'M1 waitlist on dst (same number)';
  ASSERT (SELECT count(*) FROM public.whatsapp_message_templates WHERE social_account_id = pg_temp.id('dst')) = 1, 'M1 template on dst (same WABA)';
  ASSERT (SELECT value->>'social_account_id' FROM public.app_settings WHERE key = 'n8n_webhook_' || pg_temp.id('u_a')::text || '_1') = pg_temp.id('dst')::text,
    'M19 the n8n subscription now names dst';
  ASSERT (SELECT value->>'social_account_id' FROM public.app_settings WHERE key = 'n8nXwebhookX' || pg_temp.id('u_a')::text || 'X1') = pg_temp.id('src')::text,
    'M19 the look-alike key is untouched';
  ASSERT (SELECT account_metadata->>'automation_handler' FROM public.social_accounts WHERE id = pg_temp.id('dst')) = 'internal',
    'M1 automation handler copied';

  ASSERT (SELECT social_account_id FROM public.store_events WHERE id = pg_temp.id('ev_pending')) = pg_temp.id('dst'),
    'M2 the unstarted order follows the binding';
  ASSERT (SELECT social_account_id FROM public.store_events WHERE id = pg_temp.id('ev_sent')) = pg_temp.id('src'),
    'M2 the sent order stays as history';

  v := public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'auto');
  ASSERT v->>'status' = 'noop', 'M3 a repeated move is a no-op: ' || v::text;
END $$;

-- M4 auto with a destination config: group S deferred, independents move.
DO $$
DECLARE
  v jsonb;
  t uuid := gen_random_uuid();
BEGIN
  -- Put a fresh setup back on src (config + connector + binding) while dst keeps its config.
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (pg_temp.id('u_a'), 'whatsapp', pg_temp.id('src'));
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t, pg_temp.id('u_a'), 'woo_new', 'm4', 'woocommerce', pg_temp.id('src'), 'whatsapp', 'account');
  INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
  VALUES (pg_temp.id('ks1'), pg_temp.id('src'), pg_temp.id('u_a'));

  v := public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'auto');
  ASSERT v->>'status' = 'deferred', 'M4 deferred on config conflict: ' || v::text;
  ASSERT (SELECT social_account_id FROM public.ai_agent_tools WHERE id = t) = pg_temp.id('src'), 'M4 connector stayed with its config';
  ASSERT (SELECT count(*) FROM public.ai_agent_configs WHERE social_account_id = pg_temp.id('src')) = 1, 'M4 source config stayed';
  ASSERT (SELECT account_metadata->'setup_move_pending'->>'from' FROM public.social_accounts WHERE id = pg_temp.id('dst')) = pg_temp.id('src')::text,
    'M4 dst flagged setup_move_pending';
  ASSERT NOT EXISTS (SELECT 1 FROM public.ai_knowledge_source_accounts WHERE social_account_id = pg_temp.id('src')),
    'M4 the independent knowledge link still moved (duplicate dropped)';

  -- M5 interactive: use the source agent; the old destination config is archived.
  v := public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive', '{"agent_config":"source"}');
  ASSERT v->>'status' = 'moved', 'M5 interactive moved: ' || v::text;
  ASSERT (SELECT count(*) FROM public.ai_agent_configs WHERE social_account_id = pg_temp.id('dst')) = 1, 'M5 exactly one config on dst';
  ASSERT (SELECT count(*) FROM public.ai_agent_config_archive WHERE social_account_id = pg_temp.id('dst')) = 1, 'M5 the replaced config is archived';
  ASSERT (SELECT social_account_id FROM public.ai_agent_tools WHERE id = t) = pg_temp.id('dst'), 'M5 the connector moved with the agent';
  ASSERT NOT (SELECT account_metadata ? 'setup_move_pending' FROM public.social_accounts WHERE id = pg_temp.id('dst')),
    'M5 the pending flag clears once group S moves';
END $$;

-- M6 interactive name clash with skip: the clashing connector and its binding stay.
DO $$
DECLARE
  v jsonb;
  t uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t, pg_temp.id('u_a'), 'woo_store', 'm6 clash', 'woocommerce', pg_temp.id('src'), 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id)
  VALUES (b, pg_temp.id('u_a'), pg_temp.id('src'), t, gen_random_uuid());
  BEGIN
    PERFORM public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive', '{}');
    RAISE EXCEPTION 'M6 failed: a name clash without a choice was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  v := public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive', '{"connectors":{"woo_store":"skip"}}');
  ASSERT (SELECT social_account_id FROM public.ai_agent_tools WHERE id = t) = pg_temp.id('src'), 'M6 the skipped connector stayed';
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE id = b) = pg_temp.id('src'), 'M6 its binding stayed with it';
  ASSERT v->'left' @> '[{"item":"connector","name":"woo_store","reason":"skipped"}]', 'M6 left names the skipped connector: ' || v::text;
END $$;

-- M7 different number + different WABA: waitlist and templates stay.
DO $$
DECLARE
  v jsonb;
  t uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t, pg_temp.id('u_a'), 'woo_m7', 'm7', 'woocommerce', pg_temp.id('src2'), 'whatsapp', 'account');
  INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id, product_name)
  VALUES (pg_temp.id('u_a'), pg_temp.id('src2'), t, 'wa_96500000066_96555500000', '96555500000', 7, 'P7');
  INSERT INTO public.whatsapp_message_templates
    (user_id, social_account_id, template_name, template_language, template_category, template_status, components)
  VALUES (pg_temp.id('u_a'), pg_temp.id('src2'), 'm7_tpl', 'ar', 'UTILITY', 'APPROVED', '[]');
  -- Finish src2's in-flight event so group S may move.
  UPDATE public.store_events SET status = 'sent', processed_at = now() WHERE social_account_id = pg_temp.id('src2');
  v := public.move_whatsapp_account_setup(pg_temp.id('src2'), pg_temp.id('dst_other'), 'auto');
  ASSERT (SELECT count(*) FROM public.stock_waitlist WHERE social_account_id = pg_temp.id('src2')) = 1, 'M7 waitlist stays on a number change';
  ASSERT (SELECT count(*) FROM public.whatsapp_message_templates WHERE social_account_id = pg_temp.id('src2')) = 1, 'M7 template stays on a WABA mismatch';
  ASSERT v->'left' @> '[{"item":"waitlist","reason":"number_changed"}]', 'M7 waitlist reported: ' || v::text;
  ASSERT v->'left' @> '[{"item":"templates","reason":"waba_mismatch"}]', 'M7 templates reported: ' || v::text;
END $$;

-- M12 test-case cap: dst has 99, src has 3 -> 1 moves.
DO $$
DECLARE
  v jsonb;
  i int;
BEGIN
  DELETE FROM public.ai_agent_test_cases WHERE social_account_id IN (pg_temp.id('src'), pg_temp.id('dst'));
  FOR i IN 1..99 LOOP
    INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected, position)
    VALUES (pg_temp.id('u_a'), pg_temp.id('dst'), 'whatsapp', 'q' || i, '{}', i);
  END LOOP;
  FOR i IN 1..3 LOOP
    INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected, position)
    VALUES (pg_temp.id('u_a'), pg_temp.id('src'), 'whatsapp', 's' || i, '{}', i);
  END LOOP;
  v := public.move_whatsapp_account_setup(pg_temp.id('src'), pg_temp.id('dst'), 'interactive', '{"connectors":{"woo_store":"skip"}}');
  ASSERT (SELECT count(*) FROM public.ai_agent_test_cases WHERE social_account_id = pg_temp.id('dst')) = 100, 'M12 dst filled to the cap';
  ASSERT v->'left' @> '[{"item":"test_cases","count":2,"reason":"test_case_cap"}]', 'M12 two reported left: ' || v::text;
END $$;

-- M21 dismissal.
DO $$
BEGIN
  PERFORM public.dismiss_whatsapp_setup_move(pg_temp.id('dst'), pg_temp.id('src'));
  PERFORM public.dismiss_whatsapp_setup_move(pg_temp.id('dst'), pg_temp.id('src'));
  ASSERT (SELECT account_metadata->'setup_move_dismissed' FROM public.social_accounts WHERE id = pg_temp.id('dst'))
         = jsonb_build_array(pg_temp.id('src')::text), 'M21 dismissal stored once';
  BEGIN
    PERFORM public.dismiss_whatsapp_setup_move(pg_temp.id('dst'), pg_temp.id('acc_b'));
    RAISE EXCEPTION 'M21 failed: another user''s account dismissed' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

-- M22-M25: review fixes (clean-code-guard on PR-BC).
DO $$
DECLARE
  u uuid := pg_temp.id('u_a');
  s1 uuid := gen_random_uuid();
  d1 uuid := gen_random_uuid();
  d_inactive uuid := gen_random_uuid();
  d_retired uuid := gen_random_uuid();
  t_bound uuid := gen_random_uuid();
  t_shared uuid := gen_random_uuid();
  b_bound uuid := gen_random_uuid();
  b_shared uuid := gen_random_uuid();
  v jsonb;
BEGIN
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata)
  VALUES
    (s1, u, 'whatsapp', '96577777771', '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
    (d1, u, 'whatsapp', '96577777772', '', pg_temp.id('ws_a'), true, 'evolution_qr', '{}'),
    (d_inactive, u, 'whatsapp', '96577777773', '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
    (d_retired, u, 'whatsapp', 'retired_' || gen_random_uuid()::text, '', pg_temp.id('ws_a'), true, 'evolution_qr', '{}');
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (u, 'whatsapp', s1);
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t_bound, u, 'woo_m22', 'm22', 'woocommerce', s1, 'whatsapp', 'account');
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, scope)
  VALUES (t_shared, u, 'woo_shared_m23', 'm23', 'woocommerce', 'all_accounts');
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id) VALUES
    (b_bound, u, s1, t_bound, gen_random_uuid()),
    (b_shared, u, s1, t_shared, gen_random_uuid());

  -- M22: dst has no config, so the agent moves even with agent_config "destination";
  -- skipping the store-bound connector would strand its webhook -> refused.
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s1, d1, 'interactive',
      '{"agent_config":"destination","connectors":{"woo_m22":"skip"}}');
    RAISE EXCEPTION 'M22 failed: the agent moved away from a skipped store connector' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE '%store_connector_left_behind%', 'M22 reason token: ' || SQLERRM;
  END;

  -- M24: a retired or disconnected destination is refused.
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s1, d_inactive, 'auto');
    RAISE EXCEPTION 'M24 failed: an inactive destination accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE '%accounts_not_compatible%', 'M24 reason token: ' || SQLERRM;
  END;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s1, d_retired, 'auto');
    RAISE EXCEPTION 'M24 failed: a retired destination accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- M23: a binding on an all-accounts connector moves with the setup.
  v := public.move_whatsapp_account_setup(s1, d1, 'auto');
  ASSERT v->>'status' = 'moved', 'M23 moved: ' || v::text;
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE id = b_shared) = d1,
    'M23 the shared connector''s binding moved';
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE id = b_bound) = d1,
    'M23 the account connector''s binding moved';

  -- M25: dismissing the source of a pending deferral clears setup_move_pending.
  UPDATE public.social_accounts
     SET account_metadata = jsonb_build_object('setup_move_pending', jsonb_build_object('from', s1::text))
   WHERE id = d1;
  PERFORM public.dismiss_whatsapp_setup_move(d1, s1);
  ASSERT NOT (SELECT account_metadata ? 'setup_move_pending' FROM public.social_accounts WHERE id = d1),
    'M25 dismissing the pending source clears setup_move_pending';
END $$;

-- M15 / M16 / M20: activation carries the setup (20261004111000).
DO $$
DECLARE
  u uuid := pg_temp.id('u_a');
  old_row uuid := gen_random_uuid();
  new_row uuid := gen_random_uuid();
  tool uuid := gen_random_uuid();
  bind uuid := gen_random_uuid();
  est uuid := gen_random_uuid();
  dup2 uuid := gen_random_uuid();
  new2 uuid := gen_random_uuid();
  v text;
BEGIN
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata)
  VALUES
    (old_row, u, 'whatsapp', '96511111111', '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
    (new_row, u, 'whatsapp', 'pending_' || new_row::text, '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
    (est, u, 'whatsapp', '96522222222', '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}');
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (u, 'whatsapp', old_row);
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (tool, u, 'woo_m15', 'm15', 'woocommerce', old_row, 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id)
  VALUES (bind, u, old_row, tool, gen_random_uuid());

  v := public.activate_evolution_qr_account(new_row, '96511111111');
  ASSERT v = '96511111111', 'M15 activation returns the claimed number';
  ASSERT (SELECT platform_user_id FROM public.social_accounts WHERE id = old_row) = 'retired_' || old_row::text, 'M15 duplicate retired';
  ASSERT (SELECT account_metadata->>'retired_number' FROM public.social_accounts WHERE id = old_row) = '96511111111', 'M15 retired_number kept';
  ASSERT (SELECT platform_user_id || ':' || is_active::text FROM public.social_accounts WHERE id = new_row) = '96511111111:true',
    'M15 survivor active with the number';
  ASSERT (SELECT social_account_id FROM public.ai_agent_configs WHERE social_account_id IN (old_row, new_row)) = new_row, 'M15 agent config followed';
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE id = bind) = new_row, 'M15 binding followed, same id';

  v := public.activate_evolution_qr_account(est, '96533333333');
  ASSERT v = '96522222222', 'M16 an established row keeps its number';
  ASSERT (SELECT platform_user_id FROM public.social_accounts WHERE id = est) = '96522222222', 'M16 identity unchanged';

  -- M20: the survivor already has a config -> the move defers, activation still succeeds.
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata)
  VALUES (dup2, u, 'whatsapp', '96544444444', '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}'),
         (new2, u, 'whatsapp', 'pending_' || new2::text, '', pg_temp.id('ws_a'), false, 'evolution_qr', '{}');
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (u, 'whatsapp', dup2), (u, 'whatsapp', new2);
  v := public.activate_evolution_qr_account(new2, '96544444444');
  ASSERT v = '96544444444', 'M20 activation succeeds despite the conflict';
  ASSERT (SELECT account_metadata->'setup_move_pending'->>'from' FROM public.social_accounts WHERE id = new2) = dup2::text,
    'M20 the survivor is flagged for the banner';
  ASSERT (SELECT count(*) FROM public.ai_agent_configs WHERE social_account_id = dup2) = 1, 'M20 the duplicate keeps its config';
END $$;

-- M26-M40: test-guard gaps on PR-BC, plus the browser preview / candidate RPCs (20261004111500).
DO $$
DECLARE
  u uuid := pg_temp.id('u_a');
  ub uuid := pg_temp.id('u_b');
  ws uuid := pg_temp.id('ws_a');
  s uuid := gen_random_uuid();
  d uuid := gen_random_uuid();
  meta_src uuid := gen_random_uuid();
  meta_dst uuid := gen_random_uuid();
  b_other uuid := gen_random_uuid();
  t1 uuid := gen_random_uuid();
  t_meta uuid := gen_random_uuid();
  t_dst_bound uuid := gen_random_uuid();
  t_src2 uuid := gen_random_uuid();
  bind1 uuid := gen_random_uuid();
  key1 uuid := gen_random_uuid();
  wh1 uuid := gen_random_uuid();
  ev_sending uuid := gen_random_uuid();
  t1_spare uuid := gen_random_uuid();
  v jsonb;
  i int;
BEGIN
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode, account_metadata) VALUES
    (s, u, 'whatsapp', '96588888881', '', ws, false, 'evolution_qr', '{"waba_id":"w-a"}'),
    (d, u, 'whatsapp', '96588888882', '', ws, true, 'evolution_qr', '{"waba_id":"w-b"}'),
    (meta_src, u, 'whatsapp', '111222333', '', ws, false, 'cloud_api', '{"display_phone_number":"+965 8888 8899"}'),
    (meta_dst, u, 'whatsapp', '96588888899', '', ws, true, 'evolution_qr', '{}');

  -- M26 (M9 gap): another user's account in the SAME workspace is still refused.
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, is_active, connection_mode)
  VALUES (b_other, ub, 'whatsapp', '96588888883', '', ws, true, 'evolution_qr');
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s, b_other, 'auto');
    RAISE EXCEPTION 'M26 failed: cross-user move in one workspace accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- M27 (M10 gap): a pending_ SOURCE is refused.
  UPDATE public.social_accounts SET platform_user_id = 'pending_' || s::text WHERE id = s;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s, d, 'auto');
    RAISE EXCEPTION 'M27 failed: pending source accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  UPDATE public.social_accounts SET platform_user_id = '96588888881' WHERE id = s;

  -- Fixture: config, connector + binding, a link, partner items, a pending scheduled
  -- message, a WABA-mismatched template, 3 test cases.
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (u, 'whatsapp', s);
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope) VALUES
    (t1, u, 'woo_m28', 'm28', 'woocommerce', s, 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id) VALUES (bind1, u, s, t1, gen_random_uuid());
  INSERT INTO public.ai_agent_tool_accounts (tool_id, social_account_id, user_id) VALUES (t1, s, u);
  INSERT INTO public.partner_api_keys (id, workspace_id, social_account_id, name, key_prefix, key_hash, scopes, environment)
  VALUES (key1, ws, s, 'm28 key', 'pk_m28', 'hash-m28-' || key1::text, ARRAY['messages:send'], 'production');
  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id) VALUES (key1, s, ws);
  INSERT INTO public.partner_webhooks (id, workspace_id, created_by_key_id, url, events, platform, social_account_id, secret)
  VALUES (wh1, ws, key1, 'https://example.invalid/hook', ARRAY['webhook.test'], 'whatsapp', s, 'whsec');
  INSERT INTO public.whatsapp_scheduled_messages (user_id, social_account_id, recipient_phone, message_text, scheduled_at, status)
  VALUES (u, s, '96555500001', 'later', now() + interval '1 day', 'pending');
  INSERT INTO public.whatsapp_message_templates (user_id, social_account_id, template_name, template_language, template_category, template_status, components)
  VALUES (u, s, 'm28_tpl', 'ar', 'UTILITY', 'APPROVED', '[]');
  FOR i IN 1..3 LOOP
    INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected, position)
    VALUES (u, s, 'whatsapp', 'm28-' || i, '{}', 4 - i);
  END LOOP;

  -- M36: the preview names each connector and what stays behind (as user A).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  v := public.get_whatsapp_setup_move_preview(s, d);
  ASSERT v->'connectors' @> '[{"name":"woo_m28","has_store_webhook":true,"name_clash":false}]', 'M36 preview lists the connector: ' || v::text;
  ASSERT (v->>'source_has_agent')::boolean AND NOT (v->>'destination_has_agent')::boolean, 'M36 agent sides';
  ASSERT (v->>'partner_items')::int = 3, 'M36 partner items counted';
  ASSERT NOT (v->>'templates_move')::boolean AND (v->>'template_count')::int = 1, 'M36 template stays on a WABA change';
  -- M37a: a Meta row with no setup yet is not offered.
  v := public.list_whatsapp_setup_move_candidates(meta_dst);
  ASSERT NOT (v @> jsonb_build_array(jsonb_build_object('id', meta_src::text))), 'M37 a Meta row with no setup is not offered: ' || v::text;
  BEGIN
    PERFORM public.get_whatsapp_setup_move_preview(s, b_other);
    RAISE EXCEPTION 'M38 failed: preview of another user''s account' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  -- M28 (M1 gaps): partner items, links, scheduled message and test cases move; template stays.
  v := public.move_whatsapp_account_setup(s, d, 'auto');
  ASSERT v->>'status' = 'moved', 'M28 moved: ' || v::text;
  ASSERT (SELECT social_account_id FROM public.partner_api_keys WHERE id = key1) = d, 'M28 partner primary moved';
  ASSERT EXISTS (SELECT 1 FROM public.partner_api_key_accounts WHERE key_id = key1 AND social_account_id = d), 'M28 partner link moved';
  ASSERT (SELECT social_account_id FROM public.partner_webhooks WHERE id = wh1) = d, 'M28 partner webhook moved';
  ASSERT EXISTS (SELECT 1 FROM public.ai_agent_tool_accounts WHERE tool_id = t1 AND social_account_id = d), 'M28 connector link moved';
  ASSERT (SELECT count(*) FROM public.whatsapp_scheduled_messages WHERE social_account_id = d) = 1, 'M28 pending scheduled message moved';
  ASSERT (SELECT count(*) FROM public.whatsapp_message_templates WHERE social_account_id = s) = 1, 'M28 template stays (WABA mismatch)';
  ASSERT (SELECT count(*) FROM public.ai_agent_test_cases WHERE social_account_id = d) = 3, 'M28 test cases moved';

  -- M29 (M12 gap): with room for one, the lowest position moves first.
  DELETE FROM public.ai_agent_test_cases WHERE social_account_id IN (s, d);
  FOR i IN 1..99 LOOP
    INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected, position)
    VALUES (u, d, 'whatsapp', 'fill-' || i, '{}', i);
  END LOOP;
  INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected, position) VALUES
    (u, s, 'whatsapp', 'pos-5', '{}', 5), (u, s, 'whatsapp', 'pos-1', '{}', 1);
  v := public.move_whatsapp_account_setup(s, d, 'auto');
  ASSERT EXISTS (SELECT 1 FROM public.ai_agent_test_cases WHERE social_account_id = d AND message = 'pos-1'), 'M29 position 1 moved first';
  ASSERT EXISTS (SELECT 1 FROM public.ai_agent_test_cases WHERE social_account_id = s AND message = 'pos-5'), 'M29 position 5 left behind';

  -- M30 (M4 gap): with a destination config, the binding and waitlist stay with the source group.
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (u, 'whatsapp', s);
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t_src2, u, 'woo_m30', 'm30', 'woocommerce', s, 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (user_id, social_account_id, connector_id, secret_id) VALUES (u, s, t_src2, gen_random_uuid());
  INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id, product_name)
  VALUES (u, s, t_src2, 'wa_96588888881_96555500002', '96555500002', 30, 'P30');
  v := public.move_whatsapp_account_setup(s, d, 'auto');
  ASSERT v->>'status' = 'deferred', 'M30 deferred: ' || v::text;
  ASSERT (SELECT social_account_id FROM public.store_webhook_bindings WHERE connector_id = t_src2) = s, 'M30 binding stayed';
  ASSERT (SELECT count(*) FROM public.stock_waitlist WHERE connector_id = t_src2 AND social_account_id = s) = 1, 'M30 waitlist stayed';

  -- M31 (M17 gap): a 'sending' event also counts as in flight.
  INSERT INTO public.store_events (id, user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status, due_at, claimed_at, claim_token)
  SELECT ev_sending, u, s, t_src2, b.id, 'cod_confirm', 'm31', '{}', 'sending', now(), now(), gen_random_uuid()
    FROM public.store_webhook_bindings b WHERE b.connector_id = t_src2;
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s, d, 'interactive', '{"agent_config":"source"}');
    RAISE EXCEPTION 'M31 failed: interactive move during a sending event' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN object_in_use THEN NULL;
  END;
  UPDATE public.store_events SET status = 'sent', processed_at = now() WHERE id = ev_sending;

  -- M32: 'replace' refuses when the destination connector of that name owns a store webhook.
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t_dst_bound, u, 'woo_m30', 'dst m30', 'woocommerce', d, 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (user_id, social_account_id, connector_id, secret_id) VALUES (u, d, t_dst_bound, gen_random_uuid());
  BEGIN
    PERFORM public.move_whatsapp_account_setup(s, d, 'interactive', '{"agent_config":"source","connectors":{"woo_m30":"replace"}}');
    RAISE EXCEPTION 'M32 failed: replacing a store-bound destination connector accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE '%replaced_connector_has_store_webhook%', 'M32 reason: ' || SQLERRM;
  END;

  -- M33: 'replace' of an unbound destination connector deletes it and moves the source one.
  -- Re-point (not delete) the binding: deleting fires the Vault-secret reclaim trigger.
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t1_spare, u, 'woo_m33_spare', 'spare', 'woocommerce', d, 'whatsapp', 'account');
  UPDATE public.store_webhook_bindings SET connector_id = t1_spare WHERE connector_id = t_dst_bound;
  v := public.move_whatsapp_account_setup(s, d, 'interactive', '{"agent_config":"source","connectors":{"woo_m30":"replace"}}');
  ASSERT NOT EXISTS (SELECT 1 FROM public.ai_agent_tools WHERE id = t_dst_bound), 'M33 destination connector replaced';
  ASSERT (SELECT social_account_id FROM public.ai_agent_tools WHERE id = t_src2) = d, 'M33 source connector moved';

  -- M34 / M37b / M39: a Meta source matched by display_phone_number is offered, can be
  -- dismissed, and moves its waitlist (same number).
  INSERT INTO public.ai_agent_configs (user_id, platform, social_account_id) VALUES (u, 'whatsapp', meta_src);
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type, social_account_id, platform, scope)
  VALUES (t_meta, u, 'woo_m34', 'm34', 'woocommerce', meta_src, 'whatsapp', 'account');
  INSERT INTO public.store_webhook_bindings (user_id, social_account_id, connector_id, secret_id) VALUES (u, meta_src, t_meta, gen_random_uuid());
  INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id, product_name)
  VALUES (u, meta_src, t_meta, 'wa_x', '96555500003', 34, 'P34');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  v := public.list_whatsapp_setup_move_candidates(meta_dst);
  ASSERT v @> jsonb_build_array(jsonb_build_object('id', meta_src::text, 'reason', 'same_number')),
    'M37 a Meta row with setup is offered by number: ' || v::text;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM public.dismiss_whatsapp_setup_move(meta_dst, meta_src);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  v := public.list_whatsapp_setup_move_candidates(meta_dst);
  ASSERT NOT (v @> jsonb_build_array(jsonb_build_object('id', meta_src::text))), 'M39 a dismissed candidate is not offered';
  PERFORM set_config('request.jwt.claims', '', true);
  v := public.move_whatsapp_account_setup(meta_src, meta_dst, 'auto');
  ASSERT (SELECT count(*) FROM public.stock_waitlist WHERE social_account_id = meta_dst) = 1, 'M34 waitlist moved on a matching Meta number';

  ASSERT NOT has_function_privilege('anon', 'public.list_whatsapp_setup_move_candidates(uuid)', 'EXECUTE'), 'M40 anon cannot list candidates';
  ASSERT NOT has_function_privilege('service_role', 'public.get_whatsapp_setup_move_preview(uuid,uuid)', 'EXECUTE'), 'M40 preview is browser-only';
END $$;

ROLLBACK;

\echo '=== whatsapp_account_setup_move: ALL CHECKS PASSED ==='
