-- supabase/tests/agent_procedures_b.sql
-- Spec B PR 1 (Task 1): store_events receive-and-store migration.
-- Style: one transaction, fixtures inside, labelled B1..Bn ASSERTs, expected
-- errors in nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last.
-- Fixture values are synthetic ('...@example.invalid', '9655551xxxx' test
-- range); no secrets or real data. Vault round-trip (B14) runs only when the
-- supabase_vault extension is present, like byok_provider_keys.sql.
BEGIN;
DO $$
DECLARE
  u_a uuid := '11111111-1111-4111-8111-111111111111';
  u_b uuid := '22222222-2222-4222-8222-222222222222';
  acct_a uuid := '33333333-3333-4333-8333-333333333333';
  acct_b uuid := '44444444-4444-4334-8444-444444444444';
  tool_a uuid := '55555555-5555-4555-8555-555555555555';
  tool_b uuid := '66666666-6666-4666-8666-666666666666';
  tool_c uuid := '12121212-1212-4121-8121-121212121212';
  tool_d uuid := '34343434-3434-4343-8343-343434343434';
  bind_a uuid := '77777777-7777-4777-8777-777777777777';
  bind_b uuid := '88888888-8888-4888-8888-888888888888';
BEGIN
  -- Fixtures. platform 'facebook' avoids the whatsapp-needs-workspace check.
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'procedures-b-a-' || u_a::text || '@example.invalid'),
    (u_b, 'procedures-b-b-' || u_b::text || '@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES
    (acct_a, u_a, 'facebook', 'procb-acct-a', 'token-a'),
    (acct_b, u_b, 'facebook', 'procb-acct-b', 'token-b');
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type)
  VALUES
    (tool_a, u_a, 'woo-a', 'procedures B fixture A', 'woocommerce'),
    (tool_b, u_b, 'woo-b', 'procedures B fixture B', 'woocommerce'),
    (tool_c, u_a, 'woo-c', 'procedures B spare A', 'woocommerce'),
    (tool_d, u_b, 'woo-d', 'procedures B spare B', 'woocommerce');
  INSERT INTO public.store_webhook_bindings
    (id, user_id, social_account_id, connector_id, secret_id)
  VALUES
    (bind_a, u_a, acct_a, tool_a, gen_random_uuid()),
    (bind_b, u_b, acct_b, tool_b, gen_random_uuid());
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow, external_id,
     payload, status, due_at)
  VALUES
    (u_b, acct_b, tool_b, bind_b, 'cod_confirm', 'order-1',
     '{"order_id":"1"}', 'pending', now());
  INSERT INTO public.stock_waitlist
    (user_id, social_account_id, connector_id, conversation_id, phone,
     product_id, product_name)
  VALUES
    (u_a, acct_a, tool_a, 'wa_test_a', '96555512345', 101, 'Test Product A'),
    (u_b, acct_b, tool_b, 'wa_test_b', '96555519999', 202, 'Test Product B');
  INSERT INTO public.messaging_opt_outs (user_id, phone, source)
  VALUES
    (u_a, '96555512345', 'chat'),
    (u_b, '96555519999', 'chat');

  -- B1: the objects exist and the new tables have RLS on.
  ASSERT to_regclass('public.store_webhook_bindings') IS NOT NULL,
    'B1 store_webhook_bindings exists';
  ASSERT to_regclass('public.store_events') IS NOT NULL,
    'B1 store_events exists';
  ASSERT to_regclass('public.stock_waitlist') IS NOT NULL,
    'B1 stock_waitlist exists';
  ASSERT to_regclass('public.messaging_opt_outs') IS NOT NULL,
    'B1 messaging_opt_outs exists';
  ASSERT to_regprocedure('public.create_store_webhook_secret(text)') IS NOT NULL,
    'B1 create_store_webhook_secret exists';
  ASSERT to_regprocedure('public.get_store_webhook_secret(uuid)') IS NOT NULL,
    'B1 get_store_webhook_secret exists';
  ASSERT (SELECT count(*) FROM pg_class
           WHERE relname IN ('store_webhook_bindings', 'store_events',
                             'stock_waitlist', 'messaging_opt_outs')
             AND relnamespace = 'public'::regnamespace
             AND relrowsecurity) = 4,
    'B1 RLS is on for all four tables';

  -- B2: the composite keys exist; social_accounts reuses its existing one.
  ASSERT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ai_agent_tools_id_user_id_key'
                    AND conrelid = 'public.ai_agent_tools'::regclass),
    'B2 ai_agent_tools (id, user_id) unique exists';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'social_accounts_id_user_id_key'
                    AND conrelid = 'public.social_accounts'::regclass),
    'B2 social_accounts (id, user_id) unique reused';

  -- B3: bindings are unique per connector.
  BEGIN
    INSERT INTO public.store_webhook_bindings
      (user_id, social_account_id, connector_id, secret_id)
    VALUES (u_a, acct_a, tool_a, gen_random_uuid());
    RAISE EXCEPTION 'B3 failed: duplicate connector binding accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- B4: events are unique per (binding, flow, external_id).
  BEGIN
    INSERT INTO public.store_events
      (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload)
    VALUES (u_b, acct_b, tool_b, bind_b, 'cod_confirm', 'order-1', '{}');
    RAISE EXCEPTION 'B4 failed: duplicate event accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload)
  VALUES (u_b, acct_b, tool_b, bind_b, 'review_request', 'order-1', '{}');
  ASSERT (SELECT count(*) FROM public.store_events
           WHERE binding_id = bind_b AND external_id = 'order-1') = 2,
    'B4 same external_id under another flow accepted';

  -- B5: the status check holds, and 'sending' is a legal status.
  BEGIN
    INSERT INTO public.store_events
      (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status)
    VALUES (u_b, acct_b, tool_b, bind_b, 'cod_confirm', 'order-bogus', '{}', 'bogus');
    RAISE EXCEPTION 'B5 failed: bogus status accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status)
  VALUES (u_b, acct_b, tool_b, bind_b, 'cod_confirm', 'order-sending', '{}', 'sending');
  ASSERT (SELECT status FROM public.store_events
           WHERE binding_id = bind_b AND external_id = 'order-sending') = 'sending',
    'B5 sending status accepted';

  -- B6: waitlist is unique per (connector, phone, product).
  BEGIN
    INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id)
    VALUES (u_b, acct_b, tool_b, 'wa_test_b', '96555519999', 202);
    RAISE EXCEPTION 'B6 failed: duplicate waitlist row accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- B7: opt-outs are unique per (user, phone).
  BEGIN
    INSERT INTO public.messaging_opt_outs (user_id, phone)
    VALUES (u_b, '96555519999');
    RAISE EXCEPTION 'B7 failed: duplicate opt-out accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- B8: a binding whose account belongs to another user fails the FK, and so
  -- does one whose connector belongs to another user (spare tools keep the
  -- connector unique out of the way).
  BEGIN
    INSERT INTO public.store_webhook_bindings
      (user_id, social_account_id, connector_id, secret_id)
    VALUES (u_a, acct_b, tool_c, gen_random_uuid());
    RAISE EXCEPTION 'B8 failed: cross-user account binding accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.store_webhook_bindings
      (user_id, social_account_id, connector_id, secret_id)
    VALUES (u_a, acct_a, tool_d, gen_random_uuid());
    RAISE EXCEPTION 'B8 failed: cross-user connector binding accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- RLS checks as user A. SET ROLE is a statement-level command: it cannot run
