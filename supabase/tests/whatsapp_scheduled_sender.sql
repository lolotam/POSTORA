-- supabase/tests/whatsapp_scheduled_sender.sql
-- Whatsapp scheduled sender (migration 20260930100000): FK + status CHECK,
-- owner-scoped RLS with owned-whatsapp-account writes, the client state
-- guard, the fenced claim, grants, the inactive cron job, and cascade.
-- Style: one transaction, fixtures inside, labelled S1..S11 ASSERTs,
-- expected errors in nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel
-- last. Fixture values are synthetic ('...@example.invalid', '9655551xxxx'
-- test range); no secrets or real data.
BEGIN;
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  u_b uuid := 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
  ws_a uuid := 'c0c0c0c0-c0c0-4cc0-8cc0-c0c0c0c0c0c0';
  ws_b uuid := 'd0d0d0d0-d0d0-4dd0-8dd0-d0d0d0d0d0d0';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  acct_wa_b uuid := 'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2';
  acct_fb_a uuid := 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3';
BEGIN
  -- Fixtures. Whatsapp accounts carry a workspace_id (the
  -- social_accounts_whatsapp_needs_workspace CHECK rejects them without
  -- one); the facebook account needs none.
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'sched-sender-a-' || u_a::text || '@example.invalid'),
    (u_b, 'sched-sender-b-' || u_b::text || '@example.invalid');
  INSERT INTO public.workspaces (id, name, owner_id)
  VALUES
    (ws_a, 'sender workspace a', u_a),
    (ws_b, 'sender workspace b', u_b);
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES
    (acct_wa_a, u_a, 'whatsapp', 'wss-wa-a', 'token-wss-wa-a', ws_a),
    (acct_wa_b, u_b, 'whatsapp', 'wss-wa-b', 'token-wss-wa-b', ws_b);
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token)
  VALUES
    (acct_fb_a, u_a, 'facebook', 'wss-fb-a', 'token-wss-fb-a');

  -- S1: the FK rejects a bogus social_account_id.
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at)
    VALUES (u_a, 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            '96555510001', now() - interval '1 hour');
    RAISE EXCEPTION 'S1 failed: bogus social_account_id accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  ASSERT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'whatsapp_scheduled_messages_social_account_id_fkey'
                   AND conrelid = 'public.whatsapp_scheduled_messages'::regclass),
    'S1 ownership FK exists';

  -- S2: the status CHECK rejects 'bogus'.
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at, status)
    VALUES (u_a, acct_wa_a, '96555510001', now() - interval '1 hour', 'bogus');
    RAISE EXCEPTION 'S2 failed: bogus status accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- RLS + guard checks as user A. SET ROLE is a statement-level command: it
-- cannot run inside a DO block.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  acct_wa_b uuid := 'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2';
  acct_fb_a uuid := 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3';
  msg_ok uuid := '01a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
BEGIN
  -- S3: A inserts with their own whatsapp account OK (future-dated so no
  -- later claim in this suite touches it); B's account and A's
  -- non-whatsapp account are both rejected.
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES (msg_ok, u_a, acct_wa_a, '96555510001', now() + interval '1 day');
  ASSERT (SELECT count(*) FROM public.whatsapp_scheduled_messages
          WHERE id = msg_ok) = 1,
    'S3 insert with own whatsapp account succeeds';
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at)
    VALUES (u_a, acct_wa_b, '96555510002', now() + interval '1 day');
    RAISE EXCEPTION 'S3 failed: cross-user account insert accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at)
    VALUES (u_a, acct_fb_a, '96555510003', now() + interval '1 day');
    RAISE EXCEPTION 'S3 failed: non-whatsapp account insert accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

-- S4 setup (superuser, so the guard is bypassed): a fresh-claimed row and a
-- spare pending row, both future-dated so later claims ignore them.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_claimed uuid := '04a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4';
  msg_tok uuid := '05a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5';
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES
    (msg_claimed, u_a, acct_wa_a, '96555510004', now() + interval '1 day'),
    (msg_tok, u_a, acct_wa_a, '96555510005', now() + interval '1 day');
  UPDATE public.whatsapp_scheduled_messages
  SET status = 'claimed',
      claimed_at = now(),
      claim_token = gen_random_uuid(),
      attempts = 1
  WHERE id = msg_claimed;
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_ok uuid := '01a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  msg_claimed uuid := '04a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4';
  msg_tok uuid := '05a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5';
