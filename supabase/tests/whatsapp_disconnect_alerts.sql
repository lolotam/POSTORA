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
  acc_delib uuid := 'a7a7a7a7-0006-4111-8111-a7a7a7a7a7a7';
  ep        jsonb;
  ep_two    jsonb;
  since0    timestamptz;
  first0    timestamptz;
  claim_ep  uuid;
  other_ep  uuid;
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
  -- acc_delib: a QR row used for the deliberate-disconnect and late-mark cases.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id,
     is_active, connection_mode, account_metadata)
  VALUES
    (acc, u_a, 'whatsapp', '96566600001', '', ws_a, true, 'evolution_qr',
     '{"automation_handler":"internal"}'),
    (acc_two, u_a, 'whatsapp', '96566600002', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_cloud, u_a, 'whatsapp', '96566600003', '', ws_a, true, 'cloud_api', '{}'),
    (acc_meta, u_a, 'facebook', 'fb-wda-0001', '', ws_a, true, 'cloud_api', '{}'),
    (acc_delib, u_a, 'whatsapp', '96566600004', '', ws_a, true, 'evolution_qr', '{}');

  -- ------------------------------------------------- E0: the episode opens once
  ep := public.observe_whatsapp_disconnect_state(acc, 'close', true);
  ASSERT ep IS NOT NULL, 'E0 the episode opens';
  ASSERT ep->>'state' = 'close', 'E0 the terminal state is recorded';
  ASSERT ep ? 'since', 'E0 the episode carries since';
  ASSERT ep ? 'first_seen', 'E0 the episode carries first_seen';
  ASSERT ep ? 'observed_at', 'E0 the episode carries observed_at';
  ASSERT ep ? 'episode_id', 'E0 the episode carries an episode id';
  ASSERT (ep->>'episode_id') ~ '^[0-9a-f-]{36}$', 'E0 the episode id is a uuid';
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
  ASSERT ep_two->>'episode_id' = ep->>'episode_id', 'E1 the episode id is kept';

  -- -------------------------- E2: a transient observation re-stamps but keeps it
  ep_two := public.observe_whatsapp_disconnect_state(acc, 'connecting', false);
  ASSERT ep_two IS NOT NULL, 'E2 the episode survives a transient observation';
  ASSERT ep_two->>'state' = 'connecting', 'E2 the transient state is recorded';
  ASSERT (ep_two->>'since')::timestamptz >= since0, 'E2 since does not move backwards';
  ASSERT (ep_two->>'since')::timestamptz > since0, 'E2 since moved forward';
  ASSERT (ep_two->>'first_seen')::timestamptz = first0, 'E2 first_seen is kept';
  ASSERT ep_two->>'episode_id' = ep->>'episode_id', 'E2 the episode id is kept';

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
  claim_ep := public.claim_whatsapp_disconnect_email(acc, 'user');
  ASSERT claim_ep IS NOT NULL, 'E5 the owner claim is won';
  ASSERT claim_ep = (ep->>'episode_id')::uuid, 'E5 the claim returns the episode id';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') IS NULL,
    'E5 the owner claim is once-only';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'admin') IS NOT NULL,
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
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') IS NOT NULL,
    'E6 a stale claim is retaken';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') IS NULL,
    'E6 a live claim is not retaken';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'admin') IS NULL,
    'E6 a live admin claim is not retaken either';

  -- ---------------------------- E6b: a malformed claim timestamp is stale, not fatal
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           jsonb_set(
             COALESCE(account_metadata->'whatsapp_disconnect_claimed_at', '{}'::jsonb),
             ARRAY['user'],
             to_jsonb('2026-99-99 99:99:99+00'::text))
           )
   WHERE id = acc;
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user') IS NOT NULL,
    'E6b a malformed claim timestamp is treated as stale, not as a blocker';

  -- --------------------------------------- E7: a claim needs an open episode
  ASSERT public.claim_whatsapp_disconnect_email(acc_two, 'user') IS NULL,
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
  ASSERT public.mark_whatsapp_disconnect_emailed(acc, 'user', claim_ep) = true,
    'E9 the owner mark is recorded';
  ASSERT (SELECT account_metadata->>'whatsapp_disconnect_user_email_at' IS NOT NULL
            AND account_metadata->>'whatsapp_disconnect_admin_email_at' IS NULL
            FROM public.social_accounts WHERE id = acc),
    'E9 only the owner marker is written';

  -- ---------------------- E10: a mark for another episode writes nothing at all
  ASSERT public.mark_whatsapp_disconnect_emailed(acc, 'admin', claim_ep) = true,
    'E10 the admin mark for the live episode is recorded';
  other_ep := gen_random_uuid();
  ASSERT public.mark_whatsapp_disconnect_emailed(acc, 'user', other_ep) = false,
    'E10 a mark for a foreign episode id is refused';
  ASSERT public.mark_whatsapp_disconnect_emailed(acc, 'admin', other_ep) = false,
    'E10 a mark for a foreign episode id is refused for every recipient';
  ASSERT public.mark_whatsapp_disconnect_emailed(acc, 'user', NULL) = false,
    'E10 a mark without an episode id is refused';

  -- -------------------- E11: a late mark cannot silence a later episode
  -- The episode is closed (the account came back) and a new outage opens a new one. A mark
  -- for the closed episode must not write a marker, or the new outage would be silenced.
  ep_two := public.observe_whatsapp_disconnect_state(acc_delib, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E11 the first episode opens';
  claim_ep := public.claim_whatsapp_disconnect_email(acc_delib, 'user');
  ASSERT claim_ep IS NOT NULL, 'E11 the first episode is claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_delib) = true,
    'E11 the first episode is closed';
  ep_two := public.observe_whatsapp_disconnect_state(acc_delib, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E11 a later outage opens a new episode';
  ASSERT ep_two->>'episode_id' <> claim_ep::text, 'E11 the new episode has its own id';
  ASSERT public.mark_whatsapp_disconnect_emailed(acc_delib, 'user', claim_ep) = false,
    'E11 the late mark of the closed episode is refused';
  ASSERT (SELECT account_metadata->>'whatsapp_disconnect_user_email_at' IS NULL
            FROM public.social_accounts WHERE id = acc_delib),
    'E11 the late mark wrote no marker';
  ASSERT public.claim_whatsapp_disconnect_email(acc_delib, 'user') IS NOT NULL,
    'E11 the new episode can still be claimed';

  -- ------------------ E12: a deliberate disconnect is never an outage
  ASSERT public.mark_whatsapp_user_disconnected(acc_delib) = true,
    'E12 the deliberate marker is written';
  ASSERT (SELECT account_metadata->>'whatsapp_user_disconnected_at' IS NOT NULL
            FROM public.social_accounts WHERE id = acc_delib),
    'E12 the deliberate marker is stored on the row';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect' IS NULL
            AND account_metadata->'whatsapp_disconnect_claimed_at' IS NULL
            FROM public.social_accounts WHERE id = acc_delib),
    'E12 the deliberate disconnect closes the open episode and its claims';
  ASSERT public.observe_whatsapp_disconnect_state(acc_delib, 'close', true) IS NULL,
    'E12 a deliberately disconnected account opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_delib, 'user') IS NULL,
    'E12 a deliberately disconnected account is never claimed';

  -- ------------------------------------------- E13: clearing removes everything
  UPDATE public.social_accounts
     SET needs_reauth = true, last_refresh_error = 'wda synthetic failure'
   WHERE id = acc;
  ASSERT public.clear_whatsapp_disconnect_episode(acc) = true,
    'E13 the episode is cleared';
  ASSERT (SELECT NOT (account_metadata ? 'whatsapp_disconnect')
            AND NOT (account_metadata ? 'whatsapp_disconnect_user_email_at')
            AND NOT (account_metadata ? 'whatsapp_disconnect_admin_email_at')
            AND NOT (account_metadata ? 'whatsapp_disconnect_claimed_at')
            AND NOT (account_metadata ? 'whatsapp_user_disconnected_at')
            AND NOT needs_reauth
            AND last_refresh_error IS NULL
            FROM public.social_accounts WHERE id = acc),
    'E13 every marker and the reauth state are gone';
  ASSERT public.clear_whatsapp_disconnect_episode(acc) = false,
    'E13 clearing twice is a no-op';

  -- --------------------------------- E14: a foreign account is never touched
  ASSERT public.observe_whatsapp_disconnect_state(acc_cloud, 'close', true) IS NULL,
    'E14 a Cloud API WhatsApp row opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_cloud, 'user') IS NULL,
    'E14 a Cloud API WhatsApp row is never claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_cloud) = false,
    'E14 a Cloud API WhatsApp row is never cleared';
  ASSERT public.observe_whatsapp_disconnect_state(acc_meta, 'close', true) IS NULL,
    'E14 a Meta row opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_meta, 'user') IS NULL,
    'E14 a Meta row is never claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_meta) = false,
    'E14 a Meta row is never cleared';
  ASSERT (SELECT bool_and(
                account_metadata->'whatsapp_disconnect' IS NULL
                AND NOT needs_reauth
                AND last_refresh_error IS NULL)
            FROM public.social_accounts
           WHERE id IN (acc_cloud, acc_meta)),
    'E14 the foreign rows are untouched';

  -- ------------------------------------------- E15: the RPCs stay service-role only
  ASSERT NOT has_function_privilege('authenticated',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E15 observe is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.claim_whatsapp_disconnect_email(uuid,text)', 'EXECUTE'),
    'E15 claim is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.mark_whatsapp_disconnect_emailed(uuid,text,uuid)', 'EXECUTE'),
    'E15 mark is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.clear_whatsapp_disconnect_episode(uuid)', 'EXECUTE'),
    'E15 clear is not browser-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.mark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E15 the deliberate marker is not browser-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E15 observe is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.claim_whatsapp_disconnect_email(uuid,text)', 'EXECUTE'),
    'E15 claim is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.mark_whatsapp_disconnect_emailed(uuid,text,uuid)', 'EXECUTE'),
    'E15 mark is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.clear_whatsapp_disconnect_episode(uuid)', 'EXECUTE'),
    'E15 clear is not anon-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.mark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E15 the deliberate marker is not anon-callable';
  ASSERT NOT has_function_privilege('authenticated',
        'public.get_cron_functions_base_url()', 'EXECUTE'),
    'E15 the base url resolver is not browser-callable';
  ASSERT has_function_privilege('service_role',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E15 the service role may observe';
  ASSERT has_function_privilege('service_role',
        'public.claim_whatsapp_disconnect_email(uuid,text)', 'EXECUTE'),
    'E15 the service role may claim';
  ASSERT has_function_privilege('service_role',
        'public.mark_whatsapp_disconnect_emailed(uuid,text,uuid)', 'EXECUTE'),
    'E15 the service role may mark';

  -- ------------------------ E16: the poll freshness column and its index exist
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'whatsapp_evolution_instances'
       AND column_name = 'last_polled_at'
       AND data_type = 'timestamp with time zone'),
    'E16 the poll freshness column exists';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'whatsapp_evolution_instances_last_polled_at_idx'),
    'E16 the poll freshness index exists';

  -- ------------------- E17: reactivating the account clears the episode atomically
  -- The reconnect used to clear the episode in a separate best-effort call. When that call
  -- failed, the old episode and its "already emailed" marker survived and silenced the next
  -- outage. The reset now happens in the same statement as the activation.
  ep_two := public.observe_whatsapp_disconnect_state(acc_two, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E17 the episode opens';
  claim_ep := public.claim_whatsapp_disconnect_email(acc_two, 'user');
  ASSERT claim_ep IS NOT NULL, 'E17 the episode is claimed';
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_user_email_at}',
           to_jsonb(clock_timestamp()::text)),
         needs_reauth = true,
         last_refresh_error = 'wda synthetic failure'
   WHERE id = acc_two;
  UPDATE public.social_accounts SET is_active = false WHERE id = acc_two;
  UPDATE public.social_accounts SET is_active = true WHERE id = acc_two;
  ASSERT (SELECT NOT (account_metadata ? 'whatsapp_disconnect')
            AND NOT (account_metadata ? 'whatsapp_disconnect_claimed_at')
            AND NOT (account_metadata ? 'whatsapp_disconnect_user_email_at')
            AND NOT needs_reauth
            AND last_refresh_error IS NULL
            FROM public.social_accounts WHERE id = acc_two),
    'E17 the reactivation cleared the episode, the claims and the marker';
  ASSERT public.claim_whatsapp_disconnect_email(acc_two, 'user') IS NULL,
    'E17 the cleared episode can no longer be claimed';

  -- --------------------- E18: the cron entry carries no literal domain or secret
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    ASSERT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch'),
      'E18 the watch cron job is scheduled';
    ASSERT (SELECT position('get_cron_functions_base_url()' in command) > 0
              AND command !~ 'postora\.cloud'
              AND position('get_cron_secret()' in command) > 0
              AND command !~ '''[A-Za-z0-9_-]{24,}'''
            FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch'),
      'E18 the cron command resolves its endpoint and its secret from configuration';
  END IF;

  -- ------------------ E19: the base url resolver reads the configuration
  ASSERT public.get_cron_functions_base_url() IS NULL
         OR public.get_cron_functions_base_url() !~ 'postora\.cloud',
    'E19 the resolver returns the configured base url, never a baked-in domain';
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('functions_base_url', '"https://wda.example.invalid"'::jsonb, 'wda synthetic');
  ASSERT public.get_cron_functions_base_url() = 'https://wda.example.invalid',
    'E19 the app_settings row is read as the base url';
  DELETE FROM public.app_settings WHERE key = 'functions_base_url';
END $$;

ROLLBACK;

\echo '=== whatsapp_disconnect_alerts: ALL CHECKS PASSED ==='
