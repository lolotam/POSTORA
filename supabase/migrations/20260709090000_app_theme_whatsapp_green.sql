-- Global app theme setting (admin-controlled): 'default' | 'whatsapp-green'
INSERT INTO public.app_settings (key, value, description)
VALUES ('app_theme', '"default"', 'Admin-selected global app theme (default | whatsapp-green)')
ON CONFLICT (key) DO NOTHING;

-- Recreate the authenticated read policy adding app_theme AND dark_theme_variant.
-- dark_theme_variant was missing from the whitelist, so non-admin users never
-- received the admin-selected dark variant; app_theme needs the same read access.
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
      'dark_theme_variant'::text
    ]
  )
  OR key LIKE 'feature\_%' ESCAPE '\'
);
