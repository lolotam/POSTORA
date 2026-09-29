-- Daily media-upload limit. Every new media_files row counts. A replace is an
-- UPDATE and a dedupe reuse inserts nothing, so neither passes through here.
-- Direct EXECUTE is revoked. PostgreSQL checks that privilege when the trigger
-- is created, not when it fires, so an authenticated INSERT still runs the body.

CREATE OR REPLACE FUNCTION public.enforce_media_quota_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max integer;
  v_count integer;
  v_next_day timestamptz := date_trunc('day', now()) + interval '1 day';
  v_next_month timestamptz := date_trunc('month', now()) + interval '1 month';
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'MEDIA_QUOTA_DENIED: user_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF public.has_role(NEW.user_id, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  -- The count is by created_at, which browser clients may set on insert: a
  -- backdated row would never count toward today. Pin it for client requests.
  -- current_user is this function's owner here (SECURITY DEFINER), so the
  -- caller is read from the PostgREST JWT role claim instead.
  IF coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb->>'role'
     IN ('authenticated', 'anon') THEN
    NEW.created_at := now();
  END IF;

  -- The row exists to be locked and to hold counters. Limits stay NULL so an
  -- override is not invented here; effective_user_quotas resolves the limit.
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, posts_today, quota_reset_date, daily_reset_date,
    max_profiles, max_social_accounts, max_posts_per_month,
    max_posts_per_day, max_media_uploads_per_day
  ) VALUES (
    NEW.user_id, 0, 0, v_next_month, v_next_day,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1 FROM public.user_quotas WHERE user_id = NEW.user_id FOR UPDATE;

  SELECT e.max_media_uploads_per_day
  INTO v_max
  FROM public.effective_user_quotas(NEW.user_id) e;

  SELECT COUNT(*)::integer INTO v_count
  FROM public.media_files
  WHERE user_id = NEW.user_id
    AND created_at >= date_trunc('day', now());

  IF v_max IS NOT NULL AND v_max IS DISTINCT FROM -1 AND v_count >= v_max THEN
    RAISE EXCEPTION 'MEDIA_QUOTA_DAILY_EXCEEDED: Daily upload limit of % reached. Upgrade your plan or try again tomorrow.', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.user_quotas
  SET media_uploads_today = v_count + 1,
      media_daily_reset_date = v_next_day,
      updated_at = now()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_media_quota_on_insert ON public.media_files;
CREATE TRIGGER trg_enforce_media_quota_on_insert
  BEFORE INSERT ON public.media_files
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_media_quota_on_insert();

-- NULL means unlimited (admin, or a limit of NULL / -1). 0 means none left.
-- Read-only: no lock and no counter write. service_role is the only caller.
CREATE OR REPLACE FUNCTION public.media_upload_quota_remaining(p_user uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max integer;
  v_count integer;
BEGIN
  IF p_user IS NULL THEN
    RETURN 0;
  END IF;

  IF public.has_role(p_user, 'admin'::public.app_role) THEN
    RETURN NULL;
  END IF;

  SELECT e.max_media_uploads_per_day
  INTO v_max
  FROM public.effective_user_quotas(p_user) e;

  IF v_max IS NULL OR v_max = -1 THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::integer INTO v_count
  FROM public.media_files
  WHERE user_id = p_user
    AND created_at >= date_trunc('day', now());

  RETURN GREATEST(0, v_max - v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_media_quota_on_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_upload_quota_remaining(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_upload_quota_remaining(uuid) TO service_role;
