-- Correct the 2026-11-14 legacy direct identity incident. No app proof is fabricated.
-- Operator precondition: pause bootstrap and wait for its existing leases to drain.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';

CREATE OR REPLACE FUNCTION public.dispatch_analytics_legacy_bootstrap(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='4s' AS $fn$
DECLARE policy jsonb;ids uuid[];correlation uuid:=gen_random_uuid();
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 BEGIN policy:=public.analytics_bootstrap_policy(); EXCEPTION WHEN OTHERS THEN
  PERFORM public.analytics_bootstrap_audit(correlation,NULL,'dispatch','settings_unavailable');
  RETURN jsonb_build_object('status','settings_unavailable','account_ids','[]'::jsonb); END;
 IF policy IS NULL THEN
  PERFORM public.analytics_bootstrap_audit(correlation,NULL,'dispatch','disabled');
  RETURN jsonb_build_object('status','disabled','account_ids','[]'::jsonb); END IF;
 UPDATE public.analytics_legacy_bootstrap_run SET holder=p_run_id,lease_until=clock_timestamp()+interval '45 seconds',calls=0,account_ids='{}'
 WHERE singleton AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND (pause_until IS NULL OR pause_until<=clock_timestamp());
 IF NOT FOUND THEN
  PERFORM public.analytics_bootstrap_audit(correlation,NULL,'dispatch','busy_or_paused');
  RETURN jsonb_build_object('status','busy_or_paused','account_ids','[]'::jsonb); END IF;
 SELECT array_agg(id ORDER BY priority,changed,id) INTO ids FROM (
  SELECT a.id,CASE WHEN j.state='permission_pending' THEN 0 ELSE 1 END priority,COALESCE(j.updated_at,'epoch'::timestamptz) changed
  FROM public.social_accounts a LEFT JOIN public.analytics_legacy_bootstrap_jobs j ON j.social_account_id=a.id
  WHERE policy->'account_ids' @> jsonb_build_array(a.id::text) AND a.platform IN ('instagram','facebook')
   AND (j.id IS NULL OR (SELECT count(*) FROM unnest(j.attempt_times) t WHERE t>clock_timestamp()-interval '24 hours')
    <(policy->>'max_attempts_per_account_per_day')::integer)
   AND (j.id IS NULL OR (j.state IN ('pending','verifying','permission_pending','retry') OR
     j.reason_code IN ('stored_user_credential_missing','linked_page_missing','linked_page_unavailable')
      AND j.input_fence IS DISTINCT FROM public.analytics_bootstrap_fence(j.social_account_id,j.source_account_id,j.source_credential_id) OR
     -- A restored Page can have a new row ID while the target is unchanged.
     -- Begin rediscovers and locks its complete fence before claiming work.
     j.reason_code IN ('linked_page_missing','linked_page_unavailable') AND j.source_account_id IS DISTINCT FROM (
      SELECT page_source.id FROM public.social_accounts page_source
      WHERE page_source.user_id=a.user_id AND page_source.platform='facebook'
       AND page_source.platform_user_id=CASE WHEN a.platform='facebook' THEN a.platform_user_id ELSE COALESCE(
        (SELECT b.verified_facebook_page_id FROM public.facebook_user_credential_bindings b WHERE b.social_account_id=a.id AND b.user_id=a.user_id),
        a.account_metadata->>'facebook_page_id') END
      ORDER BY page_source.id LIMIT 1) OR
     EXISTS(SELECT 1 FROM public.instagram_account_capabilities c WHERE c.social_account_id=a.id AND c.credential_generation>j.captured_generation) OR
     EXISTS(SELECT 1 FROM public.facebook_user_credential_connection_fences f WHERE f.social_account_id=a.id AND f.connection_version>j.captured_connection)) AND
    (j.retry_at IS NULL OR j.retry_at<=clock_timestamp()) AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp()))
  ORDER BY priority,changed,a.id LIMIT (policy->>'max_accounts_per_run')::integer) targets;
 UPDATE public.analytics_legacy_bootstrap_run SET account_ids=COALESCE(ids,'{}') WHERE singleton AND holder=p_run_id;
 PERFORM public.analytics_bootstrap_audit(correlation,NULL,'dispatch','dispatched');
 RETURN jsonb_build_object('status','dispatched','account_ids',COALESCE(to_jsonb(ids),'[]'::jsonb));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.begin_analytics_legacy_bootstrap(p_account_id uuid,p_idempotency_key uuid,p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='4s' AS $fn$
DECLARE a public.social_accounts;source public.social_accounts;j public.analytics_legacy_bootstrap_jobs;
 policy jsonb;page text;kind text;credential uuid;bound_ids uuid[];candidate text;provider text;discovered_fence text;
 existing_authority boolean;current_installed boolean;candidate_source text;correlation uuid:=gen_random_uuid();
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 BEGIN policy:=public.analytics_bootstrap_policy(); EXCEPTION WHEN OTHERS THEN
  PERFORM public.analytics_bootstrap_audit(correlation,p_account_id,'begin','settings_unavailable');
  RETURN jsonb_build_object('state','blocked','reason_code','settings_unavailable'); END;
 IF policy IS NULL OR NOT policy->'account_ids' @> jsonb_build_array(p_account_id::text) OR p_idempotency_key IS NULL OR
  NOT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_run WHERE holder=p_run_id AND lease_until>clock_timestamp()
   AND p_account_id=ANY(account_ids)
   AND (pause_until IS NULL OR pause_until<=clock_timestamp())) THEN
  PERFORM public.analytics_bootstrap_audit(correlation,p_account_id,'begin','not_authorized');
  RETURN jsonb_build_object('state','blocked','reason_code','not_authorized'); END IF;
 SELECT * INTO a FROM public.social_accounts WHERE id=p_account_id AND platform IN ('instagram','facebook');
 IF NOT FOUND THEN
  PERFORM public.analytics_bootstrap_audit(correlation,NULL,'begin','account_not_found');
  RETURN jsonb_build_object('state','blocked','reason_code','account_not_found'); END IF;
 SELECT * INTO j FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=a.id;
 IF FOUND AND j.idempotency_key=p_idempotency_key THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'reconcile','existing_attempt');
  RETURN public.analytics_bootstrap_projection(j.id); END IF;
 page:=CASE WHEN a.platform='facebook' THEN a.platform_user_id ELSE a.account_metadata->>'facebook_page_id' END;
 IF a.platform='instagram' THEN
  SELECT COALESCE(b.verified_facebook_page_id,page) INTO page FROM (SELECT 1) singleton
   LEFT JOIN public.facebook_user_credential_bindings b ON b.social_account_id=a.id AND b.user_id=a.user_id;
 END IF;
 SELECT c.login_kind INTO kind FROM public.instagram_account_capabilities c WHERE c.social_account_id=a.id;
 kind:=COALESCE(kind,CASE WHEN a.platform='instagram' AND (a.ig_auth_type='business_login' OR page IS NULL) THEN 'direct' ELSE 'page_linked' END);
 IF kind='direct' THEN page:=NULL; END IF;
 IF kind='direct' THEN source:=a;
 ELSE
  SELECT * INTO source FROM public.social_accounts WHERE user_id=a.user_id AND platform='facebook' AND platform_user_id=page
   ORDER BY id LIMIT 1;
 END IF;
 -- Prefer the target only among usable grants, before discovering the lock set
 -- and capturing its fence. A source fallback still requires provider verification.
 SELECT b.credential_id INTO credential FROM public.facebook_user_credential_bindings b
  JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
  WHERE b.user_id=a.user_id AND b.social_account_id IN(a.id,source.id) AND c.lifecycle='active'
   AND (c.token_expires_at IS NULL OR c.token_expires_at>clock_timestamp()) AND NULLIF(btrim(c.token),'') IS NOT NULL
  ORDER BY (b.social_account_id=a.id) DESC LIMIT 1;
 SELECT array_agg(DISTINCT id ORDER BY id) INTO bound_ids FROM (
  SELECT a.id UNION SELECT source.id UNION SELECT b.social_account_id FROM public.facebook_user_credential_bindings b
   WHERE b.credential_id=credential AND b.user_id=a.user_id) all_accounts WHERE id IS NOT NULL;
 discovered_fence:=public.analytics_bootstrap_fence(a.id,source.id,credential);
 PERFORM public.meta_account_refresh_lock_scope(a.user_id,bound_ids,CASE WHEN credential IS NULL THEN '{}'::uuid[] ELSE ARRAY[credential] END);
 IF discovered_fence IS DISTINCT FROM public.analytics_bootstrap_fence(a.id,source.id,credential) THEN RAISE EXCEPTION 'BOOTSTRAP_SOURCE_CHANGED'; END IF;
 -- Reread discovered sources under the established account -> advisory -> credential order.
 IF EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings b WHERE b.credential_id=credential AND b.user_id=a.user_id
   AND NOT b.social_account_id=ANY(bound_ids)) THEN RAISE EXCEPTION 'BOOTSTRAP_SOURCE_CHANGED'; END IF;
 SELECT * INTO a FROM public.social_accounts WHERE id=p_account_id AND user_id=a.user_id;
 SELECT * INTO source FROM public.social_accounts WHERE id=source.id AND user_id=a.user_id;
 candidate_source:=CASE WHEN kind='direct' THEN 'direct' ELSE 'legacy_page' END;
 IF credential IS NOT NULL THEN
  SELECT CASE WHEN c.token_expires_at IS NULL OR c.token_expires_at>clock_timestamp() THEN c.token END,c.provider_user_id
   INTO candidate,provider FROM public.facebook_user_credentials c WHERE c.id=credential AND c.user_id=a.user_id AND c.lifecycle='active';
  IF candidate IS NOT NULL THEN candidate_source:='protected'; END IF;
 END IF;
 IF candidate_source='direct' THEN candidate:=a.access_token;
 ELSIF candidate_source='legacy_page' THEN candidate:=source.account_metadata->>'user_token'; END IF;
 existing_authority:=EXISTS(SELECT 1 FROM public.instagram_account_capabilities cap WHERE cap.social_account_id=a.id
  AND cap.credential_generation>0 AND cap.credential_updated_at IS NOT NULL AND candidate_source IN ('direct','protected') AND
   (cap.login_kind='direct' OR EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings b JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
    WHERE b.social_account_id=a.id AND b.user_id=a.user_id AND c.id=credential AND b.verified_facebook_user_id=c.provider_user_id AND
     b.verified_instagram_user_id=a.platform_user_id AND b.verified_facebook_page_id=page AND
     (b.evidence_source IN ('oauth_exchange','token_refresh') OR public.analytics_bootstrap_binding_verified(a.id)))));
 INSERT INTO public.analytics_legacy_bootstrap_jobs(social_account_id,user_id,platform,login_kind,idempotency_key)
  VALUES(a.id,a.user_id,a.platform,kind,p_idempotency_key) ON CONFLICT(social_account_id) DO NOTHING;
 SELECT * INTO j FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=a.id FOR UPDATE;
 current_installed:=existing_authority OR (a.platform='facebook' AND candidate_source='protected' AND EXISTS(
  SELECT 1 FROM public.facebook_user_credential_bindings b JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
   JOIN public.facebook_user_credential_connection_fences f ON f.social_account_id=b.social_account_id AND f.user_id=b.user_id AND f.platform=b.platform
   WHERE b.social_account_id=a.id AND b.user_id=a.user_id AND c.id=credential AND b.connection_version=f.connection_version
    AND b.verified_facebook_user_id=c.provider_user_id AND c.provider_user_id IS NOT NULL AND
     (b.evidence_source IN ('oauth_exchange','token_refresh') OR public.analytics_bootstrap_binding_verified(a.id))));
 IF current_installed IS DISTINCT FROM j.installed THEN
  UPDATE public.analytics_legacy_bootstrap_jobs SET installed=current_installed,
   installed_at=CASE WHEN current_installed THEN clock_timestamp() ELSE NULL END WHERE id=j.id RETURNING * INTO j;
 END IF;
 IF j.lease_until>clock_timestamp() OR j.state IN ('ready','needs_reconnect','permissions_missing','blocked') AND NOT (
   j.reason_code IN ('stored_user_credential_missing','linked_page_missing','linked_page_unavailable') AND j.input_fence IS DISTINCT FROM discovered_fence OR
   EXISTS(SELECT 1 FROM public.instagram_account_capabilities c WHERE c.social_account_id=a.id AND c.credential_generation>j.captured_generation) OR
   EXISTS(SELECT 1 FROM public.facebook_user_credential_connection_fences f WHERE f.social_account_id=a.id AND f.connection_version>j.captured_connection)) THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'begin','settled_or_busy'); RETURN public.analytics_bootstrap_projection(j.id); END IF;
 IF (SELECT count(*) FROM unnest(j.attempt_times) t WHERE t>clock_timestamp()-interval '24 hours') >= (policy->>'max_attempts_per_account_per_day')::integer
   OR j.retry_at>clock_timestamp() THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'begin','attempt_budget'); RETURN public.analytics_bootstrap_projection(j.id); END IF;
 IF NOT a.is_active OR COALESCE(a.needs_reauth,false) OR a.token_expires_at<=clock_timestamp() THEN
  j.state:='needs_reconnect';j.reason_code:='token_invalid';
 ELSIF NULLIF(btrim(a.platform_user_id),'') IS NULL THEN
  j.state:='blocked';j.reason_code:='account_identity_invalid';
 ELSIF kind='page_linked' AND NULLIF(btrim(page),'') IS NULL THEN
  j.state:='blocked';j.reason_code:='linked_page_missing';
 ELSIF kind='page_linked' AND candidate_source='legacy_page' AND
   (source.id IS NULL OR NOT source.is_active OR COALESCE(source.needs_reauth,false)) THEN
  j.state:='blocked';j.reason_code:='linked_page_unavailable';
 ELSIF NULLIF(candidate,'') IS NULL THEN j.state:='needs_reconnect';j.reason_code:='stored_user_credential_missing';
 ELSE j.state:=CASE WHEN j.installed THEN 'permission_pending' ELSE 'verifying' END;j.reason_code:='verification_pending'; END IF;
 UPDATE public.analytics_legacy_bootstrap_jobs SET state=j.state,reason_code=j.reason_code,login_kind=kind,
  source_account_id=source.id,source_credential_id=credential,idempotency_key=p_idempotency_key,
  source_kind=candidate_source,
  lease_id=CASE WHEN j.state IN ('verifying','permission_pending') THEN gen_random_uuid() ELSE NULL END,
  expected_app_id=NULL,
  lease_until=CASE WHEN j.state IN ('verifying','permission_pending') THEN clock_timestamp()+interval '40 seconds' ELSE NULL END,
  attempts=attempts+1,attempt_times=array_append(ARRAY(SELECT t FROM unnest(attempt_times) t WHERE t>clock_timestamp()-interval '24 hours'),clock_timestamp()),
  input_fence=public.analytics_bootstrap_fence(a.id,source.id,credential),revision=revision+1,updated_at=clock_timestamp()
  ,captured_generation=COALESCE((SELECT credential_generation FROM public.instagram_account_capabilities WHERE social_account_id=a.id),0)
  ,captured_connection=COALESCE((SELECT connection_version FROM public.facebook_user_credential_connection_fences WHERE social_account_id=a.id),0)
  WHERE id=j.id RETURNING * INTO j;
 PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'begin',j.reason_code);
 IF j.state NOT IN ('verifying','permission_pending') THEN RETURN public.analytics_bootstrap_projection(j.id); END IF;
 RETURN public.analytics_bootstrap_projection(j.id)||jsonb_build_object('lease_id',j.lease_id,'user_id',a.user_id,
  'run_id',p_run_id,
  'capture',jsonb_build_object('token',candidate,'platform',a.platform,'login_kind',kind,'platform_user_id',a.platform_user_id,
    'page_id',page,'provider_user_id',provider));