-- inside a DO block.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-4111-8111-111111111111',
                    'role', 'authenticated')::text, true);

DO $$
BEGIN
  -- B9: A reads their own waitlist row and none of B's.
  ASSERT (SELECT count(*) FROM public.stock_waitlist) = 1,
    'B9 user A reads exactly their own waitlist row';
  ASSERT (SELECT count(*) FROM public.stock_waitlist
           WHERE user_id = '22222222-2222-4222-8222-222222222222') = 0,
    'B9 user A reads 0 of user B waitlist rows';
  ASSERT has_table_privilege('authenticated', 'public.stock_waitlist', 'DELETE'),
    'B9 authenticated holds DELETE on stock_waitlist';

  -- B10: A reads their own opt-out and none of B's.
  ASSERT (SELECT count(*) FROM public.messaging_opt_outs) = 1,
    'B10 user A reads exactly their own opt-out';
  ASSERT (SELECT count(*) FROM public.messaging_opt_outs
           WHERE user_id = '22222222-2222-4222-8222-222222222222') = 0,
    'B10 user A reads 0 of user B opt-out rows';

  -- B11: A reads their own binding and none of B's; bindings are read-only
  -- to the owner.
  ASSERT (SELECT count(*) FROM public.store_webhook_bindings) = 1,
    'B11 user A reads exactly their own binding';
  ASSERT (SELECT count(*) FROM public.store_webhook_bindings
           WHERE user_id = '22222222-2222-4222-8222-222222222222') = 0,
    'B11 user A reads 0 of user B binding rows';
  ASSERT NOT has_table_privilege('authenticated',
             'public.store_webhook_bindings', 'INSERT'),
    'B11 authenticated holds no INSERT on bindings';

  -- B12: store_events is invisible to authenticated clients.
  ASSERT NOT has_table_privilege('authenticated', 'public.store_events', 'SELECT'),
    'B12 authenticated holds no SELECT on store_events';
  BEGIN
    PERFORM 1 FROM public.store_events LIMIT 1;
    RAISE EXCEPTION 'B12 failed: authenticated SELECT on store_events accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

