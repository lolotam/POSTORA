-- Background workers Phase C+D: SQL proofs BJ1..BJ23.
-- Plan: docs/superpowers/plans/2026-11-07-background-workers-phase-cd.md (Task 1, Step 4).
--
-- The migration is applied twice inside this one transaction, so the file has to be
-- idempotent and must not commit the caller's transaction.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _cron_before AS SELECT jobname, schedule, command FROM cron.job;

\ir ../migrations/20261108120000_background_jobs.sql
\ir ../migrations/20261108120000_background_jobs.sql

DO $t$
DECLARE
  u_a uuid := 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  u_b uuid := 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  u_c uuid := 'cccccccc-3333-4333-8333-cccccccccccc';
  u_rls_1 uuid := '11111111-1111-4111-8111-111111111111';
  u_rls_2 uuid := '22222222-2222-4222-8222-222222222222';
  w_a uuid := 'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1';
  c1 uuid := 'e1e1e1e1-0000-4000-8000-000000000001';
  c2 uuid := 'e1e1e1e1-0000-4000-8000-000000000002';
  c3 uuid := 'e1e1e1e1-0000-4000-8000-000000000003';
  c4 uuid := 'e1e1e1e1-0000-4000-8000-000000000004';
  c5 uuid := 'e1e1e1e1-0000-4000-8000-000000000005';
  c6 uuid := 'e1e1e1e1-0000-4000-8000-000000000006';
  c7 uuid := 'e1e1e1e1-0000-4000-8000-000000000007';
  b1 uuid := 'b1000000-0000-4000-8000-000000000001';
  b2 uuid := 'b2000000-0000-4000-8000-000000000002';
  b3 uuid := 'b3000000-0000-4000-8000-000000000003';
  b4 uuid := 'b4000000-0000-4000-8000-000000000004';
  b5 uuid := 'b5000000-0000-4000-8000-000000000005';
  b6 uuid := 'b6000000-0000-4000-8000-000000000006';
  b7 uuid := 'b7000000-0000-4000-8000-000000000007';
  r1 uuid := 'a1000000-0000-4000-8000-000000000001';
  r2 uuid := 'a2000000-0000-4000-8000-000000000002';
  r3 uuid := 'a3000000-0000-4000-8000-000000000003';
  r4 uuid := 'a4000000-0000-4000-8000-000000000004';
  r5 uuid := 'a5000000-0000-4000-8000-000000000005';
  r6 uuid := 'a6000000-0000-4000-8000-000000000006';
  r7 uuid := 'a7000000-0000-4000-8000-000000000007';
  r8 uuid := 'a8000000-0000-4000-8000-000000000008';
  jid uuid; jid3 uuid; jid5 uuid;
  claimed_id uuid; claimed_attempts int; claimed_token uuid;
  reclaimed_id uuid; reclaimed_attempts int; reclaimed_token uuid;
  old_token uuid; n int; i int;
  v_sent int; v_failed int; v_skipped int; v_pending int; v_status text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'bg-jobs-a@example.invalid'),
    (u_b, 'bg-jobs-b@example.invalid'),
    (u_c, 'bg-jobs-c@example.invalid'),
    (u_rls_1, 'bg-jobs-rls-1@example.invalid'),
    (u_rls_2, 'bg-jobs-rls-2@example.invalid');

  INSERT INTO public.workspaces (id, name, owner_id) VALUES (w_a, 'BG jobs', u_a);

  INSERT INTO public.whatsapp_contacts (id, user_id, workspace_id, phone_number) VALUES
    (c1, u_a, w_a, '+96550001111'),
    (c2, u_a, w_a, '+96550002222'),
    (c3, u_a, w_a, '+96550003333'),
    (c4, u_a, w_a, '+96550004444'),
    (c5, u_a, w_a, '+96550005555'),
    (c6, u_a, w_a, '+96550006666'),
    (c7, u_a, w_a, '+96550007777');

  INSERT INTO public.whatsapp_broadcasts (id, user_id, name, template_name) VALUES
    (b1, u_a, 'B1', 'hello'),
    (b2, u_a, 'B2', 'hello'),
    (b3, u_a, 'B3', 'hello'),
    (b4, u_a, 'B4', 'hello'),
    (b5, u_a, 'B5', 'hello'),
    (b6, u_a, 'B6', 'hello'),
    (b7, u_a, 'B7', 'hello');

  INSERT INTO public.whatsapp_broadcast_recipients (id, broadcast_id, contact_id, phone_number, status) VALUES
    (r1, b1, c1, '+96550001111', 'pending'),
    (r2, b1, c2, '+96550002222', 'pending'),
    (r3, b1, c3, '+96550003333', 'sending'),
    (r7, b1, c7, '+96550007777', 'pending'),
    (r4, b3, c4, '+96550004444', 'sending'),
    (r5, b3, c5, '+96550005555', 'pending'),
    (r6, b5, c6, '+96550006666', 'pending'),
    (r8, b6, c6, '+96550006666', 'pending');

  -- BJ1: start returns a job id, the broadcast flips to sending, one job is enqueued.
  jid := public.start_whatsapp_broadcast(u_a, b1);
  ASSERT jid IS NOT NULL, 'BJ1: start returns a job id';
  ASSERT (SELECT status FROM public.whatsapp_broadcasts WHERE id = b1) = 'sending', 'BJ1: the broadcast is sending';
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE kind = 'whatsapp_broadcast_chunk' AND payload->>'broadcast_id' = b1::text) = 1,
    'BJ1: exactly one chunk job';
  ASSERT (SELECT payload->>'broadcast_id' FROM public.background_jobs WHERE id = jid) = b1::text,
    'BJ1: the payload carries the broadcast id';

  -- BJ2: a second start of the same broadcast is refused and enqueues nothing.
  ASSERT public.start_whatsapp_broadcast(u_a, b1) IS NULL, 'BJ2: the second start returns NULL';
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE kind = 'whatsapp_broadcast_chunk' AND payload->>'broadcast_id' = b1::text) = 1,
    'BJ2: still exactly one chunk job';

  -- BJ3: another user cannot start somebody else's broadcast.
  ASSERT public.start_whatsapp_broadcast(u_b, b1) IS NULL, 'BJ3: another user is refused';
  ASSERT (SELECT count(*) FROM public.background_jobs) = 1, 'BJ3: nothing else was enqueued';
  ASSERT (SELECT status FROM public.whatsapp_broadcasts WHERE id = b1) = 'sending', 'BJ3: the broadcast is untouched';

  -- BJ4: claim takes the job, bumps attempts, hands out a token and locks the queue.
  SELECT id, attempts, claim_token INTO claimed_id, claimed_attempts, claimed_token
    FROM public.claim_background_job(ARRAY['whatsapp_broadcast_chunk'], interval '3 minutes');
  ASSERT claimed_id = jid, 'BJ4: the queued job is claimed';
  ASSERT claimed_attempts = 1, 'BJ4: attempts are incremented';
  ASSERT claimed_token IS NOT NULL, 'BJ4: a fresh claim token is handed out';
  ASSERT (SELECT status FROM public.background_jobs WHERE id = claimed_id) = 'running', 'BJ4: the job is running';
  SELECT count(*) INTO n FROM public.claim_background_job(ARRAY['whatsapp_broadcast_chunk'], interval '3 minutes');
  ASSERT n = 0, 'BJ4: a second claim finds nothing';

  -- BJ5: continue is fenced by the claim token and hands the job back queued.
  ASSERT public.continue_background_job(claimed_id, gen_random_uuid(), NULL, NULL, NULL) IS FALSE,
    'BJ5: a wrong token cannot continue';
  ASSERT (SELECT status FROM public.background_jobs WHERE id = claimed_id) = 'running',
    'BJ5: the job is unchanged after a refused continue';
  ASSERT public.continue_background_job(claimed_id, claimed_token, '{"chunk":2}'::jsonb, '{"sent":1}'::jsonb, NULL) IS TRUE,
    'BJ5: the lease holder continues';
  ASSERT (SELECT status = 'queued' AND attempts = 0 AND claim_token IS NULL
            AND progress = '{"sent":1}'::jsonb AND payload = '{"chunk":2}'::jsonb
            FROM public.background_jobs WHERE id = claimed_id),
    'BJ5: the job is queued again with a fresh attempt budget';

  -- BJ6: a job whose run_after is in the future is not claimable.
  UPDATE public.background_jobs SET run_after = now() + interval '10 minutes' WHERE id = claimed_id;
  SELECT count(*) INTO n FROM public.claim_background_job(ARRAY['whatsapp_broadcast_chunk'], interval '3 minutes');
  ASSERT n = 0, 'BJ6: a job that is not due is not claimed';
  UPDATE public.background_jobs SET run_after = now() WHERE id = claimed_id;

  -- BJ7: a running job whose lease expired and that still has attempts left is reclaimed
  -- with a new token; the old token loses every write.
  UPDATE public.background_jobs
    SET status = 'running', claimed_at = now() - interval '4 minutes', attempts = 1,
        claim_token = gen_random_uuid()
    WHERE id = claimed_id;
  old_token := (SELECT claim_token FROM public.background_jobs WHERE id = claimed_id);
  SELECT id, attempts, claim_token INTO reclaimed_id, reclaimed_attempts, reclaimed_token
    FROM public.claim_background_job(ARRAY['whatsapp_broadcast_chunk'], interval '3 minutes');
  ASSERT reclaimed_id = claimed_id, 'BJ7: the expired job is reclaimed';
  ASSERT reclaimed_attempts = 2, 'BJ7: the attempt counter advanced';
  ASSERT reclaimed_token <> old_token, 'BJ7: the token changed';
  ASSERT public.complete_background_job(claimed_id, old_token, 'succeeded', NULL, NULL) IS FALSE,
    'BJ7: the old token cannot complete the job';

  -- BJ8: complete is fenced, terminal and rejects a status outside succeeded|failed.
  ASSERT public.complete_background_job(claimed_id, reclaimed_token, 'succeeded', '{"ok":true}'::jsonb, NULL) IS TRUE,
    'BJ8: the lease holder completes';
  ASSERT (SELECT status = 'succeeded' AND claim_token IS NULL AND finished_at IS NOT NULL
            FROM public.background_jobs WHERE id = claimed_id),
    'BJ8: the job is terminal';
  BEGIN
    PERFORM public.complete_background_job(claimed_id, reclaimed_token, 'cancelled', NULL, NULL);
    RAISE EXCEPTION 'BJ8: a status outside succeeded|failed must be refused' USING ERRCODE = 'P0002';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- BJ9: the recipient CAS moves pending -> sending exactly once.
  ASSERT public.begin_broadcast_recipient_send(r1) IS TRUE, 'BJ9: the first CAS wins';
  ASSERT public.begin_broadcast_recipient_send(r1) IS FALSE, 'BJ9: the second CAS loses';
  UPDATE public.whatsapp_broadcast_recipients SET status = 'sent', sent_at = now() WHERE id = r2;
  ASSERT public.begin_broadcast_recipient_send(r2) IS FALSE, 'BJ9: a sent recipient is not claimable';

  -- BJ10: the stale sweep turns 'sending' into outcome_unknown and leaves the rest alone.
  n := public.fail_stale_broadcast_sends(b1);
  ASSERT n = 2, 'BJ10: two indeterminate rows were settled';
  ASSERT (SELECT status = 'failed' AND error_message = 'outcome_unknown'
            FROM public.whatsapp_broadcast_recipients WHERE id = r1), 'BJ10: the claimed row is outcome_unknown';
  ASSERT (SELECT status = 'failed' AND error_message = 'outcome_unknown'
            FROM public.whatsapp_broadcast_recipients WHERE id = r3), 'BJ10: the stale row is outcome_unknown';
  ASSERT (SELECT status = 'pending' FROM public.whatsapp_broadcast_recipients WHERE id = r7),
    'BJ10: a pending row is untouched';
  ASSERT (SELECT status = 'sent' FROM public.whatsapp_broadcast_recipients WHERE id = r2),
    'BJ10: a sent row is untouched';

  -- BJ11: the totals are read from the recipient rows, and only a finishing call moves the status.
  SELECT sent, failed, skipped, pending, final_status INTO v_sent, v_failed, v_skipped, v_pending, v_status
    FROM public.refresh_whatsapp_broadcast_totals(b1, false);
  ASSERT v_status IS NOT DISTINCT FROM 'sending', 'BJ11: a non-finishing call returns sending';
  ASSERT v_sent = 1 AND v_failed = 2 AND v_skipped = 0 AND v_pending = 1, 'BJ11: the counts come from the rows';
  ASSERT (SELECT sent_count = 1 AND failed_count = 2 FROM public.whatsapp_broadcasts WHERE id = b1),
    'BJ11: the counters are written';
  ASSERT (SELECT status FROM public.whatsapp_broadcasts WHERE id = b1) = 'sending',
    'BJ11: the status is untouched without finish';
  UPDATE public.whatsapp_broadcast_recipients SET status = 'sent', sent_at = now() WHERE id = r7;
  SELECT sent, failed, skipped, pending, final_status INTO v_sent, v_failed, v_skipped, v_pending, v_status
    FROM public.refresh_whatsapp_broadcast_totals(b1, true);
  ASSERT v_pending = 0 AND v_status = 'completed', 'BJ11: finished with a delivery is completed';
  ASSERT (SELECT status FROM public.whatsapp_broadcasts WHERE id = b1) = 'completed', 'BJ11: the status is set';
  UPDATE public.whatsapp_broadcast_recipients SET status = 'failed', error_message = 'nope' WHERE id = r8;
  SELECT sent, failed, skipped, pending, final_status INTO v_sent, v_failed, v_skipped, v_pending, v_status
    FROM public.refresh_whatsapp_broadcast_totals(b6, true);
  ASSERT v_status = 'failed', 'BJ11: nothing sent and something failed is failed';

  -- BJ12: the sweep fails an exhausted lease and settles the broadcast it owned.
  jid3 := public.start_whatsapp_broadcast(u_a, b3);
  ASSERT jid3 IS NOT NULL, 'BJ12: the broadcast job was enqueued';
  UPDATE public.background_jobs
    SET status = 'running', claimed_at = now() - interval '4 minutes', attempts = 3,
        claim_token = gen_random_uuid(), updated_at = now()
    WHERE id = jid3;
  UPDATE public.whatsapp_broadcasts SET status = 'sending' WHERE id = b4;
  PERFORM public.sweep_background_jobs();
  ASSERT (SELECT status = 'failed' AND error = 'attempts_exhausted' FROM public.background_jobs WHERE id = jid3),
    'BJ12: the exhausted job is failed';
  ASSERT (SELECT status = 'failed' AND error_message = 'outcome_unknown'
            FROM public.whatsapp_broadcast_recipients WHERE id = r4), 'BJ12: a sending row is outcome_unknown';
  ASSERT (SELECT status = 'failed' AND error_message = 'broadcast_stopped'
            FROM public.whatsapp_broadcast_recipients WHERE id = r5), 'BJ12: a pending row is broadcast_stopped';
  ASSERT (SELECT status = 'failed' AND failed_count = 2 FROM public.whatsapp_broadcasts WHERE id = b3),
    'BJ12: the broadcast is terminal and the totals are refreshed';
  ASSERT (SELECT status FROM public.whatsapp_broadcasts WHERE id = b4) = 'sending',
    'BJ12: a sending broadcast without a job is left alone';

  -- BJ13: the sweep purges terminal rows older than 7 days and keeps the young ones.
  INSERT INTO public.background_jobs (user_id, kind, status, finished_at, updated_at) VALUES
    (u_c, 'purge_probe', 'succeeded', now() - interval '8 days', now() - interval '8 days'),
    (u_c, 'purge_probe', 'failed', now() - interval '1 day', now() - interval '1 day');
  PERFORM public.sweep_background_jobs();
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE kind = 'purge_probe' AND finished_at < now() - interval '7 days') = 0,
    'BJ13: an old terminal row is purged';
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE kind = 'purge_probe' AND finished_at >= now() - interval '7 days') = 1,
    'BJ13: a young terminal row stays';

  -- BJ14: every queue RPC is service_role only, and enqueue is not callable at all.
  ASSERT NOT has_function_privilege('service_role', 'public.enqueue_background_job(uuid,text,jsonb)', 'EXECUTE'),
    'BJ14: service_role cannot call enqueue_background_job';
  ASSERT NOT has_function_privilege('authenticated', 'public.enqueue_background_job(uuid,text,jsonb)', 'EXECUTE'),
    'BJ14: authenticated cannot call enqueue_background_job';
  ASSERT NOT has_function_privilege('anon', 'public.enqueue_background_job(uuid,text,jsonb)', 'EXECUTE'),
    'BJ14: anon cannot call enqueue_background_job';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_background_job(text[],interval)', 'EXECUTE'),
    'BJ14: authenticated cannot claim';
  ASSERT NOT has_function_privilege('authenticated', 'public.continue_background_job(uuid,uuid,jsonb,jsonb,timestamptz)', 'EXECUTE'),
    'BJ14: authenticated cannot continue';
  ASSERT NOT has_function_privilege('authenticated', 'public.complete_background_job(uuid,uuid,text,jsonb,text)', 'EXECUTE'),
    'BJ14: authenticated cannot complete';
  ASSERT NOT has_function_privilege('authenticated', 'public.start_whatsapp_broadcast(uuid,uuid)', 'EXECUTE'),
    'BJ14: authenticated cannot start a broadcast';
  ASSERT NOT has_function_privilege('authenticated', 'public.begin_broadcast_recipient_send(uuid)', 'EXECUTE'),
    'BJ14: authenticated cannot claim a recipient';
  ASSERT NOT has_function_privilege('authenticated', 'public.refresh_whatsapp_broadcast_totals(uuid,boolean)', 'EXECUTE'),
    'BJ14: authenticated cannot refresh the totals';
  ASSERT NOT has_function_privilege('authenticated', 'public.sweep_background_jobs()', 'EXECUTE'),
    'BJ14: authenticated cannot sweep';
  ASSERT has_function_privilege('service_role', 'public.claim_background_job(text[],interval)', 'EXECUTE'),
    'BJ14: service_role can claim';
  ASSERT has_function_privilege('service_role', 'public.sweep_background_jobs()', 'EXECUTE'),
    'BJ14: service_role can sweep';

  -- BJ15: the owner sees exactly their own job, nobody else does.
  PERFORM public.enqueue_background_job(u_rls_1, 'rls_probe', '{}'::jsonb);

  -- BJ16: both tables are in the realtime publication.
  ASSERT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'background_jobs'),
    'BJ16: background_jobs is published';
  ASSERT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'whatsapp_broadcasts'),
    'BJ16: whatsapp_broadcasts is published';

  -- BJ17: the sweep cron exists exactly once and the other jobs are untouched.
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'sweep-background-jobs') = 1,
    'BJ17: the sweep cron exists once';
  ASSERT NOT EXISTS (SELECT jobname, schedule, command FROM _cron_before
                     EXCEPT SELECT jobname, schedule, command FROM cron.job),
    'BJ17: the other cron jobs are unchanged';

  -- BJ18: a job nobody touched for 16 minutes is stalled, and its broadcast is settled.
  jid5 := public.start_whatsapp_broadcast(u_a, b5);
  ASSERT jid5 IS NOT NULL, 'BJ18: the broadcast job was enqueued';
  UPDATE public.background_jobs SET updated_at = now() - interval '16 minutes' WHERE id = jid5;
  PERFORM public.sweep_background_jobs();
  ASSERT (SELECT status = 'failed' AND error = 'stalled' FROM public.background_jobs WHERE id = jid5),
    'BJ18: the stalled job is failed';
  ASSERT (SELECT status = 'failed' FROM public.whatsapp_broadcasts WHERE id = b5),
    'BJ18: the broadcast of the stalled job is settled';
  ASSERT (SELECT status = 'failed' AND error_message = 'broadcast_stopped'
            FROM public.whatsapp_broadcast_recipients WHERE id = r6),
    'BJ18: the pending recipient of the stalled broadcast is failed';

  -- BJ23: the per-user cap admits 25 live jobs and refuses the 26th.
  FOR i IN 1..25 LOOP
    PERFORM public.enqueue_background_job(u_c, 'cap_probe', '{}'::jsonb);
  END LOOP;
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE user_id = u_c AND status IN ('queued','running')) = 25,
    'BJ23: 25 live jobs fit under the cap';
  BEGIN
    PERFORM public.enqueue_background_job(u_c, 'cap_probe', '{}'::jsonb);
    RAISE EXCEPTION 'BJ23: the 26th insert must be refused' USING ERRCODE = 'P0002';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE user_id = u_c AND status IN ('queued','running')) = 25,
    'BJ23: the refused insert changed nothing';