END;
$fn$;

-- Mirror OAuth authorize routing, including its strict global mode and whole
-- pilot-list validation. A malformed list must never advertise a legacy save
-- as a captured reconnect. This helper changes no rollout setting.
CREATE FUNCTION public.analytics_bootstrap_direct_reconnect_available(p_owner uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE raw_mode jsonb;mode text;pilot jsonb;
BEGIN
 SELECT value INTO raw_mode FROM public.app_settings WHERE key='credential_facebook_user_mode';
 IF raw_mode IS NULL OR raw_mode='null'::jsonb THEN mode:='legacy';
 ELSIF jsonb_typeof(raw_mode)<>'string' THEN RETURN false;
 ELSE mode:=COALESCE(NULLIF(lower(btrim(raw_mode#>>'{}')),''),'legacy'); END IF;
 IF mode NOT IN ('legacy','protected') THEN RETURN false; END IF;
 IF mode='protected' THEN RETURN true; END IF;
 SELECT value INTO pilot FROM public.app_settings WHERE key='credential_facebook_user_protected_pilot_user_ids';
 IF pilot IS NULL OR jsonb_typeof(pilot)<>'array' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(pilot) value WHERE jsonb_typeof(value)<>'string'
  OR lower(btrim(value#>>'{}')) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements_text(pilot) value WHERE lower(btrim(value))=p_owner::text);
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_direct_reconnect_available(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A reconnect is actionable only through the captured lifecycle route, never
-- through an unprotected legacy save. No setting is changed by this migration.
CREATE OR REPLACE FUNCTION public.analytics_bootstrap_projection(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object('job_id',j.id,'account_id',j.social_account_id,'state',j.state,'reason_code',j.reason_code,
  'correlation_id',j.correlation_id,'retry_at',j.retry_at,'revision',j.revision,'installed',j.installed,
  'next_action',CASE WHEN j.reason_code='direct_verification_unsupported' AND NOT route.enabled THEN 'support'
   WHEN j.state='needs_reconnect' THEN 'supported_reconnect' WHEN j.state='permissions_missing' THEN 'grant_permissions'
   WHEN j.state='blocked' THEN 'support' WHEN j.state='ready' THEN 'none' ELSE 'wait' END,
  'reconnect_path',CASE WHEN j.state IN ('needs_reconnect','permissions_missing')
   AND (j.reason_code IS DISTINCT FROM 'direct_verification_unsupported' OR route.enabled) THEN '/profiles' END)
 FROM public.analytics_legacy_bootstrap_jobs j CROSS JOIN LATERAL (
  SELECT public.analytics_bootstrap_direct_reconnect_available(j.user_id) AS enabled) route
 WHERE j.id=p_job;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_projection(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.settle_analytics_legacy_bootstrap(p_job_id uuid,p_lease_id uuid,p_revision bigint,p_reason text,p_retry_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='4s' AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 IF p_reason NOT IN ('token_invalid','permission_missing','app_mismatch','identity_mismatch','provider_error','provider_malformed',
  'rate_limited','budget_exhausted','direct_verification_unsupported','stale_capture') OR
  p_retry_at IS NOT NULL AND (NOT isfinite(p_retry_at) OR p_retry_at>clock_timestamp()+interval '7 days') THEN RAISE EXCEPTION 'BOOTSTRAP_INVALID_REASON'; END IF;
 -- A provider refusal belongs to the captured token/identity, not a replacement
 -- that arrived during the network call. Use the same parent/fence lock as install.
 BEGIN j:=public.analytics_bootstrap_lock_job(p_job_id,p_lease_id,p_revision);
 EXCEPTION WHEN SQLSTATE 'PAB01' OR no_data_found THEN
  PERFORM public.analytics_bootstrap_audit(gen_random_uuid(),NULL,'settle','stale_capture');
  RETURN jsonb_build_object('state','retry','reason_code','stale_capture'); END;
 UPDATE public.analytics_legacy_bootstrap_jobs SET state=CASE
   WHEN p_reason IN ('identity_mismatch','app_mismatch') THEN 'blocked'
   WHEN p_reason IN ('token_invalid','direct_verification_unsupported') THEN 'needs_reconnect'
   WHEN p_reason='permission_missing' THEN 'permissions_missing'
   WHEN installed THEN 'permission_pending' ELSE 'retry' END,
  reason_code=p_reason,retry_at=CASE WHEN p_reason IN ('provider_error','provider_malformed','rate_limited','budget_exhausted','stale_capture') THEN
   GREATEST(p_retry_at,clock_timestamp()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(attempts,6)))::integer+floor(random()*30)::integer)) END,
  lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp()
  WHERE id=j.id RETURNING * INTO j;
 IF p_reason='app_mismatch' THEN UPDATE public.analytics_legacy_bootstrap_run SET app_mismatches=app_mismatches+1,
   pause_until=CASE WHEN app_mismatches>=1 THEN clock_timestamp()+interval '1 day' ELSE pause_until END WHERE singleton; END IF;
 PERFORM public.analytics_bootstrap_audit(j.correlation_id,j.social_account_id,'settle',p_reason);
 RETURN public.analytics_bootstrap_projection(j.id);
END;
$fn$;

-- Preserve the policy/permission precedence in the canonical reader. A bootstrap
-- diagnosis is current only while its complete captured input fence still matches.
ALTER FUNCTION public.owner_analytics_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb)
 RENAME TO analytics_bootstrap_previous_readiness_snapshot;
CREATE FUNCTION public.owner_analytics_readiness_snapshot(p_platform text,p_owner uuid,p_account uuid,p_observed_at timestamptz,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='10s' AS $fn$
DECLARE result jsonb;j public.analytics_legacy_bootstrap_jobs;a public.social_accounts;reason text;route boolean;
BEGIN
 result:=public.analytics_bootstrap_previous_readiness_snapshot(p_platform,p_owner,p_account,p_observed_at,p_attempt);
 SELECT * INTO j FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=p_account AND user_id=p_owner AND platform=p_platform
  AND updated_at<=p_observed_at;
 IF NOT FOUND OR j.input_fence IS DISTINCT FROM public.analytics_bootstrap_fence(p_account,j.source_account_id,j.source_credential_id)
  OR result->'connection'->>'reason_code' IS DISTINCT FROM 'bootstrap_required' THEN RETURN result; END IF;
 SELECT * INTO a FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform;
 IF j.state='needs_reconnect' AND j.reason_code='direct_verification_unsupported' AND j.login_kind='direct' THEN
  reason:='direct_verification_unsupported';
 ELSIF j.state='blocked' AND j.reason_code IN ('account_identity_invalid','linked_page_missing','linked_page_unavailable') THEN
  -- Old jobs use the broad code; duplicates do not authorize guessing a Page.
  reason:=CASE WHEN j.reason_code IN ('linked_page_missing','linked_page_unavailable') THEN j.reason_code
   WHEN NULLIF(btrim(a.platform_user_id),'') IS NULL THEN 'account_identity_invalid'
   WHEN NULLIF(btrim(COALESCE((SELECT verified_facebook_page_id FROM public.facebook_user_credential_bindings
    WHERE social_account_id=a.id AND user_id=a.user_id),a.account_metadata->>'facebook_page_id')),'') IS NULL THEN 'linked_page_missing'
   ELSE 'linked_page_unavailable' END;
 ELSE RETURN result; END IF;
 route:=public.analytics_bootstrap_direct_reconnect_available(p_owner);
 result:=jsonb_set(result,'{collection,contract_version}','3'::jsonb);
 result:=jsonb_set(result,'{connection}',jsonb_build_object('state','unverified','reason_code',reason,
  'reconnect_path',CASE WHEN reason='direct_verification_unsupported' AND route THEN '/profiles' END));
 IF result->'collection'->>'reason_source'='connection' THEN
  result:=jsonb_set(result,'{collection}',result->'collection'||jsonb_build_object(
   'state',CASE WHEN reason='direct_verification_unsupported' THEN 'needs_reconnect' ELSE 'needs_review' END,
   'reason_code',reason,'next_action',CASE WHEN reason='direct_verification_unsupported' AND route THEN 'reconnect' ELSE 'contact_support' END,
   'reconnect_can_help',reason='direct_verification_unsupported' AND route,
   'support_correlation_id',j.correlation_id::text));
 END IF;
 RETURN result;
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_previous_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb),
 public.owner_analytics_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Internal, one-incident recovery. No raw tokens, usernames or fingerprints are
-- written to its audit; the existing account/correlation identifiers suffice.
CREATE FUNCTION public.analytics_bootstrap_direct_identity_incident_candidate(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_jobs j
  JOIN public.social_accounts a ON a.id=j.social_account_id AND a.user_id=j.user_id AND a.platform=j.platform
  WHERE j.id=p_job AND j.platform='instagram' AND j.login_kind='direct' AND j.source_kind='direct'
   AND j.source_account_id=a.id AND j.source_credential_id IS NULL AND NOT j.installed
   AND j.state='blocked' AND j.reason_code='identity_mismatch' AND j.lease_id IS NULL AND j.lease_until IS NULL
   AND j.updated_at<'2026-11-14 17:15:01+00'::timestamptz AND j.created_at<'2026-11-14 17:15:01+00'::timestamptz
   AND a.is_active AND NOT COALESCE(a.needs_reauth,false) AND (a.token_expires_at IS NULL OR a.token_expires_at>clock_timestamp())
   AND NULLIF(btrim(a.access_token),'') IS NOT NULL AND a.platform_user_id ~ '^[0-9]{1,128}$'
   AND a.platform_user_id=a.account_metadata->>'ig_user_id'
   AND a.account_metadata->>'flow'='direct' AND a.account_metadata->>'source'='instagram_business_login'
   AND NULLIF(a.account_metadata->>'ig_business_account_id','') IS NULL AND NULLIF(a.account_metadata->>'facebook_page_id','') IS NULL
   AND a.platform_username IN ('australianbodycarekw','autoverse511','elsashaikhpk','eltamlawy_chicks','etern.foto','flexitolkw','kapiva.shilajit')
   AND NOT EXISTS(SELECT 1 FROM public.instagram_account_capabilities c WHERE c.social_account_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings b WHERE b.social_account_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_receipts r WHERE r.job_id=j.id)
   AND j.input_fence=public.analytics_bootstrap_fence(a.id,j.source_account_id,j.source_credential_id));
$fn$;
CREATE FUNCTION public.analytics_bootstrap_reset_direct_identity_incident() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='10s' AS $fn$
DECLARE ids uuid[];candidate record;recovered integer:=0;
BEGIN
 -- Serialize with dispatch; a paused master alone does not stop a live invocation.
 PERFORM 1 FROM public.analytics_legacy_bootstrap_run WHERE singleton FOR UPDATE;
 IF (SELECT value FROM public.app_settings WHERE key='analytics_legacy_bootstrap_enabled') IS DISTINCT FROM 'false'::jsonb
  OR EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_run WHERE lease_until>clock_timestamp()) THEN
  RAISE EXCEPTION 'BOOTSTRAP_RECOVERY_REQUIRES_PAUSE'; END IF;
 SELECT array_agg(id ORDER BY social_account_id) INTO ids FROM (
  SELECT id,social_account_id FROM public.analytics_legacy_bootstrap_jobs
  WHERE state='blocked' AND reason_code='identity_mismatch' AND public.analytics_bootstrap_direct_identity_incident_candidate(id)
  ORDER BY social_account_id LIMIT 8) incident;
 IF cardinality(ids)>7 THEN RAISE EXCEPTION 'BOOTSTRAP_RECOVERY_POPULATION_DRIFT'; END IF;
 FOR candidate IN SELECT id,social_account_id,user_id FROM public.analytics_legacy_bootstrap_jobs WHERE id=ANY(ids) ORDER BY social_account_id LOOP
  PERFORM public.meta_account_refresh_lock_scope(candidate.user_id,ARRAY[candidate.social_account_id],'{}'::uuid[]);
  PERFORM 1 FROM public.analytics_legacy_bootstrap_jobs WHERE id=candidate.id FOR UPDATE;
  IF NOT public.analytics_bootstrap_direct_identity_incident_candidate(candidate.id) THEN CONTINUE; END IF;
  UPDATE public.analytics_legacy_bootstrap_jobs SET state='retry',reason_code='verification_pending',retry_at=clock_timestamp(),
   revision=revision+1,updated_at=clock_timestamp() WHERE id=candidate.id;
  -- Attempt history/budgets, credential fences and correlation are preserved.
  PERFORM public.analytics_bootstrap_audit((SELECT correlation_id FROM public.analytics_legacy_bootstrap_jobs WHERE id=candidate.id),
   candidate.social_account_id,'direct_identity_incident_reset','identity_mismatch');
  recovered:=recovered+1;
 END LOOP;
 RETURN recovered;
END;
$fn$;
REVOKE ALL ON FUNCTION public.analytics_bootstrap_direct_identity_incident_candidate(uuid),
 public.analytics_bootstrap_reset_direct_identity_incident() FROM PUBLIC,anon,authenticated,service_role;
-- The migration owner is the only executor; this is not a new HTTP/RPC repair API.
SELECT public.analytics_bootstrap_reset_direct_identity_incident();
NOTIFY pgrst,'reload schema';
COMMIT;
