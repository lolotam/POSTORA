-- Threads is the only connected platform whose inbound comments do not reliably arrive by
-- webhook: its Webhooks product exposes only `replies` and `delete`, and `replies` has never
-- delivered for this deployment. threads-poll-replies reads them from the Graph API instead
-- and hands each new one to the same ingest path the webhook uses, so the two can run at once
-- without double-firing a workflow.
--
-- Every two minutes: the job is what decides how fast a Threads comment reaches an n8n
-- workflow or the AI agent, and each run costs one Graph call per recent post that has
-- replies (accounts with comment automation switched off are not polled at all).

DO $$
BEGIN
  PERFORM cron.unschedule('poll-threads-replies');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'poll-threads-replies',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/threads-poll-replies',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $$
);
