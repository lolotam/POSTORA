-- Apply before deploying the Phase 3 writer. The list flag controls both the
-- browser boundary and this additive guard; legacy writes remain valid when off.
CREATE FUNCTION public.guard_ai_triage_tier_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keys text[] := ARRAY['default_ai_model_agent_triage','default_ai_model_agent_triage_fallback','default_ai_model_agent_triage_fallback_2'];
BEGIN
  IF (CASE WHEN TG_OP = 'INSERT' THEN NEW.key = ANY(keys)
      WHEN TG_OP = 'DELETE' THEN OLD.key = ANY(keys)
      ELSE OLD.key = ANY(keys) OR NEW.key = ANY(keys) END)
    AND COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'),false)
    AND COALESCE(auth.role(),'') <> 'service_role'
    AND current_setting('role') NOT IN ('none','postgres','supabase_admin') THEN
    RAISE EXCEPTION 'Use the AI configuration boundary for Triage tiers' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ai_triage_tier_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_ai_triage_tier_write BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_ai_triage_tier_write();

CREATE FUNCTION public.write_ai_triage_tier(p_key text, p_value jsonb, p_expected jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keys text[] := ARRAY['default_ai_model_agent_triage','default_ai_model_agent_triage_fallback','default_ai_model_agent_triage_fallback_2'];
  current_chain jsonb;
  next_chain jsonb;
  tier_key text;
  tier jsonb;
  gap boolean := false;
  cap_supported boolean := false;
BEGIN
  IF p_key IS NULL OR NOT p_key = ANY(keys) THEN RAISE EXCEPTION 'Invalid Triage slot'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-triage-tier-write',0));
  IF NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'),false) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO current_chain FROM public.system_settings WHERE key = ANY(keys);
  IF current_chain IS DISTINCT FROM p_expected THEN RETURN false; END IF;
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN RAISE EXCEPTION 'Triage tier required'; END IF;
  next_chain := current_chain || jsonb_build_object(p_key,p_value);
  FOREACH tier_key IN ARRAY keys LOOP
    tier := public.normalize_ai_text_tier(next_chain->tier_key);
    IF tier IS NULL OR tier = 'null'::jsonb THEN gap := true; CONTINUE; END IF;
    IF gap THEN RAISE EXCEPTION 'Invalid Triage chain'; END IF;
    cap_supported := cap_supported OR NOT (tier->>'provider_code' = 'openai' AND COALESCE(tier->>'auth_method','api_key') = 'oauth');
  END LOOP;
  IF NOT cap_supported THEN RAISE EXCEPTION 'oauth_max_tokens_unsupported'; END IF;
  -- Only the selected tier changes. Sibling strings/extension fields stay raw
  -- and participate in the next complete-chain CAS exactly as observed.
  INSERT INTO public.system_settings(key,value,updated_at) VALUES(p_key,public.normalize_ai_text_tier(p_value),now())
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.write_ai_triage_tier(text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_ai_triage_tier(text,jsonb,jsonb) TO service_role;
