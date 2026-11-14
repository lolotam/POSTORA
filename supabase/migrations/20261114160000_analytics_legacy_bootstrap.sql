-- Phase 3 only. No collection enrollment, credential-mode change, or activation.
BEGIN;

INSERT INTO public.app_settings(key,value,description) VALUES
 ('analytics_legacy_bootstrap_enabled','false','Server-owned verified credential repair master'),
 ('analytics_legacy_bootstrap_policy','{"version":1,"account_ids":[],"max_accounts_per_run":5,"max_attempts_per_account_per_day":3}',
  'Explicit bootstrap targets; an empty list admits nobody') ON CONFLICT(key) DO NOTHING;

-- Tombstones deliberately have no account FK: deletion/recreation cannot recycle an epoch.
CREATE TABLE public.analytics_legacy_bootstrap_epochs (
 kind text NOT NULL CHECK(kind IN ('account','credential')), subject_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), PRIMARY KEY(kind,subject_id)
);
CREATE TABLE public.analytics_legacy_bootstrap_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), social_account_id uuid NOT NULL UNIQUE,
 user_id uuid NOT NULL, platform text NOT NULL CHECK(platform IN ('facebook','instagram')),
 login_kind text NOT NULL CHECK(login_kind IN ('direct','page_linked')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN
  ('pending','verifying','permission_pending','ready','needs_reconnect','permissions_missing','retry','blocked')),
 idempotency_key uuid NOT NULL, lease_id uuid, lease_until timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), source_account_id uuid,
 captured_generation bigint NOT NULL DEFAULT 0, captured_connection bigint NOT NULL DEFAULT 0,
 source_credential_id uuid, input_fence text, installed boolean NOT NULL DEFAULT false,
 expected_app_id text,
 source_kind text NOT NULL DEFAULT 'legacy_page' CHECK(source_kind IN ('protected','legacy_page','direct')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), attempt_times timestamptz[] NOT NULL DEFAULT '{}',
 retry_at timestamptz, reason_code text, correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 installed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
 UNIQUE(id,user_id,social_account_id), CHECK(input_fence IS NULL OR input_fence ~ '^[0-9a-f]{64}$')
);
CREATE INDEX analytics_legacy_bootstrap_due ON public.analytics_legacy_bootstrap_jobs(state,retry_at,updated_at);
CREATE INDEX analytics_legacy_bootstrap_owner ON public.analytics_legacy_bootstrap_jobs(user_id,social_account_id);
CREATE INDEX analytics_legacy_bootstrap_source ON public.analytics_legacy_bootstrap_jobs(source_account_id);
CREATE INDEX analytics_legacy_bootstrap_credential ON public.analytics_legacy_bootstrap_jobs(source_credential_id);
CREATE TABLE public.analytics_legacy_bootstrap_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL,
 user_id uuid NOT NULL, social_account_id uuid NOT NULL, platform text NOT NULL,
 credential_id uuid, credential_revision bigint, connection_version bigint, capability_generation bigint,
 app_id text NOT NULL, provider_user_id text NOT NULL, page_id text, instagram_user_id text,
 verified_at timestamptz NOT NULL, installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Receipts survive account/job deletion while a sibling still uses the verified grant.
 FOREIGN KEY(user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
 UNIQUE(id,user_id,social_account_id), CHECK(isfinite(verified_at)),
 CHECK(platform IN ('instagram','facebook')), CHECK(app_id ~ '^[0-9]{1,128}$'), CHECK(provider_user_id ~ '^[0-9]{1,128}$')
);
CREATE INDEX analytics_legacy_bootstrap_receipt_job ON public.analytics_legacy_bootstrap_receipts(job_id);
CREATE INDEX analytics_legacy_bootstrap_receipt_owner ON public.analytics_legacy_bootstrap_receipts(user_id,social_account_id);
CREATE INDEX analytics_legacy_bootstrap_receipt_credential ON public.analytics_legacy_bootstrap_receipts(credential_id);
CREATE TABLE public.analytics_legacy_bootstrap_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, correlation_id uuid NOT NULL,
 social_account_id uuid, event text NOT NULL, reason_code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX analytics_legacy_bootstrap_audit_correlation ON public.analytics_legacy_bootstrap_audit(correlation_id,created_at);
CREATE TABLE public.analytics_legacy_bootstrap_run (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), holder uuid, lease_until timestamptz,
 account_ids uuid[] NOT NULL DEFAULT '{}',
 calls integer NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 50), pause_until timestamptz, app_mismatches integer NOT NULL DEFAULT 0
);
INSERT INTO public.analytics_legacy_bootstrap_run(singleton) VALUES(true);

ALTER TABLE public.analytics_legacy_bootstrap_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_legacy_bootstrap_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_legacy_bootstrap_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_legacy_bootstrap_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_legacy_bootstrap_run ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_legacy_bootstrap_epochs,public.analytics_legacy_bootstrap_jobs,
 public.analytics_legacy_bootstrap_receipts,public.analytics_legacy_bootstrap_audit,public.analytics_legacy_bootstrap_run
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.analytics_bootstrap_assert_service() RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
 -- JWT claims alone are insufficient: a SET ROLE authenticated caller cannot impersonate service.
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('role') NOT IN ('service_role','none') THEN
  RAISE EXCEPTION 'BOOTSTRAP_SERVICE_REQUIRED' USING ERRCODE='42501';
 END IF;
END;
$fn$;

