-- The web app follows a publish through realtime changes on posts and platform_posts
-- (src/hooks/useRealtimePostUpdates.tsx). 20260323130848 added both tables to
-- supabase_realtime, but the self-hosted database never carried that membership over:
-- on 2026-11-06 the publication held neither table, so no publish ever sent an event.
-- Each table is added only when it is missing, so this is safe to run again.
-- Existing SELECT policies keep each change visible to its owner (and admins) only.
DO $$
DECLARE
  tracked text;
BEGIN
  FOREACH tracked IN ARRAY ARRAY['posts', 'platform_posts'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tracked
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tracked);
    END IF;
  END LOOP;
END
$$;
