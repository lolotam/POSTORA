-- Short-lived cache of read-only connector answers (WooCommerce category ids and product
-- searches). Service role only: keys are hashes and values hold no credentials.
CREATE TABLE IF NOT EXISTS public.connector_response_cache (
  cache_key text PRIMARY KEY,
  tool_id uuid NOT NULL,
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_response_cache_expires_idx ON public.connector_response_cache (expires_at);
ALTER TABLE public.connector_response_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connector_response_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connector_response_cache TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-connector-response-cache';
    PERFORM cron.schedule('purge-connector-response-cache', '17 3 * * *', 'DELETE FROM public.connector_response_cache WHERE expires_at < now()');
  END IF;
END $$;
