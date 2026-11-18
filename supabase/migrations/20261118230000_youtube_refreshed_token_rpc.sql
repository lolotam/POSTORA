-- The refreshed YouTube token is stored by the database, not by a query filter.
--
-- WHY THIS EXISTS. The worker refreshed the YouTube access token with a
-- compare-and-set on the row:
--
--   supabase.from("social_accounts")
--     .update({ access_token, token_expires_at })
--     .eq("id", account.id)
--     .eq("refresh_token", account.refreshToken)
--     .eq("access_token", account.accessToken)
--     .eq("token_expires_at", account.tokenExpiresAt)
--
-- PostgREST puts every filter in the QUERY STRING, and a query string is
-- written to the access log of every hop between the worker and the
-- database -- and to the log of everything that reads those logs. The
-- refresh token and the access token therefore travelled in a URL.
--
-- The compare-and-set moves into the database, where the credentials travel
-- in the BODY of a POST and never in a URL. The rule it proves is the same
-- one the filters proved: the token is stored only if the row still carries
-- the credential the refresh was asked with, so a refresh that raced another
-- writer stores nothing and the newer credential wins.
--
-- The function is SECURITY DEFINER because it writes a row that only the
-- service role may write, and it is granted to the service role alone: the
-- caller is the worker, never the browser.
--
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.store_youtube_refreshed_token(
  p_account_id uuid,
  p_expected_refresh_token text,
  p_expected_access_token text,
  p_expected_token_expires_at timestamptz,
  p_new_access_token text,
  p_new_token_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.social_accounts%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_new_access_token IS NULL OR p_new_token_expires_at IS NULL THEN
    RETURN false;
  END IF;

  -- The row is locked for the compare-and-set, so two refreshes that race
  -- cannot both write: the second one reads the row the first one wrote.
  SELECT * INTO v_row
    FROM public.social_accounts
   WHERE id = p_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- The row must still carry the credential the refresh was asked with. A
  -- writer that changed it in the meantime owns the newer credential, and
  -- this refresh stores nothing.
  IF v_row.refresh_token IS DISTINCT FROM p_expected_refresh_token
     OR v_row.access_token IS DISTINCT FROM p_expected_access_token
     OR v_row.token_expires_at IS DISTINCT FROM p_expected_token_expires_at THEN
    RETURN false;
  END IF;

  UPDATE public.social_accounts
     SET access_token = p_new_access_token,
         token_expires_at = p_new_token_expires_at,
         updated_at = now()
   WHERE id = p_account_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.store_youtube_refreshed_token(uuid, text, text, timestamptz, text, timestamptz) IS
  'Stores a refreshed YouTube access token when the row still carries the credential the refresh was asked with. The compare-and-set happens in the database, so the credentials travel in the body of a POST and never in a URL.';

REVOKE ALL ON FUNCTION public.store_youtube_refreshed_token(uuid, text, text, timestamptz, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_youtube_refreshed_token(uuid, text, text, timestamptz, text, timestamptz) TO service_role;
