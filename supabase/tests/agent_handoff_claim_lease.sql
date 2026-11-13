-- supabase/tests/agent_handoff_claim_lease.sql
-- The handoff claims as LEASES (migration 20261113210000_agent_handoff_claim_lease.sql). One
-- transaction, synthetic fixtures, labelled L1..Ln ASSERTs, ROLLBACK, sentinel last. Assumes the
-- migrations are applied. No secrets and no real accounts.
--
-- A claim that is CLEARED when it is taken cannot survive the worker that took it: the worker may
-- be killed between the claim and the durable write, and the claim is gone with it. The customer
-- is then owed a notice nobody will ever send, and the apology after a silent window is never
-- made. These checks hold the leases to that promise:
--
--   c_live   human_first, expires in 1 hour   -> claimable, leasable, deliverable
--   c_dead   human_first, expires in 1 hour   -> a claim that lapsed without a delivery
--   c_sent   human_first, expires in 1 hour   -> a claim that became durable
--   t_marker a thread carrying an unanswered-escalation marker
BEGIN;
DO $$
DECLARE
  u_a uuid := 'c1c1c1c1-1111-4111-8111-cccccccccccc';
  u_b uuid := 'c2c2c2c2-2222-4222-8222-cccccccccccc';
  t_marker uuid := 'd1d1d1d1-0001-4001-8001-dddddddddddd';
  s_account uuid := 'e1e1e1e1-0001-4001-8001-eeeeeeeeeeee';
  r_reply uuid := 'f1f1f1f1-0001-4001-8001-ffffffffffff';
  r_reply2 uuid := 'f2f2f2f2-0001-4001-8001-ffffffffffff';
  r_kind uuid := 'f3f3f3f3-0001-4001-8001-ffffffffffff';
  v_escalated timestamptz := now() - interval '4 hours';
  v_token text;
  v_token2 text;
  v_claim jsonb;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'lease-a-' || u_a::text || '@example.invalid'),
    (u_b, 'lease-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id, unanswered_escalation_since)
  VALUES (t_marker, u_a, 'whatsapp', 'c_marker', v_escalated);

  INSERT INTO public.ai_conversation_modes (id, user_id, platform, conversation_id, mode, expires_at, escalated_at)
  VALUES
    (gen_random_uuid(), u_a, 'whatsapp', 'c_live', 'human_first', now() + interval '1 hour', now()),
    (gen_random_uuid(), u_a, 'whatsapp', 'c_dead', 'human_first', now() + interval '1 hour', now()),
    (gen_random_uuid(), u_a, 'whatsapp', 'c_sent', 'human_first', now() + interval '1 hour', now());

  -- L1: the acknowledgement claim is a lease. The first claim wins and carries the token that
  -- identifies it; a second claim while the lease is live finds the window and no token.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_live', 120);
  ASSERT v_claim->>'result' = 'claimed', 'L1 the first claim wins';
  ASSERT v_claim->>'claim_token' IS NOT NULL, 'L1 the claim carries a token';
  v_token := v_claim->>'claim_token';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_live', 120);
  ASSERT v_claim->>'result' = 'window', 'L1 a live lease is not handed out twice';
  ASSERT v_claim->>'claim_token' IS NULL, 'L1 a window claim carries no token';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_live') IS NOT NULL,
    'L1 the claim is recorded on the row';

  -- L2: another tenant sees no window at all.
  v_claim := public.claim_human_mode_ack_leased(u_b, 'whatsapp', 'c_live', 120);
  ASSERT v_claim->>'result' = 'none', 'L2 another tenant sees no window';

  -- L3: a claim that lapsed without a delivery is taken over, and the token changes: the stale
  -- worker can no longer release or complete the claim its replacement holds.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_dead', 120);
  ASSERT v_claim->>'result' = 'claimed', 'L3 the first claim of the window wins';
  v_token2 := v_claim->>'claim_token';
  UPDATE public.ai_conversation_modes
     SET customer_ack_claimed_at = now() - interval '10 minutes'
   WHERE user_id = u_a AND conversation_id = 'c_dead';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_dead', 120);
  ASSERT v_claim->>'result' = 'claimed', 'L3 a lapsed lease is taken over';
  ASSERT v_claim->>'claim_token' <> v_token2, 'L3 the takeover carries a new token';

  -- L4: the completion and the release only ever touch the claim the caller holds.
  ASSERT NOT public.complete_human_mode_ack(u_a, 'whatsapp', 'c_dead', v_token2::timestamptz),
    'L4 a stale token completes nothing';
  ASSERT NOT public.release_human_mode_ack_claim(u_a, 'whatsapp', 'c_dead', v_token2::timestamptz),
    'L4 a stale token releases nothing';
  ASSERT (SELECT customer_ack_claimed_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_dead') IS NOT NULL,
    'L4 the live claim was left alone';

  -- L5: the release puts the claim back, so the notice is still owed.
  ASSERT public.release_human_mode_ack_claim(u_a, 'whatsapp', 'c_dead', (v_claim->>'claim_token')::timestamptz),
    'L5 the claim the caller holds is released';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_dead') IS NULL,
    'L5 the claim is NULL again';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_dead', 120);
  ASSERT v_claim->>'result' = 'claimed', 'L5 the notice can be claimed again';

  -- L6: a claim that became durable is never handed out again.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_sent', 120);
  ASSERT v_claim->>'result' = 'claimed', 'L6 the first claim of the window wins';
  ASSERT public.complete_human_mode_ack(u_a, 'whatsapp', 'c_sent', (v_claim->>'claim_token')::timestamptz),
    'L6 the delivered claim is completed';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_sent', 120);
  ASSERT v_claim->>'result' = 'delivered', 'L6 a delivered notice is never sent twice';
  ASSERT (SELECT customer_ack_delivered_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_sent') IS NOT NULL,
    'L6 the delivery is recorded on the row';

  -- L7: the escalation marker is LEASED, not taken: it stays set, so a worker that dies before
  -- the reply is durable leaves the apology owed.
  ASSERT public.claim_unanswered_escalation(t_marker, u_a, 180) = v_escalated,
    'L7 the owner leases the marker';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'L7 the marker is still set after the claim';
  ASSERT public.claim_unanswered_escalation(t_marker, u_a, 180) IS NULL,
    'L7 a live lease is not handed out twice';
  ASSERT public.claim_unanswered_escalation(t_marker, u_b, 180) IS NULL,
    'L7 another tenant leases no marker';

  -- L8: a lapsed lease is taken over, and the completion clears the marker only when it is the
  -- one that was leased.
  UPDATE public.ai_threads
     SET unanswered_escalation_claimed_at = now() - interval '10 minutes'
   WHERE id = t_marker;
  ASSERT public.claim_unanswered_escalation(t_marker, u_a, 180) = v_escalated,
    'L8 a lapsed lease is taken over';
  ASSERT NOT public.complete_unanswered_escalation(t_marker, u_a, v_escalated + interval '1 hour'),
    'L8 a marker that is not the leased one is not cleared';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'L8 the marker stays';
  ASSERT public.complete_unanswered_escalation(t_marker, u_a, v_escalated),
    'L8 the leased marker is cleared';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) IS NULL,
    'L8 the marker is NULL again';

  -- L9: giving the lease back keeps the marker: the apology is still owed.
  UPDATE public.ai_threads
     SET unanswered_escalation_since = v_escalated,
         unanswered_escalation_claimed_at = now()
   WHERE id = t_marker;
  ASSERT public.release_unanswered_escalation_claim(t_marker, u_a, v_escalated),
    'L9 the lease is released';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'L9 the marker is still owed';
  ASSERT (SELECT unanswered_escalation_claimed_at FROM public.ai_threads WHERE id = t_marker) IS NULL,
    'L9 the lease is free';
  ASSERT public.claim_unanswered_escalation(t_marker, u_a, 180) = v_escalated,
    'L9 the apology can be leased again';

  -- L10: only service_role reaches the lease functions.
  ASSERT NOT has_function_privilege('anon', 'public.claim_human_mode_ack_leased(uuid, text, text, integer)', 'EXECUTE'),
    'L10 anon cannot claim an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_human_mode_ack_leased(uuid, text, text, integer)', 'EXECUTE'),
    'L10 authenticated cannot claim an ack';
  ASSERT NOT has_function_privilege('anon', 'public.complete_human_mode_ack(uuid, text, text, timestamptz)', 'EXECUTE'),
    'L10 anon cannot complete an ack';
  ASSERT NOT has_function_privilege('anon', 'public.release_human_mode_ack_claim(uuid, text, text, timestamptz)', 'EXECUTE'),
    'L10 anon cannot release an ack';
  ASSERT NOT has_function_privilege('anon', 'public.claim_unanswered_escalation(uuid, uuid, integer)', 'EXECUTE'),
    'L10 anon cannot lease the marker';
  ASSERT NOT has_function_privilege('authenticated', 'public.complete_unanswered_escalation(uuid, uuid, timestamptz)', 'EXECUTE'),
    'L10 authenticated cannot complete the marker';
  ASSERT NOT has_function_privilege('authenticated', 'public.release_unanswered_escalation_claim(uuid, uuid, timestamptz)', 'EXECUTE'),
    'L10 authenticated cannot release the marker';
  ASSERT has_function_privilege('service_role', 'public.claim_human_mode_ack_leased(uuid, text, text, integer)', 'EXECUTE'),
    'L10 service_role can claim an ack';
  ASSERT has_function_privilege('service_role', 'public.claim_unanswered_escalation(uuid, uuid, integer)', 'EXECUTE'),
    'L10 service_role can lease the marker';
  ASSERT has_function_privilege('service_role', 'public.complete_unanswered_escalation(uuid, uuid, timestamptz)', 'EXECUTE'),
    'L10 service_role can complete the marker';
  -- L11: the kind-aware transition really runs. A function that names a column the table
  -- does not have fails at the FIRST call -- long after the migration was applied, and
  -- on the reply path that matters most.
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES (s_account, u_a, 'facebook', 'page-lease', 'token-lease');
  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES (
    r_kind, s_account, u_a, 'facebook', 'm-kind', 'c_kind', 'r-kind',
    'عندكم كريم الكعب؟', now(), 'running'
  );
  ASSERT public.advance_agent_reply_kind(r_kind, 'running', 'ready_to_send', 'كريم الكعب متوفر', NULL, NULL, 'human_mode_ack'),
    'L11 the kind-aware transition runs';
  ASSERT (SELECT generated_kind FROM public.pending_agent_replies WHERE id = r_kind) = 'human_mode_ack',
    'L11 the kind is written with the text';

  -- L11: the reply and the escalation window it resolves are written by ONE statement.
  -- Two statements could leave the text durable and the marker owed: the reply is
  -- redelivered, and a later turn takes the marker over once its lease lapses and
  -- apologises for the same window a second time.
  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES (
    r_reply, s_account, u_a, 'facebook', 'm-lease', 'c_reply', 'r-lease',
    'عندكم كريم الكعب؟', now(), 'running'
  );
  UPDATE public.ai_threads
     SET unanswered_escalation_since = v_escalated,
         unanswered_escalation_claimed_at = now()
   WHERE id = t_marker;
  ASSERT public.persist_agent_reply_and_complete_escalation(
           r_reply, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           t_marker, u_a, v_escalated),
    'L11 the reply is persisted';
  ASSERT (SELECT status FROM public.pending_agent_replies WHERE id = r_reply) = 'ready_to_send',
    'L11 the row holds the reply';
  ASSERT (SELECT generated_reply FROM public.pending_agent_replies WHERE id = r_reply) = 'نعتذر على التأخير',
    'L11 the text is written with the window it resolves';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) IS NULL,
    'L11 the window the reply resolved is consumed';
  ASSERT (SELECT unanswered_escalation_claimed_at FROM public.ai_threads WHERE id = t_marker) IS NULL,
    'L11 the lease goes with it';

  -- L11: a row that is no longer in the from-state is refused, and it consumes NOTHING:
  -- the window stays owed, because the apology was never carried by a durable reply.
  ASSERT NOT public.persist_agent_reply_and_complete_escalation(
           r_reply, 'running', 'ready_to_send', 'نعتذر على التأخير', NULL, NULL, NULL,
           t_marker, u_a, v_escalated),
    'L11 a row that is no longer running is refused';
  UPDATE public.ai_threads
     SET unanswered_escalation_since = v_escalated,
         unanswered_escalation_claimed_at = now()
   WHERE id = t_marker;
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'L11 the refused call leaves the window owed';

  -- L11: the window is cleared only for its own owner and for the marker that was
  -- leased. Another tenant's completion changes nothing.
  INSERT INTO public.pending_agent_replies (
    id, social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, status
  ) VALUES (
    r_reply2, s_account, u_a, 'facebook', 'm-lease-2', 'c_reply', 'r-lease',
    'عندكم كريم الكعب؟', now(), 'running'
  );
  ASSERT public.persist_agent_reply_and_complete_escalation(
           r_reply2, 'running', 'ready_to_send', 'x', NULL, NULL, NULL,
           t_marker, u_b, v_escalated),
    'L11 the reply is persisted';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'L11 another tenant cannot consume the window';

  -- L11: a marker that is not the leased one is not cleared.
  ASSERT public.persist_agent_reply_and_complete_escalation(
           r_reply2, 'ready_to_send', 'sent', NULL, NULL, NULL, NULL,
           t_marker, u_a, v_escalated + interval '1 hour'),
    'L11 the reply is still persisted';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_marker) = v_escalated,
    'L11 a marker that is not the leased one is not cleared';

  -- L12: only service_role reaches the atomic reply and the window it resolves.
  ASSERT NOT has_function_privilege('anon', 'public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz)', 'EXECUTE'),
    'L12 anon cannot persist a reply';
  ASSERT NOT has_function_privilege('authenticated', 'public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz)', 'EXECUTE'),
    'L12 authenticated cannot persist a reply';
  ASSERT has_function_privilege('service_role', 'public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz)', 'EXECUTE'),
    'L12 service_role can persist a reply';
END $$;

ROLLBACK;
\echo '=== agent_handoff_claim_lease: ALL CHECKS PASSED ==='
