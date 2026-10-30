-- Every 30 minutes: delete AI image staging copies whose follow-up token has expired.
-- upscale-image and remove-background stage uploads in Openinary under
-- postora/<user>/ai-tmp/; a browser that never comes back leaves the copy behind.
-- The sweep-ai-image-staging function removes copies older than the token's hour
-- plus a 30-minute margin. No table: the state lives in Openinary.
DO $do_sweep_ai_image_staging$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'sweep-ai-image-staging cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-ai-image-staging') THEN
    PERFORM cron.schedule(
      'sweep-ai-image-staging',
      '17,47 * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/sweep-ai-image-staging', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_sweep_ai_image_staging$;
