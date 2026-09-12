-- Consolidates the 6 separate api_logs queries fired by useAIRateLimit
-- into a single aggregating RPC, eliminating the N+1 API call pattern.
--
-- Returns counts of api_logs rows per AI endpoint for the last hour and
-- last day for the calling user.  The client previously issued one query
-- per (endpoint × window) combination; this function replaces all six.
--
-- Security: authenticated already has SELECT under api_logs own-row RLS.
-- Use caller privileges and auth.uid() as the only subject.

CREATE OR REPLACE FUNCTION public.get_ai_rate_limit_counts()
RETURNS TABLE (
  caption_hour  integer,
  caption_day   integer,
  image_hour    integer,
  image_day     integer,
  hashtag_hour  integer,
  hashtag_day   integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  -- Endpoint values stored by edge functions have no leading slash.
  WITH counts AS (
    SELECT
      endpoint,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')   AS hour_count,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS day_count
    FROM public.api_logs
    WHERE user_id = auth.uid()
      -- Missing identity must yield zero counts, never cross-user totals.
      AND auth.uid() IS NOT NULL
      AND endpoint IN ('generate-caption', 'generate-image', 'generate-hashtags')
    GROUP BY endpoint
  )
  SELECT
    COALESCE((SELECT hour_count FROM counts WHERE endpoint = 'generate-caption'), 0)::integer,
    COALESCE((SELECT day_count  FROM counts WHERE endpoint = 'generate-caption'), 0)::integer,
    COALESCE((SELECT hour_count FROM counts WHERE endpoint = 'generate-image'),   0)::integer,
    COALESCE((SELECT day_count  FROM counts WHERE endpoint = 'generate-image'),   0)::integer,
    COALESCE((SELECT hour_count FROM counts WHERE endpoint = 'generate-hashtags'),0)::integer,
    COALESCE((SELECT day_count  FROM counts WHERE endpoint = 'generate-hashtags'),0)::integer;
$$;

REVOKE ALL ON FUNCTION public.get_ai_rate_limit_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_rate_limit_counts() TO authenticated;
