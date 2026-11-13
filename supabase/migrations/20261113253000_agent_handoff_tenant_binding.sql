-- Binds every reply transition to the tenant that owns the row.
--
-- Finding from the review of PR #408: the SECURITY DEFINER statements that move a row of
-- public.pending_agent_replies matched the row by its id and its from-state ONLY. The
-- service role bypasses RLS, so a caller that mixed up a row id -- or accepted one that
-- belongs to another tenant -- moved ANOTHER tenant's reply: it wrote the text, took the
-- delivery claim and consumed the escalation window it named. The persistence variant
-- already received p_user_id, but applied it to the THREAD it resolves and not to the ROW
-- it writes.
--
-- The rule now: a transition names the tenant it acts for, and the row it moves has to
-- belong to that tenant. A row of another tenant is refused exactly like a row that is
-- not in the from-state: nothing is written, and the claim the caller holds is not spent.
--
-- What lands here:
--
--   advance_agent_reply_for_owner(...)              the plain transition, tenant-bound
--   advance_agent_reply_kind_for_owner(...)         the kind-aware transition, tenant-bound
--   claim_agent_reply_for_delivery_for_owner(...)   the delivery claim, tenant-bound
--   persist_agent_reply_and_complete_escalation(...)  same signature, the ROW is bound
--   persist_human_mode_ack_and_complete_claim(...)   same signature, the ROW is bound
--
-- The two arities that name no tenant -- advance_agent_reply_kind and
-- claim_agent_reply_for_delivery, as the older proofs call them -- are kept, and are bound
-- to the tenant that owns the row's social account. That is the tenant enqueue_agent_reply
-- derives the row's user_id from, so a row that disagrees with its account is a row of
-- another tenant and is refused. No edge build calls them: the build that lands after this
-- migration calls the *_for_owner functions.
--
-- advance_agent_reply is NOT touched: the edge build that is live today calls it, and a
-- second arity of that name would make that call ambiguous. A later migration retires it
-- once the build that replaced it is running.
--
-- Rollout:
--   1. apply this migration. Safe while the live build keeps running: that build calls
--      only advance_agent_reply, and this migration does not touch it.
--   2. deploy the edge build that calls the tenant-bound functions. It must not be
--      deployed before this migration: the functions it calls live here.
--   3. later, once nothing calls them: retire advance_agent_reply and the two arities
--      that name no tenant.

-- -----------------------------------------------------------------------------
-- The plain transition, for the tenant that owns the row.
-- -----------------------------------------------------------------------------

-- Moves the row from one state to the next, and only for the tenant that owns it.
--
-- The tenant is not decoration: it is the row's own user_id. A row of another tenant is
-- refused the way a row that is not in the from-state is refused -- nothing is written --
-- and the caller that gets false MUST NOT go on to send anything.
--
-- The live build calls advance_agent_reply, which cannot grow a tenant argument without
-- making that call ambiguous. This is the plain transition the next build uses, and the
-- tenant comes first because it is required: a caller that names no tenant gets no
-- statement at all.
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

-- -----------------------------------------------------------------------------
-- The kind-aware transition, for the tenant that owns the row.
-- -----------------------------------------------------------------------------

-- The same transition, and it also records WHAT the text is: null for an answer the model
-- produced, 'human_mode_ack' for the one-time notice a human takeover owes the customer.
-- The kind is part of the payload the delivery claim compares against, so it is written by
-- the same statement that writes the text.
--
-- The row is bound to the tenant that owns it, exactly as the plain transition is.
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

-- -----------------------------------------------------------------------------
-- The delivery claim, for the tenant that owns the row.
-- -----------------------------------------------------------------------------

-- Moves a row into `sending` only when it still holds the payload the caller read AND
-- belongs to the tenant the caller names.
--
-- The row's text is read without a lock, so a closed gate can replace it between the read
-- and the claim. The claim carries the text and the kind the caller read, and the row is
-- only moved while it holds exactly that payload. The tenant is checked the same way: a
-- row of another tenant is refused, and the refusal is fail-closed -- nothing is sent.
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

-- -----------------------------------------------------------------------------
-- The two arities that name no tenant, bound to the owner of the row's account.
-- -----------------------------------------------------------------------------

-- The tenant a row is attributed to is derived, never taken from the caller:
-- enqueue_agent_reply copies it from social_accounts, so the account and the row agree.
-- These two arities name no tenant, so they bind the row to the owner of the account the
-- row was enqueued for -- a row attributed to anyone else is a row of another tenant, and
-- it is refused.
--
-- No edge build calls them. They exist for the proofs that predate the tenant argument,
-- and they can be retired with them.
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

-- -----------------------------------------------------------------------------
-- The two statements that write a reply and spend a claim: the ROW is bound now.
-- -----------------------------------------------------------------------------

-- Writes the reply and consumes the escalation window it resolves, in ONE statement.
--
-- The reply carries the apology, so the reply and the window it resolves are one fact.
--
-- The lease is checked BEFORE the reply is stored. A worker whose lease lapsed and was
-- taken over must not store another apology against a newer claim: it writes nothing at
-- all, and the window it would have resolved stays owed.
--
-- The row is moved only when it really was in the from-state, when it belongs to the
-- tenant this call names, and the marker is cleared only when it is the one this turn
-- leased. A row of another tenant is refused the way a row that is not in the from-state
-- is refused: the apology stays owed, because it was never carried by a durable reply.
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
    -- The row was not this caller's to move -- it is not in the from-state, or it belongs
    -- to another tenant -- so the window it would have resolved is NOT consumed: the
    -- apology stays owed.
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

-- Writes the one-time human-mode notice and completes the claim it spends.
--
-- The notice and the claim are one fact: the customer is told a human has the
-- conversation, and no later turn may tell them again. Written as two statements, a
-- completion that failed left the notice delivered with the claim still owed, and the
-- next turn that met the same window sent the notice a second time.
--
-- The claim is matched by its token, so only the claim this caller holds can be spent,
-- and a worker that was overtaken writes nothing at all.
--
-- The row is bound to the tenant that owns it, the same tenant the claim is looked up
-- under: a row of another tenant is refused, and the notice stays owed.
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

  UPDATE public.ai_conversation_modes
  SET customer_ack_delivered_at = clock_timestamp()
  WHERE id = v_mode_id
    AND customer_ack_delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_agent_reply_and_complete_escalation(uuid, text, text, text, text, jsonb, text, uuid, uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_human_mode_ack_and_complete_claim(uuid, text, text, text, text, jsonb, text, uuid, text, text, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
