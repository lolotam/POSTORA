-- supabase/tests/media_upload_limits.sql
-- Admin-selected upload limits (migration 20261029170000). One transaction,
-- synthetic users, labelled ASSERTs, ROLLBACK, sentinel last. Assumes the
-- migration is already applied. No secrets and no real accounts.
BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', 'upload-limits-user@example.invalid'),
    ('e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2', 'upload-limits-admin@example.invalid');
  INSERT INTO public.user_roles (user_id, role)
  VALUES ('e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2', 'admin');
  -- An admin-only key to prove the allow-list did not widen.
  INSERT INTO public.app_settings (key, value)
  VALUES ('cdn_storage', '{"write_policy": {"providers": ["openinary"]}}')
  ON CONFLICT (key) DO NOTHING;

  ASSERT (SELECT value FROM public.app_settings WHERE key = 'media_upload_limits')
         = '{"image_max_mb": 20, "video_max_mb": 500}'::jsonb,
    'L1 the limits row is seeded with 20 MB images and 500 MB video';
END $$;

-- A signed-in user who is not an admin.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', 'role', 'authenticated')::text, true);

DO $$
DECLARE
  v_changed integer;
BEGIN
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'media_upload_limits') = 1,
    'L2 a signed-in user can read the limits';
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'cdn_storage') = 0,
    'L3 the allow-list still hides admin-only keys';

  UPDATE public.app_settings SET value = '{"image_max_mb": 100, "video_max_mb": 2000}'
  WHERE key = 'media_upload_limits';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  ASSERT v_changed = 0, 'L4 a non-admin update changes no row';
END $$;

RESET ROLE;

-- Anonymous callers see nothing.
SET LOCAL ROLE anon;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'media_upload_limits') = 0,
    'L5 anon cannot read the limits';
END $$;
RESET ROLE;

-- An admin can change them.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2', 'role', 'authenticated')::text, true);

DO $$
BEGIN
  UPDATE public.app_settings SET value = '{"image_max_mb": 50, "video_max_mb": 1000}'
  WHERE key = 'media_upload_limits';
  ASSERT (SELECT value FROM public.app_settings WHERE key = 'media_upload_limits')
         = '{"image_max_mb": 50, "video_max_mb": 1000}'::jsonb,
    'L6 an admin can change the limits';
END $$;

RESET ROLE;
ROLLBACK;

\echo '=== media_upload_limits: ALL CHECKS PASSED ==='
