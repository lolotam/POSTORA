-- WhatsApp disconnect alerts: the episode state machine, the per-recipient email
-- claims, the deliberate-disconnect marker, the poll freshness column and the
-- least-privilege grants.
--
-- Migration under test: supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql
--
-- One transaction, synthetic fixtures only, labelled ASSERTs, ROLLBACK, sentinel last.
-- Nothing here touches a real database: the harness applies this to a disposable
-- container and rolls the whole transaction back.

BEGIN;

DO $$
DECLARE
  u_a       uuid := 'a7a7a7a7-1111-4111-8111-a7a7a7a7a7a7';
  u_b       uuid := 'b8b8b8b8-2222-4222-8222-b8b8b8b8b8b8';
  ws_a      uuid := 'a7a7a7a7-aaaa-4111-8111-a7a7a7a7a7a7';
  ws_b      uuid := 'b8b8b8b8-aaaa-4222-8222-b8b8b8b8b8b8';
  acc       uuid := 'a7a7a7a7-0002-4111-8111-a7a7a7a7a7a7';
  acc_two   uuid := 'a7a7a7a7-0003-4111-8111-a7a7a7a7a7a7';
  acc_cloud uuid := 'a7a7a7a7-0004-4111-8111-a7a7a7a7a7a7';
  acc_meta  uuid := 'a7a7a7a7-0005-4111-8111-a7a7a7a7a7a7';
  ep        jsonb;
  ep_two    jsonb;
  since0    timestamptz;
  first0    timestamptz;
