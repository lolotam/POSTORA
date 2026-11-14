-- Apply before deploying the Phase 4 writer. The list flag controls both the
-- browser boundary and this additive guard; legacy writes remain valid when off.
CREATE FUNCTION public.guard_ai_agent_tier_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keys text[] := ARRAY['default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2'];
BEGIN
  IF (CASE WHEN TG_OP = 'INSERT' THEN NEW.key = ANY(keys)
      WHEN TG_OP = 'DELETE' THEN OLD.key = ANY(keys)
      ELSE OLD.key = ANY(keys) OR NEW.key = ANY(keys) END)
    AND COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'),false)
    AND COALESCE(auth.role(),'') <> 'service_role'
    AND current_setting('role') NOT IN ('none','postgres','supabase_admin') THEN
    RAISE EXCEPTION 'Use the AI configuration boundary for Agent tiers' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ai_agent_tier_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_ai_agent_tier_write BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_ai_agent_tier_write();

CREATE FUNCTION public.write_ai_agent_tier(p_key text, p_value jsonb, p_expected jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keys text[] := ARRAY['default_ai_model_agent','default_ai_model_agent_fallback','default_ai_model_agent_fallback_2'];
  current_chain jsonb;
  next_chain jsonb;
  tier_key text;
  tier jsonb;
  gap boolean := false;
  needs_recovery boolean := false;
  recovery boolean;
BEGIN
  IF p_key IS NULL OR NOT p_key = ANY(keys) THEN RAISE EXCEPTION 'Invalid Agent slot'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-agent-tier-write',0));
  IF NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'),false) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO current_chain FROM public.system_settings WHERE key = ANY(keys);
  IF current_chain IS DISTINCT FROM p_expected THEN RETURN false; END IF;
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN RAISE EXCEPTION 'Agent tier required'; END IF;
  next_chain := current_chain || jsonb_build_object(p_key,p_value);
  FOREACH tier_key IN ARRAY keys LOOP
    tier := public.normalize_ai_text_tier(next_chain->tier_key);
    IF tier IS NULL OR tier = 'null'::jsonb THEN gap := true; CONTINUE; END IF;
    IF gap THEN RAISE EXCEPTION 'Invalid Agent chain'; END IF;
    IF COALESCE(tier->>'auth_method','api_key') = 'oauth' THEN
      -- Kill switches preserve existing selections. Only the new Auth choice
      -- must be enabled; an API recovery edit may repair a disabled ladder.
      IF tier_key = p_key THEN
      IF tier->>'provider_code' <> 'claude' THEN RAISE EXCEPTION 'oauth_tools_unsupported'; END IF;
      IF NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_oauth_tools_claude'), false)
        OR NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_provider_oauth'), false)
        THEN RAISE EXCEPTION 'oauth_tools_unsupported'; END IF;
      END IF;
      needs_recovery := true;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.ai_models m JOIN public.ai_providers p ON p.id=m.provider_id
        WHERE p.provider_code=tier->>'provider_code' AND p.is_active AND m.is_active
          AND m.model_id=tier->>'model_id' AND m.auth_method='api_key'
          AND 'chat'=ANY(m.capabilities)
          AND ('tools'=ANY(m.capabilities) OR m.metadata->'tool_calling' = 'true'::jsonb
            OR m.metadata->'supported_parameters' @> '["tools"]'::jsonb)
      ) INTO recovery;
      IF recovery THEN needs_recovery := false; END IF;
    END IF;
  END LOOP;
  IF needs_recovery THEN RAISE EXCEPTION 'oauth_api_fallback_required'; END IF;
  -- Only the selected tier changes. Sibling strings/extension fields stay raw
  -- and participate in the next complete-chain CAS exactly as observed.
  INSERT INTO public.system_settings(key,value,updated_at) VALUES(p_key,public.normalize_ai_text_tier(p_value),now())
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.write_ai_agent_tier(text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_ai_agent_tier(text,jsonb,jsonb) TO service_role;
