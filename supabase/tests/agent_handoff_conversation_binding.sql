-- supabase/tests/agent_handoff_conversation_binding.sql
-- The reply that is written is bound to the CONVERSATION it belongs to (migration
-- 20261113280000_agent_handoff_conversation_binding.sql). One transaction, synthetic fixtures,
-- labelled T1..Tn ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are applied. No
-- secrets and no real accounts.
--
-- The edge functions run as the service role, which bypasses RLS, and every statement that
-- moves a row of public.pending_agent_replies was bound to the TENANT that owns the row
-- (20261113253000_agent_handoff_tenant_binding.sql). Tenancy is the wrong half of the
-- ownership: a tenant may own many conversations, and the row, the escalation window and the
-- acknowledgement claim of two of them are not one fact.
--
-- So a caller that mixed a pending row from conversation A with an escalation thread (or an
-- acknowledgement claim) from conversation B -- both owned by the same tenant -- was refused
-- by nothing. The reply landed on A's row while B's promise was consumed: the apology for
-- B's silent window was written into A's conversation, and the one-time notice B's customer
-- was owed was spent by A's turn.
--
-- The rule now: a transition names the conversation it acts for, and the row it moves has to
-- belong to that conversation. A row of another conversation is refused the way a row of
-- another tenant is refused: nothing is written, and the claim the caller holds is not spent.
--
--   u_a             the tenant that owns both conversations
--   t_a, t_b        a thread of conversation A and a thread of conversation B
--   c_conv_a        the conversation A's thread and claim belong to
--   c_conv_b        the conversation B's thread and claim belong to
BEGIN;
DO $$
DECLARE
  u_a uuid := 'e1e1e1e1-1111-4111-8111-cccccccccccc';
  s_account uuid := 'e1e1e1e1-0001-4001-8001-eeeeeeeeeeee';
  t_a uuid := 'e2e2e2e2-0001-4001-8001-cccccccccccc';
  t_b uuid := 'e2e2e2e2-0002-4001-8002-cccccccccccc';
  r_a uuid := 'e3e3e3e3-0001-4001-8001-dddddddddddd';
  r_b uuid := 'e3e3e3e3-0002-4001-8002-dddddddddddd';
  r_free uuid := 'e3e3e3e3-0003-4001-8003-dddddddddddd';
  r_other_platform uuid := 'e3e3e3e3-0004-4001-8004-dddddddddddd';
  v_marker timestamptz := now() - interval '4 hours';
  v_lease timestamptz;
  v_claim jsonb;
  v_token timestamptz;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'conversation-a-' || u_a::text || '@example.invalid');

  INSERT INTO public.workspaces (id, name, owner_id) VALUES (u_a, 'Handoff fixture', u_a);

  INSERT INTO public.social_accounts (id, user_id, workspace_id, platform, platform_user_id, access_token)
  VALUES (s_account, u_a, u_a, 'whatsapp', 'phone-conversation', 'token-conversation');

  -- Two conversations of the SAME tenant, each with an unanswered-escalation marker and a
  -- bounded human_first window.
  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id, unanswered_escalation_since)
  VALUES
    (t_a, u_a, 'whatsapp', 'c_conv_a', v_marker),
    (t_b, u_a, 'whatsapp', 'c_conv_b', v_marker);

  INSERT INTO public.ai_conversation_modes (
    id, user_id, platform, conversation_id, mode, expires_at, escalated_at
  ) VALUES
    (gen_random_uuid(), u_a, 'whatsapp', 'c_conv_a', 'human_first', now() + interval '1 hour', now()),
    (gen_random_uuid(), u_a, 'whatsapp', 'c_conv_b', 'human_first', now() + interval '1 hour', now());

  -- One pending row per conversation, plus one row of another platform and one row that no
  -- window names.
  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES
    (r_a, s_account, u_a, 'whatsapp', 'm-conv-a', 'c_conv_a', 'r-conv-a',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_b, s_account, u_a, 'whatsapp', 'm-conv-b', 'c_conv_b', 'r-conv-b',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_free, s_account, u_a, 'whatsapp', 'm-conv-free', 'c_conv_a', 'r-conv-free',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_other_platform, s_account, u_a, 'facebook', 'm-conv-platform', 'c_conv_b', 'r-conv-platform',
     'عندكم كريم الكعب؟', now(), 'running');

  -- T1: the reply that resolves an escalation window is bound to the window's CONVERSATION.
  -- The lease belongs to conversation B and the row to conversation A: the call stores
  -- nothing, and the window stays owed -- an apology is never carried by another
  -- conversation's reply.
  v_claim := public.claim_unanswered_escalation(t_b, u_a, 180);
  v_lease := (v_claim->>'token')::timestamptz;
  ASSERT v_lease IS NOT NULL,
    'T1 the owner leases the marker';
  ASSERT NOT public.persist_agent_reply_and_complete_escalation(
           r_a, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           t_b, u_a, v_marker, v_lease),
    'T1 a row of another conversation stores nothing';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_a) = 'running',
    'T1 the row is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_a) IS NULL,
    'T1 no text is written';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_b) = v_marker,
    'T1 the window stays owed';

  -- T1: the row of the SAME conversation is stored, and the window it resolves is consumed
  -- with it.
  ASSERT public.persist_agent_reply_and_complete_escalation(
           r_b, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           t_b, u_a, v_marker, v_lease),
    'T1 the row of the same conversation stores the reply';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_b) = 'ready_to_send',
    'T1 the row holds the reply';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_b) IS NULL,
    'T1 the window the reply resolved is consumed';

  -- Start an independent acknowledgement scenario with a running row in B.
  UPDATE public.pending_agent_replies SET status = 'running', generated_reply = NULL WHERE id = r_b;

  -- T2: the one-time notice is bound to the claim's CONVERSATION. The claim belongs to
  -- conversation A and the row to conversation B: the notice is not written, and the claim
  -- is NOT spent -- so the notice is still owed, by the conversation it was promised to.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_conv_a', 120);
  ASSERT v_claim->>'result' = 'claimed',
    'T2 the window is claimed';
  v_token := (v_claim->>'claim_token')::timestamptz;
  ASSERT v_token IS NOT NULL,
    'T2 the claim carries a token';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_b, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_conv_a', v_token),
    'T2 a row of another conversation stores no notice';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_b) = 'running',
    'T2 the row is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_b) IS NULL,
    'T2 no text is written';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_conv_a') IS NULL,
    'T2 a row of another conversation does not spend the claim';

  -- T2: the row of the SAME conversation carries the notice and spends the claim.
  ASSERT public.persist_human_mode_ack_and_complete_claim(
           r_a, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_conv_a', v_token),
    'T2 the row of the same conversation stores the notice';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_a) = 'ready_to_send',
    'T2 the row holds the notice';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_conv_a') IS NOT NULL,
    'T2 the claim is spent by the same statement';

  -- T3: the PLATFORM is part of the binding. A conversation id is only unique inside its
  -- platform, so a row of another platform is a row of another conversation.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_conv_b', 120);
  ASSERT v_claim->>'result' = 'claimed',
    'T3 the second window is claimed';
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_other_platform, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_conv_b', (v_claim->>'claim_token')::timestamptz),
    'T3 a row of another platform stores no notice';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_other_platform) IS NULL,
    'T3 no text is written';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_conv_b') IS NULL,
    'T3 a row of another platform does not spend the claim';

  -- T3b: replacement checks conversation binding and spends its claim in the same write.
  UPDATE public.pending_agent_replies SET status = 'ready_to_send', generated_reply = 'old draft' WHERE id = r_b;
  ASSERT NOT public.replace_agent_reply_and_complete_claim(
    u_a, r_a, 'ready_to_send', 'ready_to_send', 'replacement notice', NULL, NULL, 'human_mode_ack',
    'whatsapp', 'c_conv_b', (v_claim->>'claim_token')::timestamptz),
    'T3b replacement refuses a different conversation';
  ASSERT public.replace_agent_reply_and_complete_claim(
    u_a, r_b, 'ready_to_send', 'ready_to_send', 'replacement notice', NULL, NULL, 'human_mode_ack',
    'whatsapp', 'c_conv_b', (v_claim->>'claim_token')::timestamptz),
    'T3b replacement and claim completion succeed together';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_b) = 'replacement notice',
    'T3b the stale draft is replaced';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
    WHERE user_id = u_a AND conversation_id = 'c_conv_b') IS NOT NULL,
    'T3b the durable replacement spends the claim';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_conv_b', 120);
  ASSERT v_claim->>'result' = 'delivered', 'T3b a replacement cannot be claimed again';

  -- T4: a call that names no window resolves no window, so there is nothing to bind the row
  -- to, and the row stays bound to its tenant alone.
  ASSERT public.persist_agent_reply_and_complete_escalation(
           r_free, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           NULL, u_a, NULL, NULL),
    'T4 a call that names no window stores the reply';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_free) = 'ready_to_send',
    'T4 the row holds the reply';

  -- T5: only service_role reaches the statements.
  ASSERT NOT has_function_privilege('anon', 'public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE'),
    'T5 anon cannot resolve an escalation window';
  ASSERT NOT has_function_privilege('authenticated', 'public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE'),
    'T5 authenticated cannot resolve an escalation window';
  ASSERT has_function_privilege('service_role', 'public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE'),
    'T5 service_role can resolve an escalation window';
  ASSERT NOT has_function_privilege('anon', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'T5 anon cannot persist a notice';
  ASSERT NOT has_function_privilege('authenticated', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'T5 authenticated cannot persist a notice';
  ASSERT has_function_privilege('service_role', 'public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    'T5 service_role can persist a notice';
END $$;

ROLLBACK;
\echo '=== agent_handoff_conversation_binding: ALL CHECKS PASSED ==='
