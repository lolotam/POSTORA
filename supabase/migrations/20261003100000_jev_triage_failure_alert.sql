-- Jev triage failure alert, and the schedule observability-alerts lost in the self-host move.
--
-- On 2026-09-28 Jev triage failed on 8 of 23 WhatsApp replies and nothing noticed: the replies
-- still went out, just without the triage plan. The new jev_triage_failure trigger type in
-- observability-alerts measures that share; this adds its rule.
--
-- No cron job invoked observability-alerts on this stack (the 2026-01-29 schedule pointed at
-- the Supabase Cloud URL), so none of the existing rules had run since 2026-08-24. The job
-- below revives them too; each keeps its own threshold, cooldown and email toggle.
--
-- Idempotent: the rule is inserted only if absent, the job only if no job has its name.

INSERT INTO public.observability_alert_configs
  (name, description, trigger_type, threshold_value, threshold_operator, time_window_minutes,
   notification_channels, notification_emails, cooldown_minutes, is_active)
SELECT
  'Jev Triage Failures',
  'More than 10% of AI agent replies in the last 24 hours ran without a Jev triage result (403, timeout or no key). Needs 10+ triaged replies.',
  'jev_triage_failure', 10, 'gt', 1440,
  ARRAY['email'], ARRAY['dr.vet.waleedtam@gmail.com'], 1440, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.observability_alert_configs WHERE trigger_type = 'jev_triage_failure'
);

DO $do_observability_alerts_cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
    AND to_regprocedure('public.get_cron_secret()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'observability-alerts') THEN
      -- One minute after observability-collector (*/5), so rules read a fresh snapshot.
      PERFORM cron.schedule(
        'observability-alerts',
        '1-59/5 * * * *',
        $cron$
        SELECT net.http_post(
          url := 'https://api.postora.cloud/functions/v1/observability-alerts',
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
    RAISE NOTICE 'observability-alerts cron skipped: pg_cron, pg_net, or get_cron_secret() unavailable';
  END IF;
END $do_observability_alerts_cron$;
