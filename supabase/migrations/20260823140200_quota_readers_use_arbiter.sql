-- Route every quota READER through the arbiter.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R4).
--
-- Behaviour preserved exactly: admin bypass, -1 = unlimited, real-usage COUNT(*)
-- recount (counters drift), and the POST_QUOTA_* error codes the frontend
-- matches on. The ONLY change is where the two numbers come from.
--
-- CREATE OR REPLACE preserves each function's existing GRANTs (same OID),
-- so can_create_post keeps the authenticated/service_role/anon grant issued
-- in 20260804120000_enforce_post_quotas.sql, and can_upload_media /
-- increment_media_uploads keep whatever privileges they already had from
-- 20260112200222_e726343f-46a4-449c-abac-98aa3e05979e.sql (both are called
-- directly by the client via supabase.rpc() in src/hooks/useQuotas.tsx).
-- No grant changes are needed here.

CREATE OR REPLACE FUNCTION public.can_create_post(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_posts_today integer;
  v_posts_month integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  SELECT e.max_posts_per_day, e.max_posts_per_month
  INTO v_max_day, v_max_month
  FROM public.effective_user_quotas(p_user_id) e;

  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = p_user_id AND created_at >= date_trunc('day', now());

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = p_user_id AND created_at >= date_trunc('month', now());

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
  'True if under daily/monthly post limits from effective_user_quotas(). Admins always true.';

CREATE OR REPLACE FUNCTION public.can_upload_media(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_uploads integer;
  v_max_uploads integer;
  v_reset_date timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  SELECT e.max_media_uploads_per_day INTO v_max_uploads
  FROM public.effective_user_quotas(p_user_id) e;

  IF v_max_uploads = -1 THEN
    RETURN true;
  END IF;

  SELECT uq.media_uploads_today, uq.media_daily_reset_date
  INTO v_current_uploads, v_reset_date
  FROM public.user_quotas uq
  WHERE uq.user_id = p_user_id;

  -- No counter row yet, or the daily window has rolled over: nothing consumed.
  IF NOT FOUND OR v_reset_date IS NULL OR v_reset_date <= now() THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_current_uploads, 0) < v_max_uploads;
END;
$$;

COMMENT ON FUNCTION public.can_upload_media(uuid) IS
  'True if under the daily media upload limit from effective_user_quotas(). Admins always true.';

-- ---------------------------------------------------------------------------
-- Round-1 amendment A2: increment_media_uploads() joins this task.
--
-- It is not counter-only - it selects max_media_uploads_per_day and enforces
-- it. Reading the override straight off user_quotas (as it did before) means
-- a NULL override made both "v_max_uploads = -1" and
-- "v_current_uploads >= v_max_uploads" evaluate to NULL, so the function fell
-- through to the increment branch every time: an unlimited upload bypass.
-- Its missing-row branch also hardcoded max_media_uploads_per_day = 20,
-- re-creating the very override this migration set (20260823140000) removes
-- the column DEFAULT for.
--
-- Fix: resolve the limit via effective_user_quotas(), and insert a missing
-- row with a NULL limit (inherit), not a hardcoded 20. Reset-window and
-- increment behaviour are otherwise unchanged.
--
-- Round-1 review fix (F1): this had a TOCTOU race. It used to read
-- media_uploads_today with no lock, check the limit, then increment -
-- two concurrent requests at 19 of 20 could both pass the check and both
-- increment, yielding two uploads out of one remaining slot. Two concurrent
-- FIRST uploads had the same problem one level up: both could enter the
-- missing-row branch, and the second INSERT would fail on the
-- user_quotas.user_id unique key (which src/hooks/useQuotas.tsx used to
-- treat as "RPC errored -> allow the upload" - see that file's incrementMediaUpload).
--
-- Fix: INSERT ... ON CONFLICT (user_id) DO NOTHING first (absorbs the
-- concurrent-first-upload race with no exception), then SELECT ... FOR
-- UPDATE to serialize concurrent callers for this user before the
-- limit/increment decision - exactly the pattern enforce_post_quota_on_insert
-- already uses in 20260823140300_quota_writers_clear_overrides.sql. The
-- initial row is created with media_uploads_today = 0 (not 1), so a brand
-- new user's first call goes through the same reset/limit/increment checks
-- as every subsequent call, instead of unconditionally returning true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_media_uploads(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_uploads integer;
  v_reset_date timestamptz;
  v_max_uploads integer;
  v_is_admin boolean;
  v_next_reset timestamptz := (CURRENT_DATE + interval '1 day')::timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Fix round 1: admin bypass parity with can_upload_media/can_create_post
  -- (CLAUDE.md: "Admins bypass all subscription limits"). Only the "at the
  -- limit" block below is skipped for admins - they still fall through to
  -- the same counter update, so counting is never bypassed, only blocking.
  v_is_admin := public.has_role(p_user_id, 'admin'::public.app_role);

  SELECT e.max_media_uploads_per_day INTO v_max_uploads
  FROM public.effective_user_quotas(p_user_id) e;

  -- The row exists to be locked and to hold counters. Limit stays NULL so
  -- it keeps inheriting from the plan through effective_user_quotas().
  INSERT INTO public.user_quotas (
    user_id, media_uploads_today, max_media_uploads_per_day, media_daily_reset_date
  ) VALUES (
    p_user_id, 0, NULL, v_next_reset
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize concurrent callers for this user.
  PERFORM 1 FROM public.user_quotas WHERE user_id = p_user_id FOR UPDATE;

  SELECT uq.media_uploads_today, uq.media_daily_reset_date
  INTO v_current_uploads, v_reset_date
  FROM public.user_quotas uq
  WHERE uq.user_id = p_user_id;

  -- Reset if past the reset window: nothing consumed yet this window.
  IF v_reset_date IS NULL OR v_reset_date <= now() THEN
    UPDATE public.user_quotas
    SET media_uploads_today = 1,
        media_daily_reset_date = v_next_reset
    WHERE user_id = p_user_id;
    RETURN true;
  END IF;

  -- Unlimited plan/override.
  IF v_max_uploads = -1 THEN
    UPDATE public.user_quotas
    SET media_uploads_today = COALESCE(v_current_uploads, 0) + 1
    WHERE user_id = p_user_id;
    RETURN true;
  END IF;

  -- At the limit: block, do not increment. Admins bypass the block but
  -- still get counted by the increment below.
  IF NOT v_is_admin AND COALESCE(v_current_uploads, 0) >= v_max_uploads THEN
    RETURN false;
  END IF;

  UPDATE public.user_quotas
  SET media_uploads_today = COALESCE(v_current_uploads, 0) + 1
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.increment_media_uploads(uuid) IS
  'Increments and enforces the daily media upload counter against effective_user_quotas(). Returns false without incrementing once the limit is reached; -1 = unlimited.';
