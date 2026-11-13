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
  acc_trans uuid := 'a7a7a7a7-0007-4111-8111-a7a7a7a7a7a7';
  acc_flag  uuid := 'a7a7a7a7-0008-4111-8111-a7a7a7a7a7a7';
  acc_legacy uuid := 'a7a7a7a7-0009-4111-8111-a7a7a7a7a7a7';
  acc_stuck uuid := 'a7a7a7a7-0010-4111-8111-a7a7a7a7a7a7';
  acc_pay   uuid := 'a7a7a7a7-0011-4111-8111-a7a7a7a7a7a7';
  ep        jsonb;
  ep_two    jsonb;
  since0    timestamptz;
  since1    timestamptz;
  first0    timestamptz;
  trans_ep  text;
  claim_ep  uuid;
  other_ep  uuid;
  -- The payload the claim stores with the first claim of a recipient.
  payload   jsonb := '{"to":["owner@example.invalid"],"subject":"wda subject","html":"<p>wda</p>"}'::jsonb;
  claim_json jsonb;
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
  -- acc_trans: a QR row used for the transient (connecting) episode cases.
  -- acc_flag : a QR row used for the healthy-poll restore case.
  -- acc_legacy: a QR row that was already inactive before this feature existed.
  -- acc_pay   : a QR row used for the claim payload cases, away from the other claims.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id,
     is_active, connection_mode, account_metadata)
  VALUES
    (acc, u_a, 'whatsapp', '96566600001', '', ws_a, true, 'evolution_qr',
     '{"automation_handler":"internal"}'),
    (acc_two, u_a, 'whatsapp', '96566600002', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_cloud, u_a, 'whatsapp', '96566600003', '', ws_a, true, 'cloud_api', '{}'),
    (acc_meta, u_a, 'facebook', 'fb-wda-0001', '', ws_a, true, 'cloud_api', '{}'),
    (acc_delib, u_a, 'whatsapp', '96566600004', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_trans, u_a, 'whatsapp', '96566600007', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_flag, u_a, 'whatsapp', '96566600008', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_legacy, u_a, 'whatsapp', '96566600009', '', ws_a, false, 'evolution_qr', '{}'),
    (acc_stuck, u_a, 'whatsapp', '96566600010', '', ws_a, true, 'evolution_qr', '{}'),
    (acc_pay, u_a, 'whatsapp', '96566600011', '', ws_a, true, 'evolution_qr', '{}');

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

  -- -------------------------- E2: a transient observation breaks the terminal streak
  -- `since` is the start of the CURRENT CONTINUOUS TERMINAL STREAK. A transient observation
  -- breaks that streak, so `since` is cleared: the ten minute grace window must never count
  -- pre-terminal time. The episode and its anchors stay.
  ep_two := public.observe_whatsapp_disconnect_state(acc, 'connecting', false);
  ASSERT ep_two IS NOT NULL, 'E2 the episode survives a transient observation';
  ASSERT ep_two->>'state' = 'connecting', 'E2 the transient state is recorded';
  ASSERT ep_two->>'since' IS NULL, 'E2 a transient observation clears the terminal streak';
  ASSERT ep_two->>'first_seen' IS NOT NULL, 'E2 the episode keeps its anchor';
  ASSERT (ep_two->>'first_seen')::timestamptz = first0, 'E2 first_seen is kept';
  ASSERT ep_two->>'episode_id' = ep->>'episode_id', 'E2 the episode id is kept';

  -- ------------------- E3: a transient observation may open an episode, without a streak
  -- An account stuck in `connecting` is broken, and the sixty minute backstop needs a
  -- first_seen to count from. A transient observation therefore opens the episode -- but it
  -- never starts a terminal streak, so the ten minute rule stays out of reach.
  ep_two := public.observe_whatsapp_disconnect_state(acc_trans, 'connecting', false);
  ASSERT ep_two IS NOT NULL, 'E3 a transient observation opens the episode';
  ASSERT ep_two->>'first_seen' IS NOT NULL, 'E3 the episode carries first_seen';
  ASSERT ep_two->>'since' IS NULL, 'E3 the episode carries no terminal streak';
  ASSERT ep_two->>'episode_id' IS NOT NULL, 'E3 the episode carries an episode id';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect' = ep_two
            FROM public.social_accounts WHERE id = acc_trans),
    'E3 the transient episode is stored on the row';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect' IS NULL
            FROM public.social_accounts WHERE id = acc_two),
    'E3 nothing was written for a row that was not observed';

  -- ----------------------------------------- E4: unrelated metadata is preserved
  ASSERT (SELECT account_metadata->>'automation_handler' = 'internal'
            FROM public.social_accounts WHERE id = acc),
    'E4 the unrelated metadata key survives';

  -- ------------------------------- E5: the owner and the admin claim independently
  claim_ep := (public.claim_whatsapp_disconnect_email(acc, 'user', payload)->>'episode_id')::uuid;
  ASSERT claim_ep IS NOT NULL, 'E5 the owner claim is won';
  ASSERT claim_ep = (ep->>'episode_id')::uuid, 'E5 the claim returns the episode id';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user', payload) IS NULL,
    'E5 the owner claim is once-only';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'admin', payload) IS NOT NULL,
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
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user', payload) IS NOT NULL,
    'E6 a stale claim is retaken';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user', payload) IS NULL,
    'E6 a live claim is not retaken';
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'admin', payload) IS NULL,
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
  ASSERT public.claim_whatsapp_disconnect_email(acc, 'user', payload) IS NOT NULL,
    'E6b a malformed claim timestamp is treated as stale, not as a blocker';

  -- ------------- E6c: the claim stores the payload once and never overwrites it
  -- The provider's idempotency key belongs to the episode and the recipient, so the body
  -- under that key must never change. The payload is therefore stored with the first claim
  -- of a recipient, and a retake answers with the stored one.
  ep_two := public.observe_whatsapp_disconnect_state(acc_pay, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E6c the episode opens';
  claim_json := public.claim_whatsapp_disconnect_email(
    acc_pay, 'user',
    '{"to":["first@example.invalid"],"subject":"first subject","html":"<p>first</p>"}'::jsonb);
  ASSERT claim_json IS NOT NULL, 'E6c the claim is won';
  ASSERT claim_json->>'episode_id' = ep_two->>'episode_id',
    'E6c the claim returns the episode id';
  ASSERT claim_json->'payload'->>'subject' = 'first subject',
    'E6c the claim returns the payload it stored';
  -- The claim goes stale and is retaken with a DIFFERENT payload: the account was renamed
  -- and the recipient list changed in the meantime.
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           jsonb_set(
             COALESCE(account_metadata->'whatsapp_disconnect_claimed_at', '{}'::jsonb),
             ARRAY['user'],
             to_jsonb((clock_timestamp() - interval '31 minutes')::text)))
   WHERE id = acc_pay;
  claim_json := public.claim_whatsapp_disconnect_email(
    acc_pay, 'user',
    '{"to":["second@example.invalid"],"subject":"second subject","html":"<p>second</p>"}'::jsonb);
  ASSERT claim_json IS NOT NULL, 'E6c the stale claim is retaken';
  ASSERT claim_json->>'episode_id' = ep_two->>'episode_id',
    'E6c the retake is the same episode';
  ASSERT claim_json->'payload'->>'subject' = 'first subject',
    'E6c a second claim does not overwrite the stored payload';
  ASSERT claim_json->'payload'->'to' = '["first@example.invalid"]'::jsonb,
    'E6c the stored recipients are the ones of the first claim';
  ASSERT (SELECT public.whatsapp_disconnect_email_payloads.payload->>'subject'
            FROM public.whatsapp_disconnect_email_payloads
           WHERE social_account_id = acc_pay AND kind = 'user'
             AND episode_id = (ep_two->>'episode_id')::uuid) = 'first subject',
    'E6c the stored payload is the one the first claim brought';

  -- ------------- E6d: the payload is not readable by the account owner or the public
  -- The payload carries the admin email addresses and the rendered admin email. It must
  -- therefore never live in social_accounts.account_metadata: that column is readable by
  -- the account owner and by anyone who can see a public profile.
  ASSERT NOT EXISTS (SELECT 1 FROM public.social_accounts
                       WHERE account_metadata ? 'whatsapp_disconnect_payload'),
    'E6d no account row carries the payload in account_metadata';
  ASSERT (SELECT relrowsecurity
            FROM pg_class
           WHERE oid = 'public.whatsapp_disconnect_email_payloads'::regclass),
    'E6d row level security is enabled on the payload table';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public'
                         AND tablename = 'whatsapp_disconnect_email_payloads'),
    'E6d the payload table has no policy at all';
  ASSERT NOT has_table_privilege('authenticated',
        'public.whatsapp_disconnect_email_payloads', 'SELECT'),
    'E6d authenticated cannot read the payload table';
  ASSERT NOT has_table_privilege('anon',
        'public.whatsapp_disconnect_email_payloads', 'SELECT'),
    'E6d anon cannot read the payload table';
  ASSERT NOT has_table_privilege('authenticated',
        'public.whatsapp_disconnect_email_payloads', 'INSERT'),
    'E6d authenticated cannot write the payload table';
  ASSERT NOT has_table_privilege('anon',
        'public.whatsapp_disconnect_email_payloads', 'DELETE'),
    'E6d anon cannot delete from the payload table';
  ASSERT has_table_privilege('service_role',
        'public.whatsapp_disconnect_email_payloads', 'SELECT'),
    'E6d the service role may read the payload table';

  -- ------------- E6e: clearing the episode removes the stored payload
  -- A later episode must build its own payload: a stale row must never be reused under
  -- a new idempotency key.
  ASSERT public.clear_whatsapp_disconnect_episode(acc_pay) = true,
    'E6e the episode is cleared';
  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_disconnect_email_payloads
                       WHERE social_account_id = acc_pay),
    'E6e clearing the episode removed the stored payload';
  ep_two := public.observe_whatsapp_disconnect_state(acc_pay, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E6e a later episode opens';
  ASSERT ep_two->>'episode_id' <> (claim_json->>'episode_id'),
    'E6e the later episode has its own id';
  claim_json := public.claim_whatsapp_disconnect_email(
    acc_pay, 'user',
    '{"to":["third@example.invalid"],"subject":"third subject","html":"<p>third</p>"}'::jsonb);
  ASSERT claim_json IS NOT NULL, 'E6e the later episode is claimed';
  ASSERT claim_json->'payload'->>'subject' = 'third subject',
    'E6e a different episode gets its own payload';
  ASSERT (SELECT count(*) FROM public.whatsapp_disconnect_email_payloads
           WHERE social_account_id = acc_pay) = 1,
    'E6e only the payload of the open episode is kept';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.whatsapp_disconnect_email_payloads'::regclass
       AND contype = 'p'
       AND pg_get_constraintdef(oid) LIKE '%episode_id%'),
    'E6e the payload rows are keyed per episode';

  -- --------------------------------------- E7: a claim needs an open episode
  ASSERT public.claim_whatsapp_disconnect_email(acc_two, 'user', payload) IS NULL,
    'E7 a claim without an episode is refused';

  -- ------------------------------------------- E8: an unknown kind is refused
  BEGIN
    PERFORM public.claim_whatsapp_disconnect_email(acc, 'nobody', payload);
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
  claim_ep := (public.claim_whatsapp_disconnect_email(acc_delib, 'user', payload)->>'episode_id')::uuid;
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
  ASSERT public.claim_whatsapp_disconnect_email(acc_delib, 'user', payload) IS NOT NULL,
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
  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_disconnect_email_payloads
                       WHERE social_account_id = acc_delib),
    'E12 the deliberate disconnect removes the stored payloads';
  ASSERT public.observe_whatsapp_disconnect_state(acc_delib, 'close', true) IS NULL,
    'E12 a deliberately disconnected account opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_delib, 'user', payload) IS NULL,
    'E12 a deliberately disconnected account is never claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_delib) = false,
    'E12 a deliberately disconnected account is never cleared';
  ASSERT (SELECT account_metadata->>'whatsapp_user_disconnected_at' IS NOT NULL
            FROM public.social_accounts WHERE id = acc_delib),
    'E12 the deliberate marker survives a clear';

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
  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_disconnect_email_payloads
                       WHERE social_account_id = acc),
    'E13 clearing the episode removed the stored payloads';
  ASSERT public.clear_whatsapp_disconnect_episode(acc) = false,
    'E13 clearing twice is a no-op';

  -- ---------- E18: the watcher flags only while the observed episode is still open
  -- Observe and flag are two calls. A reconnect or a deliberate disconnect between them must
  -- win: a stale flag would re-raise the banner on a healthy or deliberately closed account.
  ep := public.observe_whatsapp_disconnect_state(acc, 'close', true);
  ASSERT ep IS NOT NULL, 'E18 a fresh episode opens';
  ASSERT public.flag_whatsapp_disconnect_episode(acc, 'not-the-open-episode', 'wda reason') = false,
    'E18 a flag for another episode is refused';
  ASSERT (SELECT NOT needs_reauth AND is_active FROM public.social_accounts WHERE id = acc),
    'E18 the refused flag wrote nothing';
  ASSERT public.flag_whatsapp_disconnect_episode(acc, ep->>'episode_id', 'wda reason') = true,
    'E18 the open episode is flagged';
  ASSERT (SELECT needs_reauth AND NOT is_active AND last_refresh_error = 'wda reason'
            FROM public.social_accounts WHERE id = acc),
    'E18 the flag deactivates the row and raises the reconnect state';
  UPDATE public.social_accounts SET is_active = true WHERE id = acc;
  ASSERT public.flag_whatsapp_disconnect_episode(acc, ep->>'episode_id', 'wda reason') = false,
    'E18 a flag that arrives after the reconnect is refused';
  ASSERT (SELECT NOT needs_reauth AND is_active FROM public.social_accounts WHERE id = acc),
    'E18 the reconnect survives the stale flag';
  ep := public.observe_whatsapp_disconnect_state(acc, 'close', true);
  ASSERT public.mark_whatsapp_user_disconnected(acc) = true,
    'E18 the owner disconnects on purpose after the observation';
  ASSERT public.flag_whatsapp_disconnect_episode(acc, ep->>'episode_id', 'wda reason') = false,
    'E18 a deliberately disconnected account is never flagged';
  ASSERT public.flag_whatsapp_disconnect_episode(acc_cloud, ep->>'episode_id', 'wda reason') = false,
    'E18 a Cloud API WhatsApp row is never flagged';
  UPDATE public.social_accounts SET is_active = false WHERE id = acc;
  UPDATE public.social_accounts SET is_active = true WHERE id = acc;

  -- --------------------------------- E14: a foreign account is never touched
  ASSERT public.observe_whatsapp_disconnect_state(acc_cloud, 'close', true) IS NULL,
    'E14 a Cloud API WhatsApp row opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_cloud, 'user', payload) IS NULL,
    'E14 a Cloud API WhatsApp row is never claimed';
  ASSERT public.clear_whatsapp_disconnect_episode(acc_cloud) = false,
    'E14 a Cloud API WhatsApp row is never cleared';
  ASSERT public.observe_whatsapp_disconnect_state(acc_meta, 'close', true) IS NULL,
    'E14 a Meta row opens no episode';
  ASSERT public.claim_whatsapp_disconnect_email(acc_meta, 'user', payload) IS NULL,
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
        'public.claim_whatsapp_disconnect_email(uuid,text,jsonb)', 'EXECUTE'),
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
        'public.claim_whatsapp_disconnect_email(uuid,text,jsonb)', 'EXECUTE'),
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
        'public.flag_whatsapp_disconnect_episode(uuid,text,text)', 'EXECUTE'),
    'E15 the conditional flag is not browser-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.flag_whatsapp_disconnect_episode(uuid,text,text)', 'EXECUTE'),
    'E15 the conditional flag is not anon-callable';
  ASSERT has_function_privilege('service_role',
        'public.flag_whatsapp_disconnect_episode(uuid,text,text)', 'EXECUTE'),
    'E15 the service role may flag';
  ASSERT NOT has_function_privilege('authenticated',
        'public.get_cron_functions_base_url()', 'EXECUTE'),
    'E15 the base url resolver is not browser-callable';
  ASSERT has_function_privilege('service_role',
        'public.observe_whatsapp_disconnect_state(uuid,text,boolean)', 'EXECUTE'),
    'E15 the service role may observe';
  ASSERT has_function_privilege('service_role',
        'public.claim_whatsapp_disconnect_email(uuid,text,jsonb)', 'EXECUTE'),
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
  claim_ep := (public.claim_whatsapp_disconnect_email(acc_two, 'user', payload)->>'episode_id')::uuid;
  ASSERT claim_ep IS NOT NULL, 'E17 the episode is claimed';
  ASSERT EXISTS (SELECT 1 FROM public.whatsapp_disconnect_email_payloads
                  WHERE social_account_id = acc_two),
    'E17 the claim stored the payload of the episode';
  -- The reactivation fires the trigger, which clears the episode AND the stored payload in
  -- the same statement.
  UPDATE public.social_accounts SET is_active = false WHERE id = acc_two;
  UPDATE public.social_accounts SET is_active = true WHERE id = acc_two;
  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_disconnect_email_payloads
                       WHERE social_account_id = acc_two),
    'E17 the reactivation removed the stored payloads';
  ASSERT (SELECT NOT (account_metadata ? 'whatsapp_disconnect')
            AND NOT (account_metadata ? 'whatsapp_disconnect_claimed_at')
            AND NOT needs_reauth
            AND last_refresh_error IS NULL
            FROM public.social_accounts WHERE id = acc_two),
    'E17 the reactivation cleared the episode and its claims';
  ASSERT public.claim_whatsapp_disconnect_email(acc_two, 'user', payload) IS NULL,
    'E17 the cleared episode can no longer be claimed';

  -- The deliberate marker is cleared by the same trigger.
  ep_two := public.observe_whatsapp_disconnect_state(acc_two, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E17 a second episode opens';
  ASSERT public.mark_whatsapp_user_disconnected(acc_two) = true,
    'E17 the deliberate marker is written';
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
            AND NOT (account_metadata ? 'whatsapp_disconnect_user_email_at')
            AND NOT (account_metadata ? 'whatsapp_user_disconnected_at')
            AND NOT needs_reauth
            AND last_refresh_error IS NULL
            FROM public.social_accounts WHERE id = acc_two),
    'E17 the reactivation cleared the episode, the marker and the deliberate flag';

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
  -- An app_settings row is NOT a source. That table is editable by an application admin,
  -- and the resolved value is the host the cron secret is sent to in an Authorization
  -- header: an editable row would let an admin redirect the secret to a host of their
  -- choosing. The row below must therefore be ignored outright.
  -- The database setting is cleared first, so this proves the row is ignored even when
  -- the setting IS configured: otherwise the assertion would pass for the wrong reason.
  PERFORM set_config('app.settings.supabase_url', '', true);
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('functions_base_url', '"https://wda.example.invalid"'::jsonb, 'wda synthetic');
  ASSERT public.get_cron_functions_base_url() IS DISTINCT FROM 'https://wda.example.invalid',
    'E19 an app_settings row is not a trusted source for the cron base url';
  DELETE FROM public.app_settings WHERE key = 'functions_base_url';
  -- The database setting IS a source: the operator points it at this deployment.
  SET app.settings.supabase_url = 'https://wda.example.invalid';
  ASSERT public.get_cron_functions_base_url() = 'https://wda.example.invalid',
    'E19 the database setting is read as the base url';
  RESET app.settings.supabase_url;

  -- ------------------ E20: the deliberate marker can be rolled back, but only when it is owed
  -- The teardown marks first and deactivates second. When the deactivation fails, the row
  -- stays active with the marker on it, and the watcher skips every account carrying the
  -- marker: a live account whose session is gone would never be polled again.
  ASSERT public.mark_whatsapp_user_disconnected(acc_delib) = true,
    'E20 the deliberate marker is written';
  ASSERT public.unmark_whatsapp_user_disconnected(acc_delib) = true,
    'E20 the marker is cleared while the row is still active';
  ASSERT (SELECT account_metadata->'whatsapp_user_disconnected_at' IS NULL
            FROM public.social_accounts WHERE id = acc_delib),
    'E20 the marker is gone from the row';
  ASSERT public.unmark_whatsapp_user_disconnected(acc_delib) = false,
    'E20 clearing a row that carries no marker is a no-op';
  ASSERT public.unmark_whatsapp_user_disconnected(acc_cloud) = false,
    'E20 a Cloud API WhatsApp row is never unmarked';
  ASSERT public.unmark_whatsapp_user_disconnected(acc_meta) = false,
    'E20 a Meta row is never unmarked';
  ASSERT public.mark_whatsapp_user_disconnected(acc_delib) = true,
    'E20 the deliberate marker is written again';
  UPDATE public.social_accounts SET is_active = false WHERE id = acc_delib;
  ASSERT public.unmark_whatsapp_user_disconnected(acc_delib) = false,
    'E20 an inactive row keeps its marker: the disconnect did happen there';
  ASSERT (SELECT account_metadata->'whatsapp_user_disconnected_at' IS NOT NULL
            FROM public.social_accounts WHERE id = acc_delib),
    'E20 the marker survives an unmark on an inactive row';

  -- ------------------ E21: the marker rollback is service-role only
  ASSERT NOT has_function_privilege('authenticated',
        'public.unmark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E21 the marker rollback is not browser-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.unmark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E21 the marker rollback is not anon-callable';
  ASSERT has_function_privilege('service_role',
        'public.unmark_whatsapp_user_disconnected(uuid)', 'EXECUTE'),
    'E21 the service role may roll the marker back';

  -- ------------- E22: a terminal observation after a transient starts a new streak
  -- `since` is the start of the CURRENT CONTINUOUS TERMINAL STREAK, so the terminal
  -- observation that follows a transient must NOT inherit the transient's time: the ten
  -- minute grace window may only count time the account actually spent in a terminal state.
  first0 := (SELECT account_metadata->'whatsapp_disconnect'->>'first_seen'
               FROM public.social_accounts WHERE id = acc_trans)::timestamptz;
  trans_ep := (SELECT account_metadata->'whatsapp_disconnect'->>'episode_id'
                 FROM public.social_accounts WHERE id = acc_trans);
  ASSERT (SELECT account_metadata->'whatsapp_disconnect'->>'since' IS NULL
            FROM public.social_accounts WHERE id = acc_trans),
    'E22 the transient observation left no terminal streak';
  PERFORM pg_sleep(0.05);
  ep_two := public.observe_whatsapp_disconnect_state(acc_trans, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E22 the terminal observation is recorded';
  ASSERT ep_two->>'since' IS NOT NULL, 'E22 the terminal observation starts a streak';
  ASSERT (ep_two->>'since')::timestamptz > first0,
    'E22 the streak starts now, not at the transient observation';
  ASSERT (ep_two->>'first_seen')::timestamptz = first0, 'E22 the episode anchor is kept';
  ASSERT ep_two->>'episode_id' = trans_ep, 'E22 the episode id is kept';
  since1 := (ep_two->>'since')::timestamptz;

  -- --------------- E22b: consecutive terminals keep the streak anchor
  PERFORM pg_sleep(0.05);
  ep_two := public.observe_whatsapp_disconnect_state(acc_trans, 'timeout', true);
  ASSERT ep_two IS NOT NULL, 'E22b the second terminal observation is recorded';
  ASSERT (ep_two->>'since')::timestamptz = since1,
    'E22b consecutive terminals keep the streak anchor';
  ASSERT (ep_two->>'first_seen')::timestamptz = first0, 'E22b the episode anchor is kept';
  ASSERT ep_two->>'episode_id' = trans_ep, 'E22b the episode id is kept';

  -- -------- E23: an account stuck in `connecting` has the anchor the backstop needs
  -- The sixty minute backstop counts from first_seen. An account that never leaves
  -- `connecting` therefore needs a first_seen, and it must NOT have a terminal streak:
  -- the ten minute grace window is unreachable for an account that was never terminal.
  ep_two := public.observe_whatsapp_disconnect_state(acc_stuck, 'connecting', false);
  ASSERT ep_two IS NOT NULL, 'E23 the stuck account has an episode';
  ASSERT ep_two->>'first_seen' IS NOT NULL, 'E23 the stuck account has a backstop anchor';
  ASSERT ep_two->>'since' IS NULL, 'E23 the stuck account has no terminal streak';
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect,first_seen}',
           to_jsonb((clock_timestamp() - interval '61 minutes')::text))
   WHERE id = acc_stuck;
  ep_two := (SELECT account_metadata->'whatsapp_disconnect'
               FROM public.social_accounts WHERE id = acc_stuck);
  ASSERT (ep_two->>'first_seen')::timestamptz < clock_timestamp() - interval '60 minutes',
    'E23 the backstop window has elapsed';
  ASSERT ep_two->>'since' IS NULL,
    'E23 the grace window never applies to a transient-only episode';

  -- ------------- E24: a healthy poll restores an account the watcher deactivated
  ep_two := public.observe_whatsapp_disconnect_state(acc_flag, 'close', true);
  ASSERT ep_two IS NOT NULL, 'E24 the episode opens';
  ASSERT public.flag_whatsapp_disconnect_episode(acc_flag, ep_two->>'episode_id', 'wda reason') = true,
    'E24 the watcher flags the account';
  ASSERT (SELECT NOT is_active AND needs_reauth
            FROM public.social_accounts WHERE id = acc_flag),
    'E24 the flag deactivated the account';
  ASSERT (SELECT account_metadata->'whatsapp_disconnect'->>'flagged_at' IS NOT NULL
            FROM public.social_accounts WHERE id = acc_flag),
    'E24 the episode is stamped as the one the watcher flagged';
  ASSERT public.restore_whatsapp_disconnect_account(acc_flag) = true,
    'E24 the healthy poll restores the account';
  ASSERT (SELECT is_active AND NOT needs_reauth AND last_refresh_error IS NULL
            FROM public.social_accounts WHERE id = acc_flag),
    'E24 the account is active again and the red flag is gone';
  ASSERT (SELECT NOT (account_metadata ? 'whatsapp_disconnect')
            FROM public.social_accounts WHERE id = acc_flag),
    'E24 the episode is cleared';
  ASSERT public.restore_whatsapp_disconnect_account(acc_flag) = false,
    'E24 restoring an active account is refused';

  -- E24b: an account that was inactive for another reason is never restored
  UPDATE public.social_accounts SET is_active = false WHERE id = acc_two;
  ASSERT public.restore_whatsapp_disconnect_account(acc_two) = false,
    'E24b an account without a flagged episode is never restored';
  ASSERT (SELECT NOT is_active FROM public.social_accounts WHERE id = acc_two),
    'E24b the account stays inactive';

  -- E24c: an account the owner disconnected on purpose is never restored
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb), '{whatsapp_user_disconnected_at}',
           to_jsonb(clock_timestamp()::text))
   WHERE id = acc_two;
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb), '{whatsapp_disconnect}',
           jsonb_build_object('episode_id', gen_random_uuid()::text,
                              'since', clock_timestamp(), 'first_seen', clock_timestamp(),
                              'state', 'close', 'observed_at', clock_timestamp(),
                              'flagged_at', clock_timestamp()::text))
   WHERE id = acc_two;
  ASSERT public.restore_whatsapp_disconnect_account(acc_two) = false,
    'E24c a deliberately disconnected account is never restored';
  ASSERT (SELECT NOT is_active FROM public.social_accounts WHERE id = acc_two),
    'E24c the account stays inactive';
  ASSERT public.restore_whatsapp_disconnect_account(acc_cloud) = false,
    'E24c a Cloud API WhatsApp row is never restored';
  ASSERT public.restore_whatsapp_disconnect_account(acc_meta) = false,
    'E24c a Meta row is never restored';

  -- ------- E25: pre-rollout inactive accounts are treated as deliberate disconnects
  -- The marker is written by the teardown, and the teardown only existed after this feature.
  -- An account that was already inactive when the migration ran would otherwise be alerted
  -- about a disconnect the owner performed on purpose.
  ASSERT (SELECT account_metadata->'whatsapp_user_disconnected_at' IS NULL
            FROM public.social_accounts WHERE id = acc_legacy),
    'E25 the legacy account carries no marker yet';
  PERFORM public.backfill_whatsapp_legacy_disconnects('2026-11-13 00:00:00+00'::timestamptz);
  ASSERT (SELECT (account_metadata->>'whatsapp_user_disconnected_at')::timestamptz
                 = '2026-11-13 00:00:00+00'::timestamptz
            FROM public.social_accounts WHERE id = acc_legacy),
    'E25 the legacy account is marked as deliberately disconnected';
  ASSERT public.observe_whatsapp_disconnect_state(acc_legacy, 'close', true) IS NULL,
    'E25 a legacy account is never alerted';
  ASSERT (SELECT account_metadata->'whatsapp_user_disconnected_at' IS NULL
            FROM public.social_accounts WHERE id = acc_flag),
    'E25 an active account is never stamped';
  ASSERT (SELECT account_metadata->'whatsapp_user_disconnected_at' IS NULL
            FROM public.social_accounts WHERE id = acc_cloud),
    'E25 a Cloud API WhatsApp row is never stamped';
  -- A marker that is already there is never overwritten.
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb), '{whatsapp_user_disconnected_at}',
           to_jsonb('2020-01-01 00:00:00+00'::timestamptz::text))
   WHERE id = acc_stuck;
  UPDATE public.social_accounts SET is_active = false WHERE id = acc_stuck;
  PERFORM public.backfill_whatsapp_legacy_disconnects('2026-11-13 00:00:00+00'::timestamptz);
  ASSERT (SELECT (account_metadata->>'whatsapp_user_disconnected_at')::timestamptz
                 = '2020-01-01 00:00:00+00'::timestamptz
            FROM public.social_accounts WHERE id = acc_stuck),
    'E25 an existing marker keeps its own value';
  -- The account comes back into the watching when it is reactivated: the reactivation
  -- trigger clears the marker in the same statement as the activation.
  UPDATE public.social_accounts SET is_active = true WHERE id = acc_legacy;
  ASSERT (SELECT account_metadata->'whatsapp_user_disconnected_at' IS NULL
            FROM public.social_accounts WHERE id = acc_legacy),
    'E25 the reactivation clears the marker, so the account is watched again';

  -- --------------------- E26: the new RPCs stay service-role only
  ASSERT NOT has_function_privilege('authenticated',
        'public.restore_whatsapp_disconnect_account(uuid)', 'EXECUTE'),
    'E26 the restore is not browser-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.restore_whatsapp_disconnect_account(uuid)', 'EXECUTE'),
    'E26 the restore is not anon-callable';
  ASSERT has_function_privilege('service_role',
        'public.restore_whatsapp_disconnect_account(uuid)', 'EXECUTE'),
    'E26 the service role may restore';
  ASSERT NOT has_function_privilege('authenticated',
        'public.backfill_whatsapp_legacy_disconnects(timestamptz)', 'EXECUTE'),
    'E26 the backfill is not browser-callable';
  ASSERT NOT has_function_privilege('anon',
        'public.backfill_whatsapp_legacy_disconnects(timestamptz)', 'EXECUTE'),
    'E26 the backfill is not anon-callable';
  ASSERT has_function_privilege('service_role',
        'public.backfill_whatsapp_legacy_disconnects(timestamptz)', 'EXECUTE'),
    'E26 the service role may run the backfill';
END $$;

ROLLBACK;

\echo '=== whatsapp_disconnect_alerts: ALL CHECKS PASSED ==='
