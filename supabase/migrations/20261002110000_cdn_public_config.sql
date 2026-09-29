-- Non-secret CDN delivery settings for every signed-in user.
--
-- WHY
-- app_settings.cdn_storage is readable only by admins under RLS. The frontend's
-- useCdnConfig read it with the user's session, so for every non-admin the
-- Openinary origin was unknown: Library and picker thumbnails could not be
-- recognised as Openinary URLs and loaded full-size originals instead of
-- renditions.
--
-- This returns a whitelisted subset (no keys, no secrets; those live in the
-- edge-function env) in the same shape as the stored value, so the hook can
-- validate it the same way. Admins keep reading the full row directly, which
-- the CDN settings editor needs to save it back without dropping keys.
--
-- Idempotent. Run as supabase_admin.

CREATE OR REPLACE FUNCTION public.get_cdn_public_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'read_preference', v->'read_preference',
    'write_policy', jsonb_build_object(
      'providers', v->'write_policy'->'providers',
      'required', v->'write_policy'->'required'
    ),
    'openinary', jsonb_build_object(
      'enabled', v->'openinary'->'enabled',
      'serverUrl', v->'openinary'->'serverUrl',
      'folderPrefix', v->'openinary'->'folderPrefix'
    ),
    'cloudinary', jsonb_build_object(
      'enabled', v->'cloudinary'->'enabled',
      'cloudName', v->'cloudinary'->'cloudName'
    )
  ))
  FROM (
    SELECT CASE jsonb_typeof(value::jsonb)
             WHEN 'string' THEN (value::jsonb #>> '{}')::jsonb
             ELSE value::jsonb
           END AS v
    FROM public.app_settings
    WHERE key = 'cdn_storage'
  ) AS s;
$function$;

REVOKE ALL ON FUNCTION public.get_cdn_public_config() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cdn_public_config() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
