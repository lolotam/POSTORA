-- WhatsApp account continuity, PR-D (spec 2026-10-01 §7 D3): every 15 minutes, email the
-- owner of a WhatsApp account whose store orders are on hold because it is disconnected.
-- Self-hosted shape (api.postora.cloud + get_cron_secret()), idempotent by job name.
DO $do_undelivered_store_alerts_cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
    AND to_regprocedure('public.get_cron_secret()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-undelivered-store-alerts') THEN
      PERFORM cron.schedule(
        'send-undelivered-store-alerts',
        '*/15 * * * *',
        $cron$
        SELECT net.http_post(
          url := 'https://api.postora.cloud/functions/v1/send-undelivered-store-alerts',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || get_cron_secret()
          ),
          body := '{}'::jsonb
        );
        $cron$
      );
    END IF;
  ELSE
    RAISE NOTICE 'send-undelivered-store-alerts cron skipped: pg_cron, pg_net, or get_cron_secret() unavailable';
  END IF;
END $do_undelivered_store_alerts_cron$;