BEGIN
  -- S4: the client guard lets end users insert pending rows and cancel
  -- them, and nothing else.
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at, status)
    VALUES (u_a, acct_wa_a, '96555510006', now() + interval '1 day', 'sent');
    RAISE EXCEPTION 'S4 failed: client insert with status sent accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.whatsapp_scheduled_messages
  SET status = 'cancelled'
  WHERE id = msg_ok;
  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_ok) = 'cancelled',
    'S4 pending -> cancelled update succeeds';

  BEGIN
    UPDATE public.whatsapp_scheduled_messages
    SET status = 'pending'
    WHERE id = msg_claimed;
    RAISE EXCEPTION 'S4 failed: claimed -> pending update accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.whatsapp_scheduled_messages
    SET claim_token = gen_random_uuid()
    WHERE id = msg_tok;
    RAISE EXCEPTION 'S4 failed: claim_token update accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- S4b: an in-flight row cannot be deleted (RLS filters it silently); a
  -- pending row can.
  DELETE FROM public.whatsapp_scheduled_messages WHERE id = msg_claimed;
  ASSERT EXISTS (SELECT 1 FROM public.whatsapp_scheduled_messages WHERE id = msg_claimed),
    'S4b claimed row survives an end-user delete';
  DELETE FROM public.whatsapp_scheduled_messages WHERE id = msg_tok;
  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_scheduled_messages WHERE id = msg_tok),
    'S4b pending row can be deleted by its owner';
END $$;

RESET ROLE;

-- S5 as service_role: a due pending row for A on B's account fails closed.
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_b uuid := 'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2';
  msg_s5 uuid := '10a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  v_got uuid[];
  v_log jsonb;
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, message_text, scheduled_at)
  VALUES (msg_s5, u_a, acct_wa_b, '96555510011', 'S5 probe text',
          now() - interval '1 hour');

  SELECT array_agg(id)
    INTO v_got
    FROM public.claim_whatsapp_scheduled_messages(10, interval '2 minutes');

  ASSERT v_got IS NULL OR NOT (v_got @> ARRAY[msg_s5]),
    'S5 unowned-account row is not returned by the claim';
  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_s5) = 'failed',
    'S5 unowned-account row is marked failed';
  ASSERT (SELECT error_message FROM public.whatsapp_scheduled_messages
          WHERE id = msg_s5) = 'account_not_owned',
    'S5 unowned-account row carries account_not_owned';

  ASSERT (SELECT count(*) FROM public.system_logs
          WHERE metadata->>'scheduled_message_id' = msg_s5::text) = 1,
    'S5 unowned-account row logs exactly one system_logs row';
  SELECT metadata INTO v_log FROM public.system_logs
  WHERE metadata->>'scheduled_message_id' = msg_s5::text;
  ASSERT v_log->>'reason' = 'account_not_owned',
    'S5 system_logs row carries reason account_not_owned';
  ASSERT NOT (v_log ? 'phone'),
    'S5 system_logs metadata contains no phone key';
  ASSERT NOT (v_log ? 'recipient_phone'),
    'S5 system_logs metadata contains no recipient_phone key';
  ASSERT NOT (v_log ? 'message_text'),
    'S5 system_logs metadata contains no message_text key';
  ASSERT (SELECT message FROM public.system_logs
          WHERE metadata->>'scheduled_message_id' = msg_s5::text)
         = 'Scheduled message refused: account not owned',
    'S5 system_logs row carries the refusal message';
  ASSERT (SELECT source FROM public.system_logs
          WHERE metadata->>'scheduled_message_id' = msg_s5::text)
         = 'whatsapp-scheduled-sender',
    'S5 system_logs row carries the whatsapp-scheduled-sender source';
END $$;

RESET ROLE;