DO $$
BEGIN
  -- B13: the two vault wrappers are service-role only.
  ASSERT NOT has_function_privilege('anon',
             'public.create_store_webhook_secret(text)', 'EXECUTE'),
    'B13 anon cannot EXECUTE create_store_webhook_secret';
  ASSERT NOT has_function_privilege('authenticated',
             'public.create_store_webhook_secret(text)', 'EXECUTE'),
    'B13 authenticated cannot EXECUTE create_store_webhook_secret';
  ASSERT NOT has_function_privilege('anon',
             'public.get_store_webhook_secret(uuid)', 'EXECUTE'),
    'B13 anon cannot EXECUTE get_store_webhook_secret';
  ASSERT NOT has_function_privilege('authenticated',
             'public.get_store_webhook_secret(uuid)', 'EXECUTE'),
    'B13 authenticated cannot EXECUTE get_store_webhook_secret';
  ASSERT has_function_privilege('service_role',
             'public.create_store_webhook_secret(text)', 'EXECUTE'),
    'B13 service_role can EXECUTE create_store_webhook_secret';
  ASSERT has_function_privilege('service_role',
             'public.get_store_webhook_secret(uuid)', 'EXECUTE'),
    'B13 service_role can EXECUTE get_store_webhook_secret';
END $$;

-- B14: a created secret round-trips through the binding read, including the
-- rotation fields. Skipped with a NOTICE where supabase_vault is absent: the
-- function bodies resolve vault.* only at execution time.
DO $procb_vault$
DECLARE
  v_vault_present boolean;
  v_first uuid;
  v_second uuid;
  v_binding uuid := '99999999-9999-4999-8999-999999999999';
  v_got jsonb;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_vault_present;
  IF NOT v_vault_present THEN
    RAISE NOTICE 'vault absent: skipping B14 secret round-trip assertions';
    RETURN;
  END IF;

  v_first := public.create_store_webhook_secret('whsec-test-current-001');
  ASSERT v_first IS NOT NULL, 'B14 created secret id returned';
  INSERT INTO public.store_webhook_bindings
    (id, user_id, social_account_id, connector_id, secret_id)
  VALUES (v_binding, '11111111-1111-4111-8111-111111111111',
          '33333333-3333-4333-8333-333333333333',
          '12121212-1212-4121-8121-121212121212', v_first);

  v_got := public.get_store_webhook_secret(v_binding);
  ASSERT (v_got->>'current') = 'whsec-test-current-001',
    'B14 current secret round-trips';
  ASSERT (v_got->>'previous') IS NULL,
    'B14 previous is null before rotation';
  ASSERT (v_got->>'rotated_at') IS NULL,
    'B14 rotated_at is null before rotation';

  v_second := public.create_store_webhook_secret('whsec-test-current-002');
  UPDATE public.store_webhook_bindings
  SET previous_secret_id = secret_id,
      secret_id = v_second,
      rotated_at = now()
  WHERE id = v_binding;

  v_got := public.get_store_webhook_secret(v_binding);
  ASSERT (v_got->>'current') = 'whsec-test-current-002',
    'B14 current secret round-trips after rotation';
  ASSERT (v_got->>'previous') = 'whsec-test-current-001',
    'B14 previous secret round-trips after rotation';
  ASSERT (v_got->>'rotated_at') IS NOT NULL,
    'B14 rotated_at set after rotation';

  ASSERT (public.get_store_webhook_secret(gen_random_uuid())) IS NULL,
    'B14 unknown binding reads as NULL, not an empty object';
END $procb_vault$;

