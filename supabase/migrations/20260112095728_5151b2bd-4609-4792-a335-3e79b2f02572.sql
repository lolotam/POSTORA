-- Update the cron job to run hourly instead of daily
-- This is needed for platforms with short-lived tokens (Twitter 2h, YouTube 1h, Reddit 1h)

-- First, delete the existing daily cron job when present. Fresh local databases
-- may not have this legacy job, and cron.unschedule errors for missing names.
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'refresh-social-tokens-daily';

-- Create a new hourly cron job
SELECT cron.schedule(
  'refresh-social-tokens-hourly',
  '0 * * * *', -- every hour at minute 0
  $$
  SELECT
    net.http_post(
        url:='https://efruibswazzuuupgyzmf.supabase.co/functions/v1/refresh-tokens',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmcnVpYnN3YXp6dXV1cGd5em1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyOTE4NjgsImV4cCI6MjA4Mjg2Nzg2OH0.A591L2M5dMAaVm-W-DZYg5wsvtVp9qkzTrzWsRolRDA"}'::jsonb,
        body:='{"scheduled": true}'::jsonb
    ) as request_id;
  $$
);