-- S6: due owned rows claim oldest-first with a token and attempts 1; a
-- second immediate claim returns nothing for them; the future row is
-- untouched.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_a uuid := '60606060-6060-4606-8606-606060606060';
  msg_b uuid := '61616161-6161-4616-8616-616161616161';
  msg_future uuid := '62626262-6262-4626-8626-626262626262';
  v_got uuid[];
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES
    (msg_a, u_a, acct_wa_a, '96555510021', now() - interval '30 minutes'),
    (msg_b, u_a, acct_wa_a, '96555510022', now() - interval '20 minutes'),
    (msg_future, u_a, acct_wa_a, '96555510023', now() + interval '1 hour');

  SELECT array_agg(id)
    INTO v_got
    FROM public.claim_whatsapp_scheduled_messages(10, interval '2 minutes');

  ASSERT v_got @> ARRAY[msg_a, msg_b],
    'S6 claim returns the due owned rows';
  ASSERT NOT (v_got @> ARRAY[msg_future]),
    'S6 claim does not return the not-yet-due row';
  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_a) = 'claimed',
    'S6 claimed row carries claimed status';
  ASSERT (SELECT claim_token FROM public.whatsapp_scheduled_messages
          WHERE id = msg_a) IS NOT NULL,
    'S6 claimed row carries a claim token';
  ASSERT (SELECT attempts FROM public.whatsapp_scheduled_messages
          WHERE id = msg_a) = 1,
    'S6 first claim sets attempts to 1';
END $$;

DO $$
DECLARE
  msg_a uuid := '60606060-6060-4606-8606-606060606060';
  msg_b uuid := '61616161-6161-4616-8616-616161616161';
  msg_future uuid := '62626262-6262-4626-8626-626262626262';
  v_got2 uuid[];
BEGIN
  SELECT array_agg(id)
    INTO v_got2
    FROM public.claim_whatsapp_scheduled_messages(10, interval '2 minutes');

  ASSERT v_got2 IS NULL
         OR (NOT (v_got2 @> ARRAY[msg_a]) AND NOT (v_got2 @> ARRAY[msg_b])),
    'S6 second immediate claim returns nothing for the claimed rows';
  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_future) = 'pending',
    'S6 not-yet-due row stays pending';
  ASSERT (SELECT claim_token FROM public.whatsapp_scheduled_messages
          WHERE id = msg_future) IS NULL,
    'S6 not-yet-due row gets no claim token';
END $$;

-- S7: an expired 'sending' row fails as indeterminate under a cleared
-- token and is never returned for resend.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_s7 uuid := '70707070-7070-4707-8707-707070707070';
  v_old_token uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_got uuid[];
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES (msg_s7, u_a, acct_wa_a, '96555510031', now() - interval '1 hour');
  UPDATE public.whatsapp_scheduled_messages
  SET status = 'sending',
      claimed_at = now() - interval '10 minutes',
      claim_token = v_old_token,
      attempts = 1
  WHERE id = msg_s7;

  SELECT array_agg(id)
    INTO v_got
    FROM public.claim_whatsapp_scheduled_messages(10, interval '2 minutes');

  ASSERT v_got IS NULL OR NOT (v_got @> ARRAY[msg_s7]),
    'S7 expired sending row is not returned by the claim';
  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_s7) = 'failed',
    'S7 expired sending row is marked failed';
  ASSERT (SELECT error_message FROM public.whatsapp_scheduled_messages
          WHERE id = msg_s7) = 'indeterminate',
    'S7 expired sending row carries indeterminate';
  ASSERT (SELECT claim_token FROM public.whatsapp_scheduled_messages
          WHERE id = msg_s7) IS NULL,
    'S7 expired sending row carries a cleared token';
  ASSERT EXISTS (SELECT 1 FROM public.system_logs
                 WHERE metadata->>'scheduled_message_id' = msg_s7::text
                   AND metadata->>'reason' = 'indeterminate'),
    'S7 indeterminate expiry writes a log row';
END $$;