END
$t$;

-- BJ15: RLS. The owner sees their own job, nobody else does, and the browser cannot write.
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
SET LOCAL ROLE authenticated;
DO $rls$ BEGIN
  ASSERT (SELECT count(*) FROM public.background_jobs) = 1,
    'BJ15: a user sees their own job';
  ASSERT (SELECT count(*) FROM public.background_jobs
          WHERE user_id <> '11111111-1111-4111-8111-111111111111') = 0,
    'BJ15: a user sees no one else''s jobs';
  BEGIN
    INSERT INTO public.background_jobs (user_id, kind) VALUES
      ('11111111-1111-4111-8111-111111111111', 'written_by_browser');
    RAISE EXCEPTION 'BJ15: a browser insert must be denied' USING ERRCODE = 'P0002';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $rls$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
SET LOCAL ROLE authenticated;
DO $rls2$ BEGIN
  ASSERT (SELECT count(*) FROM public.background_jobs) = 0,
    'BJ15: the second user sees nothing';
END $rls2$;
RESET ROLE;

-- BJ19: the outbound row shape the chunk writes into whatsapp_messages.
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","role":"service_role"}', true);
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', true);
SET LOCAL ROLE service_role;
DO $outbound$ BEGIN
  INSERT INTO public.whatsapp_messages
    (user_id, social_account_id, conversation_id, message_id, to_phone, message_text,
     message_type, direction, status)
  VALUES
    ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'dddddddd-4444-4444-8444-dddddddddddd',
     'wa_1234567890_96550001111', 'wamid.OUTBOUND1', '+96550001111',
     '[Broadcast: B1] Template: hello', 'template', 'outbound', 'sent');
  ASSERT (SELECT count(*) FROM public.whatsapp_messages
          WHERE message_id = 'wamid.OUTBOUND1'
            AND conversation_id = 'wa_1234567890_96550001111'
            AND social_account_id = 'dddddddd-4444-4444-8444-dddddddddddd'
            AND to_phone = '+96550001111'
            AND message_type = 'template' AND direction = 'outbound' AND status = 'sent') = 1,
    'BJ19: the outbound row is written';
