-- Gives every handoff claim a token of its own, and writes the one-time notice together
-- with the claim it spends.
--
-- Two gaps this closes, both found in review of PR #408:
--
--   1. The escalation marker was leased, but the lease carried no token of its OWN: the
--      marker was the only thing a release or a completion could name, and every worker
--      that ever held the lease named it the SAME way. A worker that outlived its lease
--      could therefore release the lease a NEWER worker was holding, and a third worker
--      could claim the marker while the second was still working on it.
--
--      The claim token is the lease stamp, written with the WALL clock when the claim is
--      taken -- the shape the acknowledgement claim already uses. Every takeover writes a
--      new stamp, so a stale worker's token no longer matches, and every release,
--      completion and reply it attempts is refused.
--
--   2. The one-time notice was persisted by one statement and its claim completed by
--      another. A completion that failed left the notice delivered with the claim still
--      owed, and a later turn that met the same window sent the notice a second time.
--      The notice and the completion of the claim it spends are ONE statement now: either
--      the notice is durable and the claim is spent, or neither happened.
--
-- The delivery claim carries the payload it read. The row's text is read without a lock,
-- so a closed gate can replace it between the read and the claim; the claim only moves a
-- row that STILL holds the payload the caller read, so a replaced row is never sent.
--
-- Rollout: this migration lands BEFORE the edge build that calls these functions. It is
-- safe to apply while the edge build that is live now keeps running: that build calls
-- exactly one of them, advance_agent_reply, and this migration does not touch it.
--
-- The functions this migration replaces were introduced by 20261113210000, which is not
-- applied to production yet. They are dropped here rather than left beside their
-- replacements: a second overload would make the call ambiguous, and nothing that runs
-- today calls them.

-- -----------------------------------------------------------------------------
-- The escalation lease, with a token of its own.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.claim_unanswered_escalation(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.complete_unanswered_escalation(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.release_unanswered_escalation_claim(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz);

-- Leases the unanswered-escalation marker.
--
-- The marker is NOT cleared here: it is leased. A worker that dies before the reply is
-- durable leaves the marker in place, and a later turn takes the lease over once it
-- lapses, so the apology is still made.
--
-- The result is JSON so the caller learns WHICH lease it holds:
--
--   {"marker": null, "token": null}   no marker, or another worker holds a live lease
--   {"marker": "...", "token": "..."}  this caller holds the lease
--
-- The token is the moment the lease was taken, stamped with the WALL clock and not
-- now(): now() is the transaction's timestamp, so two claims inside one transaction
-- would carry the same token and a stale caller could release the lease that replaced
-- it. Every takeover writes a new stamp, so the token of a lapsed lease never matches
-- the one that replaced it.
CREATE OR REPLACE FUNCTION public.claim_unanswered_escalation(
  p_thread_id uuid,
  p_user_id uuid,
  p_lease_seconds integer DEFAULT 180
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_marker timestamptz;
  v_claimed_at timestamptz;
  v_token timestamptz;
  v_lease interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 180), 1));
BEGIN
  SELECT unanswered_escalation_since, unanswered_escalation_claimed_at
    INTO v_marker, v_claimed_at
    FROM public.ai_threads
   WHERE id = p_thread_id
     AND user_id = p_user_id;

  IF NOT FOUND OR v_marker IS NULL THEN
    RETURN jsonb_build_object('marker', NULL, 'token', NULL);
  END IF;

  IF v_claimed_at IS NOT NULL AND v_claimed_at >= clock_timestamp() - v_lease THEN
    -- A live lease: the apology is being made by that turn.
    RETURN jsonb_build_object('marker', NULL, 'token', NULL);
  END IF;

  UPDATE public.ai_threads
  SET unanswered_escalation_claimed_at = clock_timestamp()
  WHERE id = p_thread_id
    AND user_id = p_user_id
    AND unanswered_escalation_since = v_marker
    AND (unanswered_escalation_claimed_at IS NULL
         OR unanswered_escalation_claimed_at = v_claimed_at)
  RETURNING unanswered_escalation_claimed_at INTO v_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('marker', NULL, 'token', NULL);
  END IF;

  RETURN jsonb_build_object('marker', v_marker, 'token', v_token);
END;
$$;