-- S8: an expired 'claimed' lease below 3 attempts goes back to pending
-- (future-dated here, so the same call cannot re-claim it and the final
-- state is deterministic); at 3 attempts it exhausts.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_rel uuid := '80808080-8080-4808-8808-808080808080';
  msg_exh uuid := '81818181-8181-4818-8818-818181818181';
  v_got uuid[];
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES
    (msg_rel, u_a, acct_wa_a, '96555510041', now() + interval '1 hour'),
    (msg_exh, u_a, acct_wa_a, '96555510042', now() - interval '1 hour');
  UPDATE public.whatsapp_scheduled_messages
  SET status = 'claimed',
      claimed_at = now() - interval '10 minutes',
      claim_token = gen_random_uuid(),
      attempts = 1
  WHERE id = msg_rel;
  UPDATE public.whatsapp_scheduled_messages
  SET status = 'claimed',
      claimed_at = now() - interval '10 minutes',
      claim_token = gen_random_uuid(),
      attempts = 3
  WHERE id = msg_exh;

  SELECT array_agg(id)
    INTO v_got
    FROM public.claim_whatsapp_scheduled_messages(10, interval '2 minutes');

  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_rel) = 'pending',
    'S8 expired claimed lease below 3 attempts returns to pending';
  ASSERT (SELECT claim_token FROM public.whatsapp_scheduled_messages
          WHERE id = msg_rel) IS NULL,
    'S8 released lease carries a cleared token';
  ASSERT (SELECT claimed_at FROM public.whatsapp_scheduled_messages
          WHERE id = msg_rel) IS NULL,
    'S8 released lease carries a cleared claimed_at';
  ASSERT v_got IS NULL OR NOT (v_got @> ARRAY[msg_rel, msg_exh]),
    'S8 neither the released nor the exhausted row is returned as claimed';

  ASSERT (SELECT status FROM public.whatsapp_scheduled_messages
          WHERE id = msg_exh) = 'failed',
    'S8 expired claimed lease at 3 attempts is marked failed';
  ASSERT (SELECT error_message FROM public.whatsapp_scheduled_messages
          WHERE id = msg_exh) = 'attempts_exhausted',
    'S8 exhausted lease carries attempts_exhausted';
  ASSERT (SELECT claim_token FROM public.whatsapp_scheduled_messages
          WHERE id = msg_exh) IS NULL,
    'S8 exhausted lease carries a cleared token';
  ASSERT EXISTS (SELECT 1 FROM public.system_logs
                 WHERE metadata->>'scheduled_message_id' = msg_exh::text
                   AND metadata->>'reason' = 'attempts_exhausted'),
    'S8 exhausted lease writes a log row';
END $$;

-- S9: the claim function is executable by service_role only.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated',
             'public.claim_whatsapp_scheduled_messages(int, interval)', 'EXECUTE'),
    'S9 authenticated cannot EXECUTE claim_whatsapp_scheduled_messages';
  ASSERT NOT has_function_privilege('anon',
             'public.claim_whatsapp_scheduled_messages(int, interval)', 'EXECUTE'),
    'S9 anon cannot EXECUTE claim_whatsapp_scheduled_messages';
  ASSERT has_function_privilege('service_role',
             'public.claim_whatsapp_scheduled_messages(int, interval)', 'EXECUTE'),
    'S9 service_role can EXECUTE claim_whatsapp_scheduled_messages';
END $$;

-- S10: the cron job exists and is inactive. Skipped with a NOTICE where
-- pg_cron is absent: the harness baseline has no pg_cron, production does.
DO $s10_cron$
DECLARE
  v_cron_present boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    INTO v_cron_present;
  IF NOT v_cron_present THEN
    RAISE NOTICE 'pg_cron absent: skipping S10 cron assertions';
    RETURN;
  END IF;

  ASSERT EXISTS (SELECT 1 FROM cron.job
                 WHERE jobname = 'whatsapp-scheduled-sender'
                   AND schedule = '* * * * *'),
    'S10 whatsapp-scheduled-sender runs every minute';
  ASSERT (SELECT active FROM cron.job
          WHERE jobname = 'whatsapp-scheduled-sender') = false,
    'S10 whatsapp-scheduled-sender is inactive until hand-activated';
END $s10_cron$;

-- S11: deleting the account deletes its scheduled rows.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_tmp uuid := 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
  msg_tmp uuid := 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2';