END $outbound$;
RESET ROLE;

-- BJ20, BJ21, BJ22: the browser cannot forge a recipient state or a broadcast status.
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', true);
SET LOCAL ROLE authenticated;
DO $guards$ BEGIN
  -- Valid recipient admission must still work with the parent lock as authenticated owner.
  INSERT INTO public.whatsapp_broadcast_recipients (broadcast_id, contact_id, phone_number, status)
  VALUES ('b7000000-0000-4000-8000-000000000007',
          'e1e1e1e1-0000-4000-8000-000000000002', '+96550002222', 'pending');
  ASSERT (SELECT count(*) FROM public.whatsapp_broadcast_recipients
          WHERE broadcast_id = 'b7000000-0000-4000-8000-000000000007' AND status = 'pending') = 1,
    'BJ21: authenticated owner can admit a fresh recipient while the parent remains pending';
  -- BJ20: a sent recipient cannot be put back into pending, which would resend it.
  BEGIN
    UPDATE public.whatsapp_broadcast_recipients SET status = 'pending'
      WHERE id = 'a2000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'BJ20: a browser must not reset a recipient' USING ERRCODE = 'P0002';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- BJ21: a browser cannot insert a recipient that is already sent.
  BEGIN
    INSERT INTO public.whatsapp_broadcast_recipients (broadcast_id, contact_id, phone_number, status)
    VALUES ('b7000000-0000-4000-8000-000000000007',
            'e1e1e1e1-0000-4000-8000-000000000001', '+96550009999', 'sent');
    RAISE EXCEPTION 'BJ21: a browser must not insert a sent recipient' USING ERRCODE = 'P0002';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- BJ22: a browser cannot forge the broadcast status, but it may rename a pending broadcast.
  BEGIN
    UPDATE public.whatsapp_broadcasts SET status = 'completed'
      WHERE id = 'b2000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'BJ22: a browser must not forge a broadcast status' USING ERRCODE = 'P0002';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.whatsapp_broadcasts SET name = 'B2 renamed'
    WHERE id = 'b2000000-0000-4000-8000-000000000002';
  ASSERT (SELECT count(*) FROM public.whatsapp_broadcasts
          WHERE id = 'b2000000-0000-4000-8000-000000000002' AND name = 'B2 renamed') = 1,
    'BJ22: renaming a pending broadcast is allowed';
END $guards$;
RESET ROLE;

ROLLBACK;
\echo '=== background_jobs: ALL CHECKS PASSED ==='
