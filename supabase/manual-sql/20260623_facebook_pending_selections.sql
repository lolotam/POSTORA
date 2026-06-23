-- Purpose: short-lived stash for Facebook OAuth backend-callback page selection.
-- Type: schema (table + RLS + grants + index). Safe to re-run.
-- Rollback: DROP TABLE public.oauth_pending_facebook_selections;
--
-- Reviewed by: Postora owner before execution.
-- This script is NOT executed automatically.

CREATE TABLE IF NOT EXISTS public.oauth_pending_facebook_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_profile_id UUID,
  target_platform TEXT NOT NULL CHECK (target_platform IN ('facebook', 'instagram')),
  provider_token TEXT NOT NULL,
  pages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ig_standalone_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes')
);

GRANT SELECT ON public.oauth_pending_facebook_selections TO authenticated;
GRANT ALL ON public.oauth_pending_facebook_selections TO service_role;

ALTER TABLE public.oauth_pending_facebook_selections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own pending fb selection read" ON public.oauth_pending_facebook_selections;
CREATE POLICY "own pending fb selection read"
ON public.oauth_pending_facebook_selections
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_oauth_pending_fb_expires
  ON public.oauth_pending_facebook_selections (expires_at);

-- One-shot sweep of any already-expired rows. Safe to re-run.
-- Recommended follow-up: schedule via pg_cron, e.g.
--   SELECT cron.schedule(
--     'oauth_pending_fb_sweep',
--     '*/15 * * * *',
--     $$DELETE FROM public.oauth_pending_facebook_selections WHERE expires_at < now()$$
--   );
DELETE FROM public.oauth_pending_facebook_selections WHERE expires_at < now();
