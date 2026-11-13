-- Followup to 20261112170000_agent_handoff_messages.sql.
--
-- Both notices around a silent (human_first) handoff are CLAIMS, and both are spent
-- before the reply they belong to is durable:
--   * claim_human_mode_ack sets customer_ack_sent_at, so the acknowledgement is
--     single-flight;
--   * take_unanswered_escalation clears the thread's marker, so only one reply apologises.
--
-- When the delivery that follows fails before anything durable exists, the claim is gone
-- with it: the customer receives no acknowledgement, the apology is never made, and the
-- next turn believes the notice was already delivered. The two functions below put the
-- claim back so the next turn can make it.
--
-- The applied migration is not edited (ARCHITECTURE.md §23). This file adds the release
-- path to it.

-- Puts the human-mode acknowledgement claim back.
--
-- Only a claim this turn took can be released: the UPDATE matches a row whose
-- customer_ack_sent_at is already set, and the RPC that sets it is single-flight, so at
-- most one claim is ever outstanding for a conversation. A row that already says NULL was
-- never claimed (or was already released) and is left alone.
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
  SET customer_ack_sent_at = NULL
  WHERE user_id = p_user_id
    AND platform = p_platform
    AND conversation_id = p_conversation_id
    AND mode = 'human_first'
    AND customer_ack_sent_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

-- Puts the escalation marker back so the apology is still owed.
--
-- A marker that is already set is NEWER than this one -- another window marked the thread
-- in the meantime -- and is left alone: overwriting it would lose that window and its
-- staff replies.
CREATE OR REPLACE FUNCTION public.restore_unanswered_escalation(
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
  SET unanswered_escalation_since = p_since
  WHERE id = p_thread_id
    AND user_id = p_user_id
    AND unanswered_escalation_since IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.release_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_unanswered_escalation(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_human_mode_ack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_unanswered_escalation(uuid, uuid, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
