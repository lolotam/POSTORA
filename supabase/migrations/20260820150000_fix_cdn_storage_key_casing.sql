-- The cdn_storage seed in 20260820140000 wrote its nested provider keys in
-- snake_case, but every consumer of that JSON reads camelCase:
--
--   src/lib/cdn.ts       CdnConfig.cloudinary.cloudName   (was cloud_name)
--   src/lib/openinary.ts OpeninaryConfig.serverUrl        (was server_url)
--                        OpeninaryConfig.folderPrefix     (was folder_prefix)
--
-- The mismatch was silent rather than loud: getCdnImageUrl() falls back to the
-- unmodified source URL when cloudName is undefined, and getOpeninaryUrl()
-- returns the bare object key when serverUrl is undefined. So Cloudinary served
-- untransformed originals and Openinary delivery URLs could not be built at all,
-- with no error surfaced anywhere.
--
-- Only the nested provider objects were wrong. write_policy and read_preference
-- are genuinely snake_case in CdnConfig and are left alone.
--
-- Idempotent: the WHERE clause makes a second run a no-op.
UPDATE public.app_settings
SET value = value
  || jsonb_build_object(
       'cloudinary',
       (COALESCE(value -> 'cloudinary', '{}'::jsonb) - 'cloud_name')
       || CASE WHEN value -> 'cloudinary' ? 'cloud_name'
               THEN jsonb_build_object('cloudName', value -> 'cloudinary' -> 'cloud_name')
               ELSE '{}'::jsonb END)
  || jsonb_build_object(
       'openinary',
       (COALESCE(value -> 'openinary', '{}'::jsonb) - 'server_url' - 'folder_prefix')
       || CASE WHEN value -> 'openinary' ? 'server_url'
               THEN jsonb_build_object('serverUrl', value -> 'openinary' -> 'server_url')
               ELSE '{}'::jsonb END
       || CASE WHEN value -> 'openinary' ? 'folder_prefix'
               THEN jsonb_build_object('folderPrefix', value -> 'openinary' -> 'folder_prefix')
               ELSE '{}'::jsonb END),
    updated_at = now()
WHERE key = 'cdn_storage'
  AND (value -> 'cloudinary' ? 'cloud_name'
       OR value -> 'openinary' ? 'server_url'
       OR value -> 'openinary' ? 'folder_prefix');
