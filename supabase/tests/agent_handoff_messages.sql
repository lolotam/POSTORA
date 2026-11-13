-- supabase/tests/agent_handoff_messages.sql
-- Handoff acknowledgement and unanswered-escalation marker (migration 20261112170000, and the
-- release path added by 20261113120000_agent_handoff_messages_followup.sql). One transaction,
-- synthetic fixtures, labelled H1..Hn ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are
-- applied. No secrets and no real accounts.
--
-- Conversations, one user:
--   c_live     human_first, expires in 1 hour        -> ack claimable once, then 'window'
--   c_shared   human_then_ai, expired 1 minute ago   -> never acked, never marked
--   c_manual   human_first, no expiry                -> never acked
--   c_ended    human_first, expired 1 minute ago     -> not acked; expiry marks its thread
--   c_hybrid   human_then_ai with a stray claim      -> the release never touches it
BEGIN;
DO $$
DECLARE
  u_a uuid := 'a8a8a8a8-1111-4111-8111-aaaaaaaaaaaa';
  u_b uuid := 'b8b8b8b8-2222-4222-8222-bbbbbbbbbbbb';
  m_shared uuid := 'e1e1e1e1-0002-4002-8002-eeeeeeeeeeee';
  m_ended uuid := 'e1e1e1e1-0004-4004-8004-eeeeeeeeeeee';
  t_shared uuid := 'f1f1f1f1-0002-4002-8002-ffffffffffff';
  t_ended uuid := 'f1f1f1f1-0004-4004-8004-ffffffffffff';
  v_escalated timestamptz := now() - interval '4 hours';
  v_expires timestamptz := now() - interval '1 minute';
  v_since timestamptz;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'handoff-a-' || u_a::text || '@example.invalid'),
    (u_b, 'handoff-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id) VALUES
    (t_shared, u_a, 'whatsapp', 'c_shared'),
    (t_ended, u_a, 'whatsapp', 'c_ended');

  INSERT INTO public.ai_conversation_modes (id, user_id, platform, conversation_id, mode, expires_at, escalated_at) VALUES
    (gen_random_uuid(), u_a, 'whatsapp', 'c_live', 'human_first', now() + interval '1 hour', now()),
    (m_shared, u_a, 'whatsapp', 'c_shared', 'human_then_ai', v_expires, v_escalated),
    (gen_random_uuid(), u_a, 'whatsapp', 'c_manual', 'human_first', NULL, NULL),
    (m_ended, u_a, 'whatsapp', 'c_ended', 'human_first', v_expires, v_escalated);

  -- A human_then_ai row never carries an acknowledgement claim. This one does, on purpose:
  -- the release must not clear a claim it never made.
  INSERT INTO public.ai_conversation_modes
    (id, user_id, platform, conversation_id, mode, expires_at, escalated_at, customer_ack_sent_at)
  VALUES
    (gen_random_uuid(), u_a, 'whatsapp', 'c_hybrid', 'human_then_ai', now() + interval '1 hour', now(), now());

  -- H1: a live human_first window is acknowledged once; later messages only learn it is open.
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_live') = 'claimed', 'H1 the first claim wins';
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_live') = 'window', 'H1 the second claim reports the window';
  ASSERT public.claim_human_mode_ack(u_b, 'whatsapp', 'c_live') = 'none', 'H1 another tenant sees no window';

  -- H2: no ack and no window under human_then_ai, for a manual override, or after the window ended.
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_shared') = 'none', 'H2 human_then_ai is not acknowledged';
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_manual') = 'none', 'H2 a manual override is not acknowledged';
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_ended') = 'none', 'H2 an expired window is not acknowledged';

  -- H3: expiry needs the exact row observed: the wrong owner or a changed expires_at deletes nothing.
  ASSERT NOT public.expire_conversation_mode(m_ended, u_b, v_expires), 'H3 another tenant cannot expire it';
  ASSERT NOT public.expire_conversation_mode(m_ended, u_a, v_expires + interval '1 second'),
    'H3 a replaced expires_at is not expired';
  ASSERT EXISTS (SELECT 1 FROM public.ai_conversation_modes WHERE id = m_ended), 'H3 the row is still there';

  -- H4: an expired human_first window is deleted once and marks its thread with the escalation time.
  ASSERT public.expire_conversation_mode(m_ended, u_a, v_expires), 'H4 the expiry deletes the row';
  ASSERT NOT public.expire_conversation_mode(m_ended, u_a, v_expires), 'H4 a second expiry deletes nothing';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_ended) = v_escalated,
    'H4 the thread carries the original escalated_at';

  -- H5: an expired human_then_ai window is deleted but marks nothing: the agent never went quiet.
  ASSERT public.expire_conversation_mode(m_shared, u_a, v_expires), 'H5 the expiry deletes the row';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_shared) IS NULL,
    'H5 a human_then_ai expiry leaves no marker';

  -- H6: the marker is taken once, by its owner only.
  ASSERT public.take_unanswered_escalation(t_ended, u_b) IS NULL, 'H6 another tenant cannot take it';
  v_since := public.take_unanswered_escalation(t_ended, u_a);
  ASSERT v_since = v_escalated, 'H6 the owner takes the escalation time';
  ASSERT public.take_unanswered_escalation(t_ended, u_a) IS NULL, 'H6 the second take is NULL';

  -- H7: only service_role reaches the three functions.
  ASSERT NOT has_function_privilege('anon', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'H7 anon cannot claim an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'H7 authenticated cannot claim an ack';
  ASSERT NOT has_function_privilege('anon', 'public.expire_conversation_mode(uuid, uuid, timestamptz)', 'EXECUTE'),
    'H7 anon cannot expire a mode';
  ASSERT NOT has_function_privilege('authenticated', 'public.expire_conversation_mode(uuid, uuid, timestamptz)', 'EXECUTE'),
    'H7 authenticated cannot expire a mode';
  ASSERT NOT has_function_privilege('anon', 'public.take_unanswered_escalation(uuid, uuid)', 'EXECUTE'),
    'H7 anon cannot take the marker';
  ASSERT NOT has_function_privilege('authenticated', 'public.take_unanswered_escalation(uuid, uuid)', 'EXECUTE'),
    'H7 authenticated cannot take the marker';
  ASSERT has_function_privilege('service_role', 'public.take_unanswered_escalation(uuid, uuid)', 'EXECUTE'),
    'H7 service_role can take the marker';

  -- H8: the acknowledgement claim comes back when the notice never became durable.
  ASSERT NOT public.release_human_mode_ack(u_b, 'whatsapp', 'c_live'),
    'H8 another tenant releases no claim';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_live') IS NOT NULL,
    'H8 the other tenant did not touch the claim';
  ASSERT NOT public.release_human_mode_ack(u_a, 'whatsapp', 'c_manual'),
    'H8 a conversation with no claim releases nothing';
  ASSERT NOT public.release_human_mode_ack(u_a, 'whatsapp', 'c_hybrid'),
    'H8 a human_then_ai row is never released';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_hybrid') IS NOT NULL,
    'H8 the stray claim is left alone';
  ASSERT public.release_human_mode_ack(u_a, 'whatsapp', 'c_live'),
    'H8 the spent claim is released';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_live') IS NULL,
    'H8 the claim is NULL again';
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_live') = 'claimed',
    'H8 the notice can be claimed again';

  -- H9: the escalation marker comes back when the reply never became durable.
  ASSERT NOT public.restore_unanswered_escalation(t_ended, u_b, v_escalated),
    'H9 another tenant restores no marker';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_ended) IS NULL,
    'H9 the marker is still NULL';
  ASSERT public.restore_unanswered_escalation(t_ended, u_a, v_escalated),
    'H9 the taken marker is restored';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_ended) = v_escalated,
    'H9 the marker carries the escalation time again';
  ASSERT NOT public.restore_unanswered_escalation(t_ended, u_a, v_escalated),
    'H9 a marker that is already set is not restored twice';
  UPDATE public.ai_threads
     SET unanswered_escalation_since = v_escalated + interval '1 hour'
   WHERE id = t_ended;
  ASSERT NOT public.restore_unanswered_escalation(t_ended, u_a, v_escalated),
    'H9 a newer marker is not overwritten';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_ended)
      = v_escalated + interval '1 hour',
    'H9 the newer marker stays';

  -- H10: tokenless ack release is private; only service_role can restore a marker.
  ASSERT NOT has_function_privilege('anon', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'H10 anon cannot release an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'H10 authenticated cannot release an ack';
  ASSERT NOT has_function_privilege('anon', 'public.restore_unanswered_escalation(uuid, uuid, timestamptz)', 'EXECUTE'),
    'H10 anon cannot restore the marker';
  ASSERT NOT has_function_privilege('authenticated', 'public.restore_unanswered_escalation(uuid, uuid, timestamptz)', 'EXECUTE'),
    'H10 authenticated cannot restore the marker';
  ASSERT NOT has_function_privilege('service_role', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'H10 service_role cannot release a tokenless ack';
  ASSERT has_function_privilege('service_role', 'public.restore_unanswered_escalation(uuid, uuid, timestamptz)', 'EXECUTE'),
    'H10 service_role can restore the marker';
END $$;

ROLLBACK;
\echo '=== agent_handoff_messages: ALL CHECKS PASSED ==='
