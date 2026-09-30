-- supabase/tests/media_upload_quota.sql
-- Daily media upload quota (migration 20261002130000). One transaction,
-- synthetic fixtures, labelled ASSERTs, expected refusals in nested
-- BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Assumes the migration
-- is already applied. No secrets and no real accounts.
BEGIN;

DO $$
DECLARE
  u_limited uuid := 'a810a810-a810-48a8-88a8-a810a810a810';
  u_open uuid := 'b810b810-b810-48b8-88b8-b810b810b810';
  u_admin uuid := 'c810c810-c810-48c8-88c8-c810c810c810';
  u_old uuid := 'd810d810-d810-48d8-88d8-d810d810d810';
  v_count integer;
  v_remaining integer;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_limited, 'media-quota-limited-' || u_limited::text || '@example.invalid'),
    (u_open, 'media-quota-open-' || u_open::text || '@example.invalid'),
    (u_admin, 'media-quota-admin-' || u_admin::text || '@example.invalid'),
    (u_old, 'media-quota-old-' || u_old::text || '@example.invalid');

  -- Signup triggers insert a quotas row with NULL limits. The override is
  -- applied after that, because the trigger's own upsert does nothing on conflict.
  UPDATE public.user_quotas SET max_media_uploads_per_day = 2 WHERE user_id = u_limited;
  UPDATE public.user_quotas SET max_media_uploads_per_day = -1 WHERE user_id = u_open;
  UPDATE public.user_quotas SET max_media_uploads_per_day = 0 WHERE user_id = u_admin;
  UPDATE public.user_quotas SET max_media_uploads_per_day = 1 WHERE user_id = u_old;
  INSERT INTO public.user_roles (user_id, role) VALUES (u_admin, 'admin');

  ASSERT (SELECT e.max_media_uploads_per_day FROM public.effective_user_quotas(u_limited) e) = 2,
    'Q0 override of 2 wins over the plan';
  ASSERT (SELECT e.max_media_uploads_per_day FROM public.effective_user_quotas(u_open) e) = -1,
    'Q0 override of -1 wins over the plan';

  INSERT INTO public.media_files (user_id, file_path, file_type)
  VALUES (u_limited, 'quota/one.jpg', 'image');
  INSERT INTO public.media_files (user_id, file_path, file_type)
  VALUES (u_limited, 'quota/two.jpg', 'image');
  ASSERT (SELECT count(*) FROM public.media_files WHERE user_id = u_limited) = 2,
    'Q1 a limit of 2 allows 2 inserts';
  ASSERT (SELECT media_uploads_today FROM public.user_quotas WHERE user_id = u_limited) = 2,
    'Q1 counter matches the inserts';

  BEGIN
    INSERT INTO public.media_files (user_id, file_path, file_type)
    VALUES (u_limited, 'quota/three.jpg', 'image');
    RAISE EXCEPTION 'Q2 failed: third insert was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN check_violation THEN
      ASSERT SQLERRM LIKE 'MEDIA_QUOTA_DAILY_EXCEEDED:%',
        'Q2 refusal prefix, got: ' || SQLERRM;
      ASSERT SQLSTATE = '23514', 'Q2 SQLSTATE is check_violation';
  END;
  ASSERT (SELECT count(*) FROM public.media_files WHERE user_id = u_limited) = 2,
    'Q2 the refused insert left no row';

  FOR v_count IN 1..3 LOOP
    INSERT INTO public.media_files (user_id, file_path, file_type)
    VALUES (u_open, 'quota/open-' || v_count::text || '.jpg', 'image');
  END LOOP;
  ASSERT (SELECT count(*) FROM public.media_files WHERE user_id = u_open) = 3,
    'Q3 -1 allows inserts past any small number';
  ASSERT public.media_upload_quota_remaining(u_open) IS NULL,
    'Q3 remaining is NULL when the limit is -1';

  INSERT INTO public.media_files (user_id, file_path, file_type)
  VALUES (u_admin, 'quota/admin.jpg', 'image');
  ASSERT (SELECT count(*) FROM public.media_files WHERE user_id = u_admin) = 1,
    'Q4 admin inserts even when the override is 0';
  ASSERT (SELECT media_uploads_today FROM public.user_quotas WHERE user_id = u_admin) = 0,
    'Q4 admin bypass does not advance the counter';
  ASSERT public.media_upload_quota_remaining(u_admin) IS NULL,
    'Q4 remaining is NULL for an admin';

  UPDATE public.media_files SET file_path = 'quota/two-renamed.jpg'
  WHERE user_id = u_limited AND file_path = 'quota/two.jpg';
  ASSERT (SELECT count(*) FROM public.media_files WHERE user_id = u_limited) = 2,
    'Q5 an update does not add a row';
  ASSERT public.media_upload_quota_remaining(u_limited) = 0,
    'Q5 remaining stays 0 after an update at the limit';

  -- Q5b: deleting today's file does not free a slot (upload-then-delete bypass).
  DELETE FROM public.media_files WHERE user_id = u_limited AND file_path = 'quota/one.jpg';
  ASSERT public.media_upload_quota_remaining(u_limited) = 0,
    'Q5b remaining stays 0 after deleting a file';
  BEGIN
    INSERT INTO public.media_files (user_id, file_path, file_type)
    VALUES (u_limited, 'quota/after-delete.jpg', 'image');
    RAISE EXCEPTION 'Q5b failed: upload after delete was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Q6: a counter whose reset date has passed starts a fresh day.
  UPDATE public.user_quotas
  SET media_uploads_today = 5, media_daily_reset_date = now() - interval '1 hour'
  WHERE user_id = u_old;
  v_remaining := public.media_upload_quota_remaining(u_old);
  ASSERT v_remaining = 1, 'Q6 a rolled-over counter does not consume today''s slot';
  INSERT INTO public.media_files (user_id, file_path, file_type)
  VALUES (u_old, 'quota/today.jpg', 'image');
  ASSERT (SELECT media_uploads_today FROM public.user_quotas WHERE user_id = u_old) = 1,
    'Q6 the counter restarts at 1';
  ASSERT public.media_upload_quota_remaining(u_old) = 0,
    'Q6 the today insert consumes the one remaining slot';

  ASSERT public.media_upload_quota_remaining(u_limited) = 0,
    'Q7 remaining is 0 at the limit';
  ASSERT public.media_upload_quota_remaining(NULL) = 0,
    'Q7 a null user reads as none remaining';
