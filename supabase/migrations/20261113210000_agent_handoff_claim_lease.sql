-- Consolidated, unapplied PR #408 handoff changes. Apply before the new edge build.
-- 20261112170000 and 20261113120000 are already applied and remain unchanged.
-- Current main uses advance_agent_reply, whose signature and grants stay intact.
-- New callers use tenant-bound transitions and token-bound, conversation-bound claims.
-- Retire advance_agent_reply only after the new edge build is deployed and old workers drain;
-- see scripts/sql/retire-agent-reply-legacy.sql and the rollout checklist.
BEGIN;


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


-- A deleted window retains only its final claim. Superseded tokens never enter this
-- receipt table; completion consumes the surviving token under a row lock.
CREATE TABLE IF NOT EXISTS public.ai_handoff_ack_receipts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  conversation_id text NOT NULL,
  claim_token timestamptz NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform, conversation_id, claim_token)
);
ALTER TABLE public.ai_handoff_ack_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_handoff_ack_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ai_handoff_ack_receipts TO service_role;
DROP POLICY IF EXISTS service_role_receipts ON public.ai_handoff_ack_receipts;
CREATE POLICY service_role_receipts ON public.ai_handoff_ack_receipts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.retain_human_mode_ack_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.customer_ack_claimed_at IS NOT NULL AND OLD.customer_ack_sent_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    INSERT INTO public.ai_handoff_ack_receipts
      (user_id, platform, conversation_id, claim_token, delivered_at)
    VALUES (OLD.user_id, OLD.platform, OLD.conversation_id,
            OLD.customer_ack_claimed_at, OLD.customer_ack_delivered_at)
    ON CONFLICT (user_id, platform, conversation_id, claim_token)
    DO UPDATE SET delivered_at = coalesce(ai_handoff_ack_receipts.delivered_at, EXCLUDED.delivered_at);
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.retain_human_mode_ack_receipt() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS retain_human_mode_ack_receipt ON public.ai_conversation_modes;
CREATE TRIGGER retain_human_mode_ack_receipt BEFORE DELETE ON public.ai_conversation_modes
  FOR EACH ROW EXECUTE FUNCTION public.retain_human_mode_ack_receipt();

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
DECLARE
  v_owner uuid;
BEGIN
  SELECT sa.user_id INTO v_owner
    FROM public.social_accounts AS sa
   WHERE sa.id = (SELECT r.social_account_id FROM public.pending_agent_replies AS r WHERE r.id = p_id);
  IF v_owner IS NULL THEN
    -- No row, or a row without an account: there is nothing this call may move.
    RETURN FALSE;
  END IF;
  RETURN public.advance_agent_reply_kind_for_owner(
    v_owner, p_id, p_from, p_to, p_generated_reply, p_error, p_tool_calls, p_generated_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text) FROM service_role;

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
  v_platform text;
  v_conversation_id text;
  v_bound_to_conversation boolean := false;
BEGIN
  IF p_thread_id IS NOT NULL AND p_since IS NOT NULL THEN
    -- The lease this caller holds, and only it. FOR UPDATE keeps a takeover from
    -- slipping in between this check and the write below, and the row it locks is the
    -- row the write below has to match. The conversation comes with it: the row the
    -- reply is written into has to be the row of the conversation the window belongs to.
    SELECT unanswered_escalation_claimed_at, platform, conversation_id
      INTO v_claimed, v_platform, v_conversation_id
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
    v_bound_to_conversation := true;
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
    AND r.user_id = p_user_id
    -- The row belongs to the conversation the window belongs to. A call that names no
    -- thread resolves no window, so there is nothing to bind the row to and it stays
    -- bound to its tenant alone.
    AND (NOT v_bound_to_conversation
         OR (r.platform = v_platform AND r.conversation_id = v_conversation_id));
  IF NOT FOUND THEN
    -- The row was not this caller's to move -- it is not in the from-state, it belongs to
    -- another tenant, or it belongs to another conversation -- so the window it would have
    -- resolved is NOT consumed: the apology stays owed.
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

REVOKE ALL ON FUNCTION public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz) TO service_role;

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

