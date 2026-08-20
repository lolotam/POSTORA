-- Selection helpers for the openinary-backfill edge function.
--
-- Dual-writing only covers new uploads, so everything stored before Openinary
-- joined write_policy.providers lives on Cloudinary alone. These functions pick
-- out that backlog. The predicate is a NOT EXISTS correlated on
-- (media_file_id, object_version), which PostgREST cannot express directly.
--
-- Both are SECURITY DEFINER and granted to service_role only: the backfill runs
-- from an edge function that has already checked the caller is an admin, and
-- there is no reason to expose the backlog to the browser.

-- p_retry_failed = false skips any media that already has an openinary row,
-- including a failed one, so repeated calls drain the queue and terminate.
-- p_retry_failed = true re-includes failed rows for a deliberate retry pass;
-- without that split a permanently broken object would be handed back forever
-- and the driving loop would never finish.
CREATE OR REPLACE FUNCTION public.get_openinary_backfill_batch(
  p_limit integer,
  p_retry_failed boolean DEFAULT false
)
RETURNS TABLE(media_file_id uuid, object_version integer, object_key text, delivery_url text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.media_file_id, c.object_version, c.object_key, c.delivery_url
  FROM public.media_file_providers c
  WHERE c.provider = 'cloudinary'
    AND c.status = 'ready'
    AND NOT EXISTS (
      SELECT 1
      FROM public.media_file_providers o
      WHERE o.media_file_id = c.media_file_id
        AND o.object_version = c.object_version
        AND o.provider = 'openinary'
        AND (NOT p_retry_failed OR o.status = 'ready')
    )
  ORDER BY c.created_at
  LIMIT GREATEST(p_limit, 0);
$$;

-- Mirrors the cloudinary_only figure the admin retirement gate shows, but
-- callable by the service role (get_cdn_provider_counts is gated on
-- has_role(auth.uid(), ...) and returns zeros when there is no JWT).
CREATE OR REPLACE FUNCTION public.count_openinary_backfill_remaining()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)
  FROM public.media_file_providers c
  WHERE c.provider = 'cloudinary'
    AND c.status = 'ready'
    AND NOT EXISTS (
      SELECT 1
      FROM public.media_file_providers o
      WHERE o.media_file_id = c.media_file_id
        AND o.object_version = c.object_version
        AND o.provider = 'openinary'
        AND o.status = 'ready'
    );
$$;

REVOKE ALL ON FUNCTION public.get_openinary_backfill_batch(integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.count_openinary_backfill_remaining() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_openinary_backfill_batch(integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_openinary_backfill_remaining() TO service_role;
