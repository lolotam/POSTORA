-- supabase/tests/agent_handoff_legacy_claim_lease.sql
-- The acknowledgement claim under a build that predates the consolidated lease
-- migration 20261113210000_agent_handoff_claim_lease.sql. One transaction, synthetic
-- fixtures, labelled M1..Mn ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are
-- applied. No secrets and no real accounts.
--
-- The lease made a claim that lapsed without a delivery available again, so the notice
-- survives a worker that was killed. It left the claims of an older build alone for ever:
-- such a claim could not be told apart from a notice that build had already delivered, so
-- it was never taken over -- and a claim that can never lapse is a claim that can never
-- reach the customer. These checks hold every claim to the same promise:
--
--   c_old    human_first, a claim taken before the lease existed
--   c_live   human_first, a claim of the older build that is still live
--   c_fresh  human_first, no claim yet
BEGIN;
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-cccccccccccc';
  u_b uuid := 'b2b2b2b2-2222-4222-8222-cccccccccccc';
  v_claim jsonb;
  v_token text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'legacy-ack-a-' || u_a::text || '@example.invalid'),
    (u_b, 'legacy-ack-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.ai_conversation_modes (id, user_id, platform, conversation_id, mode, expires_at, escalated_at, customer_ack_sent_at, customer_ack_claimed_at, customer_ack_legacy_claim)
  VALUES
    -- A claim taken before the lease existed: sent, never leased.
    (gen_random_uuid(), u_a, 'whatsapp', 'c_old', 'human_first', now() + interval '1 hour', now(), now() - interval '10 minutes', NULL, true),
    -- A claim of the older build that is still live.
    (gen_random_uuid(), u_a, 'whatsapp', 'c_live', 'human_first', now() + interval '1 hour', now(), now(), NULL, true),
    -- No claim yet.
    (gen_random_uuid(), u_a, 'whatsapp', 'c_fresh', 'human_first', now() + interval '1 hour', now(), NULL, NULL, false);

  -- M1: the claim of the older build is LEASE-shaped. It keeps the result the old edge code
  -- reads, and it stamps the lease, so it can be taken over when it is not delivered.
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_fresh') = 'claimed',
    'M1 the older build claims the window';
  ASSERT (SELECT customer_ack_claimed_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_fresh') IS NOT NULL,
    'M1 the claim carries a lease';
  ASSERT public.claim_human_mode_ack(u_a, 'whatsapp', 'c_fresh') = 'window',
    'M1 a live claim is not taken twice';

  -- M2: a claim of the older build lapses like any other claim: the lease runs out and the
  -- notice is owed again.
  UPDATE public.ai_conversation_modes
     SET customer_ack_claimed_at = now() - interval '10 minutes'
   WHERE user_id = u_a AND conversation_id = 'c_fresh';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_fresh', 120);
  ASSERT v_claim->>'result' = 'claimed', 'M2 a lapsed claim of the older build is taken over';
  ASSERT v_claim->>'claim_token' IS NOT NULL, 'M2 the takeover carries a token';

  -- M3: a claim that predates the lease is taken over once it is older than the lease. Before
  -- this it could never be taken over, so the customer was never told.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_old', 120);
  ASSERT v_claim->>'result' = 'claimed', 'M3 a claim that predates the lease is taken over';
  v_token := v_claim->>'claim_token';
  ASSERT v_token IS NOT NULL, 'M3 the takeover carries a token';
  ASSERT (SELECT customer_ack_claimed_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_old') IS NOT NULL,
    'M3 the takeover stamps the lease';

  -- M4: a LIVE claim is not taken over, whoever took it.
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_live', 120);
  ASSERT v_claim->>'result' = 'window', 'M4 a live claim is left alone';
  ASSERT v_claim->>'claim_token' IS NULL, 'M4 a window claim carries no token';

  -- M5: a delivered notice is never sent twice.
  UPDATE public.ai_conversation_modes
     SET customer_ack_delivered_at = now()
   WHERE user_id = u_a AND conversation_id = 'c_old';
  v_claim := public.claim_human_mode_ack_leased(u_a, 'whatsapp', 'c_old', 120);
  ASSERT v_claim->>'result' = 'delivered', 'M5 a delivered notice is never sent twice';

  -- M6: the release puts the claim back with no lease left on it.
  ASSERT public.release_human_mode_ack(u_a, 'whatsapp', 'c_live'),
    'M6 the claim is released';
  ASSERT (SELECT customer_ack_sent_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_live') IS NULL,
    'M6 the claim is NULL again';
  ASSERT (SELECT customer_ack_claimed_at FROM public.ai_conversation_modes
          WHERE user_id = u_a AND conversation_id = 'c_live') IS NULL,
    'M6 the lease goes with it';

  -- M7: another tenant sees no window at all.
  v_claim := public.claim_human_mode_ack_leased(u_b, 'whatsapp', 'c_old', 120);
  ASSERT v_claim->>'result' = 'none', 'M7 another tenant sees no window';

  -- M8: only service_role reaches these functions.
  ASSERT NOT has_function_privilege('anon', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'M8 anon cannot claim an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'M8 authenticated cannot claim an ack';
  ASSERT NOT has_function_privilege('anon', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'M8 anon cannot release an ack';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_human_mode_ack_leased(uuid, text, text, integer, uuid, text)', 'EXECUTE'),
    'M8 authenticated cannot lease an ack';
  ASSERT has_function_privilege('service_role', 'public.claim_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'M8 service_role can claim an ack';
  ASSERT has_function_privilege('service_role', 'public.release_human_mode_ack(uuid, text, text)', 'EXECUTE'),
    'M8 service_role can release an ack';
END $$;

ROLLBACK;
\echo '=== agent_handoff_legacy_claim_lease: ALL CHECKS PASSED ==='