REVOKE ALL ON FUNCTION public.claim_human_mode_ack_leased(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack_leased(uuid, text, text, integer) TO service_role;

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
  IF FOUND THEN RETURN TRUE; END IF;
  -- Non-outbox callers may complete after expiry too. A newer active scope never
  -- lends authority to an older receipt, and only the surviving token is consumed.
  IF EXISTS (SELECT 1 FROM public.ai_conversation_modes
    WHERE user_id = p_user_id AND platform = p_platform AND conversation_id = p_conversation_id) THEN
    RETURN FALSE;
  END IF;
  UPDATE public.ai_handoff_ack_receipts SET delivered_at = clock_timestamp()
   WHERE user_id = p_user_id AND platform = p_platform
     AND conversation_id = p_conversation_id AND claim_token = p_claim_token
     AND delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_human_mode_ack(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_human_mode_ack(uuid, text, text, timestamptz) TO service_role;

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

REVOKE ALL ON FUNCTION public.release_human_mode_ack_claim(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_human_mode_ack_claim(uuid, text, text, timestamptz) TO service_role;

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

REVOKE ALL ON FUNCTION public.claim_unanswered_escalation(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_unanswered_escalation(uuid, uuid, integer) TO service_role;

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

REVOKE ALL ON FUNCTION public.complete_unanswered_escalation(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_unanswered_escalation(uuid, uuid, timestamptz, timestamptz) TO service_role;

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

REVOKE ALL ON FUNCTION public.release_unanswered_escalation_claim(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_unanswered_escalation_claim(uuid, uuid, timestamptz, timestamptz) TO service_role;

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
DECLARE
  v_claim timestamptz := clock_timestamp();
BEGIN
  UPDATE public.ai_conversation_modes
  SET customer_ack_sent_at = v_claim,
      customer_ack_claimed_at = v_claim
  WHERE user_id = p_user_id
    AND platform = p_platform
    AND conversation_id = p_conversation_id
    AND mode = 'human_first'
    AND expires_at > now()
    AND customer_ack_sent_at IS NULL
    AND customer_ack_delivered_at IS NULL;
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

REVOKE ALL ON FUNCTION public.claim_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack(uuid, text, text) TO service_role;

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
    AND customer_ack_sent_at IS NOT NULL
    AND customer_ack_delivered_at IS NULL
    AND (customer_ack_claimed_at IS NULL OR customer_ack_claimed_at = customer_ack_sent_at);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.release_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_human_mode_ack(uuid, text, text) TO service_role;

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
  ELSE
    -- An absent window is not authority. Only its last, still-unspent receipt is.
    PERFORM 1 FROM public.ai_handoff_ack_receipts
     WHERE user_id = p_user_id AND platform = p_platform
       AND conversation_id = p_conversation_id AND claim_token = p_claim_token
       AND delivered_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
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
    AND r.user_id = p_user_id
    -- The row belongs to the conversation the claim belongs to.
    AND r.platform = p_platform
    AND r.conversation_id = p_conversation_id;
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

  UPDATE public.ai_handoff_ack_receipts
     SET delivered_at = clock_timestamp()
   WHERE user_id = p_user_id AND platform = p_platform
     AND conversation_id = p_conversation_id AND claim_token = p_claim_token
     AND delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) TO service_role;

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
DECLARE
  v_owner uuid;
BEGIN
  SELECT sa.user_id INTO v_owner
    FROM public.social_accounts AS sa
   WHERE sa.id = (SELECT r.social_account_id FROM public.pending_agent_replies AS r WHERE r.id = p_id);
  IF v_owner IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN public.claim_agent_reply_for_delivery_for_owner(
    v_owner, p_id, p_from, p_to, p_expected_reply, p_expected_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text) FROM service_role;

CREATE OR REPLACE FUNCTION public.advance_agent_reply_for_owner(
  p_user_id uuid,
  p_id uuid,
  p_from text,
  p_to text,
  p_generated_reply text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_tool_calls jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.pending_agent_replies AS r
  SET status = p_to,
      generated_reply = COALESCE(p_generated_reply, generated_reply),
      generated_tool_calls = COALESCE(p_tool_calls, generated_tool_calls),
      error = COALESCE(p_error, error),
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END
  WHERE r.id = p_id
    AND r.status = p_from
    AND r.user_id = p_user_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_agent_reply_kind_for_owner(
  p_user_id uuid,
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
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_agent_reply_for_delivery_for_owner(
  p_user_id uuid,
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
  UPDATE public.pending_agent_replies AS r
  SET status = p_to,
      sent_at = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
      lease_expires_at = CASE WHEN p_to IN ('sent', 'cancelled', 'failed', 'delivery_unknown') THEN NULL ELSE lease_expires_at END
  WHERE r.id = p_id
    AND r.status = p_from
    AND r.user_id = p_user_id
    AND r.generated_reply IS NOT DISTINCT FROM p_expected_reply
    AND r.generated_kind IS NOT DISTINCT FROM p_expected_kind;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text) TO service_role;

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
      AND unanswered_escalation_claimed_at IS NULL
    FOR UPDATE
  ) AS previous
  WHERE t.id = previous.id
  RETURNING previous.unanswered_escalation_since INTO v_since;
  RETURN v_since;
END;
$$;

REVOKE ALL ON FUNCTION public.take_unanswered_escalation(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.take_unanswered_escalation(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.replace_agent_reply_and_complete_claim(
  p_user_id uuid,
  p_id uuid,
  p_from text,
  p_to text,
  p_generated_reply text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_tool_calls jsonb DEFAULT NULL,
  p_generated_kind text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_conversation_id text DEFAULT NULL,
  p_claim_token timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Replacement and fresh persistence spend the same claim under the same lock.
  RETURN public.persist_human_mode_ack_and_complete_claim(
    p_id, p_from, p_to, p_generated_reply, p_error, p_tool_calls, p_generated_kind,
    p_user_id, p_platform, p_conversation_id, p_claim_token);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_agent_reply_and_complete_claim(uuid, uuid, text, text, text, text, jsonb, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.replace_agent_reply_and_complete_claim(uuid, uuid, text, text, text, text, jsonb, text, text, text, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
