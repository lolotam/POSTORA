-- Purpose: Update the default Apify actor for Threads scraping to the correct actor slug.
-- Type: data update (app_settings)
-- Safe to re-run: yes (idempotent UPDATE)
-- Rollback: UPDATE app_settings SET value = '"igview-owner/threads-post-scraper"' WHERE key = 'apify_actor_threads';

UPDATE public.app_settings
SET value = '"igview-owner/threads-scraper-pro"'::jsonb,
    updated_at = now()
WHERE key = 'apify_actor_threads';
