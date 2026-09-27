-- Store-event worker primitives (Spec B, PR 2, Task 7; spec section 8 items 3-4).
--
-- WHY
-- process-store-events runs every minute from cron and must survive overlapping
-- runs and crashes without double-sending a WhatsApp opener. The fence:
-- claim_store_events stamps a fresh claim_token on every claim, and every
-- later worker update is conditional on (id, claim_token). A row reclaimed
-- while 'sending' is indeterminate (the send may already have left the
-- provider), so the claim refreshes its lease under a new token but keeps
-- 'sending' -- the worker never resends it and instead fails it as
-- indeterminate. The QR daily cap is reserved atomically (reserve_qr_opener)
-- so two workers cannot both take the last slot.
--
-- Tenancy is structural: the Edge Functions run under the service role, which
-- bypasses RLS, so all three functions are SECURITY DEFINER with a controlled
-- search_path and EXECUTE granted to service_role only.
--
-- Idempotent: functions are dropped IF EXISTS before CREATE; the table and
-- its grants use IF NOT EXISTS / REVOKE-then-GRANT; both cron jobs are
-- unscheduled-then-scheduled inside pg_cron guards. The stock_waitlist
-- uniqueness swap in section G is the one exception: it retires the
-- 20260927120000 (connector, phone, product) key in favour of the
-- per-account (social_account_id, connector, phone, product) key.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. system_logs category CHECK backfill: production's live constraint is
--    CHECK (category = ANY (ARRAY['auth','edge','database','token','post',
--    'system','ai','scheduler','webhook','payment','media'])), but no
--    checked-in migration contains that list -- 20260112101005 only allows
--    ('auth','edge','database','token','post','system'), so a database built
--    from migrations rejects category 'ai' and the claim_store_events log
--    insert below would roll back. Normalize any existing category CHECK to
--    exactly production's list (no-op where already applied). Idempotent: the
--    lookup drops whatever category CHECK is present, then re-adds the
--    canonical one, so a second run drops what the first run added and
--    re-adds it identically.
-- ---------------------------------------------------------------------------
DO $do_system_logs_category_check$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.system_logs') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.system_logs'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE public.system_logs DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  ALTER TABLE public.system_logs
    ADD CONSTRAINT system_logs_category_check
    CHECK (category IN ('auth','edge','database','token','post','system','ai','scheduler','webhook','payment','media'));
END $do_system_logs_category_check$;

-- ---------------------------------------------------------------------------
-- A. claim_store_events: fence (a) exhaust, (b) claim due rows, (c) refresh
--    indeterminate sends. p_lease is the claim lease (worker uses 2 minutes).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_store_events(int, interval);

