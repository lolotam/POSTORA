-- Enforce free/paid post quotas at the database layer on every posts INSERT.
-- Root cause: UI canCreatePost was never wired; n8n/API (source=api) had no quota check.
-- Free defaults: 2 posts/day, 30 posts/month (matches product intent + column defaults).

-- Keep free-tier daily default at 2 (some code paths previously used 1).
ALTER TABLE public.user_quotas
  ALTER COLUMN max_posts_per_day SET DEFAULT 2;

-- ---------------------------------------------------------------------------
-- can_create_post: non-mutating check (for UI preflight / API preflight)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_create_post(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_daily_reset timestamptz;
  v_monthly_reset timestamptz;
  v_posts_today integer;
  v_posts_month integer;
  v_day_start timestamptz;
  v_month_start timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Admins bypass limits
  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  v_day_start := date_trunc('day', now());
  v_month_start := date_trunc('month', now());

  SELECT
    COALESCE(max_posts_per_day, 2),
    COALESCE(max_posts_per_month, 30),
    daily_reset_date,
    quota_reset_date
  INTO v_max_day, v_max_month, v_daily_reset, v_monthly_reset
  FROM public.user_quotas
  WHERE user_id = p_user_id;

  -- Missing quota row → free-tier defaults apply (do not allow unlimited)
  IF NOT FOUND THEN
    v_max_day := 2;
    v_max_month := 30;
  END IF;

  -- Real usage is source of truth (counters can drift)
  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = p_user_id
    AND created_at >= v_day_start;

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = p_user_id
    AND created_at >= v_month_start;

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RETURN false;
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.can_create_post(uuid) IS
  'Returns true if user is under daily/monthly post limits. Admins always true. Free defaults 2/day, 30/month.';

-- ---------------------------------------------------------------------------
-- BEFORE INSERT trigger: hard block + keep counters in sync
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_post_quota_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_posts_today integer;
  v_posts_month integer;
  v_day_start timestamptz := date_trunc('day', now());
  v_month_start timestamptz := date_trunc('month', now());
  v_next_day timestamptz := date_trunc('day', now()) + interval '1 day';
  v_next_month timestamptz := date_trunc('month', now()) + interval '1 month';
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'POST_QUOTA_DENIED: user_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Admins bypass
  IF public.has_role(NEW.user_id, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  -- Ensure a quota row exists (free defaults) and lock it to serialize concurrent inserts
  INSERT INTO public.user_quotas (
    user_id,
    max_profiles,
    max_social_accounts,
    max_posts_per_month,
    max_posts_per_day,
    posts_this_month,
    posts_today,
    quota_reset_date,
    daily_reset_date,
    max_media_uploads_per_day
  ) VALUES (
    NEW.user_id,
    2,
    3,
    30,
    2,
    0,
    0,
    v_next_month,
    v_next_day,
    20
  )
  ON CONFLICT (user_id) DO NOTHING;

  SELECT
    COALESCE(max_posts_per_day, 2),
    COALESCE(max_posts_per_month, 30)
  INTO v_max_day, v_max_month
  FROM public.user_quotas
  WHERE user_id = NEW.user_id
  FOR UPDATE;

  -- Count existing posts (this INSERT is not visible yet)
  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = NEW.user_id
    AND created_at >= v_day_start;

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = NEW.user_id
    AND created_at >= v_month_start;

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RAISE EXCEPTION 'POST_QUOTA_DAILY_EXCEEDED: Daily post limit of % reached. Upgrade your plan or try again tomorrow.', v_max_day
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RAISE EXCEPTION 'POST_QUOTA_MONTHLY_EXCEEDED: Monthly post limit of % reached. Upgrade your plan or wait until next month.', v_max_month
      USING ERRCODE = 'check_violation';
  END IF;

  -- Sync counters to real usage + this new post
  UPDATE public.user_quotas
  SET
    posts_today = v_posts_today + 1,
    posts_this_month = v_posts_month + 1,
    daily_reset_date = v_next_day,
    quota_reset_date = v_next_month,
    updated_at = now()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_post_quota_on_insert ON public.posts;
CREATE TRIGGER trg_enforce_post_quota_on_insert
  BEFORE INSERT ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_post_quota_on_insert();

GRANT EXECUTE ON FUNCTION public.can_create_post(uuid) TO authenticated, service_role, anon;
