-- Atomic daily cap for inbound media understanding.
--
-- The first implementation counted whatsapp_messages rows where media_understanding IS
-- NOT NULL. That does not bound spend, for three separate reasons:
--   1. it is a read-then-act race -- concurrent inbound messages all see the same count
--      and all proceed;
--   2. it counted only SUCCESSFUL, PERSISTED results, so a provider failing in a loop is
--      billed every time and never counted;
--   3. it filtered on the provider-supplied message timestamp, so a delayed message
--      timestamped yesterday never counted against today.
--
-- This table counts ATTEMPTS, keyed by day, and the reservation is a single atomic
-- statement -- the same technique consume_partner_rate uses for partner rate limits.

CREATE TABLE IF NOT EXISTS public.media_understanding_usage (
  social_account_id UUID NOT NULL,
  usage_date        DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (social_account_id, usage_date)
);

ALTER TABLE public.media_understanding_usage ENABLE ROW LEVEL SECURITY;
-- Service-role only: written from the webhook path, never read by a browser client.
-- RLS on with no policies and no grants is the deny-all default.

/**
 * Increments and reports in ONE statement, so concurrent callers cannot all observe the
 * same pre-increment value. Returns true when the attempt is within the cap.
 *
 * Deliberately counts the attempt even when it is refused: a caller that is over the cap
 * has still asked, and letting refusals go uncounted is what allows a retry storm to keep
 * probing. The row is small and expires by date.
 */
CREATE OR REPLACE FUNCTION public.reserve_media_understanding(p_account_id UUID, p_cap INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.media_understanding_usage (social_account_id, usage_date, attempt_count)
  VALUES (p_account_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (social_account_id, usage_date)
  DO UPDATE SET attempt_count = media_understanding_usage.attempt_count + 1,
                updated_at    = now()
  RETURNING attempt_count INTO v_count;

  RETURN v_count <= p_cap;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_media_understanding(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_media_understanding(UUID, INTEGER) TO service_role;

CREATE INDEX IF NOT EXISTS idx_media_understanding_usage_date
  ON public.media_understanding_usage (usage_date);