CREATE FUNCTION public.analytics_bootstrap_epoch_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE old_row jsonb;new_row jsonb;subject uuid;grant_id uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND old_row IS NOT DISTINCT FROM new_row THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='facebook_user_credentials' THEN
  subject:=(COALESCE(new_row,old_row)->>'id')::uuid;
  INSERT INTO public.analytics_legacy_bootstrap_epochs(kind,subject_id) VALUES('credential',subject)
   ON CONFLICT(kind,subject_id) DO UPDATE SET revision=public.analytics_legacy_bootstrap_epochs.revision+1;
 ELSE
  subject:=(COALESCE(new_row,old_row)->>CASE WHEN TG_TABLE_NAME='social_accounts' THEN 'id' ELSE 'social_account_id' END)::uuid;
  INSERT INTO public.analytics_legacy_bootstrap_epochs(kind,subject_id) VALUES('account',subject)
   ON CONFLICT(kind,subject_id) DO UPDATE SET revision=public.analytics_legacy_bootstrap_epochs.revision+1;
  IF TG_TABLE_NAME='facebook_user_credential_bindings' THEN
   FOR grant_id IN SELECT DISTINCT x::uuid FROM unnest(ARRAY[old_row->>'credential_id',new_row->>'credential_id']) x WHERE x IS NOT NULL LOOP
    INSERT INTO public.analytics_legacy_bootstrap_epochs(kind,subject_id) VALUES('credential',grant_id)
     ON CONFLICT(kind,subject_id) DO UPDATE SET revision=public.analytics_legacy_bootstrap_epochs.revision+1;
   END LOOP;
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END;
$fn$;
CREATE TRIGGER analytics_bootstrap_epoch AFTER INSERT OR UPDATE OR DELETE ON public.social_accounts
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_epoch_trigger();
CREATE TRIGGER analytics_bootstrap_epoch AFTER INSERT OR UPDATE OR DELETE ON public.instagram_account_capabilities
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_epoch_trigger();
CREATE TRIGGER analytics_bootstrap_epoch AFTER INSERT OR UPDATE OR DELETE ON public.facebook_user_credentials
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_epoch_trigger();
CREATE TRIGGER analytics_bootstrap_epoch AFTER INSERT OR UPDATE OR DELETE ON public.facebook_user_credential_bindings
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_epoch_trigger();
CREATE TRIGGER analytics_bootstrap_epoch AFTER INSERT OR UPDATE OR DELETE ON public.facebook_user_credential_connection_fences
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_epoch_trigger();

CREATE FUNCTION public.analytics_bootstrap_policy() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE master jsonb;policy jsonb;
BEGIN
 SELECT value INTO master FROM public.app_settings WHERE key='analytics_legacy_bootstrap_enabled' FOR SHARE;
 IF master IS NULL OR master='false'::jsonb THEN RETURN NULL; END IF;
 IF master<>'true'::jsonb THEN RAISE EXCEPTION 'BOOTSTRAP_SETTINGS_UNAVAILABLE'; END IF;
 SELECT value INTO policy FROM public.app_settings WHERE key='analytics_legacy_bootstrap_policy' FOR SHARE;
 IF policy IS NULL OR jsonb_typeof(policy)<>'object' OR
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(policy) k) IS DISTINCT FROM
  ARRAY['account_ids','max_accounts_per_run','max_attempts_per_account_per_day','version']::text[] OR
  policy->'version'<>'1'::jsonb OR jsonb_typeof(policy->'account_ids')<>'array' OR
  jsonb_typeof(policy->'max_accounts_per_run')<>'number' OR jsonb_typeof(policy->'max_attempts_per_account_per_day')<>'number' OR
  policy->>'max_accounts_per_run' !~ '^[1-5]$' OR policy->>'max_attempts_per_account_per_day' !~ '^[1-3]$' THEN
  RAISE EXCEPTION 'BOOTSTRAP_SETTINGS_UNAVAILABLE';
 END IF;
 IF jsonb_array_length(policy->'account_ids')>500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(policy->'account_ids') e
   WHERE jsonb_typeof(e)<>'string' OR e#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
  (SELECT count(*)<>count(DISTINCT (e#>>'{}')::uuid) FROM jsonb_array_elements(policy->'account_ids') e) THEN
  RAISE EXCEPTION 'BOOTSTRAP_SETTINGS_UNAVAILABLE';
 END IF;
 RETURN policy;
END;
$fn$;

CREATE FUNCTION public.analytics_bootstrap_audit(p_correlation uuid,p_account uuid,p_event text,p_reason text) RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 INSERT INTO public.analytics_legacy_bootstrap_audit(correlation_id,social_account_id,event,reason_code)
 VALUES(p_correlation,p_account,p_event,p_reason);
$fn$;

CREATE FUNCTION public.analytics_bootstrap_fence(p_account uuid,p_source uuid,p_credential uuid) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT encode(extensions.digest(jsonb_build_object(
  'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.social_accounts a WHERE a.id IN(p_account,p_source)),
  'epochs',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.kind,e.subject_id) FROM public.analytics_legacy_bootstrap_epochs e
    WHERE e.kind='account' AND e.subject_id IN(p_account,p_source) OR e.kind='credential' AND e.subject_id=p_credential),
  'capabilities',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.social_account_id) FROM public.instagram_account_capabilities c WHERE c.social_account_id IN(p_account,p_source)),
  'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.social_account_id) FROM public.facebook_user_credential_bindings b
    WHERE b.social_account_id IN(p_account,p_source) OR b.credential_id=p_credential),
  'connections',(SELECT jsonb_agg(to_jsonb(f) ORDER BY f.social_account_id) FROM public.facebook_user_credential_connection_fences f WHERE f.social_account_id IN(p_account,p_source)),
  'credential',(SELECT to_jsonb(c) FROM public.facebook_user_credentials c WHERE c.id=p_credential)
 )::text,'sha256'),'hex');
$fn$;

