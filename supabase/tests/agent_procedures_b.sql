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

  -- B6: waitlist is unique per (social_account_id, connector, phone, product).
  BEGIN
    INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id)
    VALUES (u_b, acct_b, tool_b, 'wa_test_b', '96555519999', 202);
    RAISE EXCEPTION 'B6 failed: duplicate waitlist row accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- B6b: the same phone+product+connector under two different social
  -- accounts inserts two rows (per-account uniqueness). The probe rows are
  -- deleted afterwards so B9 still sees exactly one waitlist row for user A.
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES ('c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9', u_a, 'facebook', 'procb-acct-a2', 'token-a2');
  INSERT INTO public.stock_waitlist (user_id, social_account_id, connector_id, conversation_id, phone, product_id)
  VALUES
    (u_a, acct_a, tool_a, 'wa_b6_a', '96555510001', 301),
    (u_a, 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9', tool_a, 'wa_b6_b', '96555510001', 301);
  ASSERT (SELECT count(*) FROM public.stock_waitlist
           WHERE connector_id = tool_a AND phone = '96555510001' AND product_id = 301) = 2,
    'B6 same phone+product+connector under two accounts inserts two rows';
  DELETE FROM public.stock_waitlist
  WHERE connector_id = tool_a AND phone = '96555510001' AND product_id = 301;

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

-- B21..B29: the fenced claim, the QR cap, and their grants. Fixtures reuse
-- bind_a's identity (u_a, acct_a, tool_a) so the tenant FK holds. due_at
-- values are staggered so ORDER BY due_at picks the B21 rows first: older
-- rows from B4/B19 all sit at the transaction's now().
DO $$
DECLARE
  u_a uuid := '11111111-1111-4111-8111-111111111111';
  acct_a uuid := '33333333-3333-4333-8333-333333333333';
  tool_a uuid := '55555555-5555-4555-8555-555555555555';
  bind_a uuid := '77777777-7777-4777-8777-777777777777';
  v_claimed text[];
  v_old_token uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_b21_oldest_token uuid;
  v_b21_middle_token uuid;
  v_got uuid;
  v_ok boolean;
  v_stale_rows int := -1;
  v_i int;
  v_qr uuid[];
BEGIN
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b21-oldest',
     '{"order_id":"b21-a"}', 'pending', now() - interval '1 hour'),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b21-middle',
     '{"order_id":"b21-b"}', 'pending', now() - interval '50 minutes'),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b21-newest',
     '{"order_id":"b21-c"}', 'pending', now() - interval '40 minutes'),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b21-future',
     '{"order_id":"b21-f"}', 'pending', now() + interval '1 hour');

  -- B21: at most p_limit rows come back, oldest due first.
  SELECT array_agg(external_id)
    INTO v_claimed
    FROM public.claim_store_events(2, interval '2 minutes');
  ASSERT array_length(v_claimed, 1) = 2,
    'B21 claim returns exactly p_limit rows';
  ASSERT v_claimed @> ARRAY['order-b21-oldest', 'order-b21-middle'],
    'B21 claim takes the oldest due rows first';

  -- B22: a row due in the future is skipped (still pending, no token).
  ASSERT (SELECT status FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b21-future') = 'pending',
    'B22 future due_at row stays pending';
  ASSERT (SELECT claim_token FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b21-future') IS NULL,
    'B22 future due_at row gets no claim token';

  -- B23: every claimed row carries a fresh token.
  ASSERT (SELECT count(*) FROM public.store_events
          WHERE external_id = ANY (v_claimed)
            AND claim_token IS NULL) = 0,
    'B23 claimed rows all carry a claim token';
  ASSERT (SELECT count(*) FROM public.store_events
          WHERE external_id = ANY (v_claimed)
            AND status = 'claimed') = array_length(v_claimed, 1),
    'B23 claimed rows are in claimed status';

  SELECT claim_token INTO v_b21_oldest_token FROM public.store_events
  WHERE binding_id = bind_a AND external_id = 'order-b21-oldest';
  SELECT claim_token INTO v_b21_middle_token FROM public.store_events
  WHERE binding_id = bind_a AND external_id = 'order-b21-middle';

  -- Reclaim fixtures: an expired lease, an exhausted row, an expired send.
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at, claimed_at, claim_token, attempts)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b24-reclaim',
     '{"order_id":"b24"}', 'claimed', now() - interval '1 hour',
     now() - interval '10 minutes', v_old_token, 1),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b25-exhausted',
     '{"order_id":"b25"}', 'claimed', now() - interval '1 hour',
     now() - interval '10 minutes', gen_random_uuid(), 3),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b26-sending',
     '{"order_id":"b26"}', 'sending', now() - interval '1 hour',
     now() - interval '10 minutes', v_old_token, 1);
  UPDATE public.store_events
  SET outbound_message_id = 'b26-mid'
  WHERE binding_id = bind_a AND external_id = 'order-b26-sending';

  PERFORM public.claim_store_events(10, interval '2 minutes');

  ASSERT (SELECT claim_token FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b21-oldest') = v_b21_oldest_token,
    'B21 unexpired oldest row keeps its original claim token';
  ASSERT (SELECT claim_token FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b21-middle') = v_b21_middle_token,
    'B21 unexpired middle row keeps its original claim token';

  -- B24: the expired lease is reclaimed under a new token, attempts + 1.
  ASSERT (SELECT status FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b24-reclaim') = 'claimed',
    'B24 expired lease stays claimed';
  SELECT claim_token INTO v_got FROM public.store_events
  WHERE binding_id = bind_a AND external_id = 'order-b24-reclaim';
  ASSERT v_got IS NOT NULL AND v_got <> v_old_token,
    'B24 expired lease carries a new claim token';
  ASSERT (SELECT attempts FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b24-reclaim') = 2,
    'B24 reclaim bumps attempts';
  UPDATE public.store_events
  SET skip_reason = 'stale-token-write'
  WHERE binding_id = bind_a
    AND external_id = 'order-b24-reclaim'
    AND claim_token = v_old_token;
  GET DIAGNOSTICS v_stale_rows = ROW_COUNT;
  ASSERT v_stale_rows = 0,
    'B24 update with the old claim token touches 0 rows';

  -- B25: three attempts on an expired lease means failed, never reclaimed.
  ASSERT (SELECT status FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b25-exhausted') = 'failed',
    'B25 exhausted row is marked failed';
  ASSERT (SELECT skip_reason FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b25-exhausted') = 'attempts_exhausted',
    'B25 exhausted row carries attempts_exhausted';
  ASSERT (SELECT processed_at FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b25-exhausted') IS NOT NULL,
    'B25 exhausted row carries processed_at';

  -- B26: an expired send is indeterminate: still sending, new token, no resend.
  ASSERT (SELECT status FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b26-sending') = 'sending',
    'B26 expired sending row stays sending';
  SELECT claim_token INTO v_got FROM public.store_events
  WHERE binding_id = bind_a AND external_id = 'order-b26-sending';
  ASSERT v_got IS NOT NULL AND v_got <> v_old_token,
    'B26 expired sending row carries a new claim token';
  ASSERT (SELECT outbound_message_id FROM public.store_events
          WHERE binding_id = bind_a AND external_id = 'order-b26-sending') = 'b26-mid',
    'B26 expired sending row keeps its outbound id (worker must not resend)';

  -- B27: the QR cap grants exactly p_limit reservations, one event each,
  -- then refuses. The fourth event gets no reservation row.
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b27-1', '{}', 'pending', now()),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b27-2', '{}', 'pending', now()),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b27-3', '{}', 'pending', now()),
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b27-4', '{}', 'pending', now());
  SELECT array_agg(id ORDER BY external_id)
    INTO v_qr
    FROM public.store_events
    WHERE binding_id = bind_a
      AND external_id LIKE 'order-b27-%';
  FOR v_i IN 1..3 LOOP
    v_ok := public.reserve_qr_opener(acct_a, 3, v_qr[v_i]);
    ASSERT v_ok, 'B27 reservation ' || v_i || ' of 3 granted';
  END LOOP;
  ASSERT NOT public.reserve_qr_opener(acct_a, 3, v_qr[4]),
    'B27 fourth reservation refused at the cap';
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a
            AND day = (now() AT TIME ZONE 'utc')::date) = 3,
    'B27 counter holds exactly the cap';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.store_qr_opener_reservations
    WHERE store_event_id = v_qr[4]
  ), 'B27 refused reservation leaves no row';

  -- B28: release walks the counter down, one event at a time, and a release
  -- with no reservation row does not move it. The counter never drops below zero.
  PERFORM public.release_qr_opener(acct_a, v_qr[1]);
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a
            AND day = (now() AT TIME ZONE 'utc')::date) = 2,
    'B28 release decrements the counter';
  PERFORM public.release_qr_opener(acct_a, v_qr[2]);
  PERFORM public.release_qr_opener(acct_a, v_qr[3]);
  PERFORM public.release_qr_opener(acct_a, v_qr[3]);
  PERFORM public.release_qr_opener(acct_a, v_qr[4]);
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a
            AND day = (now() AT TIME ZONE 'utc')::date) = 0,
    'B28 counter never drops below zero';

  -- B29: the three worker functions are service-role only, and the counter
  -- table is invisible to client roles.
  ASSERT NOT has_function_privilege('anon',
             'public.claim_store_events(int, interval)', 'EXECUTE'),
    'B29 anon cannot EXECUTE claim_store_events';
  ASSERT NOT has_function_privilege('authenticated',
             'public.claim_store_events(int, interval)', 'EXECUTE'),
    'B29 authenticated cannot EXECUTE claim_store_events';
  ASSERT has_function_privilege('service_role',
             'public.claim_store_events(int, interval)', 'EXECUTE'),
    'B29 service_role can EXECUTE claim_store_events';
  ASSERT NOT has_function_privilege('anon',
             'public.reserve_qr_opener(uuid, int, uuid)', 'EXECUTE'),
    'B29 anon cannot EXECUTE reserve_qr_opener';
  ASSERT NOT has_function_privilege('authenticated',
             'public.reserve_qr_opener(uuid, int, uuid)', 'EXECUTE'),
    'B29 authenticated cannot EXECUTE reserve_qr_opener';
  ASSERT has_function_privilege('service_role',
             'public.reserve_qr_opener(uuid, int, uuid)', 'EXECUTE'),
    'B29 service_role can EXECUTE reserve_qr_opener';
  ASSERT NOT has_function_privilege('anon',
             'public.release_qr_opener(uuid, uuid)', 'EXECUTE'),
    'B29 anon cannot EXECUTE release_qr_opener';
  ASSERT NOT has_function_privilege('authenticated',
             'public.release_qr_opener(uuid, uuid)', 'EXECUTE'),
    'B29 authenticated cannot EXECUTE release_qr_opener';
  ASSERT has_function_privilege('service_role',
             'public.release_qr_opener(uuid, uuid)', 'EXECUTE'),
    'B29 service_role can EXECUTE release_qr_opener';
  ASSERT NOT has_table_privilege('authenticated',
             'public.store_qr_opener_counts', 'SELECT'),
    'B29 authenticated holds no SELECT on store_qr_opener_counts';
  ASSERT NOT has_table_privilege('anon',
             'public.store_qr_opener_reservations', 'SELECT'),
    'B29 anon holds no SELECT on store_qr_opener_reservations';
  ASSERT NOT has_table_privilege('authenticated',
             'public.store_qr_opener_reservations', 'SELECT'),
    'B29 authenticated holds no SELECT on store_qr_opener_reservations';
  ASSERT has_table_privilege('service_role',
             'public.store_qr_opener_reservations', 'INSERT'),
    'B29 service_role can INSERT store_qr_opener_reservations';
END $$;

-- B30: both cron jobs exist. Skipped with a NOTICE where pg_cron is absent:
-- the harness baseline has no pg_cron, production does.
DO $procb_cron$
DECLARE
  v_cron_present boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    INTO v_cron_present;
  IF NOT v_cron_present THEN
    RAISE NOTICE 'pg_cron absent: skipping B30 cron assertions';
    RETURN;
  END IF;

  ASSERT EXISTS (SELECT 1 FROM cron.job
                 WHERE jobname = 'process-store-events'
                   AND schedule = '* * * * *'),
    'B30 process-store-events runs every minute';
  ASSERT EXISTS (SELECT 1 FROM cron.job
                 WHERE jobname = 'purge-store-events'
                   AND schedule = '27 3 * * *'),
    'B30 purge-store-events runs daily';
END $procb_cron$;

-- B31: a pending row at 3 attempts (released back after a transient read)
-- exhausts on the next claim instead of being reclaimed, and logs one
-- sanitized system_logs row. Payload carries a phone number so the log
-- sanitization assert is meaningful.
DO $$
DECLARE
  u_a uuid := '11111111-1111-4111-8111-111111111111';
  acct_a uuid := '33333333-3333-4333-8333-333333333333';
  tool_a uuid := '55555555-5555-4555-8555-555555555555';
  bind_a uuid := '77777777-7777-4777-8777-777777777777';
  v_event uuid;
  v_claimed text[];
  v_log jsonb;
BEGIN
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at, attempts)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-b31-pending-exhausted',
     '{"order_id":"b31","phone":"96555519999"}', 'pending',
     now() - interval '1 hour', 3)
  RETURNING id INTO v_event;

  SELECT array_agg(external_id)
    INTO v_claimed
    FROM public.claim_store_events(10, interval '2 minutes');

  ASSERT (SELECT status FROM public.store_events WHERE id = v_event) = 'failed',
    'B31 pending row at 3 attempts is marked failed';
  ASSERT (SELECT skip_reason FROM public.store_events WHERE id = v_event) = 'attempts_exhausted',
    'B31 pending exhausted row carries attempts_exhausted';
  ASSERT (SELECT processed_at FROM public.store_events WHERE id = v_event) IS NOT NULL,
    'B31 pending exhausted row carries processed_at';
  ASSERT COALESCE(v_claimed @> ARRAY['order-b31-pending-exhausted'], false) = false,
    'B31 pending exhausted row is not returned by the claim';

  SELECT metadata INTO v_log FROM public.system_logs
  WHERE metadata->>'event_id' = v_event::text
  ORDER BY created_at DESC LIMIT 1;
  ASSERT v_log IS NOT NULL,
    'B31 exhausted event has a system_logs row';
  ASSERT NOT (v_log ? 'phone'),
    'B31 system_logs metadata contains no phone key';
  ASSERT NOT (v_log ? 'payload'),
    'B31 system_logs metadata contains no payload';
  ASSERT (SELECT message FROM public.system_logs
          WHERE metadata->>'event_id' = v_event::text
          ORDER BY created_at DESC LIMIT 1) = 'Store event failed after 3 attempts',
    'B31 system_logs row carries the exhaustion message';
  ASSERT (SELECT source FROM public.system_logs
          WHERE metadata->>'event_id' = v_event::text
          ORDER BY created_at DESC LIMIT 1) = 'process-store-events',
    'B31 system_logs row carries the process-store-events source';
END $$;

ROLLBACK;
BEGIN;
-- ---------------------------------------------------------------------------
-- B40: system_logs category CHECK (migration 20260928120000 section 0): system_logs category 'ai' inserts succeed, 'bogus' is refused.
-- ---------------------------------------------------------------------------
DO $do_system_logs_category_suite$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.system_logs (level, category, source, message, metadata)
  VALUES ('info', 'ai', 'migration-suite', 'suite probe', '{}'::jsonb)
  RETURNING id INTO v_id;

  ASSERT v_id IS NOT NULL, 'system_logs category ''ai'' insert returned no id';

  DELETE FROM public.system_logs WHERE id = v_id;

  BEGIN
    INSERT INTO public.system_logs (level, category, source, message, metadata)
    VALUES ('info', 'bogus', 'migration-suite', 'suite probe', '{}'::jsonb);
    RAISE EXCEPTION 'system_logs accepted category ''bogus''';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $do_system_logs_category_suite$;
ROLLBACK;
BEGIN;
-- ---------------------------------------------------------------------------
-- E1..E5: optout exhaustion clears the stranded pending_opener (migration
-- 20260929100000_optout_exhaustion). claim_store_events marks attempts>=3
-- events failed, logs reason attempts_exhausted, and NULLs the matching
-- pending_opener thread; whatsapp_broadcast_recipients gains 'skipped'.
-- Fixture values are synthetic ('...@example.invalid', '9655551xxxx' test
-- range); no secrets or real data.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  u_b uuid := 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
  acct_a uuid := 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
  tool_a uuid := 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
  bind_a uuid := 'e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5';
  v_e1 uuid;
  v_e2 uuid;
  v_lonely uuid;
  v_bc uuid;
  v_ct uuid;
  v_ws uuid;
  v_log jsonb;
BEGIN
  -- Fixtures. platform 'facebook' avoids the whatsapp-needs-workspace check.
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'exhaust-a-' || u_a::text || '@example.invalid'),
    (u_b, 'exhaust-b-' || u_b::text || '@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES
    (acct_a, u_a, 'facebook', 'exhaust-acct-a', 'token-exhaust-a');
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type)
  VALUES
    (tool_a, u_a, 'woo-exhaust', 'exhaustion fixture', 'woocommerce');
  INSERT INTO public.store_webhook_bindings
    (id, user_id, social_account_id, connector_id, secret_id)
  VALUES
    (bind_a, u_a, acct_a, tool_a, gen_random_uuid());

  -- E1: due 'pending' event at 3 attempts with a stranded opener thread.
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at, attempts)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-e1-pending',
     '{"order_id":"e1"}', 'pending', now() - interval '1 hour', 3)
  RETURNING id INTO v_e1;
  INSERT INTO public.ai_threads (user_id, platform, conversation_id, procedure_state)
  VALUES
    (u_a, 'whatsapp', 'conv-e1-stranded',
     jsonb_build_object('phase', 'pending_opener', 'run_id', v_e1::text, 'step', 'greeting'));

  -- E2: expired 'claimed' lease at 3 attempts with a stranded opener thread.
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at, claimed_at, claim_token, attempts)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-e2-claimed',
     '{"order_id":"e2"}', 'claimed', now() - interval '1 hour',
     now() - interval '10 minutes', gen_random_uuid(), 3)
  RETURNING id INTO v_e2;
  INSERT INTO public.ai_threads (user_id, platform, conversation_id, procedure_state)
  VALUES
    (u_a, 'whatsapp', 'conv-e2-stranded',
     jsonb_build_object('phase', 'pending_opener', 'run_id', v_e2::text, 'step', 'greeting'));

  -- E3: threads that must survive the claim: same user + same run_id but an
  -- active phase; same user + pending_opener phase but another run_id;
  -- another user + pending_opener phase + the same run_id.
  INSERT INTO public.ai_threads (user_id, platform, conversation_id, procedure_state)
  VALUES
    (u_a, 'whatsapp', 'conv-e3-active',
     jsonb_build_object('phase', 'active', 'run_id', v_e1::text, 'step', 'confirm')),
    (u_a, 'whatsapp', 'conv-e3-other-run',
     jsonb_build_object('phase', 'pending_opener', 'run_id', gen_random_uuid()::text)),
    (u_b, 'whatsapp', 'conv-e3-other-user',
     jsonb_build_object('phase', 'pending_opener', 'run_id', v_e1::text));

  -- E4: an exhausted event with NO matching thread still exhausts + logs.
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at, attempts)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-e4-lonely',
     '{"order_id":"e4"}', 'pending', now() - interval '1 hour', 3)
  RETURNING id INTO v_lonely;

  PERFORM public.claim_store_events(10, interval '2 minutes');

  -- E1: the due pending event exhausts and its stranded opener is cleared.
  ASSERT (SELECT status FROM public.store_events WHERE id = v_e1) = 'failed',
    'E1 due pending event at 3 attempts is marked failed';
  ASSERT (SELECT skip_reason FROM public.store_events WHERE id = v_e1) = 'attempts_exhausted',
    'E1 exhausted event carries attempts_exhausted';
  ASSERT (SELECT procedure_state FROM public.ai_threads
          WHERE user_id = u_a AND conversation_id = 'conv-e1-stranded') IS NULL,
    'E1 stranded pending_opener thread is cleared';

  -- E2: the expired claimed lease exhausts the same way.
  ASSERT (SELECT status FROM public.store_events WHERE id = v_e2) = 'failed',
    'E2 expired claimed event at 3 attempts is marked failed';
  ASSERT (SELECT skip_reason FROM public.store_events WHERE id = v_e2) = 'attempts_exhausted',
    'E2 exhausted event carries attempts_exhausted';
  ASSERT (SELECT procedure_state FROM public.ai_threads
          WHERE user_id = u_a AND conversation_id = 'conv-e2-stranded') IS NULL,
    'E2 stranded pending_opener thread is cleared';

  -- E3: unrelated threads keep their procedure_state.
  ASSERT (SELECT procedure_state->>'phase' FROM public.ai_threads
          WHERE user_id = u_a AND conversation_id = 'conv-e3-active') = 'active',
    'E3 active-phase thread keeps its phase';
  ASSERT (SELECT procedure_state->>'run_id' FROM public.ai_threads
          WHERE user_id = u_a AND conversation_id = 'conv-e3-active') = v_e1::text,
    'E3 active-phase thread keeps its run_id';
  ASSERT (SELECT procedure_state->>'phase' FROM public.ai_threads
          WHERE user_id = u_a AND conversation_id = 'conv-e3-other-run') = 'pending_opener',
    'E3 pending_opener thread with another run_id keeps its state';
  ASSERT (SELECT procedure_state->>'phase' FROM public.ai_threads
          WHERE user_id = u_b AND conversation_id = 'conv-e3-other-user') = 'pending_opener',
    'E3 other-user pending_opener thread keeps its state';
  ASSERT (SELECT procedure_state->>'run_id' FROM public.ai_threads
          WHERE user_id = u_b AND conversation_id = 'conv-e3-other-user') = v_e1::text,
    'E3 other-user pending_opener thread keeps its run_id';

  -- E4: the log row carries reason attempts_exhausted, and the lonely event
  -- still gets its log row.
  SELECT metadata INTO v_log FROM public.system_logs
  WHERE metadata->>'event_id' = v_e1::text
  ORDER BY created_at DESC LIMIT 1;
  ASSERT v_log IS NOT NULL,
    'E4 exhausted event has a system_logs row';
  ASSERT v_log->>'reason' = 'attempts_exhausted',
    'E4 system_logs row carries reason attempts_exhausted';
  ASSERT NOT (v_log ? 'phone'),
    'E4 system_logs metadata contains no phone key';
  ASSERT NOT (v_log ? 'payload'),
    'E4 system_logs metadata contains no payload';
  ASSERT (SELECT status FROM public.store_events WHERE id = v_lonely) = 'failed',
    'E4 lonely exhausted event is marked failed';
  ASSERT EXISTS (SELECT 1 FROM public.system_logs
                 WHERE metadata->>'event_id' = v_lonely::text),
    'E4 lonely exhausted event still gets its system_logs row';

  -- E5: recipients accept 'skipped' and reject 'bogus'.
  INSERT INTO public.whatsapp_broadcasts (id, user_id, name, template_name)
  VALUES (gen_random_uuid(), u_a, 'exhaust broadcast', 'hello_world')
  RETURNING id INTO v_bc;
  INSERT INTO public.workspaces (id, name, owner_id)
  VALUES (gen_random_uuid(), 'exhaust workspace', u_a)
  RETURNING id INTO v_ws;
  INSERT INTO public.whatsapp_contacts (id, user_id, workspace_id, phone_number, display_name)
  VALUES (gen_random_uuid(), u_a, v_ws, '96555510001', 'Exhaust Probe')
  RETURNING id INTO v_ct;
  INSERT INTO public.whatsapp_broadcast_recipients
    (broadcast_id, contact_id, phone_number, status)
  VALUES (v_bc, v_ct, '96555510001', 'skipped');
  ASSERT (SELECT status FROM public.whatsapp_broadcast_recipients
          WHERE broadcast_id = v_bc) = 'skipped',
    'E5 skipped status accepted';
  BEGIN
    INSERT INTO public.whatsapp_broadcast_recipients
      (broadcast_id, contact_id, phone_number, status)
    VALUES (v_bc, v_ct, '96555510001', 'bogus');
    RAISE EXCEPTION 'E5 failed: bogus status accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Q1..Q5: a QR reservation is once per event per UTC day. Own tenant
