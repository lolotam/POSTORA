-- Handoff messages around a silent (human_first) escalation.
--
-- curemedkw 2026-11-12: a customer whose conversation was handed to staff heard nothing at
-- all, and when the window ended unanswered the agent resumed as if no time had passed.
-- Two fixed notices close those gaps:
--   * one acknowledgement when the customer writes into a human_first window;
--   * one apology opening the agent's first reply after such a window ended with no staff
--     reply.
-- The texts live in code (ai-agent-reply/logic.ts); this migration holds the state that
-- makes each one single-flight.

ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_ack_sent_at timestamptz;

COMMENT ON COLUMN public.ai_conversation_modes.escalated_at IS
  'When escalateConversation opened this window. Staff replies after it count as an answer.';
COMMENT ON COLUMN public.ai_conversation_modes.customer_ack_sent_at IS
  'When the customer was told a human has the conversation. NULL re-arms it for a new escalation.';

ALTER TABLE public.ai_threads
  ADD COLUMN IF NOT EXISTS unanswered_escalation_since timestamptz;

COMMENT ON COLUMN public.ai_threads.unanswered_escalation_since IS
  'Set when a human_first window expires; taken (and cleared) by the agent''s next reply.';

-- Two deliveries of one message, or two quick messages, must not both send the
-- acknowledgement. Only a live, bounded human_first window qualifies: a manual override
-- (expires_at NULL) is an operator's decision and gets no automatic notice, and under
-- human_then_ai the agent is still answering.
-- Returns 'claimed' (send the notice), 'window' (a bounded window already notified: keep the
-- message for the agent's return) or 'none' (no bounded window: nothing to do).
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
  SET customer_ack_sent_at = now()
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

-- Replaces the reader's plain delete of an expired override. Deletes exactly the row
-- observed (id, owner and the expires_at it carried) and, for a human_first row, marks the
-- thread in the same transaction, so whichever function happens to observe the expiry leaves
-- the marker. An earlier unanswered marker is kept: staff replies since then still count.
CREATE OR REPLACE FUNCTION public.expire_conversation_mode(
  p_mode_id uuid,
  p_user_id uuid,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gone record;
BEGIN
  DELETE FROM public.ai_conversation_modes
  WHERE id = p_mode_id
    AND user_id = p_user_id
    AND expires_at = p_expires_at
    AND expires_at <= now()
  RETURNING user_id, platform, conversation_id, mode, coalesce(escalated_at, updated_at) AS since
  INTO v_gone;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_gone.mode = 'human_first' THEN
    UPDATE public.ai_threads
    SET unanswered_escalation_since = coalesce(unanswered_escalation_since, v_gone.since)
    WHERE user_id = v_gone.user_id
      AND platform = v_gone.platform
      AND conversation_id = v_gone.conversation_id;
  END IF;
  RETURN true;
END;
$$;

-- Returns the marker and clears it in one statement, so only one reply apologises.
-- NULL when there is no marker.
CREATE OR REPLACE FUNCTION public.take_unanswered_escalation(
  p_thread_id uuid,
  p_user_id uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  UPDATE public.ai_threads AS t
  SET unanswered_escalation_since = NULL
  FROM (
    SELECT id, unanswered_escalation_since
    FROM public.ai_threads
    WHERE id = p_thread_id
      AND user_id = p_user_id
      AND unanswered_escalation_since IS NOT NULL
    FOR UPDATE
  ) AS previous
  WHERE t.id = previous.id
  RETURNING previous.unanswered_escalation_since INTO v_since;
  RETURN v_since;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_conversation_mode(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.take_unanswered_escalation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_conversation_mode(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.take_unanswered_escalation(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
