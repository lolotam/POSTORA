-- Every 10 minutes: remove WhatsApp Direct QR attempts that never paired.
-- create_and_get_qr stores an inactive social_accounts row on a pending_<uuid> placeholder
-- plus an Evolution instance before the phone scans. The popup removes its own attempt when
-- the owner closes it; this sweep removes what a closed tab or a failed request left behind,
-- 30 minutes after the attempt started. Paired accounts (real number) are never touched.
-- No table: the state is social_accounts and whatsapp_evolution_instances.
DO $do_sweep_pending_whatsapp_qr$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'sweep-pending-whatsapp-qr cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-pending-whatsapp-qr') THEN
    PERFORM cron.schedule(
      'sweep-pending-whatsapp-qr',
      '3,13,23,33,43,53 * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/sweep-pending-whatsapp-qr', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_sweep_pending_whatsapp_qr$;
