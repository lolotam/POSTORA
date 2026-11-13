-- Keeps a human-mode acknowledgement that outlived its window.
--
-- The gap this closes, found in review of PR #408:
--
--   The one-time notice and the claim it spends are ONE statement
--   (20261113240000_agent_handoff_claim_token.sql), and that statement looks the claim up
--   on the ai_conversation_modes row. The expiry (20261113230000_agent_conversation_mode_expiry_marker.sql)
--   DELETES that row as soon as expires_at <= now(), whatever the row's claim says.
--
--   So a customer message that claims the acknowledgement just before the window ends can
--   lose it: the expiry processing deletes the row, the persistence that follows finds no
--   row, returns false, and no notice becomes durable. The claim died with the row, so
--   nothing can retry it -- the customer is never told a human has their conversation.
--
-- Two ways out, and only one of them cannot lose the acknowledgement:
--
--   * The expiry refuses to delete a row whose claim is still outstanding. The row then
--     survives, but the claim can never be taken over: claim_human_mode_ack_leased only
--     hands out a claim while expires_at > now(), so an expired row with an outstanding
--     claim is one no turn can ever claim, and the expiry RPC has to report a failure the
--     edge treats as fatal (the marker it stamps is the only thing that leaves the thread
--     marked). That wedges the conversation instead of the notice.
--
--   * The persistence treats an ABSENT row as a claim that is already terminal, and writes
--     the notice anyway. The window is over and the row is gone, so there is nothing left
--     to mark as delivered -- but the notice the claim promised is still owed, and the
--     claim this caller holds is still the only authority to spend it. A row that IS there
--     is still checked against the token: a present row with a different token is a
--     different claim, and nothing is written for it.
--
-- The second one is what this migration does: the persistence is the statement that OWNS
-- the notice, so it is the statement that must not lose it. The expiry keeps its promise
-- exactly as it was -- the window is consumed and the escalation marker is left behind in
-- the same transaction -- and the notice survives the deletion of the row it was claimed
-- on.
--
-- The notice is written exactly once, because the outbox row it is written into is moved
-- only from the state the caller named: a second persistence of the same notice finds the
-- row already moved and writes nothing. The claim token stays the authority for the
-- notice: it is handed out once, to one worker, for one notice -- a worker that holds it
-- persists the notice into its own outbox row, and a worker that does not hold it cannot
-- name it at all.
--
-- Rollout: this migration lands with the other handoff migrations and BEFORE the edge
-- deployment, because the edge build that calls this function is the one that ships with
-- the branch. It only redefines a function, so the edge code that is live now keeps
-- working while it runs.

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
  v_claimed_at timestamptz;
  v_sent_at timestamptz;
  v_delivered_at timestamptz;
BEGIN
  -- The window's row, if it is still there. The scope carries one row (the table is
  -- UNIQUE on user_id, platform, conversation_id), so this is the row the claim was
  -- taken on. FOR UPDATE keeps the expiry from deleting it between this read and the
  -- write below.
  SELECT id, customer_ack_claimed_at, customer_ack_sent_at, customer_ack_delivered_at
    INTO v_mode_id, v_claimed_at, v_sent_at, v_delivered_at
    FROM public.ai_conversation_modes
   WHERE user_id = p_user_id
     AND platform = p_platform
     AND conversation_id = p_conversation_id
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    -- The row is there, so the claim has to be THIS caller's and it has to be owed: the
    -- token is the authority, the claim has to exist, and a notice that was already
    -- delivered is never written twice. A row that carries a different token is a
    -- different claim -- it lapsed and another turn took it over, or the window was
    -- escalated again -- and nothing is written for it.
    IF p_claim_token IS NULL
       OR v_claimed_at IS DISTINCT FROM p_claim_token
       OR v_sent_at IS NULL
       OR v_delivered_at IS NOT NULL THEN
      -- The claim is not this caller's: it lapsed and another turn took it over, or the
      -- notice was already delivered. Nothing is written, so no second notice can go out.
      RETURN FALSE;
    END IF;
  ELSIF p_claim_token IS NULL THEN
    -- No row and no token: there is no claim to spend, so there is nothing to promise.
    RETURN FALSE;
  END IF;

  UPDATE public.pending_agent_replies AS r
  SET status = p_to,
      generated_reply = COALESCE(p_generated_reply, generated_reply),
      generated_tool_calls = COALESCE(p_tool_calls, generated_tool_calls),
      generated_kind = COALESCE(p_generated_kind, generated_kind),
      error = COALESCE(p_error, error),
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END
  WHERE r.id = p_id
    AND r.status = p_from
    AND r.user_id = p_user_id;
  IF NOT FOUND THEN
    -- The row was not this caller's to move: the notice was not written, so the claim
    -- is not spent either. The notice is still owed.
    RETURN FALSE;
  END IF;

  IF v_mode_id IS NOT NULL THEN
    UPDATE public.ai_conversation_modes
    SET customer_ack_delivered_at = clock_timestamp()
    WHERE id = v_mode_id
      AND customer_ack_delivered_at IS NULL;
    RETURN FOUND;
  END IF;

  -- The window's row is gone -- the expiry consumed it -- so the claim is terminal and
  -- there is no row left to mark as delivered. The notice is still owed: it is the
  -- promise the claim made to the customer, and the claim this caller holds is still the
  -- only authority to spend it. The notice is durable, so the customer is told a human
  -- has their conversation.
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
