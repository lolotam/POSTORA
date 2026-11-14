-- Caption/Hashtags use one service-only, whole-chain CAS transaction. No rows
-- means inheritance; a reset deletes all three rows, never individual slots.
CREATE FUNCTION public.guard_ai_text_ladder_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keys text[] := ARRAY['default_ai_model_caption','default_ai_model_caption_fallback','default_ai_model_caption_fallback_2',
    'default_ai_model_hashtags','default_ai_model_hashtags_fallback','default_ai_model_hashtags_fallback_2'];
BEGIN
  IF (CASE WHEN TG_OP = 'INSERT' THEN NEW.key = ANY(keys)
      WHEN TG_OP = 'DELETE' THEN OLD.key = ANY(keys)
      ELSE NEW.key = ANY(keys) OR OLD.key = ANY(keys) END)
    AND COALESCE(auth.role(), '') <> 'service_role'
    AND current_setting('role') NOT IN ('none','postgres','supabase_admin') THEN
    RAISE EXCEPTION 'Use the AI configuration boundary for text ladders' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ai_text_ladder_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_ai_text_ladder_write BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_ai_text_ladder_write();

CREATE FUNCTION public.write_ai_text_ladder(p_category text, p_chain jsonb, p_expected jsonb, p_expected_chat jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keys text[];
  chat_keys text[] := ARRAY['default_ai_model_chat','default_ai_model_chat_fallback','default_ai_model_chat_fallback_2'];
  current_chain jsonb;
  chat_chain jsonb;
  tier_key text;
  tier jsonb;
  gap boolean := false;
BEGIN
  IF p_category IS NULL OR p_category NOT IN ('caption','hashtags') THEN RAISE EXCEPTION 'Invalid text category'; END IF;
  keys := ARRAY['default_ai_model_'||p_category, 'default_ai_model_'||p_category||'_fallback', 'default_ai_model_'||p_category||'_fallback_2'];
  -- Same Chat lock as phase 1 prevents an inheritance reset from validating
  -- one Chat chain and committing after a different Chat chain was saved.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-chat-tier-write',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-text-ladder-'||p_category,0));
  IF NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_text_auth_lists'),false)
    OR NOT COALESCE((SELECT value = 'true'::jsonb FROM public.system_settings WHERE key = 'feature_ai_category_text_ladders'),false) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO current_chain FROM public.system_settings WHERE key = ANY(keys);
  IF current_chain IS DISTINCT FROM p_expected THEN RETURN false; END IF;
  IF p_chain IS NULL OR jsonb_typeof(p_chain) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_chain) k WHERE NOT k = ANY(keys)) THEN RAISE EXCEPTION 'Invalid text chain'; END IF;
  IF p_chain = '{}'::jsonb THEN
    SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO chat_chain FROM public.system_settings WHERE key = ANY(chat_keys);
    IF chat_chain IS DISTINCT FROM p_expected_chat THEN RETURN false; END IF;
  ELSE
    IF p_chain->keys[1] IS NULL OR p_chain->keys[1] = 'null'::jsonb THEN RAISE EXCEPTION 'Text Primary required'; END IF;
    FOREACH tier_key IN ARRAY keys LOOP
      tier := p_chain->tier_key;
      IF tier IS NULL OR tier = 'null'::jsonb THEN gap := true; CONTINUE; END IF;
      IF gap OR jsonb_typeof(tier) <> 'object'
        OR jsonb_typeof(tier->'provider_code') IS DISTINCT FROM 'string'
        OR jsonb_typeof(tier->'model_id') IS DISTINCT FROM 'string'
        OR btrim(tier->>'provider_code') = '' OR btrim(tier->>'model_id') = ''
        OR ((tier ? 'auth_method') AND (tier->>'auth_method' IS NULL OR tier->>'auth_method' NOT IN ('api_key','oauth'))) THEN RAISE EXCEPTION 'Invalid text chain'; END IF;
    END LOOP;
  END IF;
  DELETE FROM public.system_settings WHERE key = ANY(keys);
  INSERT INTO public.system_settings(key,value,updated_at) SELECT key,value,now() FROM jsonb_each(p_chain);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.write_ai_text_ladder(text,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_ai_text_ladder(text,jsonb,jsonb,jsonb) TO service_role;