-- HTTP refusals have no trusted account identity. Accept only closed reason codes,
-- never headers, bodies, URLs, caller identifiers or provider/driver text.
CREATE FUNCTION public.record_analytics_legacy_bootstrap_refusal(p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='4s' AS $fn$
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 IF p_reason IS NULL OR p_reason NOT IN ('unauthorized','invalid_method','invalid_request') THEN
  RAISE EXCEPTION 'BOOTSTRAP_INVALID_REFUSAL'; END IF;
 PERFORM public.analytics_bootstrap_audit(gen_random_uuid(),NULL,'http_refused',p_reason);
END;
$fn$;

CREATE FUNCTION public.analytics_bootstrap_projection(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object('job_id',id,'account_id',social_account_id,'state',state,'reason_code',reason_code,
  'correlation_id',correlation_id,'retry_at',retry_at,'revision',revision,'installed',installed,
  'next_action',CASE WHEN state='needs_reconnect' THEN 'supported_reconnect' WHEN state='permissions_missing' THEN 'grant_permissions'
    WHEN state='blocked' THEN 'support' WHEN state='ready' THEN 'none' ELSE 'wait' END,
  'reconnect_path',CASE WHEN state IN ('needs_reconnect','permissions_missing') THEN '/profiles' ELSE NULL END)
 FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job;
$fn$;

CREATE FUNCTION public.dispatch_analytics_legacy_bootstrap(p_run_id uuid) RETURNS jsonb
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
     j.reason_code='stored_user_credential_missing' AND j.input_fence IS DISTINCT FROM public.analytics_bootstrap_fence(j.social_account_id,j.source_account_id,j.source_credential_id) OR
     EXISTS(SELECT 1 FROM public.instagram_account_capabilities c WHERE c.social_account_id=a.id AND c.credential_generation>j.captured_generation) OR
     EXISTS(SELECT 1 FROM public.facebook_user_credential_connection_fences f WHERE f.social_account_id=a.id AND f.connection_version>j.captured_connection)) AND
    (j.retry_at IS NULL OR j.retry_at<=clock_timestamp()) AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp()))
  ORDER BY priority,changed,a.id LIMIT (policy->>'max_accounts_per_run')::integer) targets;
 UPDATE public.analytics_legacy_bootstrap_run SET account_ids=COALESCE(ids,'{}') WHERE singleton AND holder=p_run_id;
 PERFORM public.analytics_bootstrap_audit(correlation,NULL,'dispatch','dispatched');
 RETURN jsonb_build_object('status','dispatched','account_ids',COALESCE(to_jsonb(ids),'[]'::jsonb));
END;
$fn$;

CREATE FUNCTION public.begin_analytics_legacy_bootstrap(p_account_id uuid,p_idempotency_key uuid,p_run_id uuid) RETURNS jsonb
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
   j.reason_code='stored_user_credential_missing' AND j.input_fence IS DISTINCT FROM discovered_fence OR
   EXISTS(SELECT 1 FROM public.instagram_account_capabilities c WHERE c.social_account_id=a.id AND c.credential_generation>j.captured_generation) OR
   EXISTS(SELECT 1 FROM public.facebook_user_credential_connection_fences f WHERE f.social_account_id=a.id AND f.connection_version>j.captured_connection)) THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'begin','settled_or_busy'); RETURN public.analytics_bootstrap_projection(j.id); END IF;
 IF (SELECT count(*) FROM unnest(j.attempt_times) t WHERE t>clock_timestamp()-interval '24 hours') >= (policy->>'max_attempts_per_account_per_day')::integer
   OR j.retry_at>clock_timestamp() THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'begin','attempt_budget'); RETURN public.analytics_bootstrap_projection(j.id); END IF;
 IF NOT a.is_active OR COALESCE(a.needs_reauth,false) OR a.token_expires_at<=clock_timestamp() THEN
  j.state:='needs_reconnect';j.reason_code:='token_invalid';
 ELSIF NULLIF(a.platform_user_id,'') IS NULL OR kind='page_linked' AND (NULLIF(page,'') IS NULL OR
   candidate_source='legacy_page' AND (source.id IS NULL OR NOT source.is_active OR COALESCE(source.needs_reauth,false))) THEN
  j.state:='blocked';j.reason_code:='account_identity_invalid';
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

CREATE FUNCTION public.analytics_bootstrap_lock_job(p_job uuid,p_lease uuid,p_revision bigint) RETURNS public.analytics_legacy_bootstrap_jobs
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;ids uuid[];policy jsonb;
BEGIN
 SELECT * INTO STRICT j FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job;
 SELECT array_agg(DISTINCT id ORDER BY id) INTO ids FROM (
  SELECT j.social_account_id id UNION SELECT j.source_account_id UNION
  SELECT social_account_id FROM public.facebook_user_credential_bindings WHERE credential_id=j.source_credential_id AND user_id=j.user_id) members WHERE id IS NOT NULL;
 PERFORM public.meta_account_refresh_lock_scope(j.user_id,ids,CASE WHEN j.source_credential_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[j.source_credential_id] END);
 SELECT * INTO STRICT j FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job FOR UPDATE;
 policy:=public.analytics_bootstrap_policy();
 IF policy IS NULL OR NOT policy->'account_ids' @> jsonb_build_array(j.social_account_id::text) OR
  j.lease_id IS DISTINCT FROM p_lease OR j.revision<>p_revision OR j.lease_until<=clock_timestamp() OR
  j.input_fence IS DISTINCT FROM public.analytics_bootstrap_fence(j.social_account_id,j.source_account_id,j.source_credential_id) THEN
  RAISE EXCEPTION 'BOOTSTRAP_STALE_CAPTURE' USING ERRCODE='PAB01'; END IF;
 RETURN j;
END;
$fn$;

