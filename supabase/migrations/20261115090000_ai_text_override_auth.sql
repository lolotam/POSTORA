-- Phase 5 expand first. Operators MUST pause feature_ai_text_auth_lists=false
-- before applying, then deploy the auth-aware boundary and runtime before UI.
-- Do not roll back this writer/guard/column while OAuth override rows exist.
BEGIN;
ALTER TABLE public.user_ai_model_overrides
  ADD COLUMN auth_method text NOT NULL DEFAULT 'api_key'
  CONSTRAINT user_ai_model_overrides_auth_method_check CHECK (auth_method IN ('api_key','oauth'));

CREATE FUNCTION public.guard_ai_model_override_auth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Marker, NEVER provider/model differences: same-model legacy re-saves are API.
  IF COALESCE(current_setting('postora.auth_aware_override_writer',true),'') <> 'on'
    OR COALESCE(auth.role(),'') <> 'service_role' THEN
    NEW.auth_method := 'api_key';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ai_model_override_auth() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_ai_model_override_auth BEFORE INSERT OR UPDATE ON public.user_ai_model_overrides
FOR EACH ROW EXECUTE FUNCTION public.guard_ai_model_override_auth();

-- The boundary calls this only after an authenticated platform-admin check.
-- RLS remains authoritative for old API-only clients; no browser may call this RPC.
CREATE FUNCTION public.write_ai_model_override(p_user_id uuid, p_value jsonb, p_expected jsonb, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  observed jsonb;
  method text;
  previous_marker text := current_setting('postora.auth_aware_override_writer',true);
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role'
    OR NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=p_actor AND role='admin') THEN
    RAISE EXCEPTION 'Admin required' USING ERRCODE='42501';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'Invalid override user'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-model-override:' || p_user_id::text,0));
  SELECT to_jsonb(o) INTO observed FROM public.user_ai_model_overrides o WHERE user_id=p_user_id;
  IF observed IS DISTINCT FROM p_expected THEN RETURN false; END IF;
  IF p_value IS NULL OR p_value='null'::jsonb THEN
    DELETE FROM public.user_ai_model_overrides WHERE user_id=p_user_id;
    RETURN true;
  END IF;
  IF jsonb_typeof(p_value) <> 'object' OR NOT p_value ?& ARRAY['provider_code','model_id']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE k NOT IN ('provider_code','model_id','auth_method','expires_at','reason'))
    OR jsonb_typeof(p_value->'provider_code') <> 'string' OR length(btrim(p_value->>'provider_code')) NOT BETWEEN 1 AND 120
    OR jsonb_typeof(p_value->'model_id') <> 'string' OR length(btrim(p_value->>'model_id')) NOT BETWEEN 1 AND 300
    OR (p_value ? 'auth_method' AND (jsonb_typeof(p_value->'auth_method') <> 'string' OR p_value->>'auth_method' NOT IN ('api_key','oauth')))
    THEN RAISE EXCEPTION 'Invalid override selection'; END IF;
  method := COALESCE(p_value->>'auth_method','api_key');
  IF method='oauth' AND (
    NOT COALESCE((SELECT value='true'::jsonb FROM public.system_settings WHERE key='feature_ai_text_auth_lists'),false)
    OR NOT COALESCE((SELECT value='true'::jsonb FROM public.system_settings WHERE key='feature_ai_provider_oauth'),false)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.user_ai_model_overrides'::regclass AND tgname='guard_ai_model_override_auth' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM public.ai_provider_oauth_connections WHERE provider_code=p_value->>'provider_code' AND status='connected')
  ) THEN RAISE EXCEPTION 'OAuth overrides unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ai_providers WHERE provider_code=p_value->>'provider_code' AND is_active) THEN RAISE EXCEPTION 'Inactive override provider'; END IF;
  -- API catalogue validation also protects accidental service-only callers.
  -- OAuth registry/provisional eligibility is validated by the admin boundary.
  IF method='api_key' AND NOT EXISTS(
    SELECT 1 FROM public.ai_models m JOIN public.ai_providers p ON p.id=m.provider_id
    WHERE p.provider_code=p_value->>'provider_code' AND m.model_id=p_value->>'model_id'
      AND m.auth_method='api_key' AND m.is_active AND 'chat'=ANY(m.capabilities)
  ) THEN RAISE EXCEPTION 'Invalid override model'; END IF;
  PERFORM set_config('postora.auth_aware_override_writer','on',true);
  INSERT INTO public.user_ai_model_overrides(user_id,provider,model,auth_method,expires_at,reason,created_by)
  VALUES(p_user_id,p_value->>'provider_code',p_value->>'model_id',method,(p_value->>'expires_at')::timestamptz,p_value->>'reason',p_actor)
  ON CONFLICT(user_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model,auth_method=EXCLUDED.auth_method,
    expires_at=EXCLUDED.expires_at,reason=EXCLUDED.reason;
  -- A later legacy statement in this SAME transaction must still reset to API.
  PERFORM set_config('postora.auth_aware_override_writer',COALESCE(previous_marker,''),true);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.write_ai_model_override(uuid,jsonb,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_ai_model_override(uuid,jsonb,jsonb,uuid) TO service_role;
COMMIT;
