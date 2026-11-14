-- Phase 1 can be merged with all four rollout switches off. Existing runtime
-- OAuth uses its own master flag and must not depend on these switches.
INSERT INTO public.system_settings (key, value) VALUES
  ('feature_ai_text_auth_lists', 'false'::jsonb),
  ('feature_ai_category_text_ladders', 'false'::jsonb),
  ('feature_ai_oauth_tools_claude', 'false'::jsonb),
  ('feature_ai_oauth_tools_codex', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- While the new policy is enabled, even an admin browser must use the
-- authenticated ai-config boundary, which can check server-only credentials
-- and registry eligibility. Existing RLS still governs all other settings.
CREATE FUNCTION public.guard_ai_chat_tier_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tier_keys text[] := ARRAY['default_ai_model_chat', 'default_ai_model_chat_fallback', 'default_ai_model_chat_fallback_2'];
BEGIN
  IF (CASE WHEN TG_OP = 'INSERT' THEN NEW.key = ANY(tier_keys)
           WHEN TG_OP = 'DELETE' THEN OLD.key = ANY(tier_keys)
           ELSE OLD.key = ANY(tier_keys) OR NEW.key = ANY(tier_keys) END)
     AND COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'), false)
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND current_setting('role') NOT IN ('none', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Use the AI configuration boundary for Chat tiers' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ai_chat_tier_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_ai_chat_tier_write BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_ai_chat_tier_write();

-- One atomic compare-and-write prevents two admins from silently replacing
-- each other's ladder after validation. Only the service-side writer may call
-- this RPC; it is not a second browser validation boundary.
CREATE FUNCTION public.write_ai_chat_tier(p_key text, p_value jsonb, p_expected jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tier_keys text[] := ARRAY['default_ai_model_chat', 'default_ai_model_chat_fallback', 'default_ai_model_chat_fallback_2'];
  current_chain jsonb;
  next_chain jsonb;
  tier_key text;
  tier jsonb;
  gap boolean := false;
BEGIN
  IF NOT p_key = ANY(tier_keys) THEN RAISE EXCEPTION 'Invalid Chat slot'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-chat-tier-write', 0));
  IF NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'), false) THEN
    RETURN false;
  END IF;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO current_chain
    FROM public.system_settings WHERE key = ANY(tier_keys);
  IF current_chain IS DISTINCT FROM p_expected THEN RETURN false; END IF;
  next_chain := current_chain || jsonb_build_object(p_key, p_value);
  FOREACH tier_key IN ARRAY tier_keys LOOP
    tier := next_chain -> tier_key;
    IF tier IS NULL OR tier = 'null'::jsonb THEN gap := true; CONTINUE; END IF;
    IF gap OR jsonb_typeof(tier) <> 'object'
       OR jsonb_typeof(tier->'provider_code') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tier->'model_id') IS DISTINCT FROM 'string'
       OR btrim(tier->>'provider_code') = '' OR btrim(tier->>'model_id') = ''
       OR ((tier ? 'auth_method') AND (tier->>'auth_method' IS NULL OR tier->>'auth_method' NOT IN ('api_key', 'oauth'))) THEN
      RAISE EXCEPTION 'Invalid Chat chain';
    END IF;
  END LOOP;
  INSERT INTO public.system_settings (key, value, updated_at) VALUES (p_key, p_value, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.write_ai_chat_tier(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_ai_chat_tier(text, jsonb, jsonb) TO service_role;