ALTER TABLE public.facebook_user_credentials ADD COLUMN bootstrap_receipt_id uuid REFERENCES public.analytics_legacy_bootstrap_receipts(id);
ALTER TABLE public.facebook_user_credential_bindings ADD COLUMN bootstrap_receipt_id uuid REFERENCES public.analytics_legacy_bootstrap_receipts(id);
CREATE INDEX facebook_user_credentials_bootstrap_receipt ON public.facebook_user_credentials(bootstrap_receipt_id) WHERE bootstrap_receipt_id IS NOT NULL;
CREATE INDEX facebook_user_bindings_bootstrap_receipt ON public.facebook_user_credential_bindings(bootstrap_receipt_id) WHERE bootstrap_receipt_id IS NOT NULL;
-- Extend only the three provenance constraints; ordinary bind/write RPCs still reject this label.
DO $constraints$
DECLARE definition text;constraint_name text;table_name text;
BEGIN
 FOR table_name,constraint_name IN VALUES
  ('facebook_user_credentials','facebook_user_credentials_provenance_chk'),
  ('facebook_user_credentials','facebook_user_credentials_provenance_pair_chk'),
  ('facebook_user_credential_bindings','facebook_user_credential_bindings_evidence_chk') LOOP
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint WHERE conrelid=('public.'||table_name)::regclass AND conname=constraint_name;
  IF table_name='facebook_user_credentials' THEN
   definition:=regexp_replace(definition,'CHECK \((.*)\)$',E'CHECK ((\\1) OR (provenance_source = ''verified_legacy_bootstrap'' AND bootstrap_receipt_id IS NOT NULL AND provenance_captured_at IS NOT NULL AND provider_user_id IS NOT NULL))');
  ELSE
   definition:=regexp_replace(definition,'CHECK \((.*)\)$',E'CHECK ((\\1) OR (evidence_source = ''verified_legacy_bootstrap'' AND bootstrap_receipt_id IS NOT NULL AND verified_facebook_user_id IS NOT NULL AND ((platform = ''facebook'' AND verified_facebook_page_id IS NULL AND verified_instagram_user_id IS NULL) OR (platform = ''instagram'' AND verified_facebook_page_id IS NOT NULL AND verified_instagram_user_id IS NOT NULL))))');
  END IF;
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',table_name,constraint_name);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',table_name,constraint_name,definition);
 END LOOP;
END;
$constraints$;

CREATE FUNCTION public.analytics_bootstrap_binding_verified(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings b
  JOIN public.social_accounts a ON a.id=b.social_account_id AND a.user_id=b.user_id AND a.platform=b.platform
  JOIN public.facebook_user_credential_connection_fences f ON f.social_account_id=b.social_account_id AND f.user_id=b.user_id AND f.platform=b.platform
  JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
  JOIN public.analytics_legacy_bootstrap_receipts r ON r.id=b.bootstrap_receipt_id AND r.user_id=b.user_id AND r.social_account_id=b.social_account_id
  WHERE b.social_account_id=p_account AND b.evidence_source='verified_legacy_bootstrap' AND
   r.credential_id=c.id AND r.credential_revision<=c.revision AND r.connection_version<=b.connection_version AND b.connection_version=f.connection_version AND
   r.provider_user_id=c.provider_user_id AND r.provider_user_id=b.verified_facebook_user_id AND
   (b.platform='facebook' AND r.page_id=a.platform_user_id OR b.platform='instagram' AND r.page_id=b.verified_facebook_page_id
     AND r.instagram_user_id=b.verified_instagram_user_id AND r.instagram_user_id=a.platform_user_id));
$fn$;

CREATE FUNCTION public.analytics_bootstrap_provenance_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF TG_TABLE_NAME='facebook_user_credentials' THEN
  IF NEW.provenance_source='verified_legacy_bootstrap' AND NOT EXISTS(
   SELECT 1 FROM public.analytics_legacy_bootstrap_receipts r WHERE r.id=NEW.bootstrap_receipt_id AND r.user_id=NEW.user_id
    AND r.credential_id=NEW.id AND r.provider_user_id=NEW.provider_user_id AND r.credential_revision<=NEW.revision
    AND r.verified_at=NEW.provenance_captured_at) THEN RAISE EXCEPTION 'BOOTSTRAP_PROVENANCE_UNVERIFIED'; END IF;
 ELSE
  IF NEW.evidence_source='verified_legacy_bootstrap' AND NOT EXISTS(
   SELECT 1 FROM public.analytics_legacy_bootstrap_receipts r JOIN public.facebook_user_credentials c ON c.id=NEW.credential_id AND c.user_id=NEW.user_id
   WHERE r.id=NEW.bootstrap_receipt_id AND r.user_id=NEW.user_id AND r.social_account_id=NEW.social_account_id
    AND r.credential_id=c.id AND r.credential_revision<=c.revision AND r.connection_version<=NEW.connection_version
    AND r.provider_user_id=c.provider_user_id AND r.provider_user_id=NEW.verified_facebook_user_id AND
     (NEW.platform='facebook' OR r.page_id=NEW.verified_facebook_page_id AND r.instagram_user_id=NEW.verified_instagram_user_id)) THEN
   RAISE EXCEPTION 'BOOTSTRAP_PROVENANCE_UNVERIFIED'; END IF;
 END IF;
 RETURN NEW;
END;
$fn$;
CREATE TRIGGER analytics_bootstrap_provenance BEFORE INSERT OR UPDATE ON public.facebook_user_credentials
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_provenance_trigger();
CREATE TRIGGER analytics_bootstrap_provenance BEFORE INSERT OR UPDATE ON public.facebook_user_credential_bindings
 FOR EACH ROW EXECUTE FUNCTION public.analytics_bootstrap_provenance_trigger();

