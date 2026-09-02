-- Partner API Phase 10.1: split the single charged total into three
-- accountable buckets so a reservation, a confirmed send, an indeterminate
-- outcome and a release are distinguishable without changing what the cap
-- enforces. `current_usage_count` stays as the charged total because deployed
-- code still reads it; every RPC below keeps it as the sum.
--
-- Expand-only and idempotent: safe to apply while the old code (which calls
-- reserve_partner_quota / release_partner_quota and reads
-- current_usage_count) is still running.

-- ---------------------------------------------------------------------------
-- 1. New counter columns — each holds only a part of the charged total.
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_api_keys
  ADD COLUMN IF NOT EXISTS usage_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.partner_api_keys
  ADD COLUMN IF NOT EXISTS usage_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.partner_api_keys
  ADD COLUMN IF NOT EXISTS usage_indeterminate INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_api_keys_usage_reserved_check'
  ) THEN
    ALTER TABLE public.partner_api_keys
      ADD CONSTRAINT partner_api_keys_usage_reserved_check
      CHECK (usage_reserved >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_api_keys_usage_confirmed_check'
  ) THEN
    ALTER TABLE public.partner_api_keys
      ADD CONSTRAINT partner_api_keys_usage_confirmed_check
      CHECK (usage_confirmed >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_api_keys_usage_indeterminate_check'
  ) THEN
    ALTER TABLE public.partner_api_keys
      ADD CONSTRAINT partner_api_keys_usage_indeterminate_check
      CHECK (usage_indeterminate >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One-time backfill: settled history is treated as confirmed.
--    The guard requires all three buckets to be empty, not just confirmed:
--    a re-run after a reservation has landed would otherwise copy a total
--    that already includes the reserved unit into confirmed, double-counting.
-- ---------------------------------------------------------------------------
UPDATE public.partner_api_keys
   SET usage_confirmed = current_usage_count
 WHERE usage_reserved = 0
   AND usage_confirmed = 0
   AND usage_indeterminate = 0
   AND current_usage_count > 0;

-- ---------------------------------------------------------------------------
-- 3. reserve_partner_quota — SAME signature and return shape as before.
--    In ONE UPDATE: apply the monthly reset if due, bump reserved, recompute
--    the charged total as the sum, stamp last_used_at. The caller releases on
--    refusal, so the check is after the increment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_partner_quota(p_key_id UUID)
RETURNS TABLE (allowed BOOLEAN, usage_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quota INTEGER;
  v_count INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET usage_reserved =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 1 ELSE k.usage_reserved + 1 END,
         usage_confirmed =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 0 ELSE k.usage_confirmed END,
         usage_indeterminate =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 0 ELSE k.usage_indeterminate END,
         current_usage_count =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 1 ELSE k.usage_reserved + 1 + k.usage_confirmed + k.usage_indeterminate END,
         last_reset_at = date_trunc('month', now()),
         last_used_at  = now()
   WHERE k.id = p_key_id
   RETURNING k.monthly_quota, k.current_usage_count
        INTO v_quota, v_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_quota IS NULL OR v_count <= v_quota), v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. release_partner_quota — a definite rejection or a no-call attempt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_partner_quota(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys
     SET usage_reserved = GREATEST(usage_reserved - 1, 0),
         current_usage_count = GREATEST(usage_reserved - 1, 0) + usage_confirmed + usage_indeterminate
   WHERE id = p_key_id;
$$;

-- ---------------------------------------------------------------------------
-- 5. confirm_partner_quota — provider definitely accepted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_partner_quota(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys
     SET usage_reserved = GREATEST(usage_reserved - 1, 0),
         usage_confirmed = usage_confirmed + 1,
         current_usage_count = GREATEST(usage_reserved - 1, 0) + usage_confirmed + 1 + usage_indeterminate
   WHERE id = p_key_id;
$$;

-- ---------------------------------------------------------------------------
-- 6. indeterminate_partner_quota — outcome unknown; never refunded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.indeterminate_partner_quota(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys
     SET usage_reserved = GREATEST(usage_reserved - 1, 0),
         usage_indeterminate = usage_indeterminate + 1,
         current_usage_count = GREATEST(usage_reserved - 1, 0) + usage_confirmed + usage_indeterminate + 1
   WHERE id = p_key_id;
$$;

REVOKE ALL ON FUNCTION public.reserve_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.release_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.confirm_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.indeterminate_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.reserve_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.indeterminate_partner_quota(UUID) TO service_role;
