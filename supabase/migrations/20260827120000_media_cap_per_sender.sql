-- Per-sender sub-cap for inbound media understanding.
--
-- 20260825130000 bounded spend per ACCOUNT (100 attempts/day). That stops the bill running
-- away, but not a single sender consuming the whole allowance: one customer sending a
-- stream of photos exhausts the account by mid-morning and every other customer's media
-- is refused for the rest of the day. The account cap protects the wallet; this one
-- protects the other customers.
--
-- Two decisions worth stating, because both were live options:
--
--   * A SEPARATE TABLE, not a column on media_understanding_usage. The account counter is
--     keyed (account, date); adding sender to that key would change what an existing row
--     means and break the account cap it already enforces.
--
--   * COUNTED IN POSTGRES, not in the edge worker. An in-process counter cannot bound
--     anything here: edge isolates are ephemeral and there are several of them, so each
--     would keep its own tally and the sum would be unbounded -- the same read-then-act
--     race the parent migration's comment documents.

CREATE TABLE IF NOT EXISTS public.media_understanding_sender_usage (
  social_account_id UUID NOT NULL,
  -- The platform's own identifier for the other party: a PSID on Facebook/Instagram, a
  -- digits-only phone number on WhatsApp. Not a foreign key -- a sender is not a row in
  -- any table here, and the counter must work on the first message from a stranger.
  sender_id         TEXT NOT NULL,
  usage_date        DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (social_account_id, sender_id, usage_date)
);

ALTER TABLE public.media_understanding_sender_usage ENABLE ROW LEVEL SECURITY;
-- Service-role only, exactly as media_understanding_usage: written from the webhook path,
-- never read by a browser client. RLS on with no policies and no grants is deny-all.

CREATE INDEX IF NOT EXISTS idx_media_understanding_sender_usage_date
  ON public.media_understanding_sender_usage (usage_date);

/**
 * Reserves one attempt against BOTH caps, atomically, and reports which one refused it.
 *
 * The sender counter is incremented and checked FIRST, and a sender over its sub-cap
 * returns before the account counter is touched. That ordering is the requirement, not an
 * implementation detail: a throttled sender must not spend the account's allowance, or the
 * sub-cap would merely relabel the exhaustion it exists to prevent. It also fixes one lock
 * order for every caller, so concurrent webhooks cannot deadlock against each other.
 *
 * Like its predecessor this counts ATTEMPTS rather than successes, and counts them even
 * when refused -- a caller over the cap has still asked, and letting refusals go uncounted
 * is what lets a retry storm keep probing.
 *
 * Returns 'allowed' | 'sender_cap' | 'account_cap'. TEXT rather than BOOLEAN because the
 * caller logs the two refusals at different severities: a sender sub-cap is routine
 * throttling, an account cap is the operator's ceiling being reached.
 */
CREATE OR REPLACE FUNCTION public.reserve_media_understanding_attempt(
  p_account_id UUID,
  p_cap INTEGER,
  p_sender_id TEXT,
  p_sender_cap INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_count  INTEGER;
  v_account_count INTEGER;
BEGIN
  INSERT INTO public.media_understanding_sender_usage
    (social_account_id, sender_id, usage_date, attempt_count)
  VALUES (p_account_id, p_sender_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (social_account_id, sender_id, usage_date)
  DO UPDATE SET attempt_count = media_understanding_sender_usage.attempt_count + 1,
                updated_at    = now()
  RETURNING attempt_count INTO v_sender_count;

  IF v_sender_count > p_sender_cap THEN
    RETURN 'sender_cap';
  END IF;

  INSERT INTO public.media_understanding_usage (social_account_id, usage_date, attempt_count)
  VALUES (p_account_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (social_account_id, usage_date)
  DO UPDATE SET attempt_count = media_understanding_usage.attempt_count + 1,
                updated_at    = now()
  RETURNING attempt_count INTO v_account_count;

  IF v_account_count > p_cap THEN
    RETURN 'account_cap';
  END IF;

  RETURN 'allowed';
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_media_understanding_attempt(UUID, INTEGER, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_media_understanding_attempt(UUID, INTEGER, TEXT, INTEGER)
  TO service_role;

-- reserve_media_understanding (the 2-arg predecessor) is deliberately left in place. The
-- edge functions volume still runs the previous build until it is redeployed, and dropping
-- the function it calls would take media understanding down for the length of that window.
-- It has no caller once this change is deployed and can be dropped in a later migration.

-- The sub-cap itself is read from app_settings.media_cap_per_sender by the caller and
-- passed in as p_sender_cap, so changing it is a settings edit rather than a migration.
INSERT INTO public.app_settings (key, value, description)
VALUES (
  'media_cap_per_sender',
  '20'::jsonb,
  'Maximum inbound media items one sender may have understood per account per day. Sits under the account-wide daily cap so a single sender cannot exhaust it.'
)
ON CONFLICT (key) DO NOTHING;
