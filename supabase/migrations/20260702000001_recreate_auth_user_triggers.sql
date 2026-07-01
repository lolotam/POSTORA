-- Recreate auth-user lifecycle triggers that get dropped during
-- Supabase self-hosted upgrades (the upgrade recreates auth.users and
-- discards custom triggers, while the trigger FUNCTIONS survive).
-- All statements are idempotent so this is safe to re-run.

-- Profile + api_key + quota on new auth user
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Default 'user' role on new auth user
DROP TRIGGER IF EXISTS on_auth_user_created_role ON auth.users;
CREATE TRIGGER on_auth_user_created_role
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();

-- Quota row when a profile is created
DROP TRIGGER IF EXISTS on_profile_created_quota ON public.profiles;
CREATE TRIGGER on_profile_created_quota
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_quota();

-- Referral code when a profile is created
DROP TRIGGER IF EXISTS set_user_referral_code ON public.profiles;
CREATE TRIGGER set_user_referral_code
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  WHEN (NEW.referral_code IS NULL)
  EXECUTE FUNCTION public.handle_new_user_referral_code();

-- Backfill any users whose profile/role were never created because the
-- triggers were missing at signup time.
INSERT INTO public.profiles (id, email, full_name, api_key)
SELECT u.id, u.email,
       COALESCE(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
       'postora-' || gen_random_uuid()
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id);

INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'user'
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id);
