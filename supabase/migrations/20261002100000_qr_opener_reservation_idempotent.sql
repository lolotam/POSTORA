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
-- A. One reservation row per store event. Service-role only, same shape as
--    store_qr_opener_counts: RLS on, no policies (default deny), grants only
--    to service_role. The PK is the event, so a previous day and today share
--    one row; day says which UTC day the slot belongs to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_qr_opener_reservations (
  store_event_id uuid PRIMARY KEY
    REFERENCES public.store_events (id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_qr_opener_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.store_qr_opener_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_qr_opener_reservations TO service_role;

-- ---------------------------------------------------------------------------
-- B. reserve_qr_opener(account, limit, event)
--
-- Same-event serialization is the reservation primary key, not the counter
-- row. The counter upsert locks one (account, day) row and therefore
-- serializes different events on that account, but two first-time calls for
-- one event both observe "no reservation" and would both increment before
-- either insert conflicts. Inserting the reservation first makes the loser
-- wait on store_event_id until this transaction commits: it then sees day =
-- today and returns without touching the counter. A refused cap deletes the
-- claim before the function returns, still inside the same transaction.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reserve_qr_opener(uuid, int, uuid);

CREATE FUNCTION public.reserve_qr_opener(p_account uuid, p_limit int, p_event uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_claimed uuid;
  v_ok boolean;
BEGIN
  INSERT INTO public.store_qr_opener_reservations AS r
    (store_event_id, social_account_id, day)
  VALUES (p_event, p_account, v_day)
  ON CONFLICT (store_event_id) DO UPDATE
    SET social_account_id = EXCLUDED.social_account_id,
        day = EXCLUDED.day
    WHERE r.day IS DISTINCT FROM EXCLUDED.day
  RETURNING r.store_event_id INTO v_claimed;

  -- Conflict target already stored today: the UPDATE WHERE skipped, RETURNING
  -- is empty, and this event already holds today's slot.
  IF v_claimed IS NULL THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.store_qr_opener_reservations
      WHERE store_event_id = p_event
        AND day = v_day
    );
  END IF;

  INSERT INTO public.store_qr_opener_counts AS q (social_account_id, day, sent)
  VALUES (p_account, v_day, 1)
  ON CONFLICT (social_account_id, day)
  DO UPDATE SET sent = q.sent + 1
    WHERE q.sent < p_limit
  RETURNING true INTO v_ok;

  IF COALESCE(v_ok, false) THEN
    RETURN true;
  END IF;

  -- Cap refused. Drop the claim so a retry can try again and a concurrent
  -- caller is not told this event already holds today's slot.
  DELETE FROM public.store_qr_opener_reservations
  WHERE store_event_id = p_event
    AND day = v_day;

  RETURN false;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_qr_opener(uuid, int, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_qr_opener(uuid, int, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- C. release_qr_opener(account, event): delete that event's reservation and
--    decrement the counter for the deleted row's day only. A missing row
--    (never reserved, or already released) leaves the counter alone. The
--    counter never drops below zero.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.release_qr_opener(uuid, uuid);

CREATE FUNCTION public.release_qr_opener(p_account uuid, p_event uuid)
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

REVOKE EXECUTE ON FUNCTION public.release_qr_opener(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_qr_opener(uuid, uuid) TO service_role;

-- The account-only overloads stay for now: the deployed worker calls them
-- until this branch's code ships (migration is applied first). A follow-up
-- migration drops reserve_qr_opener(uuid,int) and release_qr_opener(uuid)
-- once the new worker is live.

COMMIT;

NOTIFY pgrst, 'reload schema';
