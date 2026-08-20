-- The Higgsfield OAuth code stores the redirect_uri it registered a client
-- against in provider_api_keys.meta, and reads it back to match the client on
-- refresh. Postora's provider_api_keys predates that code and never had a meta
-- column, so every platform-scope read failed with
--
--   column provider_api_keys.meta does not exist
--
-- Reads swallowed that and reported "not connected", which looked merely wrong;
-- the platform-scope OAuth callback threw on it, so authorising with Higgsfield
-- succeeded upstream and then failed to land back in Postora.
--
-- 20260820130000 added the other columns that code needs (auth_type,
-- access_token, refresh_token, expires_at, scope, account_id) but missed this
-- one. Shape matches the upstream definition the code was written against:
-- jsonb, NOT NULL, defaulting to an empty object, so `meta?.redirect_uri`
-- resolves to undefined rather than erroring on existing rows.
ALTER TABLE public.provider_api_keys
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
