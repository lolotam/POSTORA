-- ============================================================================
-- Manual SQL — Brand Search History
-- ============================================================================
-- Run manually on the self-hosted Postgres (api.postora.cloud).
-- Per project rules, Lovable does NOT apply DB changes automatically.
--
-- Purpose:
--   Persist per-user, per-(platform, scope) search history for the brand search
--   bars used on /analytics/threads (Analyze + Discovery tabs). Lets users
--   re-pick previous queries from a dropdown.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.brand_search_history CASCADE;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.brand_search_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform      text NOT NULL,                -- 'threads' | 'instagram' | 'facebook' | 'tiktok' | ...
  scope         text NOT NULL,                -- 'analyze' | 'discovery' | 'keyword_search' | ...
  query         text NOT NULL,
  use_count     integer NOT NULL DEFAULT 1,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brand_search_history_uniq
  ON public.brand_search_history (user_id, platform, scope, lower(query));

CREATE INDEX IF NOT EXISTS brand_search_history_user_scope_recent
  ON public.brand_search_history (user_id, platform, scope, last_used_at DESC);

-- Data API grants (required on self-hosted Supabase / PostgREST)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_search_history TO authenticated;
GRANT ALL ON public.brand_search_history TO service_role;

ALTER TABLE public.brand_search_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bsh_select_own" ON public.brand_search_history;
CREATE POLICY "bsh_select_own"
  ON public.brand_search_history FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "bsh_insert_own" ON public.brand_search_history;
CREATE POLICY "bsh_insert_own"
  ON public.brand_search_history FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "bsh_update_own" ON public.brand_search_history;
CREATE POLICY "bsh_update_own"
  ON public.brand_search_history FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "bsh_delete_own" ON public.brand_search_history;
CREATE POLICY "bsh_delete_own"
  ON public.brand_search_history FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
