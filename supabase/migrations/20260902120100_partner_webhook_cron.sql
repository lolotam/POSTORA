-- Partner API v1, Phase 5: scheduling and retention for the delivery worker
-- (deliverable 5.4, "scheduling and runtime ownership").
--
-- Separate from 20260902120000 on purpose: that migration is the schema, and
-- schema and schedule have different blast radii. Unscheduling a job to stop
-- deliveries during an incident must not mean touching the tables that hold
-- the undelivered events.
--
-- Same unschedule-then-schedule shape as 20260828000000, so a re-run replaces
-- the job rather than failing on the duplicate name.

-- ---------------------------------------------------------------------------
-- 1. The tick. EVERY MINUTE, because the retry ladder's finest rung is 1m.
-- ---------------------------------------------------------------------------
--
-- A slower cadence would make that rung a published lie: an event told to
-- retry in 60 seconds would sit until the next tick regardless.
--
-- Its own schedule rather than a piggyback on an existing job -- coupling two
-- jobs means one's slow run silently delays the other's, and this one has a
-- 45s internal budget that assumes it starts when it was asked to.
DO $$
BEGIN
  PERFORM cron.unschedule('process-partner-webhooks');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'process-partner-webhooks',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/process-partner-webhooks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ---------------------------------------------------------------------------
-- 2. Retention, with two windows for two different kinds of row.
-- ---------------------------------------------------------------------------
--
-- A delivered row is transient bookkeeping. An EXHAUSTED one is the evidence
-- behind "you never sent me that event", so it has to outlive the complaint --
-- and both carry partner payloads, which is the other reason neither lives
-- forever.
DO $$
BEGIN
  PERFORM cron.unschedule('purge-partner-webhook-deliveries');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-partner-webhook-deliveries',
  '37 4 * * *',
  $$
  DELETE FROM public.partner_webhook_deliveries
   WHERE status = 'delivered' AND created_at < now() - interval '14 days';
  DELETE FROM public.partner_webhook_deliveries
   WHERE status = 'exhausted' AND created_at < now() - interval '90 days';
  $$
);