BEGIN
  -- ---------------------------------------------------------------- fixtures
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'wda-a-' || u_a::text || '@example.invalid'),
    (u_b, 'wda-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (ws_a, 'wda a', u_a),
    (ws_b, 'wda b', u_b);

  -- acc      : the QR-connected WhatsApp row the episode machine drives.
  -- acc_two  : a second QR-connected row, used for the "nothing to observe" cases.
  -- acc_cloud: a WhatsApp row connected through the Cloud API, not Evolution QR.
  -- acc_meta : a Meta row. Neither may ever be touched by this feature.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id,
     is_active, connection_mode, account_metadata)
  VALUES
    (acc, u_a, 'whatsapp', '96566600001', '', ws_a, true, 'evolution_qr',
     '{"automation_handler":"internal"}'),
    (acc_two, u_a, 'whatsapp', '96566600002', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_cloud, u_a, 'whatsapp', '96566600003', '', ws_a, true, 'cloud_api', '{}'),
    (acc_meta, u_a, 'facebook', 'fb-wda-0001', '', ws_a, true, 'cloud_api', '{}');

  -- ------------------------------------------------- E0: the episode opens once
  ep := public.observe_whatsapp_disconnect_state(acc, 'close', true);
  ASSERT ep IS NOT NULL, 'E0 the episode opens';
  ASSERT ep->>'state' = 'close', 'E0 the terminal state is recorded';
  ASSERT ep ? 'since', 'E0 the episode carries since';
  ASSERT ep ? 'first_seen', 'E0 the episode carries first_seen';
  ASSERT ep ? 'observed_at', 'E0 the episode carries observed_at';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect' = ep
            FROM public.social_accounts WHERE id = acc),
    'E0 the episode is stored on the row';

  since0 := (ep->>'since')::timestamptz;
  first0 := (ep->>'first_seen')::timestamptz;

  -- ------------------------------- E1: a terminal state does not move the anchors
  ep_two := public.observe_whatsapp_disconnect_state(acc, 'timeout', true);
  ASSERT ep_two IS NOT NULL, 'E1 the episode survives a second terminal state';
  ASSERT ep_two->>'state' = 'timeout', 'E1 the latest terminal state is recorded';
  ASSERT (ep_two->>'since')::timestamptz = since0, 'E1 since is kept';
  ASSERT (ep_two->>'first_seen')::timestamptz = first0, 'E1 first_seen is kept';

  -- -------------------------- E2: a transient observation re-stamps but keeps it
  ep_two := public.observe_whatsapp_disconnect_state(acc, 'connecting', false);
  ASSERT ep_two IS NOT NULL, 'E2 the episode survives a transient observation';
  ASSERT ep_two->>'state' = 'connecting', 'E2 the transient state is recorded';
  ASSERT (ep_two->>'since')::timestamptz >= since0, 'E2 since does not move backwards';
  ASSERT (ep_two->>'since')::timestamptz > since0, 'E2 since moved forward';
  ASSERT (ep_two->>'first_seen')::timestamptz = first0, 'E2 first_seen is kept';

  -- ------------------------------- E3: a transient observation opens no episode
  ASSERT public.observe_whatsapp_disconnect_state(acc_two, 'connecting', false) IS NULL,
    'E3 a transient observation opens nothing';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect' IS NULL
            FROM public.social_accounts WHERE id = acc_two),
    'E3 nothing was written for the transient observation';

  -- ----------------------------------------- E4: unrelated metadata is preserved
  ASSERT (SELECT account_metadata->>'automation_handler' = 'internal'
            FROM public.social_accounts WHERE id = acc),
    'E4 the unrelated metadata key survives';

  -- ------------------------------- E5: the owner and the admin claim independently
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') = true,
    'E5 the owner claim is won';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') = false,
    'E5 the owner claim is once-only';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'admin') = true,
    'E5 the admin claim is independent of the owner claim';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect_claimed_at' ? 'user'
            AND account_metadata->'whatsapp_disconnect_claimed_at' ? 'admin'
            FROM public.social_accounts WHERE id = acc),
    'E5 each recipient holds its own in-flight claim';

  -- ------------------------------ E6: a stale claim is retaken, a live one is not
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           jsonb_set(
             COALESCE(account_metadata->'whatsapp_disconnect_claimed_at', '{}'::jsonb),
             ARRAY['user'],
             to_jsonb((clock_timestamp() - interval '31 minutes')::text)))
   WHERE id = acc;
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') = true,
    'E6 a stale claim is retaken';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') = false,
    'E6 a live claim is not retaken';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'admin') = false,
    'E6 a live admin claim is not retaken either';

  -- --------------------------------------- E7: a claim needs an open episode
  ASSERT public.claim_whatsapp_disconnect_email(acc_two, 'user') = false,
    'E7 a claim without an episode is refused';

  -- ------------------------------------------- E8: an unknown kind is refused
  BEGIN
    PERFORM public.claim_whatsapp_disconnect_email(acc, 'nobody');
    RAISE EXCEPTION 'E8 failed: an unknown claim kind was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- ------------------------------- E9: marking records the recipient, not the other
  ASSERT public.mark_whatsapp_disconnect_emailed(acc, 'user') = true,
    'E9 the owner mark is recorded';
  ASSERT (SELECT account_metadata->>'whatsapp_disconnect_user_email_at' IS NOT NULL
            AND account_metadata->>'whatsapp_disconnect_admin_email_at' IS NULL
            FROM public.social_accounts WHERE id = acc),
    'E9 only the owner marker is written';

  -- ---------------------------------- E10: the deliberate disconnect is marked
  ASSERT public.mark_whatsapp_user_disconnected(acc) = true,
    'E10 the deliberate marker is written';
  ASSERT (SELECT account_metadata->>'whatsapp_user_disconnected_at' IS NOT NULL
            FROM public.social_accounts WHERE id = acc),
    'E10 the deliberate marker is stored on the row';

  -- ------------------------------------------- E11: clearing removes everything
  UPDATE public.social_accounts
     SET needs_reauth = true, last_refresh_error = 'wda synthetic failure'
   WHERE id = acc;
  ASSERT public.clear_whatsapp_disconnect_episode(acc) = true,
    'E11 the episode is cleared';
  ASSERT (SELECT NOT (account_metadata ? 'whatsapp_disconnect')
            AND NOT (account_metadata ? 'whatsapp_disconnect_user_email_at')
            AND NOT (account_metadata ? 'whatsapp_disconnect_admin_email_at')
            AND NOT (account_metadata ? 'whatsapp_disconnect_claimed_at')
            AND NOT (account_metadata ? 'whatsapp_user_disconnected_at')
            AND NOT needs_reauth
            AND last_refresh_error IS NULL
            FROM public.social_accounts WHERE id = acc),
    'E11 every marker and the reauth state are gone';
  ASSERT public.clear_whatsapp_disconnect_episode(acc) = false,
    'E11 clearing twice is a no-op';

  -- --------------------------------- E12: a foreign account is never touched
  ASSERT public.observe_whatsapp_disconnect_state(acc_cloud, 'close', true) IS NULL,
    'E12 a Cloud API WhatsApp row opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_cloud, 'user') = false,
    'E12 a Cloud API WhatsApp row is never claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_cloud) = false,
    'E12 a Cloud API WhatsApp row is never cleared';
  ASSERT public.observe_whatsapp_disconnect_state(acc_meta, 'close', true) IS NULL,
    'E12 a Meta row opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_meta, 'user') = false,
    'E12 a Meta row is never claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_meta) = false,
    'E12 a Meta row is never cleared';
  ASSERT (SELECT bool_and(
                account_metadata->'whatsapp_disconnect' IS NULL
                AND NOT needs_reauth
                AND last_refresh_error IS NULL)
            FROM public.social_accounts
           WHERE id IN (acc_cloud, acc_meta)),
    'E12 the foreign rows are untouched';

  -- ------------------------------------------- E13: the RPCs stay service-role only
  ASSERT NOT has_function_privilege('authenticated',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E13 observe is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.claim_whatsapp_disconnect_email(uuid,text)', 'EXECUTE'),
    'E13 claim is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.mark_whatsapp_disconnect_emailed(uuid,text)', 'EXECUTE'),
    'E13 mark is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.clear_whatsapp_disconnect_episode(uuid)', 'EXECUTE'),
    'E13 clear is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.mark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E13 the deliberate marker is not browser-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E13 observe is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.claim_whatsapp_disconnect_email(uuid,text)', 'EXECUTE'),
    'E13 claim is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.mark_whatsapp_disconnect_emailed(uuid,text)', 'EXECUTE'),
    'E13 mark is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.clear_whatsapp_disconnect_episode(uuid)', 'EXECUTE'),
    'E13 clear is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.mark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E13 the deliberate marker is not anon-callable';
  ASSERT has_function_privilege('service_role',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E13 the service role may observe';

  -- ------------------------ E14: the poll freshness column and its index exist
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'whatsapp_evolution_instances'
       AND column_name = 'last_polled_at'
       AND data_type = 'timestamp with time zone'),
    'E14 the poll freshness column exists';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'whatsapp_evolution_instances_last_polled_at_idx'),
    'E14 the poll freshness index exists';

  -- The cron entry is only scheduled where pg_cron is installed, so it is only
  -- asserted where it can exist.
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    ASSERT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch'),
      'E14 the watch cron job is scheduled';
  END IF;
END $$;

ROLLBACK;

\echo '=== whatsapp_disconnect_alerts: ALL CHECKS PASSED ==='
