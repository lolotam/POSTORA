-- Persist the OAuth redirect_uri on per-user Higgsfield connections so BYO
-- refresh can look up the matching oauth_clients row.
ALTER TABLE public.higgsfield_connections
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
