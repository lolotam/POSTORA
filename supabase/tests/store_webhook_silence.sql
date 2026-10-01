-- supabase/tests/store_webhook_silence.sql
-- silent_store_webhook_bindings (migration 20261003110000). One transaction, synthetic
-- fixtures, labelled S1..Sn ASSERTs, ROLLBACK, sentinel last. Assumes the migration is
-- applied. No secrets and no real accounts.
--
-- Bindings and their deliveries, against a 24 h quiet window and a 7 day activity floor:
--   bind_quiet    one store_events row 2 days ago            -> silent
--   bind_live     one store_events row 1 hour ago            -> not silent
--   bind_never    no delivery at all                         -> not listed
--   bind_ignored  one ignored-delivery log 30 hours ago      -> silent
--   bind_stale    one store_events row 10 days ago           -> not listed (outside the floor)
--   bind_mixed    event 30 hours ago, ignored log 1 hour ago -> not silent
BEGIN;
DO $$
DECLARE
  u_a uuid := 'c3c3c3c3-3333-4333-8333-cccccccccccc';
  acct uuid := 'c4c4c4c4-4444-4444-8444-cccccccccccc';
  bind_quiet uuid := 'd1d1d1d1-0001-4001-8001-dddddddddddd';
  bind_live uuid := 'd1d1d1d1-0002-4002-8002-dddddddddddd';
  bind_never uuid := 'd1d1d1d1-0003-4003-8003-dddddddddddd';
  bind_ignored uuid := 'd1d1d1d1-0004-4004-8004-dddddddddddd';
  bind_stale uuid := 'd1d1d1d1-0005-4005-8005-dddddddddddd';
  bind_mixed uuid := 'd1d1d1d1-0006-4006-8006-dddddddddddd';
  fixture_ids uuid[];
  v_result jsonb;
  v_listed uuid[];
  v_quiet jsonb;
BEGIN
  fixture_ids := ARRAY[bind_quiet, bind_live, bind_never, bind_ignored, bind_stale, bind_mixed];

  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'store-silence-' || u_a::text || '@example.invalid');
  -- platform 'facebook' avoids the whatsapp-needs-workspace check.
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES (acct, u_a, 'facebook', 'silence-acct', 'token-a');

  -- One connector per binding: bindings are unique per connector.
  INSERT INTO public.ai_agent_tools (id, user_id, name, description, connector_type)
  SELECT b, u_a, 'woo-' || i, 'store silence fixture ' || i, 'woocommerce'
  FROM unnest(fixture_ids) WITH ORDINALITY AS t(b, i);
  INSERT INTO public.store_webhook_bindings (id, user_id, social_account_id, connector_id, secret_id)
  SELECT b, u_a, acct, b, gen_random_uuid() FROM unnest(fixture_ids) AS b;

  INSERT INTO public.store_events
    (user_id, social_account_id, connector_id, binding_id, flow, external_id, payload, status, due_at, created_at)
  VALUES
    (u_a, acct, bind_quiet, bind_quiet, 'cod_confirm', 'o-quiet', '{}', 'sent', now(), now() - interval '2 days'),
    (u_a, acct, bind_live, bind_live, 'cod_confirm', 'o-live', '{}', 'sent', now(), now() - interval '1 hour'),
    (u_a, acct, bind_stale, bind_stale, 'cod_confirm', 'o-stale', '{}', 'sent', now(), now() - interval '10 days'),
    (u_a, acct, bind_mixed, bind_mixed, 'cod_confirm', 'o-mixed', '{}', 'sent', now(), now() - interval '30 hours');

  INSERT INTO public.system_logs (level, category, source, message, user_id, metadata, created_at)
  VALUES
    ('info', 'system', 'store-webhook', 'Store webhook delivery ignored', u_a,
      jsonb_build_object('reason', 'unsupported_status', 'binding_id', bind_ignored), now() - interval '30 hours'),
    ('info', 'system', 'store-webhook', 'Store webhook delivery ignored', u_a,
      jsonb_build_object('reason', 'unsupported_status', 'binding_id', bind_mixed), now() - interval '1 hour'),
    -- A log row whose binding_id is not a uuid must not break the cast for everyone.
    ('info', 'system', 'store-webhook', 'Store webhook delivery ignored', u_a,
      jsonb_build_object('reason', 'unknown_binding', 'binding_id', 'not-a-uuid'), now() - interval '30 hours');

  v_result := public.silent_store_webhook_bindings(1440, 7);
  SELECT coalesce(array_agg((x->>'binding_id')::uuid ORDER BY x->>'binding_id'), '{}')
    INTO v_listed
    FROM jsonb_array_elements(v_result) AS x
   WHERE (x->>'binding_id')::uuid = ANY (fixture_ids);

  -- S1: exactly the two silent bindings are listed.
  ASSERT v_listed = ARRAY[bind_quiet, bind_ignored],
    format('S1 silent set is {quiet, ignored}, got %s', v_listed);

  -- S2: an entry names its owner, account and the time of its last delivery.
  SELECT x INTO v_quiet FROM jsonb_array_elements(v_result) AS x
   WHERE (x->>'binding_id')::uuid = bind_quiet;
  ASSERT (v_quiet->>'user_id')::uuid = u_a, 'S2 entry carries the owner';
  ASSERT (v_quiet->>'social_account_id')::uuid = acct, 'S2 entry carries the account';
  ASSERT abs(extract(epoch FROM ((v_quiet->>'last_delivery_at')::timestamptz - (now() - interval '2 days')))) < 1,
    'S2 entry carries the last delivery time';

  -- S3: the window is the caller's: at 72 hours neither silent binding qualifies yet.
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.silent_store_webhook_bindings(4320, 7)) AS x
     WHERE (x->>'binding_id')::uuid = ANY (fixture_ids)),
    'S3 a 72 hour window lists none of the fixtures';

  -- S4: so is the activity floor: at 14 days the 10-day-old binding is silent too.
  ASSERT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.silent_store_webhook_bindings(1440, 14)) AS x
     WHERE (x->>'binding_id')::uuid = bind_stale),
    'S4 a 14 day floor includes the 10-day-old binding';

  -- S5: only service_role may call it; the result names other users' bindings.
  ASSERT NOT has_function_privilege('anon', 'public.silent_store_webhook_bindings(integer, integer)', 'EXECUTE'),
    'S5 anon cannot execute';
  ASSERT NOT has_function_privilege('authenticated', 'public.silent_store_webhook_bindings(integer, integer)', 'EXECUTE'),
    'S5 authenticated cannot execute';
  ASSERT has_function_privilege('service_role', 'public.silent_store_webhook_bindings(integer, integer)', 'EXECUTE'),
    'S5 service_role can execute';

  -- S6: the alert rule exists exactly once.
  ASSERT (SELECT count(*) FROM public.observability_alert_configs
           WHERE trigger_type = 'store_webhook_silence' AND is_active) = 1,
    'S6 one active store_webhook_silence rule';
END $$;

ROLLBACK;
\echo '=== store_webhook_silence: ALL CHECKS PASSED ==='
