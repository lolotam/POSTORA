-- ============================================================================
-- get_active_ai_model_config: replace the retired hardcoded fallback model
-- ============================================================================
-- The final fallback returned gemini-2.5-flash, which answers 404 "no longer
-- available to new users" since the Gemini key moved project on 2026-10-05
-- (20261005120000 retired its catalogue row). The body is otherwise identical
-- to the live definition (pg_get_functiondef, 2026-10-05). CREATE OR REPLACE
-- keeps the owner and the grants that 20260922090000 / 20260922113000 set.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_active_ai_model_config(p_user_id uuid, p_feature text DEFAULT 'general'::text)
 RETURNS TABLE(provider_code text, model_id text, model_name text, api_endpoint text, api_key_env_var text, api_type text, supports_streaming boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pref_model_id UUID;
  v_system_default JSONB;
BEGIN
  SELECT amp.model_id INTO v_pref_model_id
  FROM public.ai_model_preferences amp
  WHERE amp.user_id = p_user_id AND amp.feature = p_feature;

  IF v_pref_model_id IS NOT NULL THEN
    RETURN QUERY
    SELECT ap.provider_code, am.model_id, am.name, ap.api_endpoint, ap.api_key_env_var, ap.api_type, ap.supports_streaming
    FROM public.ai_models am JOIN public.ai_providers ap ON ap.id = am.provider_id
    WHERE am.id = v_pref_model_id AND am.is_active AND ap.is_active LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT ss.value INTO v_system_default FROM public.system_settings ss WHERE ss.key = 'default_ai_model_' || p_feature;
  IF v_system_default IS NOT NULL THEN
    RETURN QUERY
    SELECT ap.provider_code, am.model_id, am.name, ap.api_endpoint, ap.api_key_env_var, ap.api_type, ap.supports_streaming
    FROM public.ai_models am JOIN public.ai_providers ap ON ap.id = am.provider_id
    WHERE ap.provider_code = (v_system_default->>'provider_code') AND am.model_id = (v_system_default->>'model_id') AND am.is_active AND ap.is_active LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT ss.value INTO v_system_default FROM public.system_settings ss WHERE ss.key = 'default_ai_model';
  IF v_system_default IS NOT NULL THEN
    RETURN QUERY
    SELECT ap.provider_code, am.model_id, am.name, ap.api_endpoint, ap.api_key_env_var, ap.api_type, ap.supports_streaming
    FROM public.ai_models am JOIN public.ai_providers ap ON ap.id = am.provider_id
    WHERE ap.provider_code = (v_system_default->>'provider_code') AND am.model_id = (v_system_default->>'model_id') AND am.is_active AND ap.is_active LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN QUERY SELECT 'gemini'::TEXT, 'gemini-3.1-flash-lite'::TEXT, 'Gemini 3.1 Flash Lite (Fallback)'::TEXT,
    'https://generativelanguage.googleapis.com/v1beta'::TEXT, 'GOOGLE_AI_STUDIO_KEY'::TEXT, 'google'::TEXT, true::BOOLEAN;
END;
$function$;
