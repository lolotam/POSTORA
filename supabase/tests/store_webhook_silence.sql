-- supabase/tests/store_webhook_silence.sql
-- Store webhook heartbeats and silent_store_connections (migration 20261003110000). One
-- transaction, synthetic fixtures, labelled S1..Sn ASSERTs, ROLLBACK, sentinel last. Assumes the
-- migration is applied. No secrets and no real accounts.
--
-- Connections and their last delivery, against a 24 h quiet window and a 7 day activity floor:
--   con_quiet    last delivery 2 days ago                       -> silent
--   con_live     last delivery 1 hour ago                       -> not silent
--   con_never    no delivery at all                             -> not listed
--   con_stale    last delivery 10 days ago                      -> not listed (outside the floor)
--   con_rebound  delivered 2 days ago, then its binding deleted -> still silent, binding_id null
BEGIN;
DO $$
DECLARE
  u_a uuid := 'c3c3c3c3-3333-4333-8333-cccccccccccc';
  acct uuid := 'c4c4c4c4-4444-4444-8444-cccccccccccc';
  con_quiet uuid := 'd1d1d1d1-0001-4001-8001-dddddddddddd';
  con_live uuid := 'd1d1d1d1-0002-4002-8002-dddddddddddd';
  con_never uuid := 'd1d1d1d1-0003-4003-8003-dddddddddddd';
  con_stale uuid := 'd1d1d1d1-0005-4005-8005-dddddddddddd';
  con_rebound uuid := 'd1d1d1d1-0006-4006-8006-dddddddddddd';
  fixture_ids uuid[];
  v_result jsonb;
  v_listed uuid[];
  v_entry jsonb;
