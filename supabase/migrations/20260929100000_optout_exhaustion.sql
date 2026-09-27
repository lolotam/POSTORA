-- Optout exhaustion: stranded pending_opener cleanup + 'skipped' recipient status.
--
-- WHY
-- A store event that exhausts its 3 claim attempts can strand the WhatsApp
-- opener thread that waits on it: ai_threads.procedure_state stays
-- {phase pending_opener, run_id <event id>} forever and the conversation
-- never recovers. claim_store_events already marks those events failed and
-- logs a sanitized row; it must also clear the stranded opener so the next
-- inbound message starts fresh. Separately, opt-out suppression writes
-- broadcast recipients with status 'skipped', which the live recipients
-- CHECK (pending/sent/delivered/failed) rejects.
--
-- Tenancy is structural (ARCHITECTURE.md sections 23-24): the Edge
-- Functions run under the service role, which bypasses RLS, so
-- claim_store_events stays SECURITY DEFINER with a controlled search_path
-- and EXECUTE granted to service_role only. The exhaustion log carries
-- event_id, flow, social_account_id and reason only -- never phone or
-- payload.
--
-- Idempotent: the status CHECK is located by definition and dropped before
-- re-adding, and the function uses CREATE OR REPLACE, so applying twice is
-- safe. No BEGIN/COMMIT of its own (the harness wraps the file).

-- ---------------------------------------------------------------------------
-- A. whatsapp_broadcast_recipients gains 'skipped': drop whatever status
--    CHECK is present, then add the canonical one. Re-running drops what the
--    first run added and re-adds it identically.
-- ---------------------------------------------------------------------------
DO $do_recipients_status_check$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.whatsapp_broadcast_recipients') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.whatsapp_broadcast_recipients'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.whatsapp_broadcast_recipients DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  ALTER TABLE public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_status_check
    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'skipped'));
END $do_recipients_status_check$;

-- ---------------------------------------------------------------------------
-- B. claim_store_events: same signature as 20260928120000; step (a)
--    additionally clears the stranded pending_opener thread and logs the
--    exhaustion reason. Steps (b) and (c) unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_store_events(p_limit int, p_lease interval)
RETURNS SETOF public.store_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- (a) Attempts are exhausted whether the row sits 'pending' after a
  -- transient-read release or holds an expired 'claimed' lease: mark it
  -- failed, clear the stranded pending_opener thread waiting on it (same
  -- user, same run_id), and log one sanitized row per exhausted event
  -- (event_id, flow, social_account_id, reason only -- never phone or
  -- payload). The log still selects FROM exhausted, so an event with no
  -- matching thread is still logged.
  WITH exhausted AS (
    UPDATE public.store_events
    SET status = 'failed',
        skip_reason = 'attempts_exhausted',
        processed_at = now()
    WHERE ((status = 'pending' AND due_at <= now())
        OR (status = 'claimed' AND claimed_at < now() - p_lease))
      AND attempts >= 3
    RETURNING id, user_id, flow, social_account_id
  ),
  cleared AS (
    UPDATE public.ai_threads t SET procedure_state = NULL
    FROM exhausted e
    WHERE t.user_id = e.user_id
      AND t.procedure_state->>'phase' = 'pending_opener'
      AND t.procedure_state->>'run_id' = e.id::text
  )
  INSERT INTO public.system_logs
    (source, category, level, message, user_id, metadata)
  SELECT 'process-store-events',
         'ai',
         'warn',
         'Store event failed after 3 attempts',
         e.user_id,
         jsonb_build_object(
           'event_id', e.id,
           'flow', e.flow,
           'social_account_id', e.social_account_id,
           'reason', 'attempts_exhausted'
         )
  FROM exhausted AS e;

  -- (b) Claim due pending rows plus expired leases, oldest first, at most
  -- p_limit. SKIP LOCKED lets overlapping workers split the queue instead
  -- of blocking on each other.
  RETURN QUERY
  UPDATE public.store_events AS e
  SET status = 'claimed',
      claimed_at = now(),
      claim_token = gen_random_uuid(),
      attempts = e.attempts + 1
  WHERE e.id IN (
    SELECT s.id
    FROM public.store_events AS s
    WHERE ((s.status = 'pending' AND s.due_at <= now())
        OR (s.status = 'claimed' AND s.claimed_at < now() - p_lease))
      AND s.attempts < 3
    ORDER BY s.due_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING e.*;

  -- (c) Expired 'sending' rows are indeterminate: refresh the lease under a
  -- new token but keep the status, so the worker treats them as
  -- already-attempted and never resends.
  RETURN QUERY
  UPDATE public.store_events AS e
  SET claimed_at = now(),
      claim_token = gen_random_uuid()
  WHERE e.id IN (
    SELECT s.id
    FROM public.store_events AS s
    WHERE s.status = 'sending'
      AND s.claimed_at < now() - p_lease
    ORDER BY s.due_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING e.*;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_store_events(int, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_store_events(int, interval) TO service_role;
