-- P1 follow-ups to 20260917120000 / 20260917130000 (Codex review round 2).
--
-- Two defects, one cause: api_key_hash was derived at each write site instead of
-- by the database, and the derivation used an unqualified digest().
--
--   1. handle_new_user() is SECURITY DEFINER with search_path pinned to 'public',
--      but pgcrypto lives in the 'extensions' schema on this stack, so
--      digest(text, unknown) does not resolve and EVERY new signup aborts.
--      Reproduced: SET search_path TO public; SELECT digest('probe','sha256')
--      -> ERROR: function digest(unknown, unknown) does not exist.
--
--   2. Nothing kept api_key_hash in step with api_key. A stale browser tab or any
--      direct own-profile UPDATE permitted by RLS writes api_key alone, after
--      which the rotated-away key still authenticates (its hash is untouched)
--      and the new key is rejected. Key rotation silently failed to revoke.
--
-- Deriving the hash in a BEFORE trigger fixes both: no write site can desync it,
-- and the one remaining digest() call is schema-qualified.
CREATE OR REPLACE FUNCTION public.profiles_sync_api_key_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- Recomputed on every write, and the trigger deliberately carries no
  -- UPDATE OF column list: with one, an UPDATE that touched api_key_hash alone
  -- would not fire it, and a client with RLS write access to its own profile
  -- could bind a self-chosen hash to a key the column does not hold. Firing on
  -- every profiles UPDATE costs one sha256 and keeps the column underivable.
  NEW.api_key_hash := CASE
    WHEN NEW.api_key IS NULL THEN NULL
    ELSE encode(extensions.digest(NEW.api_key, 'sha256'), 'hex')
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_sync_api_key_hash ON public.profiles;
CREATE TRIGGER profiles_sync_api_key_hash
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_sync_api_key_hash();

-- The trigger now owns api_key_hash, so the signup function no longer computes it.
-- This removes the unqualified digest() call that was aborting signups.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_api_key text := 'postora-' || gen_random_uuid();
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url, api_key)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
    NEW.raw_user_meta_data ->> 'avatar_url',
    new_api_key
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    updated_at = now();

  INSERT INTO public.user_quotas (user_id, max_profiles, max_social_accounts, max_posts_per_month, posts_this_month, quota_reset_date)
  VALUES (
    NEW.id,
    1,
    4,
    30,
    0,
    (date_trunc('month', now()) + interval '1 month')::timestamptz
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Repair any row whose hash drifted from its key before the trigger existed.
UPDATE public.profiles
SET api_key = api_key
WHERE api_key IS NOT NULL
  AND (
    api_key_hash IS NULL
    OR api_key_hash IS DISTINCT FROM encode(extensions.digest(api_key, 'sha256'), 'hex')
  );
