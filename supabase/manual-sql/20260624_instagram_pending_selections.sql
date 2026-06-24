-- Purpose: short-lived stash for Instagram-via-Facebook OAuth backend-callback account selection.
-- Type: schema (table + RLS + grants + index). Safe to re-run.
-- Rollback: DROP TABLE public.oauth_pending_instagram_selections;
--
-- Reviewed by: Postora owner before execution.
-- This script is NOT executed automatically.

CREATE TABLE IF NOT EXISTS public.oauth_pending_instagram_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_profile_id UUID,
  ig_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  long_lived_token TEXT NOT NULL,
  expires_in INTEGER NOT NULL DEFAULT 5184000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes')
);

GRANT SELECT ON public.oauth_pending_instagram_selections TO authenticated;
GRANT ALL ON public.oauth_pending_instagram_selections TO service_role;

ALTER TABLE public.oauth_pending_instagram_selections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own pending ig selection read" ON public.oauth_pending_instagram_selections;
CREATE POLICY "own pending ig selection read"
ON public.oauth_pending_instagram_selections
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_oauth_pending_ig_expires
  ON public.oauth_pending_instagram_selections (expires_at);

DELETE FROM public.oauth_pending_instagram_selections WHERE expires_at < now();
