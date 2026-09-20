-- Phase 1 of API-key hardening (security review 2026-09-17):
-- server-side lookups (n8n-api, ecommerce-whatsapp-api) switch from the plaintext
-- profiles.api_key to its SHA-256 hex hash. The plaintext column is kept for now so
-- the API Keys page can still display/regenerate the key; removing it (show-once
-- semantics, invalidates every existing integration key) is the Phase 2 follow-up.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS api_key_hash text;

UPDATE public.profiles
SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex')
WHERE api_key IS NOT NULL
  AND (api_key_hash IS NULL OR api_key_hash = '');

CREATE UNIQUE INDEX IF NOT EXISTS profiles_api_key_hash_key
  ON public.profiles (api_key_hash)
  WHERE api_key_hash IS NOT NULL;
