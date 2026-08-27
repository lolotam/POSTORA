-- Retention for media_understanding_sender_usage.
--
-- Its parent table is bounded by (accounts x days) and stays small on its own. This one is
-- keyed (account, SENDER, day), so it grows with every distinct person who has ever sent
-- media -- unbounded, and fastest on exactly the busy accounts the sub-cap exists to
-- protect.
--
-- A separate migration rather than an edit to 20260827120000: that one is already applied
-- to production, and ARCHITECTURE.md 23 forbids changing an applied migration's behaviour.
--
-- 30 days rather than the 7 used for webhook_unmatched_observations. Those rows are a
-- debugging aid; these are the evidence for a throttling decision, and a support question
-- about "why was my customer's document refused last week" needs the row to still exist.
-- Nothing reads a row older than today, so the window is chosen for forensics, not for
-- correctness.
--
-- Same unschedule-then-schedule idempotency shape as
-- 20260825090000_webhook_unmatched_observations.sql. Runs at 03:41 UTC, off the hour and
-- clear of the 03:17 purge already scheduled, so two deletes do not contend.
DO $$
BEGIN
  PERFORM cron.unschedule('purge-media-understanding-sender-usage');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-media-understanding-sender-usage',
  '41 3 * * *',
  $$
  DELETE FROM public.media_understanding_sender_usage
   WHERE usage_date < current_date - 30;
  $$
);