CREATE FUNCTION public.commit_analytics_legacy_bootstrap(p_job_id uuid,p_lease_id uuid,p_revision bigint,p_evidence jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='4s' AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;a public.social_accounts;source public.social_accounts;
 c public.facebook_user_credentials;b public.facebook_user_credential_bindings;cap public.instagram_account_capabilities;
 receipt uuid:=gen_random_uuid();connection bigint;generation bigint;candidate text;verified timestamptz;expiry timestamptz;
 previous_credential uuid;binding_trusted boolean;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 BEGIN j:=public.analytics_bootstrap_lock_job(p_job_id,p_lease_id,p_revision);
 EXCEPTION WHEN SQLSTATE 'PAB01' THEN
  PERFORM public.analytics_bootstrap_audit(p_job_id,NULL,'commit','stale_capture');
  RETURN jsonb_build_object('state','retry','reason_code','stale_capture'); END;
 IF j.installed OR j.state<>'verifying' THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,j.social_account_id,'commit','reconcile_required');
  RETURN public.analytics_bootstrap_projection(j.id); END IF;
 SELECT * INTO STRICT a FROM public.social_accounts WHERE id=j.social_account_id AND user_id=j.user_id;
 SELECT * INTO source FROM public.social_accounts WHERE id=j.source_account_id AND user_id=j.user_id;
 SELECT * INTO c FROM public.facebook_user_credentials WHERE id=j.source_credential_id AND user_id=j.user_id;
 SELECT * INTO b FROM public.facebook_user_credential_bindings WHERE social_account_id=a.id AND user_id=a.user_id;
 SELECT * INTO cap FROM public.instagram_account_capabilities WHERE social_account_id=a.id;
 IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object' OR
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_evidence) k) IS DISTINCT FROM
   ARRAY['app_id','expires_at','instagram_user_id','page_id','provider_user_id','token_type','verified_at']::text[] OR
  COALESCE(p_evidence->>'app_id','') !~ '^[0-9]{1,128}$' OR COALESCE(p_evidence->>'provider_user_id','') !~ '^[0-9]{1,128}$' THEN
  RAISE EXCEPTION 'BOOTSTRAP_INVALID_EVIDENCE'; END IF;
 IF j.expected_app_id IS NULL OR p_evidence->>'app_id' IS DISTINCT FROM j.expected_app_id OR p_evidence->>'token_type' IS DISTINCT FROM 'USER' THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'commit','app_or_type_mismatch');
  RETURN jsonb_build_object('state','blocked','reason_code',CASE WHEN p_evidence->>'token_type' IS DISTINCT FROM 'USER' THEN 'token_invalid' ELSE 'app_mismatch' END);
 END IF;
 verified:=public.facebook_user_credential_parse_zoned_timestamp(p_evidence->>'verified_at','verified_at');
 expiry:=CASE WHEN p_evidence->>'expires_at' IS NULL THEN NULL ELSE public.facebook_user_credential_parse_zoned_timestamp(p_evidence->>'expires_at','expires_at') END;
 IF verified<j.updated_at OR verified>clock_timestamp()+interval '1 second' OR expiry<=clock_timestamp() OR
  c.provider_user_id IS NOT NULL AND c.provider_user_id IS DISTINCT FROM p_evidence->>'provider_user_id' OR
  (j.login_kind='page_linked' AND p_evidence->>'page_id' IS DISTINCT FROM
   CASE WHEN a.platform='instagram' AND j.source_kind='protected' AND b.social_account_id=a.id
    THEN COALESCE(b.verified_facebook_page_id,source.platform_user_id) ELSE source.platform_user_id END) OR
  (a.platform='instagram' AND a.platform_user_id IS DISTINCT FROM p_evidence->>'instagram_user_id') OR
  (b.social_account_id IS NOT NULL AND b.evidence_source IN ('oauth_exchange','token_refresh','verified_legacy_bootstrap') AND
   (b.verified_facebook_user_id IS DISTINCT FROM p_evidence->>'provider_user_id' OR
    a.platform='instagram' AND (b.verified_facebook_page_id IS DISTINCT FROM p_evidence->>'page_id' OR
     b.verified_instagram_user_id IS DISTINCT FROM p_evidence->>'instagram_user_id'))) OR
  (j.login_kind='direct' AND (a.platform_user_id IS DISTINCT FROM p_evidence->>'provider_user_id' OR p_evidence->>'page_id' IS NOT NULL)) THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'commit','identity_mismatch');
  RETURN jsonb_build_object('state','blocked','reason_code','identity_mismatch'); END IF;
 candidate:=CASE WHEN j.source_kind='protected' THEN c.token WHEN j.source_kind='direct' THEN a.access_token ELSE source.account_metadata->>'user_token' END;
 IF NULLIF(candidate,'') IS NULL THEN RAISE EXCEPTION 'BOOTSTRAP_CREDENTIAL_MISSING'; END IF;
 binding_trusted:=COALESCE(b.evidence_source IN ('oauth_exchange','token_refresh','verified_legacy_bootstrap')
   AND j.source_kind='protected' AND b.credential_id=c.id AND c.provider_user_id IS NOT NULL AND c.provider_user_id=b.verified_facebook_user_id,false);
 IF j.login_kind='page_linked' THEN
  previous_credential:=b.credential_id;
  -- Upgrade an unverified compatibility member onto an isolated verified grant;
  -- never mutate the old shared secret or its remaining siblings.
  IF c.id IS NULL OR c.provider_user_id IS NULL OR j.source_kind='legacy_page' THEN c.id:=gen_random_uuid();c.revision:=1; END IF;
  IF NOT binding_trusted THEN
   connection:=public.facebook_user_credential_allocate_connection_version(a.id,a.user_id,a.platform);
  ELSE connection:=b.connection_version; END IF;
 END IF;
 IF a.platform='instagram' THEN
  -- Permission-only repair preserves authority. A newly installed grant opens a new generation.
  generation:=CASE WHEN cap.credential_generation>0 AND (j.login_kind='direct' OR binding_trusted) THEN cap.credential_generation
   ELSE COALESCE(cap.credential_generation,0)+1 END;
  INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,credential_generation,credential_updated_at,generation_reason)
   VALUES(a.id,a.user_id,'instagram',j.login_kind,generation,clock_timestamp(),'verified_legacy_bootstrap')
   ON CONFLICT(social_account_id) DO UPDATE SET credential_generation=generation,
    credential_updated_at=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN clock_timestamp() ELSE public.instagram_account_capabilities.credential_updated_at END,
    generation_reason=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN 'verified_legacy_bootstrap' ELSE public.instagram_account_capabilities.generation_reason END,
    permission_read_state=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN 'unknown' ELSE public.instagram_account_capabilities.permission_read_state END,
    granted_scopes=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN '{}'::text[] ELSE public.instagram_account_capabilities.granted_scopes END,
    scopes_read_at=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN NULL ELSE public.instagram_account_capabilities.scopes_read_at END,
    last_read_failed_at=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN NULL ELSE public.instagram_account_capabilities.last_read_failed_at END,
    last_read_error_code=CASE WHEN public.instagram_account_capabilities.credential_generation<>generation THEN NULL ELSE public.instagram_account_capabilities.last_read_error_code END;
 END IF;
 INSERT INTO public.analytics_legacy_bootstrap_receipts(id,job_id,user_id,social_account_id,platform,credential_id,credential_revision,connection_version,
  capability_generation,app_id,provider_user_id,page_id,instagram_user_id,verified_at)
 VALUES(receipt,j.id,a.user_id,a.id,a.platform,c.id,c.revision,connection,generation,p_evidence->>'app_id',p_evidence->>'provider_user_id',
  p_evidence->>'page_id',p_evidence->>'instagram_user_id',verified);
 IF j.login_kind='page_linked' THEN
  IF NOT EXISTS(SELECT 1 FROM public.facebook_user_credentials WHERE id=c.id) THEN
   INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at,token_expires_at,bootstrap_receipt_id)
    VALUES(c.id,a.user_id,candidate,p_evidence->>'provider_user_id','verified_legacy_bootstrap',verified,expiry,receipt);
  END IF;
  IF b.social_account_id IS NULL THEN
   INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,
    verified_facebook_page_id,verified_instagram_user_id,evidence_source,connection_version,bootstrap_receipt_id)
   VALUES(a.id,a.user_id,a.platform,c.id,p_evidence->>'provider_user_id',CASE WHEN a.platform='instagram' THEN p_evidence->>'page_id' END,
    CASE WHEN a.platform='instagram' THEN p_evidence->>'instagram_user_id' END,'verified_legacy_bootstrap',connection,receipt);
  ELSIF NOT binding_trusted THEN
   UPDATE public.facebook_user_credential_bindings SET credential_id=c.id,verified_facebook_user_id=p_evidence->>'provider_user_id',
    verified_facebook_page_id=CASE WHEN a.platform='instagram' THEN p_evidence->>'page_id' END,
    verified_instagram_user_id=CASE WHEN a.platform='instagram' THEN p_evidence->>'instagram_user_id' END,
    evidence_source='verified_legacy_bootstrap',connection_version=connection,bootstrap_receipt_id=receipt WHERE social_account_id=a.id;
  END IF;
  IF previous_credential IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE credential_id=previous_credential) THEN
   DELETE FROM public.facebook_user_credentials WHERE id=previous_credential AND user_id=a.user_id;
  END IF;
 END IF;
 UPDATE public.analytics_legacy_bootstrap_jobs SET installed=true,installed_at=clock_timestamp(),state='permission_pending',reason_code='permission_verification_pending',
  source_credential_id=c.id,revision=revision+1,updated_at=clock_timestamp(),
  captured_generation=COALESCE(generation,0),captured_connection=COALESCE(connection,0),
  input_fence=public.analytics_bootstrap_fence(a.id,j.source_account_id,c.id) WHERE id=j.id RETURNING * INTO j;
 PERFORM public.analytics_bootstrap_audit(j.correlation_id,a.id,'install','verified_legacy_bootstrap');
 RETURN public.analytics_bootstrap_projection(j.id);