-- Consumes the escalation marker: the reply it belonged to became durable, so the window
-- is resolved and no later turn apologises for it.
--
-- The marker AND the lease have to be the ones this turn holds. A worker whose lease
-- lapsed can no longer clear a marker a newer worker is working on.
CREATE OR REPLACE FUNCTION public.complete_unanswered_escalation(
  p_thread_id uuid,
  p_user_id uuid,
  p_since timestamptz,
  p_claim_token timestamptz
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
    AND unanswered_escalation_since = p_since
    AND unanswered_escalation_claimed_at = p_claim_token;
  RETURN FOUND;
END;
$$;

-- Gives the escalation lease back, so the apology is still owed.
--
-- The marker itself was never cleared, so this only frees the lease -- and only the lease
-- this caller holds. A worker that was overtaken cannot free the lease its replacement
-- is working under, and a marker that is set to a different value belongs to a newer
-- window and is left alone.
CREATE OR REPLACE FUNCTION public.release_unanswered_escalation_claim(
  p_thread_id uuid,
  p_user_id uuid,
  p_since timestamptz,
  p_claim_token timestamptz
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
    AND unanswered_escalation_claimed_at = p_claim_token;
  RETURN FOUND;
END;
$$;

-- Writes the reply and consumes the escalation window it resolves, in ONE statement.
--
-- The reply carries the apology, so the reply and the window it resolves are one fact.
-- Two statements could leave the text durable and the marker owed: the reply is
-- redelivered, and a later turn takes the marker over once its lease lapses and
-- apologises for the same window a second time. One transaction has no such boundary.
--
-- The lease is checked BEFORE the reply is stored. A worker whose lease lapsed and was
-- taken over must not store another apology against a newer claim: it writes nothing at
-- all, and the window it would have resolved stays owed.
--
-- The row is moved only when it really was in the from-state, and the marker is cleared
-- only when it is the one this turn leased.
CREATE OR REPLACE FUNCTION public.persist_agent_reply_and_complete_escalation(
  p_id uuid,
  p_from text,
  p_to text,
  p_generated_reply text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_tool_calls jsonb DEFAULT NULL,
  p_generated_kind text DEFAULT NULL,
  p_thread_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_claim_token timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed timestamptz;
BEGIN
  IF p_thread_id IS NOT NULL AND p_since IS NOT NULL THEN
    -- The lease this caller holds, and only it. FOR UPDATE keeps a takeover from
    -- slipping in between this check and the write below, and the row it locks is the
    -- row the write below has to match.
    SELECT unanswered_escalation_claimed_at INTO v_claimed
      FROM public.ai_threads
     WHERE id = p_thread_id
       AND user_id = p_user_id
       AND unanswered_escalation_since = p_since
       AND unanswered_escalation_claimed_at = p_claim_token
     FOR UPDATE;
    IF NOT FOUND THEN
      -- The lease is not this caller's: it lapsed and another turn took it over, or it
      -- was never taken. Nothing is written -- a stale worker must not store another
      -- apology against a newer claim.
      RETURN FALSE;
    END IF;
  END IF;

  UPDATE public.pending_agent_replies
  SET status = p_to,
      generated_reply = COALESCE(p_generated_reply, generated_reply),
      generated_tool_calls = COALESCE(p_tool_calls, generated_tool_calls),
      generated_kind = COALESCE(p_generated_kind, generated_kind),
      error = COALESCE(p_error, error),
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END
  WHERE id = p_id
    AND status = p_from;
  IF NOT FOUND THEN
    -- The row was not this caller's to move, so the window it would have resolved is
    -- NOT consumed: the apology stays owed.
    RETURN FALSE;
  END IF;

  IF p_thread_id IS NOT NULL AND p_since IS NOT NULL THEN
    UPDATE public.ai_threads
    SET unanswered_escalation_since = NULL,
        unanswered_escalation_claimed_at = NULL
    WHERE id = p_thread_id
      AND user_id = p_user_id
      AND unanswered_escalation_since = p_since
      -- The stamp this statement locked and checked, not the one the caller named: the
      -- row cannot have changed under the lock, so they are the same value, and the
      -- write says which lease it consumed.
      AND unanswered_escalation_claimed_at = v_claimed;
  END IF;

  RETURN TRUE;
END;
$$;

-- -----------------------------------------------------------------------------
-- The one-time notice and the claim it spends, in ONE statement.
-- -----------------------------------------------------------------------------

-- Writes the one-time human-mode notice and completes the claim it spends.
--
-- The notice and the claim are one fact: the customer is told a human has the
-- conversation, and no later turn may tell them again. Written as two statements, a
-- completion that failed left the notice delivered with the claim still owed, and the
-- next turn that met the same window sent the notice a second time.
--
-- The claim is matched by its token, so only the claim this caller holds can be spent,
-- and a worker that was overtaken writes nothing at all.
CREATE OR REPLACE FUNCTION public.persist_human_mode_ack_and_complete_claim(
  p_id uuid,
  p_from text,
  p_to text,
  p_generated_reply text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_tool_calls jsonb DEFAULT NULL,
  p_generated_kind text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_conversation_id text DEFAULT NULL,
  p_claim_token timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode_id uuid;
BEGIN
  -- The claim this caller holds. The token is the authority: the row that carries it is
  -- the row that was claimed, whatever has happened to the window since. FOR UPDATE keeps
  -- a takeover from slipping in between this check and the write below.
  SELECT id INTO v_mode_id
    FROM public.ai_conversation_modes
   WHERE user_id = p_user_id
     AND platform = p_platform
     AND conversation_id = p_conversation_id
     AND customer_ack_claimed_at = p_claim_token
     AND customer_ack_sent_at IS NOT NULL
     AND customer_ack_delivered_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    -- The claim is not this caller's: it lapsed and another turn took it over, or the
    -- notice was already delivered. Nothing is written, so no second notice can go out.
    RETURN FALSE;
  END IF;

  UPDATE public.pending_agent_replies
  SET status = p_to,
      generated_reply = COALESCE(p_generated_reply, generated_reply),
      generated_tool_calls = COALESCE(p_tool_calls, generated_tool_calls),
      generated_kind = COALESCE(p_generated_kind, generated_kind),
      error = COALESCE(p_error, error),
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END
  WHERE id = p_id
    AND status = p_from;
  IF NOT FOUND THEN
    -- The row was not this caller's to move: the notice was not written, so the claim
    -- is not spent either. The notice is still owed.
    RETURN FALSE;
  END IF;

  UPDATE public.ai_conversation_modes
  SET customer_ack_delivered_at = clock_timestamp()
  WHERE id = v_mode_id
    AND customer_ack_delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Puts the acknowledgement claim back, so a notice that never became durable is still
-- owed.
--
-- Only the claim the caller holds is released: a worker that was overtaken cannot take
-- the notice away from the worker that replaced it.
--
-- A claim that was DELIVERED is never released. The notice reached the customer, and
-- putting the claim back would let a later turn send it a second time.
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
    AND customer_ack_claimed_at = p_claim_token
    AND customer_ack_delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

-- -----------------------------------------------------------------------------
-- The delivery claim, carrying the payload it read.
-- -----------------------------------------------------------------------------

-- Moves a row into `sending` only when it still holds the payload the caller read.
--
-- The row's text is read without a lock, so a closed gate can replace it between the
-- read and the claim -- the row stays in `ready_to_send`, so the replacement is not
-- refused. A delivery that sent the OLD text would hand the customer an answer the
-- closed gate was meant to block, and the notice would never go out.
--
-- The claim therefore carries the text and the kind the caller read, and the row is
-- only moved while it holds exactly that payload. A row whose payload changed is
-- refused, and the refusal is fail-closed: nothing is sent.
CREATE OR REPLACE FUNCTION public.claim_agent_reply_for_delivery(
  p_id uuid,
  p_from text,
  p_to text,
  p_expected_reply text,
  p_expected_kind text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.pending_agent_replies
  SET status = p_to,
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END
  WHERE id = p_id
    AND status = p_from
    AND generated_reply IS NOT DISTINCT FROM p_expected_reply
    AND generated_kind IS NOT DISTINCT FROM p_expected_kind;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_unanswered_escalation(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_unanswered_escalation(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_unanswered_escalation_claim(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_human_mode_ack_claim(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_unanswered_escalation(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_unanswered_escalation(uuid, uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_unanswered_escalation_claim(uuid, uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_human_mode_ack_claim(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
