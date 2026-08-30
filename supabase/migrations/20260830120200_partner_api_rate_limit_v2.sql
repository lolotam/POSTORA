
-- Partner API rate limiting v2: the limiter learns to report its own numbers.
--
-- consume_partner_rate (foundation migration 20260813120000) atomically
-- consumes a per-minute bucket but answers only a boolean. That forced the
-- edge function to compute X-RateLimit-Reset from its own clock -- a clock
-- that can disagree with the one that picked the bucket, and did: the
-- response could claim 60 seconds for a window that had already ended, or 1
-- second for one with nearly a minute left. This function performs the same
-- atomic consume and returns the decision together with the numbers the
-- response headers need, all derived from Postgres's own clock and the SAME
-- date_trunc('minute', now()) bucket that was incremented, so the reset can
-- never describe a different window than the one that was charged.
--
-- ADDED ALONGSIDE consume_partner_rate, NOT REPLACING IT. Migrations and
-- edge functions deploy through different pipelines, so between the two
-- deployments the OLD deployed code must keep calling the OLD function, and
-- rolling the new edge code back must still find it. Changing the existing
-- function's return type would break whichever side landed in the wrong
-- order; a new name makes both orders safe.
--
-- Reset is SECONDS REMAINING until the consumed window ends (1..60), not an
-- absolute timestamp: the header already publishes seconds, and Retry-After
-- is delay-seconds by RFC 9110, so the same database-derived number feeds
-- both without any local recomputation. CEIL, never floor: the window that
-- was consumed is never already over, so 0 must be impossible, and a floored
-- value would claim a live window had ended.
CREATE OR REPLACE FUNCTION public.consume_partner_rate_v2(p_key_id UUID, p_limit INTEGER)
RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, reset_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count  INTEGER;
  v_now    TIMESTAMPTZ;
  v_window TIMESTAMPTZ;
BEGIN
  -- Captured once so the bucket that is incremented and the window the reset
  -- is measured against are provably the same instant. now() is stable
  -- within a transaction anyway; the variable makes that invariant explicit
  -- instead of relying on every future reader knowing it.
  v_now    := now();
  v_window := date_trunc('minute', v_now);

  INSERT INTO public.partner_api_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, v_window, 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_api_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN QUERY SELECT
    -- Same predicate as consume_partner_rate.
    v_count <= p_limit,
    -- Requests left in THIS window after the one just consumed. Clamped: on
    -- a refused call the arithmetic goes negative, and "remaining" cannot.
    GREATEST(p_limit - v_count, 0),
    -- Seconds until the consumed window ends. v_window + 1 minute > now()
    -- always holds inside the window, so CEIL yields 1..60 and never 0.
    CEIL(EXTRACT(EPOCH FROM (v_window + INTERVAL '1 minute' - v_now)))::INTEGER;
END;
$$;

-- Locked down exactly like consume_partner_rate: service_role only.
REVOKE ALL ON FUNCTION public.consume_partner_rate_v2(UUID, INTEGER)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.consume_partner_rate_v2(UUID, INTEGER)
  TO service_role;
