-- Makes the escalation marker survive a thread that is created at the same moment.
--
-- The expired window is deleted and the thread is marked in one transaction, so
-- whichever function observes the expiry leaves the marker. The marker was written
-- with an UPDATE on the thread row, and the thread row is written by the turn
-- itself: the reply handler upserts the thread while it resolves the override. When
-- the two ran at the same time, the UPDATE could find no row to mark -- the thread
-- did not exist yet -- and the marker was lost. The apology for a human_first
-- window that expired unanswered was never made, and no later turn could make it:
-- the expiry had already been consumed.
--
-- The marker is now written the same way the thread is: an upsert on the thread's
-- own key. If the thread exists, the marker is set on it. If it does not, the row
-- is created with the marker, and the turn's own upsert finds the row it made and
-- leaves the marker alone. Whichever of the two runs first, the marker survives.
--
-- An earlier marker is kept: staff replies since then still count.
--
-- Rollout: this migration lands with the other handoff migrations and before the
-- edge functions that use it. It only redefines a function, so the edge code that
-- is live now keeps working while it runs.

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
    INSERT INTO public.ai_threads AS t
      (user_id, platform, conversation_id, unanswered_escalation_since)
    VALUES (v_gone.user_id, v_gone.platform, v_gone.conversation_id, v_gone.since)
    ON CONFLICT (user_id, platform, conversation_id)
    DO UPDATE SET unanswered_escalation_since = coalesce(t.unanswered_escalation_since, EXCLUDED.unanswered_escalation_since);
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_conversation_mode(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_conversation_mode(uuid, uuid, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