BEGIN
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token)
  VALUES (acct_tmp, u_a, 'facebook', 'wss-tmp', 'token-wss-tmp');
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES (msg_tmp, u_a, acct_tmp, '96555510051', now() + interval '1 day');

  DELETE FROM public.social_accounts WHERE id = acct_tmp;

  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_scheduled_messages
                     WHERE id = msg_tmp),
    'S11 deleting the account deletes its scheduled rows';
END $$;

-- S12: a SECURITY DEFINER function called by an end user (like the account
-- merge, which repoints social_account_id on rows in any status) passes the
-- client guard, while the same end user updating the row directly does not.
CREATE FUNCTION public.s12_repoint(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER AS $fn$
  UPDATE public.whatsapp_scheduled_messages
  SET social_account_id = social_account_id, updated_at = now()
  WHERE id = p_id;
$fn$;
GRANT EXECUTE ON FUNCTION public.s12_repoint(uuid) TO authenticated;

INSERT INTO public.whatsapp_scheduled_messages
  (id, user_id, social_account_id, recipient_phone, scheduled_at, status, sent_at)
VALUES ('12121212-1212-4212-8212-121212121212', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
        'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', '96555510061', now() - interval '1 day',
        'sent', now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
                    'role', 'authenticated')::text, true);

DO $$
BEGIN
  PERFORM public.s12_repoint('12121212-1212-4212-8212-121212121212');
  BEGIN
    UPDATE public.whatsapp_scheduled_messages
    SET social_account_id = social_account_id
    WHERE id = '12121212-1212-4212-8212-121212121212';
    RAISE EXCEPTION 'S12 failed: direct end-user update of a sent row accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

-- S13: the media_filename column exists, its 240-char CHECK holds, and the
-- client guard lets an authenticated insert carry it (it only guards
-- claim/status columns).
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'whatsapp_scheduled_messages'
                   AND column_name = 'media_filename'),
    'S13 media_filename column exists';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'whatsapp_scheduled_messages_media_filename_check'
                   AND conrelid = 'public.whatsapp_scheduled_messages'::regclass),
    'S13 media_filename length CHECK exists';
END $$;

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
BEGIN
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at, media_filename)
    VALUES (u_a, acct_wa_a, '96555510071', now() + interval '1 day', repeat('x', 241));
    RAISE EXCEPTION 'S13 failed: 241-char media_filename accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_mf uuid := '13131313-1313-4313-8313-131313131313';
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at,
     media_url, media_type, media_filename)
  VALUES (msg_mf, u_a, acct_wa_a, '96555510072', now() + interval '1 day',
          'https://cdn.example/invoice.pdf', 'document', 'invoice.pdf');
  ASSERT (SELECT media_filename FROM public.whatsapp_scheduled_messages
          WHERE id = msg_mf) = 'invoice.pdf',
    'S13 authenticated insert with media_filename passes the guard';
END $$;

RESET ROLE;

-- S14: the claim RPC round-trips media_filename to the sender.
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_r uuid := '14141414-1414-4414-8414-141414141414';
  v_name text;
BEGIN
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at,
     media_url, media_type, media_filename)
  VALUES (msg_r, u_a, acct_wa_a, '96555510073', now() - interval '1 hour',
          'https://cdn.example/postora_2026_ab12.pdf', 'document', 'report.pdf');

  SELECT c.media_filename
    INTO v_name
    FROM public.claim_whatsapp_scheduled_messages(10, interval '2 minutes') AS c
   WHERE c.id = msg_r;

  ASSERT v_name = 'report.pdf',
    'S14 claim returns the media_filename the dialog stored';
END $$;

RESET ROLE;

