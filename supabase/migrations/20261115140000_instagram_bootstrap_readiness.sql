-- Report-only correction: accept receipt-verified bootstrap authority just as
-- the collection reader does. A provenance label alone is never identity proof.
BEGIN;

CREATE OR REPLACE FUNCTION public.analytics_bootstrap_previous_readiness_snapshot(p_platform text,p_owner uuid,p_account uuid,p_observed_at timestamptz,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='10s' AS $fn$
DECLARE
  a public.social_accounts; c public.instagram_account_capabilities;
  o public.fb_analytics_permission_observations;
  v_enabled jsonb; v_policy jsonb; v_normal jsonb; v_ids jsonb; v_authority jsonb;
  v_reason text; v_source text; v_state text; v_action text:='wait'; v_reconnect boolean:=false;
  v_connection text:='verified'; v_connection_reason text; v_permission text:='unknown';
  v_permission_at timestamptz; v_verified_at timestamptz; v_missing text[]:='{}'; v_required text[];
  v_credential record; v_route boolean:=false; v_retry timestamptz;
BEGIN
  -- Internal-only helper; callable snapshots establish their owner first.
  IF p_owner IS NULL OR p_platform NOT IN ('instagram','facebook') THEN
    RAISE EXCEPTION 'REPORT_INVALID_REQUEST' USING ERRCODE='MAH01'; END IF;
  SELECT * INTO a FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  SELECT COALESCE((SELECT value='"protected"'::jsonb FROM public.app_settings WHERE key='credential_facebook_user_mode'),false)
    OR COALESCE((SELECT jsonb_typeof(value)='array' AND value @> jsonb_build_array(p_owner::text)
      FROM public.app_settings WHERE key='credential_facebook_user_protected_pilot_user_ids'),false) INTO v_route;

  -- Policy parsers are the same pure parsers used by collection. Do not call
  -- VOLATILE admission/enqueue functions from a report read.
  BEGIN
    SELECT value INTO v_enabled FROM public.app_settings WHERE key=CASE p_platform
      WHEN 'instagram' THEN 'collection_instagram_insights_enabled' ELSE 'collection_facebook_analytics_enabled' END;
    -- Match the owner intake's legacy JSON string and absent-value semantics.
    IF p_platform='instagram' AND (v_enabled IS NULL OR v_enabled='null'::jsonb) THEN v_enabled:='false'::jsonb;
    ELSIF p_platform='instagram' AND jsonb_typeof(v_enabled)='string' THEN
      v_enabled:=CASE lower(btrim(v_enabled#>>'{}')) WHEN 'true' THEN 'true'::jsonb WHEN 'false' THEN 'false'::jsonb WHEN '' THEN 'false'::jsonb ELSE v_enabled END;
    END IF;
    IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
      v_reason:='settings_unavailable';
    ELSIF v_enabled='false'::jsonb THEN v_reason:='collection_disabled';
    ELSE
      SELECT value INTO v_policy FROM public.app_settings WHERE key=CASE p_platform
        WHEN 'instagram' THEN 'collection_instagram_rollout_policy' ELSE 'collection_facebook_analytics_policy' END;
      IF p_platform='instagram' THEN
        v_normal:=public.ig_collection_rollout_normalize_policy(v_policy);
        IF v_normal->>'owner_mode'='off' OR (v_normal->>'owner_mode'='allowlist' AND NOT (v_normal->'owner_ids' @> jsonb_build_array(p_account::text))) THEN
          v_reason:='collection_not_eligible'; END IF;
      ELSE
        v_normal:=public.fb_analytics_normalize_policy(v_policy);
        IF v_normal->>'mode'='off' THEN v_reason:='collection_disabled';
        ELSIF v_normal->>'mode'='allowlist' AND NOT (v_normal->'account_ids' @> jsonb_build_array(p_account::text)) THEN
          v_reason:='collection_not_eligible'; END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN v_reason:='settings_unavailable'; END;
  v_source:=CASE WHEN v_reason='settings_unavailable' THEN 'configuration' WHEN v_reason IS NOT NULL THEN 'rollout_policy' END;

  IF NULLIF(btrim(a.platform_user_id),'') IS NULL THEN
    v_connection:='invalid'; v_connection_reason:='account_identity_invalid';
  ELSIF NOT COALESCE(a.is_active,false) THEN
    v_connection:='invalid'; v_connection_reason:='account_inactive';
  ELSIF COALESCE(a.needs_reauth,false) OR a.token_expires_at<=p_observed_at OR NULLIF(btrim(a.access_token),'') IS NULL THEN
    v_connection:='invalid'; v_connection_reason:='token_invalid';
  END IF;

  IF p_platform='instagram' THEN
    SELECT * INTO c FROM public.instagram_account_capabilities WHERE social_account_id=p_account AND user_id=p_owner;
    IF NOT FOUND OR c.credential_generation IS NULL OR c.credential_generation<1 THEN
      IF v_connection_reason IS NULL THEN v_connection:='unverified'; v_connection_reason:='bootstrap_required'; END IF;
    ELSE
      v_required:=CASE WHEN c.login_kind='direct' THEN ARRAY['instagram_business_manage_insights'] ELSE ARRAY['instagram_manage_insights'] END;
      v_permission_at:=c.scopes_read_at;
      IF c.permission_read_state='ok' AND c.scopes_read_at IS NOT NULL AND c.scopes_read_at<=p_observed_at THEN
        v_verified_at:=c.scopes_read_at;
        SELECT COALESCE(array_agg(s),'{}') INTO v_missing FROM unnest(v_required) s WHERE NOT (s=ANY(c.granted_scopes));
        v_permission:=CASE WHEN cardinality(v_missing)>0 THEN 'missing' ELSE 'verified' END;
      ELSIF c.permission_read_state='failed' THEN v_permission:='unavailable'; END IF;
      IF c.login_kind='page_linked' AND v_connection_reason IS NULL THEN
        SELECT g.lifecycle,g.token_expires_at,NULLIF(btrim(g.token),'') IS NOT NULL AS token_present,
          (b.evidence_source='migrated_instagram_account_credential' OR
            (b.connection_version=f.connection_version AND b.verified_facebook_user_id=g.provider_user_id
              AND b.verified_instagram_user_id=a.platform_user_id
              AND (b.evidence_source IN ('oauth_exchange','token_refresh')
                OR b.evidence_source='verified_legacy_bootstrap' AND public.analytics_bootstrap_binding_verified(p_account)))) AS identity_matches
        INTO v_credential FROM public.facebook_user_credential_bindings b
        LEFT JOIN public.facebook_user_credential_connection_fences f USING(social_account_id,user_id,platform)
        JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
        WHERE b.social_account_id=p_account AND b.user_id=p_owner AND b.platform='instagram';
        IF NOT FOUND THEN v_connection:='unverified'; v_connection_reason:='bootstrap_required';
        ELSIF NOT COALESCE(v_credential.identity_matches,false) THEN v_connection:='invalid'; v_connection_reason:='identity_mismatch';
        ELSIF v_credential.lifecycle<>'active' OR NOT v_credential.token_present OR v_credential.token_expires_at<=p_observed_at THEN
          v_connection:='invalid'; v_connection_reason:='token_invalid'; END IF;
      END IF;
    END IF;
  ELSE
    -- Reproduce the current authority's nonsecret version projection without
    -- executing the VOLATILE credential reader or returning credential IDs.
    SELECT g.lifecycle,g.token_expires_at,NULLIF(btrim(g.token),'') IS NOT NULL AS token_present,
      b.connection_version=f.connection_version AND b.verified_facebook_user_id=g.provider_user_id
        AND g.provider_user_id IS NOT NULL AND (b.evidence_source IN ('oauth_exchange','token_refresh')
          OR b.evidence_source='verified_legacy_bootstrap' AND public.analytics_bootstrap_binding_verified(p_account)) AS identity_matches,
      jsonb_build_object('platform_user_id',a.platform_user_id,'connection_version',f.connection_version,
        'credential_id',g.id,'credential_revision',g.revision,'provider_user_id',g.provider_user_id,'token_expires_at',a.token_expires_at) AS authority
    INTO v_credential FROM public.facebook_user_credential_bindings b
    JOIN public.facebook_user_credential_connection_fences f USING(social_account_id,user_id,platform)
    JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
    WHERE b.social_account_id=p_account AND b.user_id=p_owner AND b.platform='facebook';
    IF NOT FOUND THEN
      IF v_connection_reason IS NULL THEN v_connection:='unverified'; v_connection_reason:='bootstrap_required'; END IF;
    ELSE
      v_authority:=v_credential.authority;
      IF v_connection_reason IS NULL THEN
        IF NOT COALESCE(v_credential.identity_matches,false) THEN v_connection:='invalid'; v_connection_reason:='identity_mismatch';
        ELSIF v_credential.lifecycle<>'active' OR NOT v_credential.token_present OR v_credential.token_expires_at<=p_observed_at THEN
          v_connection:='invalid'; v_connection_reason:='token_invalid'; END IF;
      END IF;
      SELECT * INTO o FROM public.fb_analytics_permission_observations
        WHERE social_account_id=p_account AND user_id=p_owner AND authority=v_authority
          AND observed_at<=p_observed_at;
      -- Freshness governs admission today; supersession is monotonic across days.
      IF FOUND AND o.state='verified' THEN v_verified_at:=o.observed_at; END IF;
      IF FOUND AND (o.observed_at AT TIME ZONE 'America/Los_Angeles')::date=(p_observed_at AT TIME ZONE 'America/Los_Angeles')::date THEN
        v_permission_at:=o.observed_at;
        IF o.state='verified' THEN
          SELECT COALESCE(array_agg(s),'{}') INTO v_missing FROM unnest(ARRAY['read_insights','pages_read_engagement']) s WHERE NOT (s=ANY(o.granted_scopes));
          v_permission:=CASE WHEN cardinality(v_missing)>0 THEN 'missing' ELSE 'verified' END;
        ELSE v_permission:='unavailable'; END IF;
      END IF;
    END IF;
  END IF;

  -- Current authority is established independently of the winning policy reason.
  -- A newer successful permission read retires a refusal, even on a later day.
  -- Instagram settles these provider errors as unavailable, Facebook as failed.
  -- A diagnosed connection refusal wins collection precedence, but must not
  -- hide independent permission evidence from the same current authority.
  IF COALESCE((p_attempt->>'context_current')::boolean,false)
    AND ((p_platform='facebook' AND p_attempt->>'state'='failed')
      OR (p_platform='instagram' AND p_attempt->>'state'='unavailable'))
    AND (p_attempt->>'observed_at')::timestamptz<=p_observed_at
    AND (p_attempt->>'observed_at')::timestamptz>=COALESCE(v_verified_at,'-infinity'::timestamptz) THEN
    IF v_connection_reason IS NULL AND p_attempt->>'reason_code' IN ('reauth_required','token_invalid') THEN
      v_connection:='invalid'; v_connection_reason:='token_invalid';
    ELSIF p_attempt->>'reason_code' IN ('permission_missing','scope_missing') THEN
      v_permission:='missing'; v_permission_at:=(p_attempt->>'observed_at')::timestamptz;
      v_missing:='{}';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    IF v_connection_reason IS NOT NULL THEN v_reason:=v_connection_reason; v_source:='connection';
    ELSIF v_permission IN ('unknown','unavailable') THEN v_reason:='permission_verification_pending'; v_source:='permission';
    ELSIF v_permission='missing' THEN v_reason:='permission_missing'; v_source:=CASE WHEN cardinality(v_missing)=0 THEN 'job' ELSE 'permission' END;
    ELSIF (p_attempt->>'state' IN ('queued','pending') OR COALESCE((p_attempt->>'context_current')::boolean,true)) AND p_attempt->>'state' IN ('queued','pending','running','leased','retry') THEN
      v_reason:=CASE p_attempt->>'state' WHEN 'pending' THEN 'queued' WHEN 'leased' THEN 'running' WHEN 'retry' THEN
        CASE WHEN p_attempt->>'reason_code' IN ('rate_limited','throttled') THEN 'rate_limited' ELSE 'provider_error' END
        ELSE p_attempt->>'state' END; v_source:='job';
    ELSE v_reason:='awaiting_first_capture'; v_source:='data'; END IF;
  END IF;
  v_state:=CASE WHEN v_reason IN ('collection_disabled','collection_not_eligible') THEN 'not_enabled'
    WHEN v_reason IN ('bootstrap_required','permission_verification_pending') THEN 'preparing'
    WHEN v_reason IN ('token_invalid','stored_user_credential_missing','reconnect_required') THEN 'needs_reconnect'
    WHEN v_reason='permission_missing' THEN 'permissions_missing'
    WHEN v_reason IN ('identity_mismatch','account_identity_invalid','app_mismatch','account_inactive') THEN 'needs_review'
    WHEN v_reason IN ('queued','running','awaiting_first_capture') THEN 'syncing'
    ELSE 'unavailable' END;
  IF v_reason IN ('queued','running','awaiting_first_capture','permission_verification_pending') THEN v_action:='wait';
  ELSIF v_reason IN ('token_invalid','stored_user_credential_missing','reconnect_required','permission_missing') AND v_route THEN
    v_action:=CASE WHEN v_reason='permission_missing' THEN 'grant_permissions' ELSE 'reconnect' END; v_reconnect:=true;
  ELSIF v_reason IN ('rate_limited','provider_error') THEN v_action:='retry_after';
  ELSE v_action:='contact_support'; END IF;
  v_retry:=CASE WHEN COALESCE((p_attempt->>'context_current')::boolean,true) THEN NULLIF(p_attempt->>'retry_at','')::timestamptz END;
  RETURN jsonb_build_object('collection',jsonb_build_object('contract_version',2,'state',v_state,'reason_code',v_reason,
    'reason_source',v_source,'observed_at',p_observed_at,'next_action',v_action,'reconnect_can_help',v_reconnect,
    'retry_at',v_retry,'support_correlation_id',gen_random_uuid()::text),
    'connection',jsonb_build_object('state',v_connection,'reason_code',v_connection_reason),
    'permission',jsonb_build_object('state',v_permission,'observed_at',v_permission_at,'missing_scopes',to_jsonb(v_missing)),
    'last_attempt',CASE WHEN p_attempt->>'observed_at' IS NULL THEN NULL ELSE
      jsonb_build_object('state',p_attempt->>'state','reason_code',p_attempt->>'reason_code','observed_at',p_attempt->>'observed_at') END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
