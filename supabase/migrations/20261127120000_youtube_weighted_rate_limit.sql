-- YouTube vNext Phase 3B-pre (PR-8A): Weighted Rate Limit Counter
-- Adds public.check_weighted_rate_limit(p_key, p_cost, p_max, p_window_seconds)
-- for atomic multi-unit project write budget debits (fail-closed, no partial debit).
--
-- Leaves public.check_rate_limit and public.rate_limit_buckets columns untouched.
-- Apply as supabase_admin with ON_ERROR_STOP=1.
-- Rollback: DROP FUNCTION IF EXISTS public.check_weighted_rate_limit(text, integer, integer, integer);

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Defensive precondition: ensure rate_limit_buckets and its lock-down exist
-- even on a fresh database that did not run manual-sql scripts directly.
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    bucket_key   TEXT        PRIMARY KEY,
    count        INTEGER     NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expired
    ON public.rate_limit_buckets (expires_at);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM anon;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM authenticated;
GRANT  ALL ON TABLE public.rate_limit_buckets TO service_role;

CREATE OR REPLACE FUNCTION public.check_weighted_rate_limit(
    p_key            TEXT,
    p_cost           INTEGER,
    p_max            INTEGER,
    p_window_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_bucket_key   TEXT;
    v_now          TIMESTAMPTZ := now();
    v_count        INTEGER;
    v_window_start TIMESTAMPTZ;
    v_window_end   TIMESTAMPTZ;
    v_retry_after  INTEGER;
BEGIN
    IF p_key IS NULL OR btrim(p_key) = '' THEN
        RAISE EXCEPTION 'check_weighted_rate_limit: p_key must be a non-empty string'
            USING ERRCODE = '22023';
    END IF;

    IF p_cost IS NULL OR p_cost <= 0 THEN
        RAISE EXCEPTION 'check_weighted_rate_limit: p_cost must be positive'
            USING ERRCODE = '22023';
    END IF;

    IF p_max IS NULL OR p_max <= 0 THEN
        RAISE EXCEPTION 'check_weighted_rate_limit: p_max must be positive'
            USING ERRCODE = '22023';
    END IF;

    IF p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
        RAISE EXCEPTION 'check_weighted_rate_limit: p_window_seconds must be positive'
            USING ERRCODE = '22023';
    END IF;

    -- Namespace weighted buckets separately from check_rate_limit ('endpoint:identifier').
    v_bucket_key := CASE
        WHEN p_key LIKE 'weighted:%' THEN p_key
        ELSE 'weighted:' || p_key
    END;

    -- Step 1: Ensure the bucket row exists before acquiring the row lock.
    INSERT INTO public.rate_limit_buckets (bucket_key, count, window_start, expires_at)
    VALUES (v_bucket_key, 0, v_now, v_now + make_interval(secs => p_window_seconds))
    ON CONFLICT (bucket_key) DO NOTHING;

    -- Step 2: Acquire row-level lock to serialize concurrent debits on this bucket.
    SELECT count, window_start
      INTO v_count, v_window_start
      FROM public.rate_limit_buckets
     WHERE bucket_key = v_bucket_key
       FOR UPDATE;

    -- Guard against a concurrent cleanup_rate_limit_buckets() deleting an expired row
    -- between Step 1 and Step 2.
    IF NOT FOUND THEN
        INSERT INTO public.rate_limit_buckets (bucket_key, count, window_start, expires_at)
        VALUES (v_bucket_key, 0, v_now, v_now + make_interval(secs => p_window_seconds))
        ON CONFLICT (bucket_key) DO NOTHING;

        SELECT count, window_start
          INTO v_count, v_window_start
          FROM public.rate_limit_buckets
         WHERE bucket_key = v_bucket_key
           FOR UPDATE;
    END IF;

    -- Step 3: Reset the window when it has expired.
    IF v_now - v_window_start > make_interval(secs => p_window_seconds) THEN
        IF p_cost <= p_max THEN
            UPDATE public.rate_limit_buckets
               SET count        = p_cost,
                   window_start = v_now,
                   expires_at   = v_now + make_interval(secs => p_window_seconds)
             WHERE bucket_key = v_bucket_key;

            RETURN jsonb_build_object(
                'allowed', true,
                'count', p_cost,
                'retry_after', 0
            );
        ELSE
            UPDATE public.rate_limit_buckets
               SET count        = 0,
                   window_start = v_now,
                   expires_at   = v_now + make_interval(secs => p_window_seconds)
             WHERE bucket_key = v_bucket_key;

            RETURN jsonb_build_object(
                'allowed', false,
                'count', 0,
                'retry_after', p_window_seconds
            );
        END IF;
    END IF;

    -- Step 4: Active window check — allow only when current count + cost <= ceiling.
    IF v_count::bigint + p_cost::bigint <= p_max::bigint THEN
        UPDATE public.rate_limit_buckets
           SET count = v_count + p_cost
         WHERE bucket_key = v_bucket_key;

        RETURN jsonb_build_object(
            'allowed', true,
            'count', v_count + p_cost,
            'retry_after', 0
        );
    END IF;

    -- Step 5: Refused — leave count unchanged (never partially debit).
    v_window_end := v_window_start + make_interval(secs => p_window_seconds);
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now)))::integer);

    RETURN jsonb_build_object(
        'allowed', false,
        'count', v_count,
        'retry_after', v_retry_after
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_weighted_rate_limit(text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_weighted_rate_limit(text, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.check_weighted_rate_limit(text, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_weighted_rate_limit(text, integer, integer, integer) TO service_role;

COMMENT ON FUNCTION public.check_weighted_rate_limit(text, integer, integer, integer) IS
    'Atomic weighted rate-limit debit on public.rate_limit_buckets (weighted: namespace). Service-role only; refuses whole without partial debit when count + cost > max.';

COMMIT;
