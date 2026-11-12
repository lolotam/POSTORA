-- Fence OAuth refresh completion against disconnect and reconnect
-- (PR #404 review; follows 20261112120000_ai_provider_oauth.sql, which is
-- already applied and is not edited).
--
-- Before: a refresh that finished after an admin disconnected re-created the
-- connection through the login upsert, and one that finished after a
-- reconnect overwrote the new login's credentials.
--
-- Now every won lease carries a random token. Refresh completion and failure
-- update the row only while that token is still the row's token, and never
-- insert a row. A login save (save_ai_oauth_credentials) and a disconnect
-- (row deleted) both clear the token, so a refresh in flight across either
-- event writes nothing.

ALTER TABLE public.ai_provider_oauth_connections
  ADD COLUMN IF NOT EXISTS refresh_lease_token uuid;

-- Login save: same upsert as before, plus it voids any refresh in flight.
CREATE OR REPLACE FUNCTION public.save_ai_oauth_credentials(
  p_oauth_provider text, p_provider_code text, p_credentials jsonb,
  p_account_label text, p_expires_at timestamptz, p_user uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_secret uuid;
BEGIN
  SELECT credentials_secret_id INTO v_secret FROM public.ai_provider_oauth_connections
    WHERE oauth_provider = p_oauth_provider FOR UPDATE;
  IF v_secret IS NULL THEN
    v_secret := vault.create_secret(p_credentials::text, 'ai_oauth_' || p_oauth_provider);
  ELSE
    PERFORM vault.update_secret(v_secret, p_credentials::text);
  END IF;
  INSERT INTO public.ai_provider_oauth_connections AS c
    (oauth_provider, provider_code, credentials_secret_id, status, account_label, expires_at,
     refresh_lock_until, refresh_lease_token, last_refresh_error, connected_by, updated_at)
  VALUES (p_oauth_provider, p_provider_code, v_secret, 'connected', p_account_label, p_expires_at,
     NULL, NULL, NULL, p_user, now())
  ON CONFLICT (oauth_provider) DO UPDATE SET
    provider_code = EXCLUDED.provider_code, credentials_secret_id = EXCLUDED.credentials_secret_id,
    status = 'connected', account_label = COALESCE(EXCLUDED.account_label, c.account_label),
    expires_at = EXCLUDED.expires_at, refresh_lock_until = NULL, refresh_lease_token = NULL,
    last_refresh_error = NULL, connected_by = COALESCE(EXCLUDED.connected_by, c.connected_by),
    updated_at = now();
END $fn$;

-- Returns the lease token when the caller wins the lease, NULL otherwise.
CREATE OR REPLACE FUNCTION public.claim_ai_oauth_refresh(p_oauth_provider text, p_lease_seconds int)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.ai_provider_oauth_connections
     SET refresh_lock_until = now() + make_interval(secs => p_lease_seconds),
         refresh_lease_token = gen_random_uuid(), updated_at = now()
   WHERE oauth_provider = p_oauth_provider
     AND (refresh_lock_until IS NULL OR refresh_lock_until < now())
  RETURNING refresh_lease_token
$fn$;

-- Stores rotated credentials only while p_lease_token is still the row's
-- token. A lease that expired but was not re-claimed still completes: the
-- provider has already rotated the refresh token, so discarding it would
-- strand the connection. Returns false when the row is gone or re-leased.
CREATE OR REPLACE FUNCTION public.complete_ai_oauth_refresh(
  p_oauth_provider text, p_lease_token uuid, p_credentials jsonb, p_expires_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_secret uuid;
BEGIN
  SELECT credentials_secret_id INTO v_secret FROM public.ai_provider_oauth_connections
    WHERE oauth_provider = p_oauth_provider AND refresh_lease_token = p_lease_token
    FOR UPDATE;
  IF NOT FOUND OR v_secret IS NULL THEN
    RETURN false;
  END IF;
  PERFORM vault.update_secret(v_secret, p_credentials::text);
  UPDATE public.ai_provider_oauth_connections
     SET status = 'connected', expires_at = p_expires_at, refresh_lock_until = NULL,
         refresh_lease_token = NULL, last_refresh_error = NULL, updated_at = now()
   WHERE oauth_provider = p_oauth_provider;
  RETURN true;
END $fn$;

CREATE OR REPLACE FUNCTION public.fail_ai_oauth_refresh(
  p_oauth_provider text, p_lease_token uuid, p_error text, p_reauth boolean
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH failed AS (
    UPDATE public.ai_provider_oauth_connections
       SET refresh_lock_until = NULL, refresh_lease_token = NULL,
           last_refresh_error = left(p_error, 500),
           status = CASE WHEN p_reauth THEN 'reauth_required' ELSE status END, updated_at = now()
     WHERE oauth_provider = p_oauth_provider AND refresh_lease_token = p_lease_token
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM failed)
$fn$;

-- The unfenced lease pair has no caller left (the edge code that used it was
-- never deployed); drop it so nothing can bypass the fence.
DROP FUNCTION IF EXISTS public.begin_ai_oauth_refresh(text, int);
DROP FUNCTION IF EXISTS public.fail_ai_oauth_refresh(text, text, boolean);

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'save_ai_oauth_credentials(text,text,jsonb,text,timestamptz,uuid)',
    'claim_ai_oauth_refresh(text,int)',
    'complete_ai_oauth_refresh(text,uuid,jsonb,timestamptz)',
    'fail_ai_oauth_refresh(text,uuid,text,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $grants$;

NOTIFY pgrst, 'reload schema';
