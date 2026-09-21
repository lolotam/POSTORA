-- get_cdn_provider_counts answered non-admins with zeros instead of refusing.
--
-- The function is SECURITY DEFINER, so it reads media_file_providers with RLS
-- bypassed, and its only guard was a row filter on the aggregate:
--
--     SELECT count(*) FILTER (...), ... FROM versions
--     WHERE public.has_role(auth.uid(), 'admin');
--
-- For a non-admin that predicate is false for every row, but an aggregate over
-- no rows still returns one row — of zeros. So the call succeeded and reported
-- `cloudinary_only = 0`, which is not a refusal but a specific, false claim:
-- that nothing is stored only on Cloudinary.
--
-- That claim is what the admin screen's retirement gate reads. On zero it
-- treats the counts as loaded and lets the Cloudinary write provider be turned
-- off. EXECUTE was additionally held by PUBLIC and anon, so the caller did not
-- even need to be signed in.
--
-- Verified before this change: as the admin the function returns 61/1282/186;
-- as a signed-in non-admin it returned one row of 0/0/0 rather than an error.
--
-- The fix is to deny rather than to zero, and to stop offering the function to
-- anonymous callers. `authenticated` keeps EXECUTE because the admin screen
-- calls it as a signed-in admin; the check inside now does the deciding.

CREATE OR REPLACE FUNCTION public.get_cdn_provider_counts()
RETURNS TABLE(cloudinary_only bigint, "both" bigint, openinary_only bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'get_cdn_provider_counts is restricted to admins'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH versions AS (
    SELECT
      mfp.media_file_id,
      mfp.object_version,
      bool_or(mfp.provider = 'cloudinary') AS has_cloudinary,
      bool_or(mfp.provider = 'openinary') AS has_openinary
    FROM public.media_file_providers mfp
    WHERE mfp.status = 'ready'
    GROUP BY mfp.media_file_id, mfp.object_version
  )
  SELECT
    count(*) FILTER (WHERE v.has_cloudinary AND NOT v.has_openinary),
    count(*) FILTER (WHERE v.has_cloudinary AND v.has_openinary),
    count(*) FILTER (WHERE v.has_openinary AND NOT v.has_cloudinary)
  FROM versions v;
END;
$function$;

-- REVOKE FROM PUBLIC alone leaves the role grants in place, so name them.
REVOKE EXECUTE ON FUNCTION public.get_cdn_provider_counts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cdn_provider_counts() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_cdn_provider_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cdn_provider_counts() TO service_role;
