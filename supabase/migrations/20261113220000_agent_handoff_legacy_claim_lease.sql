-- Makes the acknowledgement claim lease-shaped for every build, so a claim can never
-- be stranded.
--
-- The lease migration (20261113210000) introduced the lease: a claim is handed out
-- again once its lease lapsed without a delivery. It deliberately left the claims
-- that predate the lease alone, because such a claim cannot be told apart from a
-- notice the old build already delivered -- and re-sending a delivered notice is
-- worse than missing one.
--
-- That left a claim that could never lapse at all: the old build stamped only
-- customer_ack_sent_at, and the leased function read a missing customer_ack_claimed_at
-- as "delivered by the old build" and left the row alone for ever. The customer was
-- never told a human had the conversation, and no later turn could fix it.
--
-- This migration closes that window:
--
--   1. claim_human_mode_ack stamps the lease as well, so a claim taken by a build
--      that predates the lease is a lease like any other and lapses when it is not
--      delivered. Its signature and its result are unchanged, so that build keeps
--      working.
--   2. claim_human_mode_ack_leased reads the clock of a claim that predates the lease
--      as the moment it was sent, so such a claim is taken over once it is older than
--      the lease instead of never.
--
-- The takeover can repeat a notice that the old build delivered: the old build has
-- no way to record the delivery, so there is nothing to read. That is bounded by the
-- lease -- at most one extra notice per lease -- and it is the only way a claim
-- left behind by that build can reach the customer at all.
--
-- Rollout: this migration lands with the other handoff migrations and before the
-- edge functions that use the lease. It only redefines functions, so the edge code
-- that is live now keeps working while it runs.

-- The pre-lease claim, made lease-shaped.
--
-- The result is what the old edge code reads: 'claimed' (send the notice), 'window'
-- (a bounded window already notified) or 'none' (no bounded window).
CREATE OR REPLACE FUNCTION public.claim_human_mode_ack(
  p_user_id uuid,
  p_platform text,
  p_conversation_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.ai_conversation_modes
  SET customer_ack_sent_at = clock_timestamp(),
      customer_ack_claimed_at = clock_timestamp()
  WHERE user_id = p_user_id
    AND platform = p_platform
    AND conversation_id = p_conversation_id
    AND mode = 'human_first'
    AND expires_at > now()
    AND customer_ack_sent_at IS NULL;
  IF FOUND THEN
    RETURN 'claimed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ai_conversation_modes
    WHERE user_id = p_user_id
      AND platform = p_platform
      AND conversation_id = p_conversation_id
      AND mode = 'human_first'
      AND expires_at > now()
  ) THEN
    RETURN 'window';
  END IF;
  RETURN 'none';
END;
$$;

-- Puts the acknowledgement claim back, so a notice that never became durable is still
-- owed. The lease stamp goes with it: a released claim is no claim.
CREATE OR REPLACE FUNCTION public.release_human_mode_ack(
  p_user_id uuid,
  p_platform text,
  p_conversation_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.ai_conversation_modes
  SET customer_ack_sent_at = NULL,
      customer_ack_claimed_at = NULL
  WHERE user_id = p_user_id
    AND platform = p_platform
    AND conversation_id = p_conversation_id
    AND mode = 'human_first'
    AND customer_ack_sent_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

-- Leases the one-time human-mode acknowledgement.
--
-- The result is JSON so the caller learns WHICH claim it holds: the token that identifies the
-- claim is what makes a release or a completion touch only that claim and never a newer one.
--
--   {"result": "none",      "claim_token": null}  no bounded human_first window
--   {"result": "delivered", "claim_token": null}  the notice already reached the customer
--   {"result": "claimed",   "claim_token": "..."}  this caller holds the claim
--   {"result": "window",    "claim_token": null}  the window exists, the notice is not ours to send
--
-- A claim that never became durable is handed out again once its lease lapses: that is the
-- whole point of the lease, and it is what makes the notice survive a killed worker. The
-- clock of a claim that predates the lease (customer_ack_claimed_at IS NULL) is the moment
-- it was sent, so such a claim lapses too instead of being stranded for ever.
CREATE OR REPLACE FUNCTION public.claim_human_mode_ack_leased(
  p_user_id uuid,
  p_platform text,
  p_conversation_id text,
  p_lease_seconds integer DEFAULT 180
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.ai_conversation_modes%ROWTYPE;
  v_lease interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 180), 1));
BEGIN
  SELECT * INTO v_row
    FROM public.ai_conversation_modes
   WHERE user_id = p_user_id
     AND platform = p_platform
     AND conversation_id = p_conversation_id
     AND mode = 'human_first'
     AND expires_at > now()
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'none', 'claim_token', NULL);
  END IF;

  IF v_row.customer_ack_delivered_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'delivered', 'claim_token', NULL);
  END IF;

  IF v_row.customer_ack_sent_at IS NULL THEN
    -- The first claim of this window. The lease is stamped with the WALL clock, not
    -- now(): now() is the transaction's timestamp, so two claims inside one
    -- transaction would carry the same token and a stale caller could release the
    -- claim that replaced it.
    UPDATE public.ai_conversation_modes
       SET customer_ack_sent_at = clock_timestamp(),
           customer_ack_claimed_at = clock_timestamp(),
           customer_ack_delivered_at = NULL
     WHERE id = v_row.id
       AND customer_ack_sent_at IS NULL
       AND customer_ack_delivered_at IS NULL
    RETURNING customer_ack_claimed_at INTO v_row.customer_ack_claimed_at;
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'claimed', 'claim_token', v_row.customer_ack_claimed_at);
    END IF;
    -- Another worker took it in the meantime.
    RETURN jsonb_build_object('result', 'window', 'claim_token', NULL);
  END IF;

  -- A claim exists. It may be taken over only when its lease lapsed without a delivery.
  -- A claim that predates the lease has no lease stamp of its own: the moment it was
  -- sent is its clock, so it lapses like any other claim.
  IF coalesce(v_row.customer_ack_claimed_at, v_row.customer_ack_sent_at) < clock_timestamp() - v_lease THEN
    UPDATE public.ai_conversation_modes
       SET customer_ack_claimed_at = clock_timestamp()
     WHERE id = v_row.id
       AND coalesce(customer_ack_claimed_at, customer_ack_sent_at) = coalesce(v_row.customer_ack_claimed_at, v_row.customer_ack_sent_at)
       AND customer_ack_delivered_at IS NULL
    RETURNING customer_ack_claimed_at INTO v_row.customer_ack_claimed_at;
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'claimed', 'claim_token', v_row.customer_ack_claimed_at);
    END IF;
  END IF;

  -- A live claim.
  RETURN jsonb_build_object('result', 'window', 'claim_token', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_human_mode_ack_leased(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_human_mode_ack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack_leased(uuid, text, text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
