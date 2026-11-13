-- supabase/tests/agent_handoff_claim_atomicity.sql
-- The handoff claims and the writes that spend them, in ONE statement (migration
-- 20261113240000_agent_handoff_claim_token.sql). One transaction, synthetic fixtures, labelled
-- A1..An ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are applied. No secrets and no
-- real accounts.
--
-- Two promises this holds:
--
--   * The one-time notice and the claim it spends are ONE fact. Written as two statements, a
--     completion that failed left the notice delivered with the claim still owed -- and the
--     next turn that met the same window sent the customer a second notice.
--
--   * The delivery claim carries the payload the caller read. The row's text is read without a
--     lock, so a closed gate can replace it between the read and the claim; a delivery that
--     sent the OLD text would hand the customer an answer the closed gate was meant to block.
BEGIN;
DO $$
DECLARE
  u_a uuid := 'a5a5a5a5-1111-4111-8111-cccccccccccc';
  s_account uuid := 'a5a5a5a5-0001-4001-8001-eeeeeeeeeeee';
  r_notice uuid := 'b1b1b1b1-0001-4001-8001-ffffffffffff';
  r_notice2 uuid := 'b2b2b2b2-0001-4001-8001-ffffffffffff';
  r_notice3 uuid := 'b3b3b3b3-0001-4001-8001-ffffffffffff';
  r_notice4 uuid := 'b6b6b6b6-0001-4001-8001-ffffffffffff';
  r_deliver uuid := 'b4b4b4b4-0001-4001-8001-ffffffffffff';
  r_deliver2 uuid := 'b5b5b5b5-0001-4001-8001-ffffffffffff';
  v_claim jsonb;
  v_token timestamptz;
  v_token_take timestamptz;
  v_token2 timestamptz;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'atomic-ack-' || u_a::text || '@example.invalid');

  INSERT INTO public.ai_conversation_modes (
    id, user_id, platform, conversation_id, mode, expires_at, escalated_at
  ) VALUES
    (gen_random_uuid(), u_a, 'whatsapp', 'c_atomic', 'human_first', now() + interval '1 hour', now()),
    (gen_random_uuid(), u_a, 'whatsapp', 'c_takeover', 'human_first', now() + interval '1 hour', now());

  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES (s_account, u_a, 'facebook', 'page-atomic', 'token-atomic');

  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES
    (r_notice, s_account, u_a, 'facebook', 'm-atomic-1', 'c_atomic', 'r-atomic-1',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_notice2, s_account, u_a, 'facebook', 'm-atomic-2', 'c_takeover', 'r-atomic-2',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_notice3, s_account, u_a, 'facebook', 'm-atomic-3', 'c_takeover', 'r-atomic-3',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_notice4, s_account, u_a, 'facebook', 'm-atomic-4', 'c_takeover', 'r-atomic-4',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_deliver, s_account, u_a, 'facebook', 'm-atomic-5', 'c_atomic', 'r-atomic-5',
     'عندكم كريم الكعب؟', now(), 'ready_to_send'),
    (r_deliver2, s_account, u_a, 'facebook', 'm-atomic-6', 'c_atomic', 'r-atomic-6',
     'عندكم كريم الكعب؟', now(), 'ready_to_send');

  -- A1: the notice and the claim it spends are ONE statement: the row holds the notice and
  -- the claim is delivered, and neither happened without the other.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_atomic', 120);
  ASSERT v_claim->>'result' = 'claimed', 'A1 the window is claimed';
  v_token := (v_claim->>'claim_token')::timestamptz;
  ASSERT v_token IS NOT NULL, 'A1 the claim carries a token';
  ASSERT public.persist_human_mode_ack_and_complete_claim(
           r_notice, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_atomic', v_token),
    'A1 the notice is persisted with the claim';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice) = 'ready_to_send',
    'A1 the row holds the notice';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_notice) = 'تم تحويل محادثتك لفريقنا',
    'A1 the text is written';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_notice) = 'human_mode_ack',
    'A1 the row knows what the text is';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_atomic') IS NOT NULL,
    'A1 the claim is spent by the same statement';

  -- A2: the completion failed: the claim this caller holds is not the live one. Nothing is
  -- written, so no notice can reach the customer without the claim it spends.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_takeover', 120);
  ASSERT v_claim->>'result' = 'claimed', 'A2 the window is claimed';
  v_token_take := (v_claim->>'claim_token')::timestamptz;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_notice2, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_takeover', v_token_take + interval '1 second'),
    'A2 a claim that is not the live one stores nothing';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice2) = 'running',
    'A2 the row is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_notice2) IS NULL,
    'A2 no text is written';

  -- A3: the lease lapses and another turn takes it over. The worker that was overtaken
  -- writes nothing; the worker that took over writes the notice ONCE, and the customer is
  -- never told twice.
  UPDATE public.ai_conversation_modes
     SET customer_ack_claimed_at = now() - interval '10 minutes'
   WHERE user_id = u_a AND conversation_id = 'c_takeover';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_takeover', 120);
  ASSERT v_claim->>'result' = 'claimed', 'A3 the lapsed lease is taken over';
  v_token2 := (v_claim->>'claim_token')::timestamptz;
  ASSERT v_token2 IS NOT NULL AND v_token2 <> v_token_take, 'A3 the takeover carries a new token';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_notice2, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_takeover', v_token_take),
    'A3 the overtaken worker stores nothing';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice2) = 'running',
    'A3 the overtaken worker stores no notice';
  ASSERT public.persist_human_mode_ack_and_complete_claim(
           r_notice2, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_takeover', v_token2),
    'A3 the worker that took over persists the notice';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_notice2) = 'تم تحويل محادثتك لفريقنا',
    'A3 the notice is durable';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_notice3, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_takeover', v_token2),
    'A3 a delivered notice is never written twice';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice3) = 'running',
    'A3 a delivered notice leaves the row alone';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_notice4, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_takeover', v_token2),
    'A3 a delivered notice is never written twice, whichever row carries it';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_notice4) = 'running',
    'A3 a delivered notice leaves every row alone';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_takeover', 120);
  ASSERT v_claim->>'result' = 'delivered', 'A3 a delivered notice is never sent twice';

  -- A4: a DELIVERED claim is never released. The notice reached the customer, and putting
  -- the claim back would let a later turn send it again.
  ASSERT NOT public.release_human_mode_ack_claim(u_a, 'whatsapp', 'c_atomic', v_token2),
    'A4 a delivered claim is not released';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_atomic') IS NOT NULL,
    'A4 the delivered claim stands';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_atomic', 120);
  ASSERT v_claim->>'result' = 'delivered', 'A4 the notice is never owed again';

  -- A5: the delivery claim moves a row only while it holds the payload the caller read.
  UPDATE public.pending_agent_replies
     SET generated_reply = 'كريم الكعب متوفر'
   WHERE id = r_deliver;
  ASSERT public.claim_agent_reply_for_delivery(r_deliver, 'ready_to_send', 'sending', 'كريم الكعب متوفر', NULL),
    'A5 a row that holds the payload is moved';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_deliver) = 'sending',
    'A5 the row is sending';

  -- A5: the closed gate took the row's place with the notice it owes: the text the caller
  -- read is gone, so the delivery is refused and nothing is sent.
  UPDATE public.pending_agent_replies
     SET generated_reply = 'تم تحويل محادثتك لفريقنا',
         generated_kind = 'human_mode_ack'
   WHERE id = r_deliver2;
  ASSERT NOT public.claim_agent_reply_for_delivery(r_deliver2, 'ready_to_send', 'sending', 'كريم الكعب متوفر', NULL),
    'A5 a row whose text was replaced is not moved';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_deliver2) = 'ready_to_send',
    'A5 the replaced row stays where it is';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_deliver2) = 'تم تحويل محادثتك لفريقنا',
    'A5 the notice stays in the row';

  -- A5: the kind is part of the payload: the row that holds the notice is never sent as an
  -- answer, and the row that holds an answer is never sent as the notice.
  ASSERT NOT public.claim_agent_reply_for_delivery(r_deliver2, 'ready_to_send', 'sending', 'تم تحويل محادثتك لفريقنا', NULL),
    'A5 a row whose kind was replaced is not moved';
  ASSERT public.claim_agent_reply_for_delivery(r_deliver2, 'ready_to_send', 'sending', 'تم تحويل محادثتك لفريقنا', 'human_mode_ack'),
    'A5 the row is moved when the whole payload matches';

  -- A6: only service_role reaches the new functions.
  ASSERT NOT has_function_privilege('anon', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'A6 anon cannot persist a notice';
  ASSERT NOT has_function_privilege('authenticated', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'A6 authenticated cannot persist a notice';
  ASSERT has_function_privilege('service_role', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'A6 service_role can persist a notice';
  ASSERT NOT has_function_privilege('anon', 'public.claim_agent_reply_for_delivery(uuid, text, text, text, text)', 'EXECUTE'),
    'A6 anon cannot claim a delivery';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_agent_reply_for_delivery(uuid, text, text, text, text)', 'EXECUTE'),
    'A6 authenticated cannot claim a delivery';
  ASSERT has_function_privilege('service_role', 'public.claim_agent_reply_for_delivery(uuid, text, text, text, text)', 'EXECUTE'),
    'A6 service_role can claim a delivery';
END $$;

ROLLBACK;
\echo '=== agent_handoff_claim_atomicity: ALL CHECKS PASSED ==='