BEGIN
  fixture_ids := ARRAY[con_quiet, con_live, con_never, con_stale, con_rebound];

  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'store-silence-' || u_a::text || '@example.invalid');
  -- platform 'facebook' avoids the whatsapp-needs-workspace check.
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES (acct, u_a, 'facebook', 'silence-acct', 'token-a');

  -- One connector and one binding each; the binding id doubles as the connector id.
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type)
  SELECT c, u_a, 'woo-' || i, 'store silence fixture ' || i, 'woocommerce'
  FROM unnest(fixture_ids) WITH ORDINALITY AS t(c, i);
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id)
  SELECT c, u_a, acct, c, gen_random_uuid() FROM unnest(fixture_ids) AS c;

  -- S1: a delivery records the heartbeat on the binding's connector, and a repeat moves it.
  PERFORM public.record_store_webhook_delivery(con_quiet);
  ASSERT (SELECT last_delivery_at FROM public.store_webhook_heartbeats WHERE connector_id = con_quiet) = now(),
    'S1 the first delivery creates the heartbeat';
  UPDATE public.store_webhook_heartbeats SET last_delivery_at = now() - interval '3 days' WHERE connector_id = con_quiet;
  PERFORM public.record_store_webhook_delivery(con_quiet);
  ASSERT (SELECT last_delivery_at FROM public.store_webhook_heartbeats WHERE connector_id = con_quiet) = now(),
    'S1 a later delivery moves it';
  ASSERT (SELECT count(*) FROM public.store_webhook_heartbeats WHERE connector_id = con_quiet) = 1,
    'S1 still one row per connector';
  -- An unknown binding writes nothing.
  PERFORM public.record_store_webhook_delivery(gen_random_uuid());
  ASSERT NOT EXISTS (SELECT 1 FROM public.store_webhook_heartbeats WHERE connector_id <> ALL (fixture_ids)
                       AND user_id = u_a),
    'S1 an unknown binding records nothing';

  PERFORM public.record_store_webhook_delivery(c) FROM unnest(ARRAY[con_live, con_stale, con_rebound]) AS c;
  UPDATE public.store_webhook_heartbeats h
  SET last_delivery_at = now() - v.age
  FROM (VALUES (con_quiet, interval '2 days'), (con_live, interval '1 hour'),
               (con_stale, interval '10 days'), (con_rebound, interval '2 days')) AS v(c, age)
  WHERE h.connector_id = v.c;

  -- S2: the heartbeat outlives its binding: the store may still be calling the deleted URL.
  DELETE FROM public.store_webhook_bindings WHERE id = con_rebound;
  ASSERT EXISTS (SELECT 1 FROM public.store_webhook_heartbeats WHERE connector_id = con_rebound),
    'S2 deleting the binding keeps the connection''s heartbeat';

  v_result := public.silent_store_connections(1440, 7);
  SELECT coalesce(array_agg((x->>'connector_id')::uuid ORDER BY x->>'connector_id'), '{}')
    INTO v_listed
    FROM jsonb_array_elements(v_result) AS x
   WHERE (x->>'connector_id')::uuid = ANY (fixture_ids);

  -- S3: exactly the two silent connections are listed.
  ASSERT v_listed = ARRAY[con_quiet, con_rebound],
    format('S3 silent set is {quiet, rebound}, got %s', v_listed);

  -- S4: an entry names its owner, account, current binding and last delivery.
  SELECT x INTO v_entry FROM jsonb_array_elements(v_result) AS x
   WHERE (x->>'connector_id')::uuid = con_quiet;
  ASSERT (v_entry->>'user_id')::uuid = u_a, 'S4 entry carries the owner';
  ASSERT (v_entry->>'social_account_id')::uuid = acct, 'S4 entry carries the account';
  ASSERT (v_entry->>'binding_id')::uuid = con_quiet, 'S4 entry carries the current binding';
  ASSERT (v_entry->>'last_delivery_at')::timestamptz = now() - interval '2 days',
    'S4 entry carries the last delivery time';
  SELECT x INTO v_entry FROM jsonb_array_elements(v_result) AS x
   WHERE (x->>'connector_id')::uuid = con_rebound;
  ASSERT v_entry->'binding_id' = 'null'::jsonb, 'S4 a deleted binding is reported as null';

  -- S5: the window is the caller's: at 72 hours neither silent connection qualifies yet.
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.silent_store_connections(4320, 7)) AS x
     WHERE (x->>'connector_id')::uuid = ANY (fixture_ids)),
    'S5 a 72 hour window lists none of the fixtures';

  -- S6: so is the activity floor: at 14 days the 10-day-old connection is silent too.
  ASSERT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.silent_store_connections(1440, 14)) AS x
     WHERE (x->>'connector_id')::uuid = con_stale),
    'S6 a 14 day floor includes the 10-day-old connection';

  -- S7: deleting the connector removes its heartbeat; there is nothing left to watch.
  DELETE FROM public.ai_agent_tools WHERE id = con_stale;
  ASSERT NOT EXISTS (SELECT 1 FROM public.store_webhook_heartbeats WHERE connector_id = con_stale),
    'S7 a deleted connector takes its heartbeat with it';

  -- S8: only service_role reaches either function or the table.
  ASSERT NOT has_function_privilege('anon', 'public.silent_store_connections(integer, integer)', 'EXECUTE'),
    'S8 anon cannot read silent connections';
  ASSERT NOT has_function_privilege('authenticated', 'public.silent_store_connections(integer, integer)', 'EXECUTE'),
    'S8 authenticated cannot read silent connections';
  ASSERT NOT has_function_privilege('authenticated', 'public.record_store_webhook_delivery(uuid)', 'EXECUTE'),
    'S8 authenticated cannot record a delivery';
  ASSERT has_function_privilege('service_role', 'public.record_store_webhook_delivery(uuid)', 'EXECUTE'),
    'S8 service_role can record a delivery';
  ASSERT NOT has_table_privilege('authenticated', 'public.store_webhook_heartbeats', 'SELECT'),
    'S8 authenticated cannot read heartbeats';

  -- S9: the alert rule exists exactly once.
  ASSERT (SELECT count(*) FROM public.observability_alert_configs
           WHERE trigger_type = 'store_webhook_silence' AND is_active) = 1,
    'S9 one active store_webhook_silence rule';
END $$;

ROLLBACK;
\echo '=== store_webhook_silence: ALL CHECKS PASSED ==='
