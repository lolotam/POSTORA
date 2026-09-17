-- P1 follow-up to 20260917120000 (Codex review): handle_new_user() mints an
-- api_key but never api_key_hash, so every account created after the backfill
-- would fail the hash-based lookups until a manual regeneration. The key and
-- its hash must come from ONE gen_random_uuid() call.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_api_key text := 'postora-' || gen_random_uuid();
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url, api_key, api_key_hash)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
    NEW.raw_user_meta_data ->> 'avatar_url',
    new_api_key,
    encode(digest(new_api_key, 'sha256'), 'hex')
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
