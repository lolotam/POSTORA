-- supabase/tests/agent_handoff_legacy_claim_ownership.sql
-- The ownership guards of the legacy handoff functions (migration
-- 20261113270000_agent_handoff_legacy_claim_ownership.sql). One transaction, synthetic
-- fixtures, labelled G1..Gn ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are
-- applied. No secrets and no real accounts.
--
-- The promises this holds:
--
--   1. The legacy release clears the claim the legacy path owns and nothing else. During
--      the rolling deployment an old worker and a new one can hold the same window at the
--      same time: the old worker's release used to erase the claim its SUCCESSOR held, so
--      the successor was about to send the notice, the claim was gone, another turn
--      claimed it and sent the notice again -- two notices for one window.
--
--   2. The legacy escalation taker refuses a marker the new build has LEASED, so the
--      apology for a silent window is made once.
--
--   3. The legacy claim never hands out an acknowledgement the database knows was
--      DELIVERED. What the database cannot tell apart -- a claim taken by the build that
--      predates the lease, which recorded no delivery -- is documented in the migration
--      and is not pretended away here.
BEGIN;
DO $$
DECLARE
  u_a uuid := 'd7d7d7d7-1111-4111-8111-cccccccccccc';
  u_b uuid := 'd8d8d8d8-2222-4222-8222-cccccccccccc';
  v_own uuid := 'e7e7e7e7-0001-4001-8001-dddddddddddd';
  v_own2 uuid := 'e8e8e8e8-0001-4001-8001-dddddddddddd';
  v_delivered uuid := 'e9e9e9e9-0001-4001-8001-dddddddddddd';
  v_thread uuid := 'f7f7f7f7-0001-4001-8001-dddddddddddd';
  v_thread2 uuid := 'f8f8f8f8-0001-4001-8001-dddddddddddd';
  v_since timestamptz := now() - interval '2 hours';
  v_claim jsonb;
  v_sent timestamptz;
  v_taken timestamptz;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'legacy-ack-a-' || u_a::text || '@example.invalid'),
    (u_b, 'legacy-ack-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.ai_conversation_modes (
    id, user_id, platform, conversation_id, mode, expires_at, escalated_at
  ) VALUES
    (v_own, u_a, 'whatsapp', 'c_own', 'human_first', now() + interval '1 hour', now()),
    (v_own2, u_a, 'whatsapp', 'c_own2', 'human_first', now() + interval '1 hour', now()),
    (v_delivered, u_a, 'whatsapp', 'c_delivered', 'human_first', now() + interval '1 hour', now());

  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id, unanswered_escalation_since)
  VALUES (v_thread, u_a, 'whatsapp', 'c_marker', v_since);

  -- G1: the legacy path claims the window, its lease lapses and a new worker takes the
  -- claim over. The old worker's release must not erase the claim its successor holds.
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_own') = 'claimed',
    'G1 the legacy path claims the window';
  SELECT customer_ack_sent_at INTO v_sent
    FROM public.ai_conversation_modes WHERE id = v_own;
  UPDATE public.ai_conversation_modes
     SET customer_ack_claimed_at = now() - interval '10 minutes'
   WHERE id = v_own;
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_own', 120);
  ASSERT v_claim->>'result' = 'claimed', 'G1 the lapsed lease is taken over';
  SELECT customer_ack_claimed_at INTO v_taken
    FROM public.ai_conversation_modes WHERE id = v_own;
  ASSERT v_taken IS NOT NULL AND v_taken <> v_sent, 'G1 the takeover carries a newer stamp';

  ASSERT NOT public.release_human_mode_ack(u_a, 'whatsapp', 'c_own'),
    'G1 the legacy release does not erase a successor claim';
  ASSERT (SELECT customer_ack_claimed_at FROM public.ai_conversation_modes WHERE id = v_own) = v_taken,
    'G1 the successor claim is left alone';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes WHERE id = v_own) = v_sent,
    'G1 the claim stamp is left alone';

  -- G2: the legacy release still clears the claim the legacy path owns, so a notice that
  -- never became durable is still owed.
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_own2') = 'claimed',
    'G2 the legacy path claims the window';
  ASSERT public.release_human_mode_ack(u_a, 'whatsapp', 'c_own2'),
    'G2 the legacy release clears the claim it owns';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes WHERE id = v_own2) IS NULL,
    'G2 the claim is NULL again';
  ASSERT (SELECT customer_ack_claimed_at FROM public.ai_conversation_modes WHERE id = v_own2) IS NULL,
    'G2 the lease stamp is NULL again';

  -- G3: a DELIVERED notice is never released: it reached the customer, and putting the
  -- claim back would let a later turn send it again.
  UPDATE public.ai_conversation_modes
     SET customer_ack_sent_at = now(),
         customer_ack_claimed_at = now(),
         customer_ack_delivered_at = now()
   WHERE id = v_delivered;
  ASSERT NOT public.release_human_mode_ack(u_a, 'whatsapp', 'c_delivered'),
    'G3 a delivered notice is not released';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes WHERE id = v_delivered) IS NOT NULL,
    'G3 the delivered claim stands';

  -- G4: the legacy claim never hands out a DELIVERED acknowledgement. The delivered marker
  -- is what the database reads, and it is written by every completion that made a notice
  -- durable.
  UPDATE public.ai_conversation_modes
     SET customer_ack_sent_at = NULL,
         customer_ack_claimed_at = NULL
   WHERE id = v_delivered;
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_delivered') <> 'claimed',
    'G4 a delivered notice is never claimed again';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes WHERE id = v_delivered) IS NULL,
    'G4 the delivered notice keeps no claim';

  -- G5: the legacy escalation taker refuses a LEASED marker: the new build is making the
  -- apology for that window, and taking the marker here would make it twice.
  UPDATE public.ai_threads
     SET unanswered_escalation_claimed_at = clock_timestamp()
   WHERE id = v_thread;
  ASSERT public.take_unanswered_escalation(v_thread, u_a) IS NULL,
    'G5 a leased marker is not taken';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = v_thread) = v_since,
    'G5 the leased marker is left alone';

  -- G6: a marker nobody leased is still taken, and the apology is still made once.
  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id, unanswered_escalation_since)
  VALUES (v_thread2, u_a, 'whatsapp', 'c_marker2', v_since);
  ASSERT public.take_unanswered_escalation(v_thread2, u_a) = v_since,
    'G6 an unleased marker is taken';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = v_thread2) IS NULL,
    'G6 the marker is cleared';

  -- G7: another tenant reaches neither the marker nor the claim.
  ASSERT public.take_unanswered_escalation(v_thread, u_b) IS NULL,
    'G7 another tenant takes no marker';
  ASSERT public.claim_human_mode_ack(u_b, 'whatsapp', 'c_own') = 'none',
    'G7 another tenant claims no window';

  -- G8: only service_role reaches the legacy functions.
  ASSERT NOT has_function_privilege('anon', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'G8 anon cannot claim an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'G8 authenticated cannot claim an ack';
  ASSERT has_function_privilege('service_role', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'G8 service_role can claim an ack';
  ASSERT NOT has_function_privilege('anon', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'G8 anon cannot release an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'G8 authenticated cannot release an ack';
  ASSERT has_function_privilege('service_role', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'G8 service_role can release an ack';
  ASSERT NOT has_function_privilege('anon', 'public.take_unanswered_escalation(uuid, uuid)', 'EXECUTE'),
    'G8 anon cannot take a marker';
  ASSERT NOT has_function_privilege('authenticated', 'public.take_unanswered_escalation(uuid, uuid)', 'EXECUTE'),
    'G8 authenticated cannot take a marker';
  ASSERT has_function_privilege('service_role', 'public.take_unanswered_escalation(uuid, uuid)', 'EXECUTE'),
    'G8 service_role can take a marker';
END $$;

ROLLBACK;
\echo '=== agent_handoff_legacy_claim_ownership: ALL CHECKS PASSED ==='
