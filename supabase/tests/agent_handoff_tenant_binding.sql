-- supabase/tests/agent_handoff_tenant_binding.sql
-- Every reply transition is bound to the tenant that owns the row
-- (migration 20261113253000_agent_handoff_tenant_binding.sql). One transaction, synthetic
-- fixtures, labelled T1..Tn ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are
-- applied. No secrets and no real accounts.
--
-- The edge functions run as the service role, which bypasses RLS. A statement that moved a
-- row of public.pending_agent_replies by its id and its from-state alone therefore moved
-- WHATEVER row carried that id -- a row id that was mixed up, or accepted from another
-- tenant, wrote that tenant's reply, took that tenant's delivery claim and consumed that
-- tenant's escalation window.
--
-- The rule now: a transition names the tenant it acts for, and the row it moves has to
-- belong to that tenant. A row of another tenant is refused the way a row that is not in
-- the from-state is refused: nothing is written, and the claim the caller holds is not
-- spent.
--
--   u_a, s_account_a   the tenant that owns its rows
--   u_b, s_account_b   the tenant that owns nothing here
--   t_marker           a thread of u_a carrying an unanswered-escalation marker
--   c_ack              a conversation of u_a whose notice is claimed
BEGIN;
DO $$
DECLARE
  u_a uuid := 'b1b1b1b1-1111-4111-8111-cccccccccccc';
  u_b uuid := 'b2b2b2b2-2222-4222-8222-cccccccccccc';
  s_a uuid := 'a1a1a1a1-0001-4001-8001-aaaaaaaaaaaa';
  s_b uuid := 'a2a2a2a2-0002-4001-8002-aaaaaaaaaaaa';
  t_marker uuid := 'c3c3c3c3-0003-4001-8003-cccccccccccc';
  r_plain uuid := 'd1d1d1d1-0001-4001-8001-dddddddddddd';
  r_kind uuid := 'd2d2d2d2-0002-4001-8002-dddddddddddd';
  r_deliver uuid := 'd3d3d3d3-0003-4001-8003-dddddddddddd';
  r_escalate uuid := 'd4d4d4d4-0004-4001-8004-dddddddddddd';
  r_escalate_other uuid := 'd5d5d5d5-0005-4001-8005-dddddddddddd';
  r_ack uuid := 'd6d6d6d6-0006-4001-8006-dddddddddddd';
  r_ack_other uuid := 'd7d7d7d7-0007-4001-8007-dddddddddddd';
  r_legacy uuid := 'd8d8d8d8-0008-4001-8008-dddddddddddd';
  r_live uuid := 'd9d9d9d9-0009-4001-8009-dddddddddddd';
  v_escalated timestamptz := now() - interval '4 hours';
  v_lease timestamptz;
  v_claim jsonb;
  v_token timestamptz;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'tenant-a-' || u_a::text || '@example.invalid'),
    (u_b, 'tenant-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES
    (s_a, u_a, 'facebook', 'page-tenant-a', 'token-tenant-a'),
    (s_b, u_b, 'facebook', 'page-tenant-b', 'token-tenant-b');

  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id, unanswered_escalation_since)
  VALUES (t_marker, u_a, 'whatsapp', 'c_marker', v_escalated);

  INSERT INTO public.ai_conversation_modes (id, user_id, platform, conversation_id, mode, expires_at, escalated_at)
  VALUES (gen_random_uuid(), u_a, 'whatsapp', 'c_ack', 'human_first', now() + interval '1 hour', now());

  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES
    (r_plain, s_a, u_a, 'facebook', 'm-tenant-1', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_kind, s_a, u_a, 'facebook', 'm-tenant-2', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_deliver, s_a, u_a, 'facebook', 'm-tenant-3', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'ready_to_send'),
    (r_escalate, s_a, u_a, 'facebook', 'm-tenant-4', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_escalate_other, s_b, u_b, 'facebook', 'm-tenant-5', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_ack, s_a, u_a, 'facebook', 'm-tenant-6', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_ack_other, s_b, u_b, 'facebook', 'm-tenant-7', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_legacy, s_a, u_a, 'facebook', 'm-tenant-8', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'running'),
    (r_live, s_a, u_a, 'facebook', 'm-tenant-9', 'c_tenant', 'r-tenant',
     'عندكم كريم الكعب؟', now(), 'pending');
  UPDATE public.pending_agent_replies
     SET generated_reply = 'كريم الكعب متوفر'
   WHERE id = r_deliver;

  -- T1: the plain transition moves the row of the tenant it names, and refuses the row of
  -- another one. A refused row keeps its state and its text: nothing was written.
  ASSERT NOT public.advance_agent_reply_for_owner(u_b, r_plain, 'running', 'ready_to_send', 'x', NULL, NULL),
    'T1 another tenant cannot move the row';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_plain) = 'running',
    'T1 another tenant leaves the row where it is';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_plain) IS NULL,
    'T1 another tenant writes no reply';
  ASSERT public.advance_agent_reply_for_owner(u_a, r_plain, 'running', 'ready_to_send', 'x', NULL, NULL),
    'T1 the owner moves the row';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_plain) = 'ready_to_send',
    'T1 the owner holds the reply';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_plain) = 'x',
    'T1 the owner has its text written';

  -- T2: the kind-aware transition is bound the same way. The kind is written with the text,
  -- so a refusal leaves neither.
  ASSERT NOT public.advance_agent_reply_kind_for_owner(u_b, r_kind, 'running', 'ready_to_send', 'y', NULL, NULL, 'human_mode_ack'),
    'T2 another tenant cannot move the row';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_kind) = 'running',
    'T2 another tenant leaves the row where it is';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_kind) IS NULL,
    'T2 another tenant writes no kind';
  ASSERT public.advance_agent_reply_kind_for_owner(u_a, r_kind, 'running', 'ready_to_send', 'y', NULL, NULL, 'human_mode_ack'),
    'T2 the owner moves the row';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_kind) = 'human_mode_ack',
    'T2 the owner has its kind written';

  -- T3: the delivery claim is bound the same way. A row of another tenant is not moved, so
  -- nothing is sent for it.
  ASSERT NOT public.claim_agent_reply_for_delivery_for_owner(u_b, r_deliver, 'ready_to_send', 'sending', 'كريم الكعب متوفر', NULL),
    'T3 another tenant cannot claim the delivery';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_deliver) = 'ready_to_send',
    'T3 another tenant leaves the row where it is';
  ASSERT public.claim_agent_reply_for_delivery_for_owner(u_a, r_deliver, 'ready_to_send', 'sending', 'كريم الكعب متوفر', NULL),
    'T3 the owner claims the delivery';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_deliver) = 'sending',
    'T3 the owner holds the row in sending';

  -- T4: the reply that resolves an escalation window is bound to the tenant as well. The
  -- window and its lease belong to u_a, and the row belongs to u_b: the call stores nothing,
  -- and the apology stays owed -- an apology is never carried by another tenant's reply.
  v_claim := public.claim_unanswered_escalation(t_marker, u_a, 180);
  v_lease := (v_claim->>'token')::timestamptz;
  ASSERT v_lease IS NOT NULL,
    'T4 the owner leases the marker';
  ASSERT NOT public.persist_agent_reply_and_complete_escalation(
           r_escalate_other, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           t_marker, u_a, v_escalated, v_lease),
    'T4 a row of another tenant stores nothing';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_escalate_other) = 'running',
    'T4 a row of another tenant stores no reply';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_escalate_other) IS NULL,
    'T4 a row of another tenant writes no text';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'T4 a row of another tenant consumes no window';

  -- T4: the owner's own row is stored, and the window it resolves is consumed with it.
  ASSERT public.persist_agent_reply_and_complete_escalation(
           r_escalate, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           t_marker, u_a, v_escalated, v_lease),
    'T4 the owner stores the reply';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_escalate) = 'ready_to_send',
    'T4 the owner holds the reply';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) IS NULL,
    'T4 the window the reply resolved is consumed';

  -- T5: the one-time notice is bound the same way. The claim belongs to u_a and the row to
  -- u_b: the notice is not written, and the claim is NOT spent -- so the notice is still
  -- owed and can be sent once, by its own tenant.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_ack', 120);
  ASSERT v_claim->>'result' = 'claimed',
    'T5 the window is claimed';
  v_token := (v_claim->>'claim_token')::timestamptz;
  ASSERT NOT public.persist_human_mode_ack_and_complete_claim(
           r_ack_other, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_ack', v_token),
    'T5 a row of another tenant stores no notice';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_ack_other) = 'running',
    'T5 a row of another tenant is not moved';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_ack_other) IS NULL,
    'T5 a row of another tenant writes no text';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_ack') IS NULL,
    'T5 a row of another tenant does not spend the claim';

  -- T5: the owner's own row carries the notice and spends the claim.
  ASSERT public.persist_human_mode_ack_and_complete_claim(
           r_ack, 'running', 'ready_to_send', 'تم تحويل محادثتك لفريقنا', NULL, NULL, 'human_mode_ack',
           u_a, 'whatsapp', 'c_ack', v_token),
    'T5 the owner stores the notice';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_ack) = 'ready_to_send',
    'T5 the owner holds the notice';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_ack') IS NOT NULL,
    'T5 the claim is spent by the same statement';

  -- T6: the arities that name no tenant are bound to the owner of the row's account -- the
  -- tenant enqueue_agent_reply derives the row's user_id from. They are not called by any
  -- edge build, and they still move the row of their own account.
  ASSERT public.advance_agent_reply_kind(r_legacy, 'running', 'ready_to_send', 'z', NULL, NULL, 'human_mode_ack'),
    'T6 the account owner moves the row';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_legacy) = 'human_mode_ack',
    'T6 the kind is written with the text';
  ASSERT public.claim_agent_reply_for_delivery(r_live, 'pending', 'ready_to_send', NULL, NULL),
    'T6 the account owner claims the delivery';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_live) = 'ready_to_send',
    'T6 the row holds the claim';

  -- T7: the statement the LIVE build calls is untouched: its signature and its behaviour
  -- are the same, so the build that is running today keeps working against this database.
  ASSERT public.advance_agent_reply(r_live, 'ready_to_send', 'running', NULL, NULL, NULL),
    'T7 the live transition still moves the row';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_live) = 'running',
    'T7 the live transition holds the row';

  -- T8: only service_role reaches the tenant-bound transitions.
  ASSERT NOT has_function_privilege('anon', 'public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb)', 'EXECUTE'),
    'T8 anon cannot advance a reply';
  ASSERT NOT has_function_privilege('authenticated', 'public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb)', 'EXECUTE'),
    'T8 authenticated cannot advance a reply';
  ASSERT has_function_privilege('service_role', 'public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb)', 'EXECUTE'),
    'T8 service_role can advance a reply';
  ASSERT NOT has_function_privilege('anon', 'public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
    'T8 anon cannot advance a kind-aware reply';
  ASSERT NOT has_function_privilege('authenticated', 'public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
    'T8 authenticated cannot advance a kind-aware reply';
  ASSERT has_function_privilege('service_role', 'public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
    'T8 service_role can advance a kind-aware reply';
  ASSERT NOT has_function_privilege('anon', 'public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text)', 'EXECUTE'),
    'T8 anon cannot claim a delivery';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text)', 'EXECUTE'),
    'T8 authenticated cannot claim a delivery';
  ASSERT has_function_privilege('service_role', 'public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text)', 'EXECUTE'),
    'T8 service_role can claim a delivery';
END $$;

ROLLBACK;
\echo '=== agent_handoff_tenant_binding: ALL CHECKS PASSED ==='
