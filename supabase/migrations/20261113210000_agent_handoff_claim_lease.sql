-- Leases for the two handoff claims, so a claim survives the death of the worker that took it.
--
-- Both notices around a silent (human_first) handoff are CLAIMS, and both are spent before
-- the reply they belong to is durable:
--   * claim_human_mode_ack sets customer_ack_sent_at, so the acknowledgement is single-flight;
--   * take_unanswered_escalation clears the thread's marker, so only one reply apologises.
--
-- A claim that is CLEARED when it is taken cannot survive the worker that took it. The worker
-- may be killed between the claim and the durable write -- the reply was never stored and
-- nothing reached the customer -- and then the claim is gone with it: the customer is owed a
-- notice nobody will ever send, and the apology after a silent window is never made. A later
-- turn sees a closed gate and says nothing.
--
-- This file makes both claims LEASES:
--   * the acknowledgement claim carries when it was taken (customer_ack_claimed_at) and when it
--     was delivered (customer_ack_delivered_at);
--   * the escalation marker carries when it was taken (unanswered_escalation_claimed_at).
-- A lease that lapses without a delivery can be taken over by a later turn, so the notice
-- survives the termination of the worker that owed it. A lease that DID become durable is
-- completed, and the token that identifies it keeps a stale worker from releasing or
-- completing a newer claim.
--
-- The outbox row also learns what its text IS, so a gate that is closed for an answer the
-- model produced is not closed for the notice a human takeover owes the customer
-- (pending_agent_replies.generated_kind).
--
-- The applied migrations are not edited (ARCHITECTURE.md §23). Every function added here is
-- NEW, so the code that is deployed right now keeps working unchanged: the deployed edge
-- functions call claim_human_mode_ack, release_human_mode_ack, take_unanswered_escalation,
-- restore_unanswered_escalation and advance_agent_reply, and those five are left exactly as
-- they are. The functions below are the lease-based successors and are called only by the
-- edge build that ships after this migration.
--
-- Deploy order: this migration first, then the edge functions.

ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS customer_ack_claimed_at timestamptz;
ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS customer_ack_delivered_at timestamptz;
ALTER TABLE public.ai_threads
  ADD COLUMN IF NOT EXISTS unanswered_escalation_claimed_at timestamptz;
ALTER TABLE public.pending_agent_replies
  ADD COLUMN IF NOT EXISTS generated_kind text;

COMMENT ON COLUMN public.ai_conversation_modes.customer_ack_claimed_at IS
  'When the one-time human-mode acknowledgement claim was taken. A claim whose lease lapsed without a delivery may be taken over.';
COMMENT ON COLUMN public.ai_conversation_modes.customer_ack_delivered_at IS
  'When the one-time human-mode acknowledgement became durable. Set only once, so the notice is never sent twice.';
COMMENT ON COLUMN public.ai_threads.unanswered_escalation_claimed_at IS
  'When the unanswered-escalation marker was leased. A lease that lapsed without a durable reply may be taken over.';
COMMENT ON COLUMN public.pending_agent_replies.generated_kind IS
  'What the row''s stored text is: NULL for an answer the model produced, ''human_mode_ack'' for the one-time handoff notice.';

-- Writes the kind of the stored text together with the text, in the same statement.
--
-- advance_agent_reply is left exactly as it is: the deployed edge functions call it, and a
-- second overload with an extra defaulted parameter would make that call ambiguous. This
-- function is the one that also records the kind, and it is the only kind-aware path.
CREATE OR REPLACE FUNCTION public.advance_agent_reply_kind(
  p_id uuid,
  p_from text,
  p_to text,
  p_generated_reply text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_tool_calls jsonb DEFAULT NULL,
  p_generated_kind text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.pending_agent_replies
  SET status = p_to,
      generated_reply = COALESCE(p_generated_reply, generated_reply),
      generated_tool_calls = COALESCE(p_tool_calls, generated_tool_calls),
      generated_kind = COALESCE(p_generated_kind, generated_kind),
      error = COALESCE(p_error, error),
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END,
      updated_at = now()
  WHERE id = p_id
    AND status = p_from;
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
-- whole point of the lease, and it is what makes the notice survive a killed worker. A claim
-- made by the build that predates the lease (customer_ack_claimed_at IS NULL) is left alone:
-- it cannot be told apart from a notice that was already delivered by that build, and
-- re-sending a delivered notice is worse than missing one.
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
  IF v_row.customer_ack_claimed_at IS NOT NULL
     AND v_row.customer_ack_claimed_at < clock_timestamp() - v_lease THEN
    UPDATE public.ai_conversation_modes
       SET customer_ack_claimed_at = clock_timestamp()
     WHERE id = v_row.id
       AND customer_ack_claimed_at = v_row.customer_ack_claimed_at
       AND customer_ack_delivered_at IS NULL
    RETURNING customer_ack_claimed_at INTO v_row.customer_ack_claimed_at;
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'claimed', 'claim_token', v_row.customer_ack_claimed_at);
    END IF;
  END IF;

  -- A live claim, or one made by the build that predates the lease.
  RETURN jsonb_build_object('result', 'window', 'claim_token', NULL);
