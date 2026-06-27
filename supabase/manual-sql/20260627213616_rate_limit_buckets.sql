-- ═══════════════════════════════════════════════════════════════════
-- P2-4: Rate Limit Buckets Table + Atomic Check-and-Increment RPC
-- ═══════════════════════════════════════════════════════════════════
-- Purpose: Provide O(1) atomic rate limiting for security-critical
-- edge-function endpoints (send-reset-otp, manage-backup-codes, etc.)
-- without the scan-heavy COUNT(*) approach used by the legacy api_logs
-- based rate limiter.
--
-- Architecture:
--   Each rate-limit "bucket" is keyed by 'endpoint:identifier' where
--   identifier is an IP address (pre-auth) or 'user:<uuid>' (post-auth).
--   The check_rate_limit() RPC performs a single atomic check-and-
--   increment using INSERT ... ON CONFLICT + SELECT FOR UPDATE to
--   serialise concurrent requests on the same bucket.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.check_rate_limit(TEXT, TEXT, INTEGER, INTEGER);
--   DROP TABLE IF EXISTS public.rate_limit_buckets;
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    bucket_key   TEXT        PRIMARY KEY,
    count        INTEGER     NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour')
);

-- Partial index for efficient TTL cleanup (only rows past their expiry).
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expired
    ON public.rate_limit_buckets (expires_at);

-- ── 2. Atomic check-and-increment RPC ──────────────────────────────
-- Called from edge functions via supabase.rpc('check_rate_limit', {...}).
-- Returns JSONB: { allowed: bool, count: int, remaining: int, retry_after: int }
CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_endpoint       TEXT,
    p_identifier     TEXT,
    p_max_requests   INTEGER,
    p_window_seconds INTEGER
) RETURNS JSONB AS $$
DECLARE
    v_bucket_key   TEXT       := p_endpoint || ':' || p_identifier;
    v_now          TIMESTAMPTZ := now();
    v_count        INTEGER;
    v_window_start TIMESTAMPTZ;
    v_window_end   TIMESTAMPTZ;
BEGIN
    -- Step 1: Insert-or-noop. If the row doesn't exist, create it with count 0.
    -- The RETURNING clause gives us the initial values if we won the insert race.
    INSERT INTO public.rate_limit_buckets (bucket_key, count, window_start, expires_at)
    VALUES (v_bucket_key, 0, v_now, v_now + make_interval(secs => p_window_seconds))
    ON CONFLICT (bucket_key) DO NOTHING
    RETURNING count, window_start INTO v_count, v_window_start;

    -- Step 2: If we didn't win the insert (row already existed), lock and read.
    IF v_count IS NULL THEN
        SELECT count, window_start INTO v_count, v_window_start
        FROM public.rate_limit_buckets
        WHERE bucket_key = v_bucket_key
        FOR UPDATE;
    END IF;

    -- Guard: row should exist at this point.
    IF v_count IS NULL THEN
        RETURN jsonb_build_object('allowed', true, 'count', 0, 'remaining', p_max_requests, 'retry_after', 0);
    END IF;

    -- Step 3: Check if the sliding window has expired.
    IF v_now - v_window_start > make_interval(secs => p_window_seconds) THEN
        UPDATE public.rate_limit_buckets
        SET count = 1,
            window_start = v_now,
            expires_at = v_now + make_interval(secs => p_window_seconds)
        WHERE bucket_key = v_bucket_key;
        RETURN jsonb_build_object(
            'allowed', true,
            'count', 1,
            'remaining', p_max_requests - 1,
            'retry_after', 0
        );
    END IF;

    -- Step 4: Check if rate limit is exceeded.
    IF v_count >= p_max_requests THEN
        v_window_end := v_window_start + make_interval(secs => p_window_seconds);
        RETURN jsonb_build_object(
            'allowed', false,
            'count', v_count,
            'remaining', 0,
            'retry_after', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now))))
        );
    END IF;

    -- Step 5: Increment and allow.
    UPDATE public.rate_limit_buckets
    SET count = count + 1
    WHERE bucket_key = v_bucket_key;

    RETURN jsonb_build_object(
        'allowed', true,
        'count', v_count + 1,
        'remaining', p_max_requests - v_count - 1,
        'retry_after', 0
    );
END;
$$ LANGUAGE plpgsql;
-- SECURITY DEFINER is NOT needed because edge functions call this RPC with
-- the service-role key, which bypasses RLS.

-- ── 3. Cleanup function (call via pg_cron every 15 minutes) ─────────
CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_buckets()
RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.rate_limit_buckets WHERE expires_at < now();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Optional: schedule cleanup via pg_cron ───────────────────────
-- Uncomment after verifying pg_cron is enabled on the self-hosted instance:
-- SELECT cron.schedule(
--     'cleanup-rate-limit-buckets',
--     '*/15 * * * *',
--     $$SELECT public.cleanup_rate_limit_buckets()$$
-- );