-- fixtures (earlier blocks remove the shared bind_a before this point).
-- platform 'facebook' avoids the whatsapp-needs-workspace check.
DO $$
DECLARE
  u_a uuid := 'a9a9a9a9-a9a9-49a9-89a9-a9a9a9a9a9a9';
  acct_a uuid := 'b9b9b9b9-b9b9-49b9-89b9-b9b9b9b9b9b9';
  tool_a uuid := 'c9c9c9c9-c9c9-49c9-89c9-c9c9c9c9c9c9';
  bind_a uuid := 'd9d9d9d9-d9d9-49d9-89d9-d9d9d9d9d9d9';
  v_same uuid;
  v_never uuid;
  v_cap uuid;
  v_yest uuid;
  v_ok boolean;
  v_sent int;
  v_today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'qr-q-' || u_a::text || '@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES (acct_a, u_a, 'facebook', 'qr-q-acct', 'token-qr-q');
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type)
  VALUES (tool_a, u_a, 'woo-qr-q', 'qr reservation fixture', 'woocommerce');
  INSERT INTO public.store_webhook_bindings
    (id, user_id, social_account_id, connector_id, secret_id)
  VALUES (bind_a, u_a, acct_a, tool_a, gen_random_uuid());

  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-q-same', '{}', 'pending', now())
  RETURNING id INTO v_same;
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-q-never', '{}', 'pending', now())
  RETURNING id INTO v_never;
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-q-cap', '{}', 'pending', now())
  RETURNING id INTO v_cap;
  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow,
     external_id, payload, status, due_at)
  VALUES
    (u_a, acct_a, tool_a, bind_a, 'cod_confirm', 'order-q-yest', '{}', 'pending', now())
  RETURNING id INTO v_yest;

  -- Q1: reserving the same event twice takes one slot and both calls succeed.
  v_ok := public.reserve_qr_opener(acct_a, 50, v_same);
  ASSERT v_ok, 'Q1 first reserve returns true';
  v_ok := public.reserve_qr_opener(acct_a, 50, v_same);
  ASSERT v_ok, 'Q1 second reserve returns true';
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a AND day = v_today) = 1,
    'Q1 counter moved by one';
  ASSERT (SELECT count(*) FROM public.store_qr_opener_reservations
          WHERE store_event_id = v_same AND day = v_today) = 1,
    'Q1 one reservation row for today';

  -- Q2: release removes the row and hands the slot back.
  PERFORM public.release_qr_opener(acct_a, v_same);
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a AND day = v_today) = 0,
    'Q2 release returns the counter to zero';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.store_qr_opener_reservations WHERE store_event_id = v_same
  ), 'Q2 release deletes the reservation row';

  -- Q3: releasing an event that was never reserved leaves the counter.
  -- Q2 left today's row at 0; update it rather than inserting a second key.
  UPDATE public.store_qr_opener_counts
  SET sent = 4
  WHERE social_account_id = acct_a AND day = v_today;
  PERFORM public.release_qr_opener(acct_a, v_never);
  SELECT sent INTO v_sent FROM public.store_qr_opener_counts
  WHERE social_account_id = acct_a AND day = v_today;
  ASSERT v_sent = 4, 'Q3 release of a never-reserved event leaves the counter';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.store_qr_opener_reservations WHERE store_event_id = v_never
  ), 'Q3 never-reserved event still has no row';

  -- Q4: at the cap a new event is refused and no reservation row is written.
  UPDATE public.store_qr_opener_counts
  SET sent = 1
  WHERE social_account_id = acct_a AND day = v_today;
  v_ok := public.reserve_qr_opener(acct_a, 1, v_cap);
  ASSERT NOT v_ok, 'Q4 reserve at the cap returns false';
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a AND day = v_today) = 1,
    'Q4 refused reserve does not move the counter';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.store_qr_opener_reservations WHERE store_event_id = v_cap
  ), 'Q4 refused reserve writes no reservation row';

  -- Q5: a reservation dated yesterday does not count as today's slot.
  DELETE FROM public.store_qr_opener_counts WHERE social_account_id = acct_a;
  INSERT INTO public.store_qr_opener_reservations (store_event_id, social_account_id, day)
  VALUES (v_yest, acct_a, v_today - 1);
  v_ok := public.reserve_qr_opener(acct_a, 50, v_yest);
  ASSERT v_ok, 'Q5 retry the next day returns true';
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a AND day = v_today) = 1,
    'Q5 yesterday reservation takes a new slot today';
  ASSERT (SELECT day FROM public.store_qr_opener_reservations
          WHERE store_event_id = v_yest) = v_today,
    'Q5 reservation day advances to today';
  v_ok := public.reserve_qr_opener(acct_a, 50, v_yest);
  ASSERT v_ok, 'Q5 same-day retry still returns true';
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a AND day = v_today) = 1,
    'Q5 same-day retry does not take a second slot';

  -- Releasing that yesterday row, before it was advanced, must not punch a
  -- hole in today's counter. Rebuild the stale row beside a live today count.
  DELETE FROM public.store_qr_opener_reservations WHERE store_event_id = v_yest;
  INSERT INTO public.store_qr_opener_reservations (store_event_id, social_account_id, day)
  VALUES (v_yest, acct_a, v_today - 1);
  UPDATE public.store_qr_opener_counts
  SET sent = 5
  WHERE social_account_id = acct_a AND day = v_today;
  PERFORM public.release_qr_opener(acct_a, v_yest);
  ASSERT (SELECT sent FROM public.store_qr_opener_counts
          WHERE social_account_id = acct_a AND day = v_today) = 5,
    'Q5 release of a previous-day reservation leaves today''s counter';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.store_qr_opener_reservations WHERE store_event_id = v_yest
  ), 'Q5 release deletes the stale reservation row';
END $$;

ROLLBACK;
\echo '=== agent_procedures_b: ALL CHECKS PASSED ==='
