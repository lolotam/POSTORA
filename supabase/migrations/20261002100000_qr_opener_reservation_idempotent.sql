-- QR opener reservations are idempotent per store event (issue #213).
--
-- WHY
-- reserve_qr_opener(uuid, int) only bumped today's counter. A worker that
-- crashed after reserving and before status = 'sending' was re-claimed and
-- reserved again, so each crash burned one of the 50 daily slots.
-- release_qr_opener(uuid) had no event to tie the hand-back to.
--
-- The reservation row and the counter move in one function call, so they
-- commit or roll back together. A row whose day is already today means this
-- event holds a slot: return true and leave the counter alone. A row from a
-- previous UTC day does not count; the retry takes a new slot and the old
-- row is advanced. There is no store-events purge function — retention is the
-- inline cron command in 20260928120000_store_events_worker.sql — so stale
-- reservation rows are left in place. They do not affect today's cap.
--
-- The worker is the only caller. The event-scoped functions are new
-- overloads; the 2-arg ones stay until the new worker is deployed (see the
-- end of this file).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, REVOKE-then-GRANT, DROP FUNCTION
-- IF EXISTS before CREATE. Run as supabase_admin.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. One reservation row per store event, owned by the claim attempt that
--    holds it (claim_token). Service-role only: RLS on, no policies, grants
--    only to service_role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_qr_opener_reservations (
  store_event_id uuid PRIMARY KEY
    REFERENCES public.store_events (id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  day date NOT NULL,
  claim_token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_qr_opener_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.store_qr_opener_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_qr_opener_reservations TO service_role;

-- ---------------------------------------------------------------------------
-- B. reserve_qr_opener(account, limit, event, claim)
--
-- The event must belong to the account and p_claim must be the event's live
-- claim_token: these run as service_role, so neither is trusted from the
-- caller. A stale attempt is refused instead of taking the reservation back.
--
-- Same-event serialization is the reservation primary key. INSERT ... ON
-- CONFLICT DO NOTHING waits for a concurrent first reservation of this event
-- to commit; the loser then locks the committed row. A row for today means
-- the slot is already held: the newer claim takes ownership (claim_token) and
-- the counter is untouched. A row from an earlier UTC day takes a new slot.
-- A refused cap removes the row before returning.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reserve_qr_opener(uuid, int, uuid);
DROP FUNCTION IF EXISTS public.reserve_qr_opener(uuid, int, uuid, uuid);

CREATE FUNCTION public.reserve_qr_opener(p_account uuid, p_limit int, p_event uuid, p_claim uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_inserted uuid;
  v_held_day date;
  v_ok boolean;
  v_event_account uuid;
  v_live_claim uuid;
BEGIN
  SELECT e.social_account_id, e.claim_token
  INTO v_event_account, v_live_claim
  FROM public.store_events AS e
  WHERE e.id = p_event
  FOR SHARE;
  IF v_event_account IS DISTINCT FROM p_account THEN
    RAISE EXCEPTION 'reserve_qr_opener: event % does not belong to account', p_event
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only the event's current claim may take or re-own a reservation. The row
  -- lock holds off a reclaim until this function returns.
  IF p_claim IS NULL OR v_live_claim IS DISTINCT FROM p_claim THEN
    RAISE EXCEPTION 'reserve_qr_opener: claim is not current for event %', p_event
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.store_qr_opener_reservations
    (store_event_id, social_account_id, day, claim_token)
  VALUES (p_event, p_account, v_day, p_claim)
  ON CONFLICT (store_event_id) DO NOTHING
  RETURNING store_event_id INTO v_inserted;

  IF v_inserted IS NULL THEN
    SELECT day INTO v_held_day
    FROM public.store_qr_opener_reservations
    WHERE store_event_id = p_event
    FOR UPDATE;
    IF v_held_day = v_day THEN
      UPDATE public.store_qr_opener_reservations
      SET claim_token = p_claim
      WHERE store_event_id = p_event;
      RETURN true;
    END IF;
  END IF;

  INSERT INTO public.store_qr_opener_counts AS q (social_account_id, day, sent)
  VALUES (p_account, v_day, 1)
  ON CONFLICT (social_account_id, day)
  DO UPDATE SET sent = q.sent + 1
    WHERE q.sent < p_limit
  RETURNING true INTO v_ok;

  IF COALESCE(v_ok, false) THEN
    UPDATE public.store_qr_opener_reservations
    SET day = v_day, claim_token = p_claim
    WHERE store_event_id = p_event;
    RETURN true;
  END IF;

  DELETE FROM public.store_qr_opener_reservations
  WHERE store_event_id = p_event;
  RETURN false;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_qr_opener(uuid, int, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_qr_opener(uuid, int, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- C. release_qr_opener(account, event, claim): only the claim attempt that
--    currently owns the reservation can release it. A stale attempt (its
--    event was reclaimed and re-reserved under a newer token) releases
--    nothing, so it cannot hand back a slot the newer attempt is using. The
--    counter is decremented for the deleted row's day, never below zero.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.release_qr_opener(uuid, uuid);
DROP FUNCTION IF EXISTS public.release_qr_opener(uuid, uuid, uuid);

CREATE FUNCTION public.release_qr_opener(p_account uuid, p_event uuid, p_claim uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_day date;
BEGIN
  DELETE FROM public.store_qr_opener_reservations
  WHERE store_event_id = p_event
    AND social_account_id = p_account
    AND claim_token = p_claim
  RETURNING day INTO v_day;

  IF v_day IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.store_qr_opener_counts
  SET sent = GREATEST(sent - 1, 0)
  WHERE social_account_id = p_account
    AND day = v_day;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.release_qr_opener(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_qr_opener(uuid, uuid, uuid) TO service_role;

-- The account-only overloads stay for now: the deployed worker calls them
-- until this branch's code ships (migration is applied first). A follow-up
-- migration drops reserve_qr_opener(uuid,int) and release_qr_opener(uuid)
-- once the new worker is live.

COMMIT;

NOTIFY pgrst, 'reload schema';