END;
$$;

-- Marks the acknowledgement as delivered. Only the claim the caller holds may be completed.
CREATE OR REPLACE FUNCTION public.complete_human_mode_ack(
  p_user_id uuid,
  p_platform text,
  p_conversation_id text,
  p_claim_token timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.ai_conversation_modes
  SET customer_ack_delivered_at = now()
  WHERE user_id = p_user_id
    AND platform = p_platform
    AND conversation_id = p_conversation_id
    AND mode = 'human_first'
    AND customer_ack_claimed_at = p_claim_token
    AND customer_ack_sent_at IS NOT NULL
    AND customer_ack_delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Puts the acknowledgement claim back, so a notice that never became durable is still owed.
--
-- Only the claim the caller holds is released: a worker that was overtaken cannot take the
-- notice away from the worker that replaced it.
CREATE OR REPLACE FUNCTION public.release_human_mode_ack_claim(
  p_user_id uuid,
  p_platform text,
  p_conversation_id text,
  p_claim_token timestamptz
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
    AND customer_ack_claimed_at = p_claim_token;
  RETURN FOUND;
END;
$$;

-- Leases the unanswered-escalation marker.
--
-- The marker is NOT cleared here. It is leased, so a worker that dies before the reply is
-- durable leaves the marker in place and a later turn takes the lease over once it lapses.
-- The marker is cleared only by complete_unanswered_escalation.
--
-- Returns the marker when this caller holds the lease, NULL when there is no marker or when
-- another worker holds a live lease.
CREATE OR REPLACE FUNCTION public.claim_unanswered_escalation(
  p_thread_id uuid,
  p_user_id uuid,
  p_lease_seconds integer DEFAULT 180
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_marker timestamptz;
  v_claimed_at timestamptz;
  v_lease interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 180), 1));
BEGIN
  SELECT unanswered_escalation_since, unanswered_escalation_claimed_at
    INTO v_marker, v_claimed_at
    FROM public.ai_threads
   WHERE id = p_thread_id
     AND user_id = p_user_id;

  IF NOT FOUND OR v_marker IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_claimed_at IS NOT NULL AND v_claimed_at >= clock_timestamp() - v_lease THEN
    -- A live lease: the apology is being made by that turn.
    RETURN NULL;
  END IF;

  UPDATE public.ai_threads
  SET unanswered_escalation_claimed_at = clock_timestamp()
  WHERE id = p_thread_id
    AND user_id = p_user_id
    AND unanswered_escalation_since = v_marker
    AND (unanswered_escalation_claimed_at IS NULL
         OR unanswered_escalation_claimed_at = v_claimed_at);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_marker;
END;
$$;

-- Consumes the escalation marker: the reply it belonged to became durable, so the window is
-- resolved and no later turn apologises for it.
--
-- The marker has to be the one this turn leased, so a stale completion can never clear a
-- marker a newer window set.
CREATE OR REPLACE FUNCTION public.complete_unanswered_escalation(
  p_thread_id uuid,
  p_user_id uuid,
  p_since timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.ai_threads
  SET unanswered_escalation_since = NULL,
      unanswered_escalation_claimed_at = NULL
  WHERE id = p_thread_id
    AND user_id = p_user_id
    AND unanswered_escalation_since = p_since;
  RETURN FOUND;
END;
$$;

-- Gives the escalation lease back, so the apology is still owed.
--
-- The marker itself was never cleared, so this only frees the lease. A marker that is set to a
-- different value belongs to a newer window and is left alone.
CREATE OR REPLACE FUNCTION public.release_unanswered_escalation_claim(
  p_thread_id uuid,
  p_user_id uuid,
  p_since timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.ai_threads
  SET unanswered_escalation_claimed_at = NULL
  WHERE id = p_thread_id
    AND user_id = p_user_id
    AND unanswered_escalation_since = p_since
    AND unanswered_escalation_claimed_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_human_mode_ack_leased(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_human_mode_ack(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_human_mode_ack_claim(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_unanswered_escalation(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_unanswered_escalation(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_unanswered_escalation_claim(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack_leased(uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_human_mode_ack(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_human_mode_ack_claim(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_unanswered_escalation(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_unanswered_escalation(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_unanswered_escalation_claim(uuid, uuid, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
