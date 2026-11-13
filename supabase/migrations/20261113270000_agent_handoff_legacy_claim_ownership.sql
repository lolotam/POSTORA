-- Gives the legacy handoff functions the ownership guards the leased ones have.
--
-- The gap this closes, found in review of PR #408:
--
--   The handoff RPCs come in two shapes. The LEASED ones (20261113210000,
--   20261113220000, 20261113240000) name the claim they act on by a token, and the token
--   is the claim this caller holds. The LEGACY ones -- claim_human_mode_ack,
--   release_human_mode_ack and take_unanswered_escalation (20261112170000, made
--   lease-shaped by 20261113220000) -- have no token at all. They act on "the claim of
--   this conversation", whoever holds it.
--
--   That is harmless while only one build is running, and it is not harmless during the
--   rolling deployment, where an old worker and a new one can be inside the same window
--   at the same time:
--
--   1. The legacy RELEASE clears whatever claim the row carries. An old worker whose
--      lease lapsed can therefore erase the claim its SUCCESSOR holds: the successor is
--      about to send the notice, the claim is gone, another turn claims it and sends the
--      notice again -- and the customer is told twice that a human has their
--      conversation. The legacy release also has no delivered-state guard, so it can
--      erase the stamp of a notice that was already delivered.
--
--   2. The legacy escalation taker takes the unanswered-escalation marker with no lease
--      awareness, so it can take a marker the new build has LEASED: the new worker is
--      making the apology for that window, and the legacy taker takes the marker and
--      makes it as well.
--
--   3. The legacy claim ignores the delivered marker, so a notice the database KNOWS
--      was delivered can be handed out again.
--
-- The guards, and what the database can and cannot tell apart:
--
--   * The legacy release clears the claim only when the claim on the row is the ORIGINAL
--     claim of the window -- the one the legacy path took -- and never a delivered one.
--     The two are told apart by the stamps: a claim the legacy path takes writes ONE
--     stamp into customer_ack_sent_at and customer_ack_claimed_at, so the two are equal,
--     while a claim taken over later carries a newer stamp in customer_ack_claimed_at
--     and leaves customer_ack_sent_at alone. A claim that predates the lease (no
--     customer_ack_claimed_at at all) is the legacy path's too. A claim whose stamps
--     differ is a successor's lease, and it is left alone. The legacy path's own claim
--     taken before this migration carries two different stamps and is therefore also
--     left alone: it is not lost, the leased path takes it over once its lease lapses.
--
--   * The legacy claim refuses a row whose acknowledgement was DELIVERED. The database
--     can read that: customer_ack_delivered_at is written by complete_human_mode_ack and
--     by persist_human_mode_ack_and_complete_claim, so a notice that became durable is
--     never handed out again.
--
--   * The legacy escalation taker refuses a marker that is LEASED, whether the lease is
--     live or has lapsed: the leased path takes a lapsed lease over with a token of its
--     own, and a tokenless take would break the completion that consumes the marker.
--
-- What the database genuinely cannot tell apart, stated plainly rather than papered
-- over: a claim taken by the build that predates the lease. That build stamped only
-- customer_ack_sent_at (20261113210000, "A claim made by the build that predates the
-- lease (customer_ack_claimed_at IS NULL) is left alone: it cannot be told apart from a
-- notice that was already delivered by that build") and it had no way to record a
-- delivery (20261113220000, "The takeover can repeat a notice that the old build
-- delivered: the old build has no way to record the delivery, so there is nothing to
-- read"). For such a row customer_ack_delivered_at is NULL whether the notice reached
-- the customer or not, so the takeover in claim_human_mode_ack_leased may repeat ONE
-- notice for it, bounded by the lease. Refusing that takeover instead would strand the
-- notice of a claim that never became durable -- a notice nobody would ever send -- so
-- the trade-off stays, and it is the same one the migration that introduced it already
-- documents.
--
-- Rollout: this migration lands with the other handoff migrations and BEFORE the edge
-- deployment. It only redefines functions, so the edge code that is live now keeps
-- working while it runs.

-- The pre-lease claim, made lease-shaped, and refusing a delivered notice.
--
-- The result is what the old edge code reads: 'claimed' (send the notice), 'window'
-- (a bounded window already notified) or 'none' (no bounded window).
--
-- The delivered marker is read here: a notice the database knows was delivered is never
-- handed out again, not even by the build that predates the lease.
--
-- ONE stamp goes into both columns on purpose. A claim this function takes is the
-- ORIGINAL claim of the window, and the release below tells the two apart by the stamps:
-- the legacy path's claim carries the same value in both, a claim taken over later
-- carries a newer value in customer_ack_claimed_at.
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

-- Puts the acknowledgement claim back, so a notice that never became durable is still
-- owed.
--
-- Only the claim the legacy path owns is released:
--
--   * a claim whose stamps differ (customer_ack_claimed_at is not the stamp of
--     customer_ack_sent_at) was taken over by a later worker. That worker owns it now,
--     and erasing its claim would let a third turn claim the notice while the successor
--     is still sending it -- two notices for one window.
--
--   * a claim with no lease stamp at all (customer_ack_claimed_at IS NULL) predates the
--     lease and is the legacy path's own.
--
--   * a delivered notice is never released. The notice reached the customer, and putting
--     the claim back would let a later turn send it again.
--
-- A claim the legacy path took after this migration carries ONE stamp in both columns,
-- so it is released: the old worker owns it, and the notice is still owed.
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

-- Takes the unanswered-escalation marker, and clears it in one statement, so only one
-- reply apologises.
--
-- A marker that is LEASED is not this function's to take: the new build leased it and is
-- making the apology for that window, and taking it here would make the apology twice.
-- The leased path takes a lapsed lease over with a token of its own, so a marker whose
-- lease lapsed is still owed and still reachable -- only the tokenless take is refused.
--
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
      AND unanswered_escalation_claimed_at IS NULL
    FOR UPDATE
  ) AS previous
  WHERE t.id = previous.id
  RETURNING previous.unanswered_escalation_since INTO v_since;
  RETURN v_since;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_human_mode_ack(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.take_unanswered_escalation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_human_mode_ack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.take_unanswered_escalation(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
