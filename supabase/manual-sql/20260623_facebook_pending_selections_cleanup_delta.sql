-- Purpose: cleanup/maintenance follow-up for oauth_pending_facebook_selections.
-- Type: data (DELETE) + optional pg_cron schedule. Safe to re-run.
-- Depends on: 20260623_facebook_pending_selections.sql (already applied).
-- Rollback: SELECT cron.unschedule('oauth_pending_fb_sweep'); -- only if scheduled.
--
-- Reviewed by: Postora owner before execution.
-- This script is NOT executed automatically.

-- 1. One-shot sweep of any already-expired rows.
DELETE FROM public.oauth_pending_facebook_selections
WHERE expires_at < now();

-- 2. (Optional) Schedule a recurring sweep every 15 minutes via pg_cron.
--    Uncomment after confirming pg_cron is enabled in this project.
-- SELECT cron.schedule(
--   'oauth_pending_fb_sweep',
--   '*/15 * * * *',
--   $$DELETE FROM public.oauth_pending_facebook_selections WHERE expires_at < now()$$
-- );
