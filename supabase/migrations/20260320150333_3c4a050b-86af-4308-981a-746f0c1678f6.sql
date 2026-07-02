-- Performance indexes for scaling to 100K+ users
-- These indexes convert full table scans into instant B-tree lookups

CREATE INDEX IF NOT EXISTS idx_posts_user_created ON public.posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user_status ON public.posts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_logs_user_endpoint ON public.api_logs(user_id, endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_accounts_user_platform ON public.social_accounts(user_id, platform);

DO $$
BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON public.support_tickets(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
  END IF;
END $$;
