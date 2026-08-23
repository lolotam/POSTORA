-- Stop every quota WRITER from writing limits.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R4).
--
-- These three functions held copies 6, 7 and 8 of the plan table. Copy 7
-- (handle_new_user_quota: 1 profile / 4 accounts) and copy 8
-- (set_user_quotas_for_plan: free = 1 post/day) wrote numbers that appear in no
-- TypeScript source, which is why the live data disagreed with the dashboard.
--
-- After this migration a user_quotas row is a COUNTER row: usage + reset dates +
-- an optional deliberate override. Entitlements come from the plan.
--
-- Round-1 amendment A1: every INSERT below names all five limit columns
-- explicitly with NULL. Task 1 (20260823140000) already dropped the column
-- DEFAULTs (2/4/20/2/20), but naming them explicitly documents intent and
-- survives a future default being re-added.

CREATE OR REPLACE FUNCTION public.handle_new_user_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Limits are deliberately NULL: inherit from subscription_plans.
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, quota_reset_date,
    max_profiles, max_social_accounts, max_posts_per_month,
    max_posts_per_day, max_media_uploads_per_day
  )
  VALUES (
    NEW.id, 0, (date_trunc('month', now()) + interval '1 month')::timestamptz,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Signature preserved: handle_subscription_change() calls this with the slug.
-- p_plan_slug is now unused - clearing the override makes the user inherit
-- whichever plan they are on, so the slug is redundant.
CREATE OR REPLACE FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_quotas (
    user_id, updated_at,
    max_posts_per_day, max_posts_per_month, max_profiles,
    max_social_accounts, max_media_uploads_per_day
  )
  VALUES (
    p_user_id, now(),
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day         = NULL,
    max_posts_per_month       = NULL,
    max_profiles              = NULL,
    max_social_accounts       = NULL,
    max_media_uploads_per_day = NULL,
    updated_at                = now();
END;
$$;

COMMENT ON FUNCTION public.set_user_quotas_for_plan(uuid, text) IS
  'Clears per-user overrides so the user inherits their plan. p_plan_slug retained for caller compatibility and intentionally unused.';

-- Round-1 review fix (F4): handle_subscription_change() previously called
-- set_user_quotas_for_plan() unconditionally on every fire. The trigger is
-- "AFTER INSERT OR UPDATE OF plan_id" - Postgres's "UPDATE OF column" fires
-- whenever that column is named in the UPDATE's SET list, not only when its
-- VALUE actually changes. src/pages/admin/AdminUsers.tsx's
-- applySubscriptionPlan() always does `UPDATE ... SET plan_id = <planId>`
-- even when reassigning the SAME plan, so re-picking a subscriber's current
-- plan in the admin UI silently cleared every per-user override - destroying
-- a deliberate admin grant for no reason.
--
-- Fix: only clear on a REAL entitlement change - a first-time INSERT, or an
-- UPDATE whose plan_id actually differs from what it was.
CREATE OR REPLACE FUNCTION public.handle_subscription_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_slug text;
BEGIN
  IF TG_OP = 'INSERT' OR OLD.plan_id IS DISTINCT FROM NEW.plan_id THEN
    SELECT slug INTO v_plan_slug
    FROM subscription_plans
    WHERE id = NEW.plan_id;

    PERFORM set_user_quotas_for_plan(NEW.user_id, v_plan_slug);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_subscription_change() IS
  'Trigger fn: clears per-user quota overrides only on a real plan_id change (INSERT, or UPDATE where the value differs) - not on every UPDATE OF plan_id firing.';

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
  v_next_day timestamptz := date_trunc('day', now()) + interval '1 day';
  v_next_month timestamptz := date_trunc('month', now()) + interval '1 month';
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'POST_QUOTA_DENIED: user_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF public.has_role(NEW.user_id, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  -- The row exists to be locked and to hold counters. Limits stay NULL.
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, posts_today, quota_reset_date, daily_reset_date,
    max_profiles, max_social_accounts, max_posts_per_month,
    max_posts_per_day, max_media_uploads_per_day
  ) VALUES (
    NEW.user_id, 0, 0, v_next_month, v_next_day,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize concurrent inserts for this user.
  PERFORM 1 FROM public.user_quotas WHERE user_id = NEW.user_id FOR UPDATE;

  SELECT e.max_posts_per_day, e.max_posts_per_month
  INTO v_max_day, v_max_month
  FROM public.effective_user_quotas(NEW.user_id) e;

  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = NEW.user_id AND created_at >= date_trunc('day', now());

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = NEW.user_id AND created_at >= date_trunc('month', now());

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RAISE EXCEPTION 'POST_QUOTA_DAILY_EXCEEDED: Daily post limit of % reached. Upgrade your plan or try again tomorrow.', v_max_day
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RAISE EXCEPTION 'POST_QUOTA_MONTHLY_EXCEEDED: Monthly post limit of % reached. Upgrade your plan or wait until next month.', v_max_month
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.user_quotas
  SET posts_today       = v_posts_today + 1,
      posts_this_month  = v_posts_month + 1,
      daily_reset_date  = v_next_day,
      quota_reset_date  = v_next_month,
      updated_at        = now()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;