END $$;

DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.enforce_media_quota_on_insert()', 'EXECUTE'),
    'Q8 anon cannot EXECUTE the trigger function';
  ASSERT NOT has_function_privilege('authenticated', 'public.enforce_media_quota_on_insert()', 'EXECUTE'),
    'Q8 authenticated cannot EXECUTE the trigger function';
  ASSERT NOT has_function_privilege('anon', 'public.media_upload_quota_remaining(uuid)', 'EXECUTE'),
    'Q8 anon cannot EXECUTE the reader';
  ASSERT NOT has_function_privilege('authenticated', 'public.media_upload_quota_remaining(uuid)', 'EXECUTE'),
    'Q8 authenticated cannot EXECUTE the reader';
  ASSERT has_function_privilege('service_role', 'public.media_upload_quota_remaining(uuid)', 'EXECUTE'),
    'Q8 service_role can EXECUTE the reader';
END $$;

SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.media_upload_quota_remaining('a810a810-a810-48a8-88a8-a810a810a810');
  RAISE EXCEPTION 'Q9 failed: anon executed the reader' USING ERRCODE = 'assert_failure';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.media_upload_quota_remaining('a810a810-a810-48a8-88a8-a810a810a810');
  RAISE EXCEPTION 'Q9 failed: authenticated executed the reader' USING ERRCODE = 'assert_failure';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;

-- Q11: the legacy increment_media_uploads() is a read-only preflight now.
DO $$
DECLARE
  u_limited uuid := 'a810a810-a810-48a8-88a8-a810a810a810';
  v_before integer;
BEGIN
  SELECT media_uploads_today INTO v_before FROM public.user_quotas WHERE user_id = u_limited;
  ASSERT public.increment_media_uploads(u_limited) = false,
    'Q11 at the limit the preflight answers false';
  ASSERT (SELECT media_uploads_today FROM public.user_quotas WHERE user_id = u_limited) = v_before,
    'Q11 the preflight does not charge the counter';
  ASSERT NOT has_function_privilege('anon', 'public.increment_media_uploads(uuid)', 'EXECUTE'),
    'Q11 anon cannot EXECUTE increment_media_uploads';
END $$;

ROLLBACK;

\echo '=== media_upload_quota: ALL CHECKS PASSED ==='