END;
$fn$;

CREATE FUNCTION public.reconcile_analytics_legacy_bootstrap(p_account_id uuid,p_idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='4s' AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 SELECT * INTO j FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=p_account_id AND idempotency_key=p_idempotency_key;
 PERFORM public.analytics_bootstrap_audit(COALESCE(j.correlation_id,gen_random_uuid()),p_account_id,'reconcile',CASE WHEN j.id IS NULL THEN 'not_found' ELSE j.state END);
 RETURN COALESCE(public.analytics_bootstrap_projection(j.id),jsonb_build_object('state','retry','reason_code','not_found'));
END;
$fn$;

CREATE FUNCTION public.complete_analytics_legacy_bootstrap(p_job_id uuid,p_lease_id uuid,p_revision bigint,p_permissions jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='4s' AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;scopes text[];observed timestamptz;permission_state text;required text[];authority jsonb;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 BEGIN j:=public.analytics_bootstrap_lock_job(p_job_id,p_lease_id,p_revision);
 EXCEPTION WHEN SQLSTATE 'PAB01' THEN
  PERFORM public.analytics_bootstrap_audit(p_job_id,NULL,'permissions','stale_capture');
  RETURN jsonb_build_object('state','permission_pending','reason_code','stale_capture'); END;
 IF NOT j.installed OR j.state<>'permission_pending' THEN RAISE EXCEPTION 'BOOTSTRAP_INSTALL_REQUIRED'; END IF;
 IF p_permissions IS NULL OR jsonb_typeof(p_permissions)<>'object' OR COALESCE(p_permissions->>'state','') NOT IN ('ok','failed') OR
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_permissions) k) IS DISTINCT FROM ARRAY['observed_at','scopes','state']::text[] THEN
  RAISE EXCEPTION 'BOOTSTRAP_PERMISSION_INVALID'; END IF;
 observed:=public.facebook_user_credential_parse_zoned_timestamp(p_permissions->>'observed_at','observed_at');
 -- JavaScript observations have millisecond precision; installation has microseconds.
 -- The lease/revision/input fence already ties this result to the installed attempt.
 -- Reject older milliseconds, then retain strict ordering for the capability writer.
 IF observed<date_trunc('milliseconds',j.installed_at) OR observed>clock_timestamp()+interval '1 second' THEN RAISE EXCEPTION 'BOOTSTRAP_PERMISSION_STALE'; END IF;
 observed:=GREATEST(observed,j.installed_at+interval '1 microsecond');
 permission_state:=p_permissions->>'state';
 IF jsonb_typeof(p_permissions->'scopes')<>'array' OR jsonb_array_length(p_permissions->'scopes')>400 OR EXISTS
  (SELECT 1 FROM jsonb_array_elements(p_permissions->'scopes') s WHERE jsonb_typeof(s)<>'string' OR s#>>'{}' !~ '^[a-z][a-z0-9_]{0,127}$') THEN
  RAISE EXCEPTION 'BOOTSTRAP_PERMISSION_INVALID'; END IF;
 SELECT array_agg(s#>>'{}' ORDER BY s#>>'{}') INTO scopes FROM jsonb_array_elements(p_permissions->'scopes') s;
 scopes:=COALESCE(scopes,'{}');
 IF cardinality(scopes)<>(SELECT count(DISTINCT s) FROM unnest(scopes) s) OR permission_state='failed' AND cardinality(scopes)>0 THEN RAISE EXCEPTION 'BOOTSTRAP_PERMISSION_INVALID'; END IF;
 IF j.platform='instagram' THEN
  PERFORM public.write_instagram_account_capability(j.social_account_id,j.user_id,jsonb_build_object(
   'login_kind',j.login_kind,'expected_credential_generation',(SELECT credential_generation FROM public.instagram_account_capabilities WHERE social_account_id=j.social_account_id),
   'permission_read_state',permission_state)||CASE WHEN permission_state='ok' THEN jsonb_build_object('granted_scopes',scopes,'scopes_read_at',observed)
    ELSE jsonb_build_object('read_failed_at',observed,'read_error_code','permission_read_failed') END);
  required:=CASE WHEN j.login_kind='direct' THEN ARRAY['instagram_business_manage_insights'] ELSE ARRAY['instagram_manage_insights'] END;
 ELSE
  -- This verification is independent of collection policy: never call policy-blocked prepare/observe.
  authority:=public.meta_analytics_current_authority('facebook',j.social_account_id,j.user_id);
  INSERT INTO public.fb_analytics_permission_observations(user_id,social_account_id,authority,granted_scopes,observed_at,state,source_ref)
   VALUES(j.user_id,j.social_account_id,authority,
    ARRAY(SELECT s FROM unnest(scopes) s WHERE s IN ('read_insights','pages_read_engagement')),observed,
    CASE WHEN permission_state='ok' THEN 'verified' ELSE 'unavailable' END,'meta_graph_v25')
   ON CONFLICT(social_account_id) DO UPDATE SET
    authority=EXCLUDED.authority,granted_scopes=EXCLUDED.granted_scopes,observed_at=EXCLUDED.observed_at,state=EXCLUDED.state
   WHERE public.fb_analytics_permission_observations.authority IS DISTINCT FROM EXCLUDED.authority OR
    (public.fb_analytics_permission_observations.observed_at<EXCLUDED.observed_at AND
     (EXCLUDED.state='verified' OR public.fb_analytics_permission_observations.state<>'verified'));
  required:=ARRAY['read_insights','pages_read_engagement'];
 END IF;
 UPDATE public.analytics_legacy_bootstrap_jobs SET
  state=CASE WHEN permission_state='failed' THEN 'permission_pending' WHEN scopes @> required THEN 'ready' ELSE 'permissions_missing' END,
  reason_code=CASE WHEN permission_state='failed' THEN 'permission_read_failed' WHEN scopes @> required THEN 'verified' ELSE 'permission_missing' END,
  retry_at=CASE WHEN permission_state='failed' THEN clock_timestamp()+interval '5 minutes' END,
  lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp()
  WHERE id=j.id RETURNING * INTO j;
 PERFORM public.analytics_bootstrap_audit(j.correlation_id,j.social_account_id,'permissions',j.reason_code);
 RETURN public.analytics_bootstrap_projection(j.id);
END;
$fn$;

CREATE FUNCTION public.settle_analytics_legacy_bootstrap(p_job_id uuid,p_lease_id uuid,p_revision bigint,p_reason text,p_retry_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='4s' AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 IF p_reason NOT IN ('token_invalid','permission_missing','app_mismatch','identity_mismatch','provider_error','provider_malformed',
  'rate_limited','budget_exhausted','direct_verification_unsupported','stale_capture') OR
  p_retry_at IS NOT NULL AND (NOT isfinite(p_retry_at) OR p_retry_at>clock_timestamp()+interval '7 days') THEN RAISE EXCEPTION 'BOOTSTRAP_INVALID_REASON'; END IF;
 SELECT * INTO j FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job_id AND lease_id=p_lease_id AND revision=p_revision AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN
  PERFORM public.analytics_bootstrap_audit(gen_random_uuid(),NULL,'settle','stale_capture');
  RETURN jsonb_build_object('state','retry','reason_code','stale_capture'); END IF;
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

CREATE FUNCTION public.permit_analytics_legacy_bootstrap(p_run_id uuid,p_job_id uuid,p_lease_id uuid,p_revision bigint,p_app_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' SET statement_timeout='4s' AS $fn$
DECLARE j public.analytics_legacy_bootstrap_jobs;bucket text;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 IF p_app_id IS NULL OR p_app_id !~ '^[0-9]{1,128}$' THEN RAISE EXCEPTION 'BOOTSTRAP_APP_UNAVAILABLE'; END IF;
 BEGIN j:=public.analytics_bootstrap_lock_job(p_job_id,p_lease_id,p_revision);
 EXCEPTION WHEN SQLSTATE 'PAB01' THEN
  PERFORM public.analytics_bootstrap_audit(p_job_id,NULL,'permit','stale_capture');RETURN false; END;
 -- Pin the configured app on the first service permit, before any network request.
 -- Subsequent permits and install must agree with this same captured app.
 IF j.expected_app_id IS NOT NULL AND j.expected_app_id<>p_app_id THEN
  PERFORM public.analytics_bootstrap_audit(j.correlation_id,j.social_account_id,'permit','app_mismatch');RETURN false; END IF;
 UPDATE public.analytics_legacy_bootstrap_jobs SET expected_app_id=p_app_id WHERE id=j.id AND expected_app_id IS NULL;
 UPDATE public.analytics_legacy_bootstrap_run SET calls=calls+1 WHERE singleton AND holder=p_run_id AND lease_until>clock_timestamp()
  AND calls<50 AND (pause_until IS NULL OR pause_until<=clock_timestamp());
 IF NOT FOUND THEN PERFORM public.analytics_bootstrap_audit(j.correlation_id,j.social_account_id,'permit','budget_exhausted');RETURN false; END IF;
 FOR bucket IN SELECT encode(extensions.digest(prefix,'sha256'),'hex') FROM unnest(ARRAY[
  'owned_analytics:app:'||CASE WHEN (SELECT login_kind FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job_id)='direct' THEN 'instagram' ELSE 'facebook' END||':'||p_app_id,'instagram_owner:'||p_app_id||':'||j.source_credential_id::text,
  'instagram_discovery:'||p_app_id||':'||j.source_credential_id::text]) prefix WHERE prefix IS NOT NULL LOOP
  IF EXISTS(SELECT 1 FROM public.instagram_provider_throttle_buckets WHERE bucket_key=bucket AND
   (throttled_until>clock_timestamp() OR usage_percent>=80 AND last_reported_at>clock_timestamp()-interval '5 minutes')) THEN
   PERFORM public.analytics_bootstrap_audit(j.correlation_id,j.social_account_id,'permit','rate_limited');RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$fn$;

CREATE FUNCTION public.record_analytics_legacy_bootstrap_usage(p_run_id uuid,p_job_id uuid,p_usage integer,p_retry_at timestamptz,p_app_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='4s' AS $fn$
DECLARE credential uuid;until_time timestamptz;bucket text;
BEGIN
 PERFORM public.analytics_bootstrap_assert_service();
 IF p_usage IS NULL OR p_usage NOT BETWEEN 0 AND 100 OR p_app_id IS NULL OR p_app_id !~ '^[0-9]{1,128}$' OR p_retry_at IS NOT NULL AND NOT isfinite(p_retry_at) THEN RAISE EXCEPTION 'BOOTSTRAP_INVALID_USAGE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_run r JOIN public.analytics_legacy_bootstrap_jobs j
  ON j.social_account_id=ANY(r.account_ids) AND j.id=p_job_id AND j.expected_app_id=p_app_id
  WHERE r.holder=p_run_id AND r.lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'BOOTSTRAP_RUN_EXPIRED'; END IF;
 until_time:=GREATEST(p_retry_at,CASE WHEN p_usage>=80 THEN clock_timestamp()+interval '5 minutes' END);
 UPDATE public.analytics_legacy_bootstrap_run SET pause_until=GREATEST(pause_until,until_time) WHERE singleton;
 SELECT source_credential_id INTO credential FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job_id;
 FOR bucket IN SELECT encode(extensions.digest(prefix,'sha256'),'hex') FROM unnest(ARRAY[
  'owned_analytics:app:'||CASE WHEN (SELECT login_kind FROM public.analytics_legacy_bootstrap_jobs WHERE id=p_job_id)='direct' THEN 'instagram' ELSE 'facebook' END||':'||p_app_id,'instagram_owner:'||p_app_id||':'||credential::text,
  'instagram_discovery:'||p_app_id||':'||credential::text]) prefix WHERE prefix IS NOT NULL LOOP
  INSERT INTO public.instagram_provider_throttle_buckets(bucket_key,usage_percent,throttled_until,last_reported_at)
   VALUES(bucket,p_usage,until_time,clock_timestamp())
  -- Match record_instagram_provider_throttle: usage and its timestamp are one
  -- latest sample; only the explicit pause is monotonic across concurrent writers.
  ON CONFLICT(bucket_key) DO UPDATE SET usage_percent=EXCLUDED.usage_percent,
   throttled_until=GREATEST(public.instagram_provider_throttle_buckets.throttled_until,EXCLUDED.throttled_until),
   last_reported_at=EXCLUDED.last_reported_at,updated_at=EXCLUDED.last_reported_at;
 END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.meta_analytics_current_authority(p_platform text,p_account uuid,p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE v_account public.social_accounts;v_context jsonb;v_generation bigint;
BEGIN
  SELECT * INTO v_account FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF NOT v_account.is_active OR COALESCE(v_account.needs_reauth,false) OR NULLIF(btrim(v_account.access_token),'') IS NULL
    OR v_account.token_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'META_ANALYTICS_REAUTH_REQUIRED' USING ERRCODE='MAH03';
  END IF;
  IF p_platform='facebook' THEN
    SELECT jsonb_build_object('platform_user_id',v_account.platform_user_id,'connection_version',f.connection_version,
      'credential_id',c.id,'credential_revision',c.revision,'provider_user_id',c.provider_user_id,'token_expires_at',v_account.token_expires_at)
    INTO v_context FROM public.facebook_user_credential_bindings b
    JOIN public.facebook_user_credential_connection_fences f USING(social_account_id,user_id,platform)
    JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
    WHERE b.social_account_id=p_account AND b.user_id=p_owner AND b.platform='facebook'
      AND b.connection_version=f.connection_version AND b.verified_facebook_user_id=c.provider_user_id
      AND c.provider_user_id IS NOT NULL AND (b.evidence_source IN ('oauth_exchange','token_refresh') OR public.analytics_bootstrap_binding_verified(b.social_account_id)) AND c.lifecycle='active';
    IF v_context IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_AUTHORITY_MISSING' USING ERRCODE='MAH03'; END IF;
  ELSIF p_platform='threads' THEN
    SELECT credential_generation INTO v_generation FROM public.threads_analytics_connection_fences WHERE social_account_id=p_account AND user_id=p_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_AUTHORITY_MISSING' USING ERRCODE='MAH03'; END IF;
    v_context:=jsonb_build_object('platform_user_id',v_account.platform_user_id,'credential_generation',v_generation,'token_expires_at',v_account.token_expires_at);
  ELSE RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  RETURN v_context;
END;
$fn$;

-- Internal helpers cannot be invoked by service-role clients; only the entry RPCs own them.
DO $acl$
DECLARE signature regprocedure;function_name text;
BEGIN
 FOR signature,function_name IN SELECT oid::regprocedure,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND
  (proname LIKE 'analytics_bootstrap_%' OR proname IN ('dispatch_analytics_legacy_bootstrap','begin_analytics_legacy_bootstrap',
   'commit_analytics_legacy_bootstrap','complete_analytics_legacy_bootstrap','settle_analytics_legacy_bootstrap',
   'permit_analytics_legacy_bootstrap','record_analytics_legacy_bootstrap_usage','record_analytics_legacy_bootstrap_refusal','reconcile_analytics_legacy_bootstrap')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',signature);
  IF function_name NOT LIKE 'analytics_bootstrap_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',signature); END IF;
 END LOOP;
END;
$acl$;
COMMIT;
