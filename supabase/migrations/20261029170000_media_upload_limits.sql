-- Admin-selected upload limits for the browser-direct path (Admin → Settings →
-- Media upload limits). Values are megabytes from fixed option lists; anything
-- else is ignored by parseUploadLimits and the default applies.
INSERT INTO public.app_settings (key, value, description)
VALUES (
  'media_upload_limits',
  '{"image_max_mb": 20, "video_max_mb": 500}',
  'Largest image (10/20/50/100 MB) and video (100/200/500/1000/2000 MB) a user may upload'
)
ON CONFLICT (key) DO NOTHING;

-- Every signed-in browser needs the limits to show them and to pick the upload
-- path, so the key joins the authenticated read allow-list. The list below is
-- 20260709090000_app_theme_whatsapp_green.sql verbatim plus media_upload_limits;
-- writes stay admin-only.
DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.app_settings;

CREATE POLICY "Authenticated can read public settings"
ON public.app_settings
FOR SELECT
TO authenticated
USING (
  key = ANY (
    ARRAY[
      'app_name'::text,
      'app_logo'::text,
      'app_favicon'::text,
      'default_plan'::text,
      'feature_flag_categories'::text,
      'META_WHATSAPP_CONFIG_ID'::text,
      'META_WHATSAPP_COEXISTENCE_CONFIG_ID'::text,
      'WHATSAPP_TP_STATUS'::text,
      'app_theme'::text,
      'dark_theme_variant'::text,
      'media_upload_limits'::text
    ]
  )
  OR key LIKE 'feature\_%' ESCAPE '\'
);
