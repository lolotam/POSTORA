-- Admission bootstrap for the platform-owned analytics workers. No activation.
BEGIN;

CREATE FUNCTION public.meta_analytics_admission_credential(
  p_platform text,p_account_id uuid,p_expected_authority jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_prepared jsonb;v_authority jsonb;v_token text;v_permission_token text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  SELECT user_id INTO v_owner FROM public.social_accounts WHERE id=p_account_id AND platform=p_platform;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  -- Preparation acquires the existing account/advisory locks and checks rollout.
  -- Its monotonic guard/epoch cannot be replaced with an unfenced table read.
  IF p_platform='facebook' THEN
    v_prepared:=public.prepare_fb_analytics_account(v_owner,p_account_id);
  ELSIF p_platform='threads' THEN
    v_prepared:=public.prepare_threads_analytics_account(v_owner,p_account_id);
  ELSE RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  v_authority:=v_prepared->'authority';
  IF p_expected_authority IS NOT NULL AND p_expected_authority IS DISTINCT FROM v_authority THEN
    RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_CHANGED' USING ERRCODE='MAH04'; END IF;
  SELECT access_token INTO v_token FROM public.social_accounts
    WHERE id=p_account_id AND user_id=v_owner AND platform=p_platform;
  IF p_platform='facebook' THEN
    SELECT token INTO v_permission_token FROM public.facebook_user_credentials
      WHERE id=(v_authority->>'credential_id')::uuid AND user_id=v_owner
        AND revision=(v_authority->>'credential_revision')::bigint AND lifecycle='active'
        AND (token_expires_at IS NULL OR token_expires_at>clock_timestamp());
    IF NULLIF(btrim(v_permission_token),'') IS NULL THEN
      RAISE EXCEPTION 'META_ANALYTICS_REAUTH_REQUIRED' USING ERRCODE='MAH03'; END IF;
  ELSE v_permission_token:=v_token; END IF;
  RETURN jsonb_build_object('account_id',p_account_id,'user_id',v_owner,'authority',v_authority,
    'access_token',v_token,'permission_token',v_permission_token);
END;
$fn$;

CREATE FUNCTION public.read_fb_analytics_admission_credential(
  p_account_id uuid,p_expected_authority jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
  SELECT public.meta_analytics_admission_credential('facebook',p_account_id,p_expected_authority);
$fn$;
CREATE FUNCTION public.read_threads_analytics_admission_credential(
  p_account_id uuid,p_expected_authority jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
  SELECT public.meta_analytics_admission_credential('threads',p_account_id,p_expected_authority);
$fn$;

REVOKE ALL ON FUNCTION public.meta_analytics_admission_credential(text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_fb_analytics_admission_credential(uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.read_threads_analytics_admission_credential(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_fb_analytics_admission_credential(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_threads_analytics_admission_credential(uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