-- B15..B19: store_events rows are bound to their binding structurally.
-- bind_a is (u_a, acct_a, tool_a); tool_c is u_a's spare connector, so only
-- the connector leg differs in B16.
DO $$
DECLARE
  u_a uuid := '11111111-1111-4111-8111-111111111111';
  u_b uuid := '22222222-2222-4222-8222-222222222222';
  acct_a uuid := '33333333-3333-4333-8333-333333333333';
  acct_b uuid := '44444444-4444-4334-8444-444444444444';
  tool_a uuid := '55555555-5555-4555-8555-555555555555';
  tool_c uuid := '12121212-1212-4121-8121-121212121212';
  bind_a uuid := '77777777-7777-4777-8777-777777777777';
BEGIN
  -- B15: a social_account_id that differs from the binding fails the FK.
  BEGIN
    INSERT INTO public.store_events
      (user_id, social_account_id, connector_id, binding_id, flow,
       external_id, payload)
    VALUES (u_a, acct_b, tool_a, bind_a, 'cod_confirm', 'order-b15-acct',
            '{"order_id":"b15"}');
    RAISE EXCEPTION 'B15 failed: cross-account event accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- B16: a connector_id that differs from the binding fails the FK.
  BEGIN
    INSERT INTO public.store_events
      (user_id, social_account_id, connector_id, binding_id, flow,
       external_id, payload)
    VALUES (u_a, acct_a, tool_c, bind_a, 'cod_confirm', 'order-b16-tool',
            '{"order_id":"b16"}');
    RAISE EXCEPTION 'B16 failed: cross-connector event accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- B17: a user_id that differs from the binding fails the FK.
  BEGIN
    INSERT INTO public.store_events
      (user_id, social_account_id, connector_id, binding_id, flow,
       external_id, payload)
    VALUES (u_b, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b17-user',
            '{"order_id":"b17"}');
    RAISE EXCEPTION 'B17 failed: cross-user event accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- B18: a null social_account_id fails NOT NULL, not the FK.
  BEGIN
    INSERT INTO public.store_events
      (user_id, social_account_id, connector_id, binding_id, flow,
       external_id, payload)
    VALUES (u_a, NULL, tool_a, bind_a, 'cod_confirm', 'order-b18-null',
            '{"order_id":"b18"}');
    RAISE EXCEPTION 'B18 failed: null social_account_id accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;

  -- B19: a row whose identity matches its binding inserts.
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload)
  VALUES (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b19-ok',
          '{"order_id":"b19"}');
  ASSERT (SELECT count(*) FROM public.store_events
           WHERE binding_id = bind_a AND external_id = 'order-b19-ok') = 1,
    'B19 matching identity row inserts';
END $$;

-- B20 (reclaim; task spec "B16" -- the B16 label is already taken above by
-- the cross-connector FK check, so numbering continues after B19): deleting
-- a binding reclaims both its vault secrets. tool_d is u_b's spare connector
-- (tool_c is already bound by B14's rotation binding), so the connector
-- unique stays out of the way. Skipped with a NOTICE where supabase_vault is
-- absent, like B14.
DO $procb_reclaim$
DECLARE
  v_vault_present boolean;
  v_current uuid;
  v_previous uuid;
  v_binding uuid := 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1';
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_vault_present;
  IF NOT v_vault_present THEN
    RAISE NOTICE 'vault absent: skipping B20 secret reclaim assertions';
    RETURN;
  END IF;

  v_current := public.create_store_webhook_secret('whsec-reclaim-current-001');
  v_previous := public.create_store_webhook_secret('whsec-reclaim-previous-001');
  ASSERT v_current IS NOT NULL AND v_previous IS NOT NULL,
    'B20 both secret ids returned';
  ASSERT (SELECT count(*) FROM vault.secrets
          WHERE id IN (v_current, v_previous)) = 2,
    'B20 both secrets present before binding delete';

  INSERT INTO public.store_webhook_bindings
    (id, user_id, social_account_id, connector_id, secret_id, previous_secret_id)
  VALUES (v_binding, '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4334-8444-444444444444',
          '34343434-3434-4343-8343-343434343434', v_current, v_previous);

  DELETE FROM public.store_webhook_bindings WHERE id = v_binding;

  ASSERT NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_current),
    'B20 current secret reclaimed on binding delete';
  ASSERT NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_previous),
    'B20 previous secret reclaimed on binding delete';
END $procb_reclaim$;

ROLLBACK;
\echo '=== agent_procedures_b: ALL CHECKS PASSED ==='