CREATE FUNCTION public.claim_store_events(p_limit int, p_lease interval)
RETURNS SETOF public.store_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- (a) Attempts are exhausted whether the row sits 'pending' after a
  -- transient-read release or holds an expired 'claimed' lease: mark it
  -- failed and log one sanitized row per exhausted event (event_id, flow,
  -- social_account_id only -- never phone or payload).
  WITH exhausted AS (
    UPDATE public.store_events
    SET status = 'failed',
        skip_reason = 'attempts_exhausted',
        processed_at = now()
    WHERE ((status = 'pending' AND due_at <= now())
        OR (status = 'claimed' AND claimed_at < now() - p_lease))
      AND attempts >= 3
    RETURNING id, user_id, flow, social_account_id
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
           'social_account_id', e.social_account_id
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

-- ---------------------------------------------------------------------------
-- B. store_qr_opener_counts: atomic per-account daily QR opener cap
--    (50/day, spec section 8 item 9). Service-role only: no policies, no
--    grants below service_role, like store_events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_qr_opener_counts (
  social_account_id uuid NOT NULL,
  day date NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  CONSTRAINT store_qr_opener_counts_pkey PRIMARY KEY (social_account_id, day)
);

ALTER TABLE public.store_qr_opener_counts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.store_qr_opener_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_qr_opener_counts TO service_role;

-- ---------------------------------------------------------------------------
-- C. reserve_qr_opener: atomically take one of today's p_limit slots.
--    Returns true only when the row was inserted or the counter moved.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reserve_qr_opener(uuid, int);

CREATE FUNCTION public.reserve_qr_opener(p_account uuid, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_ok boolean;
BEGIN
  INSERT INTO public.store_qr_opener_counts AS q (social_account_id, day, sent)
  VALUES (p_account, v_day, 1)
  ON CONFLICT (social_account_id, day)
  DO UPDATE SET sent = q.sent + 1
    WHERE q.sent < p_limit
  RETURNING true INTO v_ok;

  -- A refused reservation (cap reached) updates nothing, so RETURNING yields
  -- no row and v_ok stays NULL: report false rather than a null-looking miss.
  RETURN COALESCE(v_ok, false);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_qr_opener(uuid, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_qr_opener(uuid, int) TO service_role;

-- ---------------------------------------------------------------------------
-- D. release_qr_opener: hand back one of today's slots (send skipped after
--    reserving). The counter never drops below zero.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.release_qr_opener(uuid);

CREATE FUNCTION public.release_qr_opener(p_account uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.store_qr_opener_counts
  SET sent = GREATEST(sent - 1, 0)
  WHERE store_qr_opener_counts.social_account_id = p_account
    AND store_qr_opener_counts.day = (now() AT TIME ZONE 'utc')::date;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.release_qr_opener(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_qr_opener(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- E. Cron: process-store-events every minute. Unschedule-then-schedule shape
--    from 20260926091000_connector_response_cache.sql, additionally gated on
--    public.get_cron_secret() (the command text resolves it at run time).
-- ---------------------------------------------------------------------------
DO $do_cron_process$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND to_regprocedure('public.get_cron_secret()') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'process-store-events';
    PERFORM cron.schedule(
      'process-store-events',
      '* * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/process-store-events', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_cron_process$;

-- ---------------------------------------------------------------------------
-- F. Cron: purge-store-events daily. Retention clears payloads to '{}' after
--    30 days but keeps the rows, so the (binding, flow, external_id) unique
--    key keeps blocking WooCommerce replay deliveries (spec section 8 item 7).
-- ---------------------------------------------------------------------------
DO $do_cron_purge$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-store-events';
    PERFORM cron.schedule(
      'purge-store-events',
      '27 3 * * *',
      $$
      UPDATE public.store_events SET payload = '{}'::jsonb WHERE processed_at < now() - interval '30 days' AND payload <> '{}'::jsonb;
      DELETE FROM public.stock_waitlist WHERE expires_at < now();
      DELETE FROM public.store_qr_opener_counts WHERE day < current_date - 7;
      $$
    );
  END IF;
END $do_cron_purge$;

-- ---------------------------------------------------------------------------
-- G. stock_waitlist uniqueness becomes per-account: the same phone+product
--    under one connector may wait on two different social accounts (two
--    chat identities), while a re-opt-in on the same account stays one row.
--    Retires stock_waitlist_connector_phone_product_key from 20260927120000
--    in favour of stock_waitlist_account_connector_phone_product_key.
--    Idempotent: the old key drops IF EXISTS; the new key is added only
--    when missing (a DROP on re-run would fail once rows depend on it, and
--    an unconditional ADD would fail on re-run).
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_waitlist
  DROP CONSTRAINT IF EXISTS stock_waitlist_connector_phone_product_key;

DO $do_stock_waitlist_account_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_waitlist_account_connector_phone_product_key'
      AND conrelid = 'public.stock_waitlist'::regclass
  ) THEN
    ALTER TABLE public.stock_waitlist
      ADD CONSTRAINT stock_waitlist_account_connector_phone_product_key
      UNIQUE (social_account_id, connector_id, phone, product_id);
  END IF;
END $do_stock_waitlist_account_key$;


COMMIT;

NOTIFY pgrst, 'reload schema';
