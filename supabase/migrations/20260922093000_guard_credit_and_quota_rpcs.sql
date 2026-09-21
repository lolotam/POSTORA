-- Stops an authenticated caller naming a user other than themselves.
--
-- 20260922090000 took EXECUTE away from anon, which closed the unauthenticated
-- hole. It did not change what a signed-in caller may do, and these
-- functions take the user they act on as a parameter rather than deriving it
-- from auth.uid(). So any signed-in account could still spend another user's
-- credits, grant itself credits, redeem a coupon against someone else, or
-- rewrite another user's quotas — just by passing a different uuid.
--
-- WHO MAY CALL WHAT, AFTER THIS
--
--   use_credits               the owner, or an admin
--   add_user_credits          an admin only (granting credit is not self-service)
--   set_user_quotas_for_plan  an admin only
--
-- `redeem_coupon` is left for a follow-up. At 54 lines it carries coupon
-- validity, usage-limit and subscription-linking logic that has to be preserved
-- exactly, and CREATE OR REPLACE means retyping the whole body to add one
-- guard. It is no longer reachable anonymously after 20260922090000, so the
-- remaining exposure is an authenticated caller redeeming against another
-- user's id — worth fixing, not worth rushing into this change.
--
-- THE SERVICE-ROLE CASE
--
-- Edge functions call these with the service key, where `auth.uid()` is NULL.
-- That is treated as authorised. Reading a NULL uid as "trusted server" is only
-- safe because the previous migration removed anon's EXECUTE: an anonymous
-- caller also has a NULL uid, so without that revoke this check would be no
-- check at all. The two migrations are a pair, and this one asserts the first
-- has run rather than trusting the ordering.
--
-- Bodies are otherwise untouched: same balance arithmetic, same return values,
-- same transaction records. Only the entry condition is new.

DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.add_user_credits(uuid, integer, text, text, text)', 'EXECUTE'),
    'anon still holds EXECUTE on add_user_credits; apply 20260922090000 first, or the auth.uid() IS NULL branch below is open to anonymous callers';
END $$;

-- use_credits: the owner, an admin, or the service role.
CREATE OR REPLACE FUNCTION public.use_credits(
  p_user_id uuid,
  p_amount integer,
  p_description text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_current_balance INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL
     AND auth.uid() <> p_user_id
     AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'use_credits may only spend the calling user''s credits'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT balance INTO v_current_balance
  FROM user_credits
  WHERE user_id = p_user_id;

  IF v_current_balance IS NULL OR v_current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE user_credits
  SET balance = balance - p_amount,
      total_used = total_used + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (p_user_id, -p_amount, 'usage', p_description);

  RETURN TRUE;
END;
$function$;

-- add_user_credits: admins and the service role. Granting credit is not
-- something an account may do for itself, so there is no owner branch here.
CREATE OR REPLACE FUNCTION public.add_user_credits(
  p_user_id uuid,
  p_amount integer,
  p_transaction_type text DEFAULT 'purchase'::text,
  p_description text DEFAULT NULL::text,
  p_stripe_session_id text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'add_user_credits is restricted to admins'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO user_credits (user_id, balance, total_purchased)
  VALUES (p_user_id, p_amount, CASE WHEN p_transaction_type = 'purchase' THEN p_amount ELSE 0 END)
  ON CONFLICT (user_id) DO UPDATE SET
    balance = user_credits.balance + p_amount,
    total_purchased = CASE
      WHEN p_transaction_type = 'purchase'
      THEN user_credits.total_purchased + p_amount
      ELSE user_credits.total_purchased
    END,
    updated_at = now()
  RETURNING balance INTO v_new_balance;

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description, stripe_session_id)
  VALUES (p_user_id, p_amount, p_transaction_type, p_description, p_stripe_session_id);

  RETURN v_new_balance;
END;
$function$;

-- set_user_quotas_for_plan: admins and the service role. Every column it writes
-- is NULL - it clears per-user overrides so the plan's own limits apply - so an
-- unguarded caller could silently reset another user's quotas.
CREATE OR REPLACE FUNCTION public.set_user_quotas_for_plan(
  p_user_id uuid,
  p_plan_slug text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'set_user_quotas_for_plan is restricted to admins'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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
$function$;
