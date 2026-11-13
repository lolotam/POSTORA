-- supabase/tests/agent_handoff_ack_terminal_claim.sql
-- The one-time notice that outlived its window (migration
-- 20261113260000_agent_handoff_ack_terminal_claim.sql). One transaction, synthetic fixtures,
-- labelled T1..Tn ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are applied. No
-- secrets and no real accounts.
--
-- The promise this holds:
--
--   The customer is told once that a human has their conversation, and the notice is never
--   lost because the window it was claimed on expired while the claim was in flight.
--
--   The expiry (20261113230000) deletes the ai_conversation_modes row as soon as
--   expires_at <= now(), and the notice is persisted by a statement that used to look the
--   claim up ON that row. A claim taken just before the window ended could therefore be
--   erased before the notice was written: the persistence found no row, wrote nothing, and
--   the claim died with the row -- so no turn could ever retry it, and the customer was
--   never told.
--
--   Expiry retains only the final claim token. Its durable receipt is checked and
--   consumed atomically; arbitrary or superseded tokens cannot recreate a notice.
BEGIN;
DO $$
DECLARE
  u_a uuid := 'c7c7c7c7-1111-4111-8111-cccccccccccc';
  s_account uuid := 'c7c7c7c7-0001-4001-8001-eeeeeeeeeeee';
  r_notice uuid := 'c8c8c8c8-0001-4001-8001-ffffffffffff';
  r_again uuid := 'c9c9c9c9-0001-4001-8001-ffffffffffff';
  r_other uuid := 'cacacaca-0001-4001-8001-ffffffffffff';
  r_notoken uuid := 'cbcbcbcb-0001-4001-8001-ffffffffffff';
  v_mode uuid := 'd7d7d7d7-0001-4001-8001-dddddddddddd';
  v_mode2 uuid := 'd8d8d8d8-0001-4001-8001-dddddddddddd';
  v_claim jsonb;
  v_token timestamptz;
  v_other_claim timestamptz := clock_timestamp() - interval '1 day';
  v_notice text := 'تم تحويل محادثتك لفريقنا';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'terminal-ack-' || u_a::text || '@example.invalid');

  INSERT INTO public.workspaces (id, name, owner_id) VALUES (u_a, 'Handoff fixture', u_a);

  INSERT INTO public.social_accounts (id, user_id, workspace_id, platform, platform_user_id, access_token)
  VALUES (s_account, u_a, u_a, 'whatsapp', 'page-terminal', 'token-terminal');

  INSERT INTO public.ai_conversation_modes (
    id, user_id, platform, conversation_id, mode, expires_at, escalated_at
  ) VALUES
    (v_mode, u_a, 'whatsapp', 'c_terminal', 'human_first', now() + interval '1 hour', now()),
    (v_mode2, u_a, 'whatsapp', 'c_rearmed', 'human_first', now() + interval '1 hour', now());

  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES
    (r_notice, s_account, u_a, 'whatsapp', 'm-terminal-1', 'c_terminal', 'r-terminal-1',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_again, s_account, u_a, 'whatsapp', 'm-terminal-2', 'c_terminal', 'r-terminal-2',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_other, s_account, u_a, 'whatsapp', 'm-terminal-3', 'c_rearmed', 'r-terminal-3',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_notoken, s_account, u_a, 'whatsapp', 'm-terminal-4', 'c_absent', 'r-terminal-4',
     'عندكم كريم الكعب؟', now(), 'running');

  -- T1: the customer writes into the window and the claim is taken while it is still live.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_terminal', 120);
  ASSERT v_claim->>'result' = 'claimed', 'T1 the window is claimed';
  v_token := (v_claim->>'claim_token')::timestamptz;
  ASSERT v_token IS NOT NULL, 'T1 the claim carries a token';

  -- T1: the window ends and the expiry consumes the row, the claim on it and all.
  UPDATE public.ai_conversation_modes
     SET expires_at = now() - interval '1 minute'
   WHERE id = v_mode;
  ASSERT public.expire_conversation_mode(v_mode, u_a, (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode)),
    'T1 the expired window is consumed';
  ASSERT NOT EXISTS (SELECT 1 FROM public.ai_conversation_modes WHERE id = v_mode),
    'T1 the window row is gone';

  -- T1: the expiry keeps its own promise: the apology for the silent window is still owed.
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads
          WHERE user_id = u_a AND platform = 'whatsapp' AND conversation_id = 'c_terminal') IS NOT NULL,
    'T1 the escalation marker is left behind';

  -- T1: the notice the claim promised is written even though the row it was claimed on is
  -- gone. This is the acknowledgement that used to be lost.
  ASSERT public.persist_human_mode_ack_and_complete_claim(
           r_notice, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_terminal', v_token),
    'T1 the notice is persisted after the window expired';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice) = 'ready_to_send',
    'T1 the row holds the notice';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_notice) = v_notice,
    'T1 the text is written';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_notice) = 'human_mode_ack',
    'T1 the row knows what the text is';

  -- T1: the notice is written ONCE. The row it was written into is moved only from the
  -- state the caller named, so a second persistence of the same notice writes nothing.
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_notice, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_terminal', v_token),
    'T1 the notice is not written twice';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice) = 'ready_to_send',
    'T1 the row keeps the notice it holds';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_notice) = v_notice,
    'T1 the text is not written twice';

  -- T1: the outbox row's own state machine still decides whether the notice is written: a
  -- row that is not in the from-state is not this caller's to move, and the claim is not
  -- spent either.
  UPDATE public.pending_agent_replies SET status = 'sent' WHERE id = r_again;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_again, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_terminal', v_token),
    'T1 a row that is not in the from-state is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_again) IS NULL,
    'T1 no text is written into a row that was not this caller to move';

  -- T2: a row that IS there and carries ANOTHER claim is refused: the claim this caller
  -- holds is not the live one, so nothing is written for it.
  UPDATE public.ai_conversation_modes
     SET customer_ack_sent_at = v_other_claim,
         customer_ack_claimed_at = v_other_claim
   WHERE id = v_mode2;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_other, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_rearmed', v_token),
    'T2 a row carrying another claim stores nothing';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_other) = 'running',
    'T2 the row is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_other) IS NULL,
    'T2 no text is written';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes WHERE id = v_mode2) IS NULL,
    'T2 the other claim is not spent';

  -- T3: no row at all and no token: there is no claim to spend, so there is nothing to
  -- promise.
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_notoken, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_absent', NULL),
    'T3 a notice without a claim token stores nothing';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notoken) = 'running',
    'T3 the row is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_notoken) IS NULL,
    'T3 no text is written';

  -- T4: a consumed receipt cannot spend the same claim on a different outbox row.
  UPDATE public.pending_agent_replies SET status = 'running' WHERE id = r_again;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
    r_again, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_terminal', v_token), 'T4 the receipt cannot be spent twice';
  ASSERT NOT public.replace_agent_reply_and_complete_claim(
    u_a, r_again, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    'whatsapp', 'c_terminal', v_token), 'T4 replacement cannot spend a consumed receipt';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
    r_notoken, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_absent', clock_timestamp()), 'T4 an invented token is refused';

  -- T5: worker B supersedes A, persists, then the mode row expires. A never becomes valid again.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_rearmed', 120);
  v_token := (v_claim->>'claim_token')::timestamptz;
  ASSERT public.persist_human_mode_ack_and_complete_claim(
    r_other, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_rearmed', v_token), 'T5 successor persists the notice';
  UPDATE public.ai_conversation_modes SET expires_at = now() - interval '1 minute' WHERE id = v_mode2;
  ASSERT public.expire_conversation_mode(v_mode2, u_a,
    (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode2)), 'T5 mode expires';
  UPDATE public.pending_agent_replies SET conversation_id = 'c_rearmed' WHERE id = r_again;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
    r_again, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_rearmed', v_other_claim), 'T5 superseded worker is refused after expiry';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
    r_again, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_rearmed', v_token), 'T5 completed worker is refused after expiry';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_again) = 'running',
    'T5 no duplicate notice was persisted';

  -- T6: receipt storage is inaccessible to browser roles, including another tenant.
  ASSERT NOT has_table_privilege('anon', 'public.ai_handoff_ack_receipts', 'SELECT'), 'T6 anon cannot read receipts';
  ASSERT NOT has_table_privilege('authenticated', 'public.ai_handoff_ack_receipts', 'SELECT'), 'T6 users cannot read receipts';
  ASSERT NOT has_table_privilege('authenticated', 'public.ai_handoff_ack_receipts', 'INSERT'), 'T6 users cannot forge receipts';
  ASSERT has_table_privilege('service_role', 'public.ai_handoff_ack_receipts', 'SELECT'), 'T6 service can read receipts';

  -- T7: a non-outbox completion also consumes the surviving receipt after expiry.
  INSERT INTO public.ai_conversation_modes (user_id, platform, conversation_id, mode, expires_at)
    VALUES (u_a, 'whatsapp', 'c_complete', 'human_first', now() + interval '1 hour') RETURNING id INTO v_mode;
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_complete', 120);
  v_token := (v_claim->>'claim_token')::timestamptz;
  UPDATE public.ai_conversation_modes SET expires_at = now() - interval '1 minute' WHERE id = v_mode;
  ASSERT public.expire_conversation_mode(v_mode, u_a,
    (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode)), 'T7 mode expires';
  ASSERT public.complete_human_mode_ack(u_a, 'whatsapp', 'c_complete', v_token), 'T7 late completion consumes receipt';
  ASSERT NOT public.complete_human_mode_ack(u_a, 'whatsapp', 'c_complete', v_token), 'T7 completion is single use';
  UPDATE public.pending_agent_replies SET conversation_id = 'c_complete' WHERE id = r_again;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
    r_again, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_complete', v_token), 'T7 completed receipt cannot persist another notice';

  -- T8: a worker dies after leasing. Expiry persists its exact notice for the normal
  -- outbox retry path, so recovery never needs to discover an orphaned receipt token.
  INSERT INTO public.ai_conversation_modes (user_id, platform, conversation_id, mode, expires_at)
    VALUES (u_a, 'whatsapp', 'c_recover', 'human_first', now() + interval '1 hour') RETURNING id INTO v_mode;
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_recover', 120, r_other, 'One fixed notice');
  ASSERT v_claim->>'result' = 'failed', 'T8 a different conversation cannot bind the recovery row';
  UPDATE public.pending_agent_replies SET conversation_id = 'c_recover' WHERE id IN (r_again, r_notoken);
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_recover', 120, r_again, 'One fixed notice');
  ASSERT v_claim->>'result' = 'claimed', 'T8 the notice recipe is bound with the lease';
  v_token := (v_claim->>'claim_token')::timestamptz;
  UPDATE public.ai_conversation_modes SET expires_at = now() - interval '1 minute' WHERE id = v_mode;
  ASSERT public.expire_conversation_mode(v_mode, u_a,
    (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode)), 'T8 mode expires after worker death';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_again) = 'One fixed notice',
    'T8 expiry preserves the promised text';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_again) = 'human_mode_ack',
    'T8 recovery knows this is an acknowledgement';
  ASSERT (SELECT lease_expires_at FROM public.pending_agent_replies WHERE id = r_again) < clock_timestamp(),
    'T8 normal outbox recovery can pick the row up immediately';
  ASSERT public.claim_agent_reply_for_delivery_for_owner(u_a, r_again,
    'ready_to_send', 'sending', 'One fixed notice', 'human_mode_ack'), 'T8 recovery claims the durable notice';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
    r_notoken, 'running', 'ready_to_send', v_notice, NULL, NULL, 'human_mode_ack',
    u_a, 'whatsapp', 'c_recover', v_token), 'T8 the old worker cannot create a duplicate notice';

  -- T9: only service_role reaches the function.
  ASSERT NOT has_function_privilege('anon', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'T4 anon cannot persist a notice';
  ASSERT NOT has_function_privilege('authenticated', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'T4 authenticated cannot persist a notice';
  ASSERT has_function_privilege('service_role', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'T4 service_role can persist a notice';
END $$;

ROLLBACK;
\echo '=== agent_handoff_ack_terminal_claim: ALL CHECKS PASSED ==='
