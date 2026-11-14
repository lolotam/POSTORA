-- Keep existing contracts; bootstrap provenance requires a durable, same-owner verification receipt.
BEGIN;
CREATE FUNCTION public.analytics_bootstrap_require_verified_binding(p_account uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings b WHERE b.social_account_id=p_account
  AND b.evidence_source='verified_legacy_bootstrap') AND NOT public.analytics_bootstrap_binding_verified(p_account) THEN
  RAISE EXCEPTION 'BOOTSTRAP_PROVENANCE_UNVERIFIED' USING ERRCODE='FUC03'; END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_require_verified_binding(uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.read_facebook_user_account_credential(uuid,uuid) RENAME TO analytics_bootstrap_previous_account_credential;
CREATE FUNCTION public.read_facebook_user_account_credential(p_user_id uuid,p_social_account_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 PERFORM public.analytics_bootstrap_require_verified_binding(p_social_account_id);
 RETURN public.analytics_bootstrap_previous_account_credential(p_user_id,p_social_account_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_account_credential(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_facebook_user_account_credential(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_facebook_user_account_credential(uuid,uuid) TO service_role;

-- Refresh's capture delegates to the OAuth capture, so both see this same provenance check.
ALTER FUNCTION public.meta_oauth_attempt_capture_account(uuid,uuid) RENAME TO analytics_bootstrap_previous_oauth_capture;
CREATE FUNCTION public.meta_oauth_attempt_capture_account(p_user_id uuid,p_social_account_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
 PERFORM public.analytics_bootstrap_require_verified_binding(p_social_account_id);
 RETURN public.analytics_bootstrap_previous_oauth_capture(p_user_id,p_social_account_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_oauth_capture(uuid,uuid),public.meta_oauth_attempt_capture_account(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.meta_oauth_attempt_require_captured_account(uuid,jsonb) RENAME TO analytics_bootstrap_previous_oauth_require;
CREATE FUNCTION public.meta_oauth_attempt_require_captured_account(p_user_id uuid,p_capture jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
 PERFORM public.analytics_bootstrap_require_verified_binding((p_capture->>'social_account_id')::uuid);
 PERFORM public.analytics_bootstrap_previous_oauth_require(p_user_id,p_capture);
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_oauth_require(uuid,jsonb),public.meta_oauth_attempt_require_captured_account(uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.meta_account_refresh_require_captured_account(uuid,jsonb) RENAME TO analytics_bootstrap_previous_refresh_require;
CREATE FUNCTION public.meta_account_refresh_require_captured_account(p_user_id uuid,p_capture jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
 PERFORM public.analytics_bootstrap_require_verified_binding((p_capture->>'social_account_id')::uuid);
 PERFORM public.analytics_bootstrap_previous_refresh_require(p_user_id,p_capture);
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_refresh_require(uuid,jsonb),public.meta_account_refresh_require_captured_account(uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.facebook_user_credential_status(uuid,uuid) RENAME TO analytics_bootstrap_previous_credential_status;
CREATE FUNCTION public.facebook_user_credential_status(p_user_id uuid,p_credential_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE account_id uuid;
BEGIN
 FOR account_id IN SELECT social_account_id FROM public.facebook_user_credential_bindings WHERE user_id=p_user_id AND credential_id=p_credential_id LOOP
  PERFORM public.analytics_bootstrap_require_verified_binding(account_id);
 END LOOP;
 RETURN public.analytics_bootstrap_previous_credential_status(p_user_id,p_credential_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_credential_status(uuid,uuid),public.facebook_user_credential_status(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
