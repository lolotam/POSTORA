-- Openinary dual-cloud provider state for media files.

ALTER TABLE public.media_files
  ADD COLUMN IF NOT EXISTS current_object_version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.media_file_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_file_id  uuid NOT NULL REFERENCES public.media_files(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('cloudinary', 'openinary')),
  object_version integer NOT NULL DEFAULT 1,
  object_key     text NOT NULL,
  delivery_url   text,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'ready', 'failed', 'deleted')),
  bytes          bigint,
  mime_type      text,
  error          text,
  deleted_at     timestamptz,
  deleted_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_file_id, provider, object_version)
);

CREATE INDEX IF NOT EXISTS media_file_providers_media_file_id_object_version_idx
  ON public.media_file_providers (media_file_id, object_version);

ALTER TABLE public.media_file_providers ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS media_file_providers_updated_at ON public.media_file_providers;
CREATE TRIGGER media_file_providers_updated_at BEFORE UPDATE ON public.media_file_providers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP POLICY IF EXISTS "Users can view own media file providers"
  ON public.media_file_providers;

CREATE POLICY "Users can view own media file providers"
  ON public.media_file_providers FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.media_files
      WHERE media_files.id = media_file_providers.media_file_id
        AND auth.uid() = media_files.user_id
    )
  );

CREATE POLICY "Admins can view all media file providers"
  ON public.media_file_providers FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- "both" must stay double-quoted: BOTH is a reserved word in Postgres (TRIM(BOTH ...)),
-- and an unquoted column of that name is a syntax error that fails the whole migration.
-- Quoting keeps the identifier lowercase, so PostgREST still exposes it as `both`.
CREATE OR REPLACE FUNCTION public.get_cdn_provider_counts()
RETURNS TABLE(cloudinary_only bigint, "both" bigint, openinary_only bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH versions AS (
    SELECT media_file_id, object_version,
      bool_or(provider = 'cloudinary') AS has_cloudinary,
      bool_or(provider = 'openinary') AS has_openinary
    FROM public.media_file_providers
    WHERE status = 'ready'
    GROUP BY media_file_id, object_version
  )
  SELECT count(*) FILTER (WHERE has_cloudinary AND NOT has_openinary),
         count(*) FILTER (WHERE has_cloudinary AND has_openinary),
         count(*) FILTER (WHERE has_openinary AND NOT has_cloudinary)
  FROM versions
  WHERE public.has_role(auth.uid(), 'admin');
$$;
GRANT EXECUTE ON FUNCTION public.get_cdn_provider_counts() TO authenticated;

INSERT INTO public.media_file_providers (
  media_file_id,
  provider,
  object_version,
  status,
  object_key,
  delivery_url
)
SELECT
  id,
  'cloudinary',
  1,
  'ready',
  cloudinary_public_id,
  file_path
FROM public.media_files
WHERE cloudinary_public_id IS NOT NULL
  AND (
    storage_bucket = 'cloudinary'
    OR file_path LIKE '%res.cloudinary.com%'
  )
ON CONFLICT DO NOTHING;

INSERT INTO public.app_settings (key, value, description)
VALUES (
  'cdn_storage',
  '{
    "write_policy": { "providers": ["cloudinary"], "required": ["cloudinary"] },
    "read_preference": "cloudinary",
    "cloudinary": { "enabled": true, "cloudName": "dur1soa8n" },
    "openinary": {
      "enabled": false,
      "serverUrl": "https://openinary.walidmohamed.com",
      "folderPrefix": "postora.cloud"
    }
  }'::jsonb,
  'Dual-cloud CDN storage configuration'
)
ON CONFLICT (key) DO NOTHING;