-- S15: a scheduled media_url matching a deleting library file is refused by
-- the retention reference guard, for both the file_path address and a
-- provider delivery_url; the same URL passes once nothing is deleting.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  mf uuid := '15151515-1515-4515-8515-151515151515';
BEGIN
  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type,
     storage_bucket, cloudinary_public_id, retention_state)
  VALUES (mf, u_a, 'https://cdn.example/protected.pdf', 'document', 1024, 'application/pdf',
          'cloudinary', 'sched-s15/protected', 'deleting');
  INSERT INTO public.media_file_providers
    (media_file_id, provider, object_key, delivery_url, status)
  VALUES (mf, 'openinary', 'sched-s15/protected',
          'https://open.example/t/sched-s15/protected', 'ready');
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
BEGIN
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at, media_url, media_type)
    VALUES (u_a, acct_wa_a, '96555510074', now() + interval '1 day',
            'https://cdn.example/protected.pdf', 'document');
    RAISE EXCEPTION 'S15 failed: media_url matching a deleting file_path accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM = 'This file is being deleted from your library',
      'S15 expected the retention guard for the file_path match, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at, media_url, media_type)
    VALUES (u_a, acct_wa_a, '96555510075', now() + interval '1 day',
            'https://open.example/t/sched-s15/protected', 'document');
    RAISE EXCEPTION 'S15 failed: media_url matching a deleting delivery_url accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM = 'This file is being deleted from your library',
      'S15 expected the retention guard for the delivery_url match, got: ' || SQLERRM;
  END;
END $$;

RESET ROLE;

-- Once the file is no longer deleting, the same URL schedules fine.
UPDATE public.media_files
SET retention_state = NULL
WHERE file_path = 'https://cdn.example/protected.pdf';

INSERT INTO public.whatsapp_scheduled_messages
  (user_id, social_account_id, recipient_phone, scheduled_at, media_url, media_type)
VALUES ('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1',
        '96555510076', now() + interval '1 day', 'https://cdn.example/protected.pdf', 'document');

-- S16: deleting an account removes resting rows and nulls an in-flight one.
-- A client still cannot insert or update a row onto a NULL account.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  ws_a uuid := 'c0c0c0c0-c0c0-4cc0-8cc0-c0c0c0c0c0c0';
  acct uuid := 'f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3';
  msg_pending uuid := 'f4f4f4f4-f4f4-44f4-84f4-f4f4f4f4f4f4';
  msg_sending uuid := 'f5f5f5f5-f5f5-45f5-85f5-f5f5f5f5f5f5';
BEGIN
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'whatsapp_scheduled_messages'
            AND column_name = 'social_account_id') = 'YES',
    'S16 social_account_id is nullable';
  ASSERT (SELECT confdeltype FROM pg_constraint
          WHERE conname = 'whatsapp_scheduled_messages_social_account_id_fkey'
            AND conrelid = 'public.whatsapp_scheduled_messages'::regclass) = 'n',
    'S16 social_account_id FK is ON DELETE SET NULL';

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES (acct, u_a, 'whatsapp', 'wss-s16', 'token-wss-s16', ws_a);
  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at, status)
  VALUES
    (msg_pending, u_a, acct, '96555510081', now() + interval '1 day', 'pending'),
    (msg_sending, u_a, acct, '96555510082', now() + interval '1 day', 'sending');

  DELETE FROM public.social_accounts WHERE id = acct;

  ASSERT NOT EXISTS (SELECT 1 FROM public.whatsapp_scheduled_messages WHERE id = msg_pending),
    'S16 deleting the account removes its pending row';
  ASSERT EXISTS (SELECT 1 FROM public.whatsapp_scheduled_messages
                 WHERE id = msg_sending
                   AND status = 'sending'
                   AND social_account_id IS NULL),
    'S16 a sending row survives with social_account_id null';
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  acct_wa_a uuid := 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
  msg_owned uuid := 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
BEGIN
  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at)
    VALUES (u_a, NULL, '96555510083', now() + interval '1 day');
    RAISE EXCEPTION 'S16 failed: null account insert accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  INSERT INTO public.whatsapp_scheduled_messages
    (id, user_id, social_account_id, recipient_phone, scheduled_at)
  VALUES (msg_owned, u_a, acct_wa_a, '96555510084', now() + interval '1 day');
  BEGIN
    UPDATE public.whatsapp_scheduled_messages
    SET social_account_id = NULL
    WHERE id = msg_owned;
    RAISE EXCEPTION 'S16 failed: null account update accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT (SELECT social_account_id FROM public.whatsapp_scheduled_messages
          WHERE id = msg_owned) = acct_wa_a,
    'S16 a rejected null update leaves the owned account in place';
END $$;

RESET ROLE;

ROLLBACK;
\echo '=== whatsapp_scheduled_sender: ALL CHECKS PASSED ==='
