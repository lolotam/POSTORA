-- Consolidates the 6 separate api_logs queries fired by useAIRateLimit
-- into a single aggregating RPC, eliminating the N+1 API call pattern.
--
-- Returns counts of api_logs rows per AI endpoint for the last hour and
-- last day for the calling user.  The client previously issued one query
-- per (endpoint × window) combination; this function replaces all six.
--
-- Security: the function ignores the caller-supplied p_user_id and uses
-- auth.uid() directly, so a user can never read another user's counts.

CREATE OR REPLACE FUNCTION public.get_ai_rate_limit_counts(p_user_id uuid DEFAULT NULL)
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
SECURITY DEFINER
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

GRANT EXECUTE ON FUNCTION public.get_ai_rate_limit_counts(uuid) TO authenticated;
