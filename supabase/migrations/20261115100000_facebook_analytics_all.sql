-- Phase 6 only. Apply as app_settings owner, with Facebook enqueue/drain and
-- bootstrap invocations paused and existing bounded requests/leases settled.
-- Verify this catalog before deploying the compatible runtime; only afterwards
-- use the revisioned CAS to convert policy. No setting/master/schedule changes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Canonicalization already rejects duplicate UUID identities and caps staging
-- lists at 100. This Facebook-only decoder never widens Threads or retention.
CREATE FUNCTION public.fb_analytics_normalize_policy(p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE canonical jsonb;
BEGIN
 canonical:=public.analytics_collection_canonical_policy('collection_facebook_analytics_policy',p_policy);
 RETURN CASE WHEN canonical ? 'version' THEN canonical
  ELSE jsonb_build_object('version',2,'mode','allowlist','account_ids',canonical->'account_ids') END;
END;$fn$;
REVOKE ALL ON FUNCTION public.fb_analytics_normalize_policy(jsonb) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION public.analytics_collection_policy_snapshot(p_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE raw jsonb; canonical jsonb; present boolean; revision bigint; raw_fingerprint text; fingerprint text; state text:='valid';
BEGIN
 -- One MVCC statement: content and its revision cannot come from two commits.
 SELECT s.key IS NOT NULL,s.value,r.revision INTO present,raw,revision
 FROM public.analytics_collection_policy_revisions r LEFT JOIN public.app_settings s ON s.key=r.key WHERE r.key=p_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'ANALYTICS_POLICY_REVISION_UNAVAILABLE'; END IF;
 raw_fingerprint:=encode(sha256(convert_to(jsonb_build_object('present',present,'value',raw)::text,'utf8')),'hex');
 IF NOT present THEN state:='missing';
 ELSE
  BEGIN canonical:=public.analytics_collection_canonical_policy(p_key,raw);
  EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN state:='malformed'; END;
 END IF;
 fingerprint:=CASE WHEN state='valid' THEN encode(sha256(convert_to(canonical::text,'utf8')),'hex') ELSE raw_fingerprint END;
 RETURN jsonb_build_object('state',state,'policy',canonical,'fingerprint',fingerprint,'raw_fingerprint',raw_fingerprint,'revision',revision);
END;$fn$;

CREATE OR REPLACE FUNCTION public.analytics_collection_policy_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE old_key text; new_key text; k text; trusted_owner boolean; caller name; cas boolean;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'ANALYTICS_POLICY_TRUNCATE_DENIED' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN old_key:=OLD.key; END IF;
 IF TG_OP<>'DELETE' THEN new_key:=NEW.key; END IF;
 IF COALESCE(old_key,'') NOT IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy')
  AND COALESCE(new_key,'') NOT IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy') THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND old_key IS DISTINCT FROM new_key THEN
  RAISE EXCEPTION 'ANALYTICS_POLICY_RENAME_DENIED' USING ERRCODE='42501';
 END IF;
 k:=COALESCE(new_key,old_key);
 caller:=COALESCE(NULLIF(current_setting('role',true),'none'),session_user);
 SELECT pending_actor IS NOT NULL INTO STRICT cas FROM public.analytics_collection_policy_revisions WHERE key=k;
 SELECT caller=pg_get_userbyid(c.relowner) OR r.rolsuper INTO trusted_owner
  FROM pg_class c CROSS JOIN pg_roles r WHERE c.oid='public.app_settings'::regclass AND r.rolname=caller;
 IF NOT cas AND NOT COALESCE(trusted_owner,false) THEN
  IF caller<>'authenticated' OR NOT public.has_role(auth.uid(),'admin') OR TG_OP<>'UPDATE' THEN
   RAISE EXCEPTION 'ANALYTICS_POLICY_DIRECT_WRITE_DENIED' USING ERRCODE='42501';
  END IF;
  -- Preserve the existing trusted admin update path, with strict validation.
  NEW.value:=public.analytics_collection_canonical_policy(NEW.key,NEW.value);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;$fn$;

CREATE OR REPLACE FUNCTION public.analytics_collection_policy_audit_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE k text; before_policy jsonb; after_policy jsonb; old_revision bigint; old_fingerprint text; new_fingerprint text;
 actor text; approval text; path text;
BEGIN
 k:=CASE WHEN TG_OP='DELETE' THEN OLD.key ELSE NEW.key END;
 IF k NOT IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy') THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 SELECT revision,pending_actor,pending_approval_ref INTO STRICT old_revision,actor,approval
  FROM public.analytics_collection_policy_revisions WHERE key=k FOR UPDATE NOWAIT;
 IF TG_OP<>'INSERT' THEN
  BEGIN before_policy:=public.analytics_collection_canonical_policy(k,OLD.value);
  EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN NULL; END;
 END IF;
 IF TG_OP<>'DELETE' THEN
  BEGIN after_policy:=public.analytics_collection_canonical_policy(k,NEW.value);
  EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN NULL; END;
 END IF;
 old_fingerprint:=encode(sha256(convert_to(COALESCE(before_policy,jsonb_build_object('present',TG_OP<>'INSERT','value',CASE WHEN TG_OP<>'INSERT' THEN OLD.value END))::text,'utf8')),'hex');
 new_fingerprint:=encode(sha256(convert_to(COALESCE(after_policy,jsonb_build_object('present',TG_OP<>'DELETE','value',CASE WHEN TG_OP<>'DELETE' THEN NEW.value END))::text,'utf8')),'hex');
 path:=CASE WHEN actor IS NOT NULL AND approval IS NOT NULL THEN 'cas' WHEN auth.uid() IS NOT NULL THEN 'trusted_admin_settings' ELSE 'trusted_owner_maintenance' END;
 actor:=COALESCE(actor,auth.uid()::text,'database-owner:'||current_user);
 approval:=COALESCE(approval,path);
 UPDATE public.analytics_collection_policy_revisions SET revision=old_revision+1,pending_actor=NULL,pending_approval_ref=NULL,updated_at=clock_timestamp() WHERE key=k;
 INSERT INTO public.system_logs(source,category,level,message,user_id,metadata)
 VALUES(CASE WHEN k='collection_instagram_rollout_policy' THEN 'instagram' ELSE 'facebook' END||'-collection-rollout',
  'database','info','Analytics collection rollout policy changed',auth.uid(),jsonb_build_object(
   'event','rollout_policy_changed','operation',lower(TG_OP),'path',path,
   'old_fingerprint',old_fingerprint,'new_fingerprint',new_fingerprint,'policy_fingerprint',new_fingerprint,
   'old_revision',old_revision,'new_revision',old_revision+1,'actor',actor,'approval_ref',approval));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;$fn$;

CREATE OR REPLACE FUNCTION public.analytics_collection_set_policy(p_key text,p_expected_fingerprint text,p_expected_revision bigint,p_policy jsonb,p_actor text,p_approval_ref text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp SET lock_timeout='3s' SET statement_timeout='10s' AS $fn$
DECLARE old jsonb; canonical jsonb; reason text; closed boolean;
BEGIN
 IF p_key NOT IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy') OR p_key IS NULL THEN
  RAISE EXCEPTION 'ANALYTICS_POLICY_INVALID_KEY' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.analytics_collection_policy_revisions WHERE key=p_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ANALYTICS_POLICY_REVISION_UNAVAILABLE'; END IF;
 -- Locks the live row as well, so trusted maintenance cannot race the compare.
 PERFORM 1 FROM public.app_settings WHERE key=p_key FOR UPDATE;
 old:=public.analytics_collection_policy_snapshot(p_key);
 IF p_actor IS NULL OR p_approval_ref IS NULL OR length(p_actor)>200 OR length(p_approval_ref)>200
  OR p_actor ~ '^[[:space:]]*$' OR p_approval_ref ~ '^[[:space:]]*$' THEN reason:='operator_context_invalid';
 ELSIF p_expected_fingerprint IS DISTINCT FROM old->>'fingerprint' OR p_expected_revision IS DISTINCT FROM (old->>'revision')::bigint THEN reason:='policy_conflict';
 ELSE
  BEGIN canonical:=public.analytics_collection_canonical_policy(p_key,p_policy);
  EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN reason:='policy_invalid'; END;
  IF reason IS NULL AND old->>'state'<>'valid' THEN
   closed:=CASE WHEN p_key='collection_instagram_rollout_policy' THEN
    (canonical->'owners'->>'mode'='off' OR (canonical->'owners'->>'mode'='allowlist' AND canonical->'owners'->'account_ids'='[]'::jsonb))
    AND (canonical->'competitors'->>'mode'='off' OR (canonical->'competitors'->>'mode'='allowlist' AND canonical->'competitors'->'targets'='[]'::jsonb))
    ELSE COALESCE(canonical->>'mode','allowlist')='off' OR
     (COALESCE(canonical->>'mode','allowlist')='allowlist' AND canonical->'account_ids'='[]'::jsonb) END;
   IF NOT closed THEN reason:='recovery_requires_closed_policy'; END IF;
  END IF;
 END IF;
 IF reason IS NOT NULL THEN
  INSERT INTO public.system_logs(source,category,level,message,metadata)
  VALUES(CASE WHEN p_key='collection_instagram_rollout_policy' THEN 'instagram' ELSE 'facebook' END||'-collection-rollout',
   'database','warn','Analytics collection policy change refused',jsonb_build_object('event','rollout_policy_change_refused','reason_code',reason,
   'old_fingerprint',old->>'fingerprint','old_revision',(old->>'revision')::bigint));
  RETURN jsonb_build_object('ok',false,'reason_code',reason);
 END IF;
 UPDATE public.analytics_collection_policy_revisions SET pending_actor=btrim(p_actor),pending_approval_ref=btrim(p_approval_ref) WHERE key=p_key;
 INSERT INTO public.app_settings(key,value) VALUES(p_key,canonical) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp();
 RETURN jsonb_build_object('ok',true)||public.analytics_collection_policy_snapshot(p_key);
END;$fn$;

CREATE OR REPLACE FUNCTION public.meta_analytics_collection_policy(p_platform text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_enabled jsonb;v_policy jsonb;v_ids jsonb;v_revision bigint;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  SELECT value INTO v_enabled FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_enabled' FOR SHARE;
  IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF v_enabled='false'::jsonb THEN RETURN jsonb_build_object('state','disabled'); END IF;
  SELECT value INTO v_policy FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_policy' FOR SHARE;
  IF p_platform='facebook' THEN
    BEGIN v_policy:=public.fb_analytics_normalize_policy(v_policy);
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN
      RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END;
    IF v_policy->>'mode'='off' THEN RETURN jsonb_build_object('state','disabled'); END IF;
    -- Settings stay locked against CAS until this operation ends. Read revision
    -- after the settings lock, without inverting CAS's revision -> settings order.
    SELECT revision INTO STRICT v_revision FROM public.analytics_collection_policy_revisions WHERE key='collection_facebook_analytics_policy';
    RETURN v_policy||jsonb_build_object('state','enabled','policy_digest',
      encode(sha256(convert_to(jsonb_build_object('policy',v_policy,'revision',v_revision)::text,'utf8')),'hex'));
  END IF;
  v_ids:=public.meta_analytics_policy_ids(v_policy);
  RETURN jsonb_build_object('state','enabled','account_ids',v_ids,'policy_digest',encode(sha256(convert_to(v_policy::text,'utf8')),'hex'));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.meta_analytics_collection_allowed(p_platform text,p_account uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_policy jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') OR p_account IS NULL THEN RETURN false; END IF;
  v_policy:=public.meta_analytics_collection_policy(p_platform);
  IF p_platform='facebook' THEN
    RETURN v_policy->>'state'='enabled' AND (v_policy->>'mode'='all' OR v_policy->'account_ids' @> jsonb_build_array(p_account::text))
      AND EXISTS(SELECT 1 FROM public.social_accounts WHERE id=p_account AND platform='facebook' AND is_active);
  END IF;
  RETURN v_policy->>'state'='enabled' AND (v_policy->'account_ids') @> jsonb_build_array(p_account::text);
EXCEPTION WHEN SQLSTATE 'MAH05' THEN RETURN false;
END;
$fn$;

-- UUID keyset for all, indexed intersections for staging. Never aggregate
-- the global population into a policy, ticket, response or invocation array.
CREATE INDEX social_accounts_facebook_analytics_keyset ON public.social_accounts(id)
 WHERE platform='facebook' AND is_active;
CREATE FUNCTION public.meta_analytics_dispatch_next_account(p_platform text,p_policy jsonb,p_after uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
BEGIN
 IF p_platform='facebook' THEN
  IF p_policy->>'mode'='all' THEN
   RETURN (SELECT id FROM public.social_accounts WHERE platform='facebook' AND is_active
    AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT 1);
  ELSIF p_policy->>'mode'='allowlist' THEN
   RETURN (SELECT id FROM public.social_accounts WHERE platform='facebook' AND is_active
    AND id=ANY(ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(p_policy->'account_ids') e))
    AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT 1);
  END IF;
  RETURN NULL;
 END IF;
 RETURN public.meta_analytics_dispatch_next_id(p_policy,p_after);
END;$fn$;
REVOKE ALL ON FUNCTION public.meta_analytics_dispatch_next_account(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.meta_analytics_enqueue_sweeps
 ADD COLUMN visited_count integer NOT NULL DEFAULT 0 CHECK(visited_count>=0),
 ADD COLUMN queued_count integer NOT NULL DEFAULT 0 CHECK(queued_count>=0),
 ADD COLUMN refused_count integer NOT NULL DEFAULT 0 CHECK(refused_count>=0);
CREATE TABLE public.fb_analytics_sweep_outcomes (
 platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),
 due_on date NOT NULL,policy_digest text NOT NULL,dispatch_round bigint NOT NULL CHECK(dispatch_round>0),
 social_account_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('admission_pending','queued','refused')),
 reason text CHECK(reason IN ('account_unavailable','permission_missing','reauth_required','identity_mismatch','app_mismatch',
   'provider_error','admission_refused','provider_unavailable','invalid_contract')),
 job_id uuid,attempt_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(attempt_ids)<=3 AND array_position(attempt_ids,NULL) IS NULL),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(platform,due_on,policy_digest,dispatch_round,social_account_id),
 FOREIGN KEY(platform,due_on,policy_digest) REFERENCES public.meta_analytics_enqueue_sweeps(platform,due_on,policy_digest) ON DELETE CASCADE
);
ALTER TABLE public.fb_analytics_sweep_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_analytics_sweep_outcomes FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX fb_analytics_sweep_outcomes_retry ON public.fb_analytics_sweep_outcomes(platform,due_on,policy_digest,dispatch_round,outcome,social_account_id);
-- Preserve current legacy-round diagnostics while moving ALL Facebook modes to
-- one storage path. These bounded pre-v2 objects are at most 64 KiB each.
INSERT INTO public.fb_analytics_sweep_outcomes(platform,due_on,policy_digest,dispatch_round,social_account_id,outcome,reason,job_id,attempt_ids)
 SELECT s.platform,s.due_on,s.policy_digest,s.dispatch_round,e.key::uuid,e.value->>'outcome',e.value->>'reason',
  (e.value->>'job_id')::uuid,ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(COALESCE(e.value->'attempt_ids','[]')) x)
 FROM public.meta_analytics_enqueue_sweeps s CROSS JOIN LATERAL jsonb_each(s.outcomes) e WHERE s.platform='facebook';
UPDATE public.meta_analytics_enqueue_sweeps s SET outcomes='{}',
 visited_count=(SELECT count(*) FROM public.fb_analytics_sweep_outcomes o WHERE (o.platform,o.due_on,o.policy_digest,o.dispatch_round)=(s.platform,s.due_on,s.policy_digest,s.dispatch_round) AND o.outcome IN ('queued','refused')),
 queued_count=(SELECT count(*) FROM public.fb_analytics_sweep_outcomes o WHERE (o.platform,o.due_on,o.policy_digest,o.dispatch_round)=(s.platform,s.due_on,s.policy_digest,s.dispatch_round) AND o.outcome='queued'),
 refused_count=(SELECT count(*) FROM public.fb_analytics_sweep_outcomes o WHERE (o.platform,o.due_on,o.policy_digest,o.dispatch_round)=(s.platform,s.due_on,s.policy_digest,s.dispatch_round) AND o.outcome='refused')
 WHERE s.platform='facebook';
ALTER TABLE public.meta_analytics_enqueue_sweeps ADD CONSTRAINT facebook_sweep_outcomes_normalized CHECK(platform<>'facebook' OR outcomes='{}'::jsonb);


CREATE OR REPLACE FUNCTION public.next_meta_analytics_dispatch_target(p_platform text,p_start boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_policy jsonb;v_sweep public.meta_analytics_enqueue_sweeps;v_account uuid;
  v_due date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_refused integer;v_owner uuid;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_start IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH' USING ERRCODE='MAH01'; END IF;
  v_policy:=public.meta_analytics_collection_policy(p_platform);
  IF v_policy->>'state'='disabled' THEN RETURN jsonb_build_object('state','disabled'); END IF;
  IF p_start THEN
    INSERT INTO public.meta_analytics_enqueue_sweeps(platform,due_on,policy_digest)
      VALUES(p_platform,v_due,v_policy->>'policy_digest') ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO v_sweep FROM public.meta_analytics_enqueue_sweeps
    WHERE platform=p_platform AND due_on=v_due AND policy_digest=v_policy->>'policy_digest' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','not_started'); END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_sweep.complete AND p_start THEN
    WITH reopened AS (
      UPDATE public.meta_analytics_enqueue_sweeps s SET dispatch_round=dispatch_round+1,last_account_id=NULL,
        complete=false,outcomes='{}',visited_count=0,queued_count=0,refused_count=0,updated_at=clock_timestamp()
        WHERE platform=p_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest RETURNING s.*
    ), pruned AS (
      DELETE FROM public.fb_analytics_sweep_outcomes o USING reopened r
       WHERE (o.platform,o.due_on,o.policy_digest)=(r.platform,r.due_on,r.policy_digest) RETURNING 1
    ) SELECT r.* INTO v_sweep FROM reopened r;
  END IF;
  v_account:=public.meta_analytics_dispatch_next_account(p_platform,v_policy,v_sweep.last_account_id);
  IF v_sweep.complete OR v_account IS NULL THEN
    IF NOT v_sweep.complete THEN
      UPDATE public.meta_analytics_enqueue_sweeps SET complete=true,updated_at=clock_timestamp()
        WHERE platform=p_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest;
    END IF;
    IF p_platform='facebook' THEN v_refused:=v_sweep.refused_count;
    ELSE SELECT count(*) INTO v_refused FROM jsonb_each(v_sweep.outcomes) e WHERE e.value->>'outcome'='refused'; END IF;
    RETURN jsonb_build_object('state','complete','refused_count',v_refused,'round',v_sweep.dispatch_round,'served_at',v_sweep.updated_at);
  END IF;
  IF p_platform='facebook' THEN
    SELECT user_id INTO v_owner FROM public.social_accounts WHERE id=v_account AND platform='facebook' AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  END IF;
  RETURN jsonb_build_object('state','target','served_at',v_sweep.updated_at,'ticket',jsonb_build_object('platform',p_platform,'due_on',v_due,
    'policy_digest',v_sweep.policy_digest,'round',v_sweep.dispatch_round,'after_account_id',v_sweep.last_account_id,'account_id',v_account)||
    CASE WHEN p_platform='facebook' THEN jsonb_build_object('owner_id',v_owner) ELSE '{}'::jsonb END);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.commit_meta_analytics_dispatch_target(p_ticket jsonb,p_outcome text DEFAULT 'enqueue',p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_platform text;v_due date;v_round bigint;v_account uuid;v_after uuid;v_owner uuid;
  v_policy jsonb;v_sweep public.meta_analytics_enqueue_sweeps;v_prepared jsonb;v_job jsonb;
  v_outcome text:=p_outcome;v_reason text:=p_reason;v_ready boolean;v_complete boolean;v_refused integer;v_attempts integer;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_ticket IS NULL OR jsonb_typeof(p_ticket)<>'object' OR pg_column_size(p_ticket)>8192 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH_TICKET' USING ERRCODE='MAH01'; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_ticket) k) IS DISTINCT FROM
      (CASE WHEN p_ticket->>'platform'='facebook' THEN ARRAY['account_id','after_account_id','due_on','owner_id','platform','policy_digest','round']::text[]
      ELSE ARRAY['account_id','after_account_id','due_on','platform','policy_digest','round']::text[] END)
    OR p_ticket->>'platform'='facebook' AND COALESCE(p_ticket->>'owner_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR p_ticket->>'platform' IS NULL OR p_ticket->>'platform' NOT IN ('facebook','threads')
    OR COALESCE(p_ticket->>'policy_digest','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_ticket->'round') IS DISTINCT FROM 'number' OR COALESCE(p_ticket->>'round','') !~ '^[1-9][0-9]{0,14}$'
    OR COALESCE(p_ticket->>'due_on','') !~ '^\d{4}-\d{2}-\d{2}$'
    OR COALESCE(p_ticket->>'account_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR jsonb_typeof(p_ticket->'after_account_id') NOT IN ('null','string')
    OR p_ticket->>'after_account_id' IS NOT NULL AND p_ticket->>'after_account_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR p_outcome IS NULL OR p_outcome NOT IN ('enqueue','refused')
    OR p_outcome='enqueue' AND p_reason IS NOT NULL
    OR p_outcome='refused' AND (p_reason IS NULL OR p_reason NOT IN ('account_unavailable','permission_missing','reauth_required','identity_mismatch','app_mismatch','provider_error','admission_refused')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH_TICKET' USING ERRCODE='MAH01'; END IF;
  BEGIN v_due:=(p_ticket->>'due_on')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH_TICKET' USING ERRCODE='MAH01'; END;
  v_platform:=p_ticket->>'platform';v_round:=(p_ticket->>'round')::bigint;
  v_account:=(p_ticket->>'account_id')::uuid;v_after:=(p_ticket->>'after_account_id')::uuid;
  -- Parent account first. The sweep reader never waits for an account lock.
  SELECT user_id INTO v_owner FROM public.social_accounts WHERE id=v_account AND platform=v_platform;
  IF v_platform='facebook' AND v_owner IS DISTINCT FROM (p_ticket->>'owner_id')::uuid THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_owner IS NOT NULL THEN PERFORM public.meta_analytics_lock_account(v_account,v_owner,v_platform); END IF;
  v_policy:=public.meta_analytics_collection_policy(v_platform);
  IF v_policy->>'state'<>'enabled' THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date OR v_policy->>'policy_digest' IS DISTINCT FROM p_ticket->>'policy_digest' THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  SELECT * INTO v_sweep FROM public.meta_analytics_enqueue_sweeps
    WHERE platform=v_platform AND due_on=v_due AND policy_digest=p_ticket->>'policy_digest' FOR UPDATE;
  IF NOT FOUND OR v_sweep.complete OR v_sweep.dispatch_round<>v_round OR v_sweep.last_account_id IS DISTINCT FROM v_after
    OR public.meta_analytics_dispatch_next_account(v_platform,v_policy,v_after) IS DISTINCT FROM v_account THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_platform='facebook' THEN
    SELECT cardinality(attempt_ids) INTO v_attempts FROM public.fb_analytics_sweep_outcomes
      WHERE (platform,due_on,policy_digest,dispatch_round,social_account_id)=(v_platform,v_due,v_sweep.policy_digest,v_round,v_account);
  ELSE v_attempts:=jsonb_array_length(v_sweep.outcomes->v_account::text->'attempt_ids'); END IF;
  IF v_outcome='refused' AND v_reason='provider_error' AND COALESCE(v_attempts,0)<3 THEN
    RAISE EXCEPTION 'META_ANALYTICS_ADMISSION_FAILURE_BOUND_REQUIRED' USING ERRCODE='MAH01'; END IF;
  IF v_outcome='enqueue' THEN
    IF v_owner IS NULL THEN v_outcome:='refused';v_reason:='account_unavailable';
    ELSE
      BEGIN
        IF v_platform='facebook' THEN
          v_prepared:=public.prepare_fb_analytics_account(v_owner,v_account);
          SELECT EXISTS(SELECT 1 FROM public.fb_analytics_permission_observations WHERE user_id=v_owner AND social_account_id=v_account
            AND authority=v_prepared->'authority' AND state='verified' AND observed_at>=v_due::timestamp AT TIME ZONE 'America/Los_Angeles'
            AND granted_scopes @> ARRAY['read_insights','pages_read_engagement']::text[]) INTO v_ready;
        ELSE
          v_prepared:=public.prepare_threads_analytics_account(v_owner,v_account);
          SELECT EXISTS(SELECT 1 FROM public.threads_analytics_permission_observations WHERE user_id=v_owner AND social_account_id=v_account
            AND authority=v_prepared->'authority' AND state='verified' AND observed_at>=v_due::timestamp AT TIME ZONE 'America/Los_Angeles'
            AND granted_scopes @> ARRAY['threads_basic','threads_manage_insights']::text[]) INTO v_ready;
        END IF;
        IF NOT v_ready THEN
          IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
            RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
          RETURN jsonb_build_object('state','needs_admission');
        END IF;
        IF v_platform='facebook' THEN v_job:=public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_due,false);
        ELSE v_job:=public.enqueue_threads_analytics_collection_job(v_owner,v_account,v_due,false); END IF;
        v_outcome:='queued';
      EXCEPTION WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH03' THEN v_outcome:='refused';v_reason:='admission_refused'; END;
    END IF;
  END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  v_complete:=public.meta_analytics_dispatch_next_account(v_platform,v_policy,v_account) IS NULL;
  IF v_platform='facebook' THEN
    INSERT INTO public.fb_analytics_sweep_outcomes(platform,due_on,policy_digest,dispatch_round,social_account_id,outcome,reason,job_id)
      VALUES(v_platform,v_due,v_sweep.policy_digest,v_round,v_account,v_outcome,v_reason,(v_job->>'job_id')::uuid)
      ON CONFLICT(platform,due_on,policy_digest,dispatch_round,social_account_id) DO UPDATE SET
        outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,job_id=EXCLUDED.job_id,updated_at=clock_timestamp();
    UPDATE public.meta_analytics_enqueue_sweeps SET last_account_id=v_account,complete=v_complete,updated_at=clock_timestamp(),
      visited_count=visited_count+1,queued_count=queued_count+CASE WHEN v_outcome='queued' THEN 1 ELSE 0 END,
      refused_count=refused_count+CASE WHEN v_outcome='refused' THEN 1 ELSE 0 END
      WHERE platform=v_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest RETURNING * INTO v_sweep;
    v_refused:=v_sweep.refused_count;
  ELSE
  UPDATE public.meta_analytics_enqueue_sweeps SET last_account_id=v_account,complete=v_complete,updated_at=clock_timestamp(),
    outcomes=outcomes||jsonb_build_object(v_account::text,jsonb_build_object('outcome',v_outcome,'reason',v_reason,'job_id',v_job->'job_id'))
    WHERE platform=v_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest RETURNING * INTO v_sweep;
  SELECT count(*) INTO v_refused FROM jsonb_each(v_sweep.outcomes) e WHERE e.value->>'outcome'='refused';
  END IF;
  RETURN jsonb_build_object('state','advanced','outcome',v_outcome,'complete',v_complete,'refused_count',v_refused);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.record_meta_analytics_admission_failure(p_ticket jsonb,p_reason text,p_attempt_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_initial jsonb;v_ids jsonb;v_account text;v_platform text;v_due date;v_digest text;v_count integer;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_reason IS NULL OR p_reason NOT IN ('provider_unavailable','invalid_contract') OR p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_ADMISSION_FAILURE' USING ERRCODE='MAH01'; END IF;
  -- Reuse ticket validation, parent-first locking and current policy/authority.
  -- A concurrently verified grant wins over this failed provider attempt.
  v_initial:=public.commit_meta_analytics_dispatch_target(p_ticket,'enqueue',NULL);
  IF v_initial->>'state'='advanced' THEN RETURN v_initial; END IF;
  v_account:=((p_ticket->>'account_id')::uuid)::text;v_platform:=p_ticket->>'platform';
  v_due:=(p_ticket->>'due_on')::date;v_digest:=p_ticket->>'policy_digest';
  IF v_platform='facebook' THEN
    SELECT to_jsonb(attempt_ids) INTO v_ids FROM public.fb_analytics_sweep_outcomes
      WHERE (platform,due_on,policy_digest,dispatch_round,social_account_id)=
        (v_platform,v_due,v_digest,(p_ticket->>'round')::bigint,v_account::uuid);
    v_ids:=COALESCE(v_ids,'[]'::jsonb);
  ELSE
  SELECT COALESCE(outcomes->v_account->'attempt_ids','[]'::jsonb) INTO v_ids
    FROM public.meta_analytics_enqueue_sweeps WHERE platform=v_platform AND due_on=v_due AND policy_digest=v_digest;
  END IF;
  IF NOT v_ids @> jsonb_build_array(p_attempt_id::text) THEN v_ids:=v_ids||jsonb_build_array(p_attempt_id::text); END IF;
  v_count:=jsonb_array_length(v_ids);
  IF v_count NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_ADMISSION_FAILURE' USING ERRCODE='MAH01'; END IF;
  IF v_platform='facebook' THEN
    INSERT INTO public.fb_analytics_sweep_outcomes(platform,due_on,policy_digest,dispatch_round,social_account_id,outcome,reason,attempt_ids)
      VALUES(v_platform,v_due,v_digest,(p_ticket->>'round')::bigint,v_account::uuid,'admission_pending',p_reason,
        ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_ids) x))
      ON CONFLICT(platform,due_on,policy_digest,dispatch_round,social_account_id) DO UPDATE SET
        outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,attempt_ids=EXCLUDED.attempt_ids,updated_at=clock_timestamp();
    UPDATE public.meta_analytics_enqueue_sweeps SET updated_at=clock_timestamp()
      WHERE platform=v_platform AND due_on=v_due AND policy_digest=v_digest;
  ELSE
  UPDATE public.meta_analytics_enqueue_sweeps SET updated_at=clock_timestamp(),
    outcomes=outcomes||jsonb_build_object(v_account,jsonb_build_object('outcome','admission_pending','reason',p_reason,'attempt_ids',v_ids))
    WHERE platform=v_platform AND due_on=v_due AND policy_digest=v_digest;
  END IF;
  IF v_count<3 THEN RETURN jsonb_build_object('state','pending','attempts',v_count); END IF;
  -- This is a visible failed enumeration outcome, not permission denial. A
  -- later round retries admission; unknown SQL outcomes still stop the caller.
  RETURN public.commit_meta_analytics_dispatch_target(p_ticket,'refused','provider_error');
END;
$fn$;

-- An admission from a dispatch ticket must not switch tenants if the Page is
-- reowned between commit's needs_admission result and the first provider read.
-- The original two-argument service API remains compatible for explicit admit.
CREATE FUNCTION public.read_fb_analytics_admission_credential(p_account_id uuid,p_expected_authority jsonb,p_expected_owner uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' SET statement_timeout='5s' AS $fn$
BEGIN
 PERFORM public.meta_analytics_assert_service();
 IF p_expected_owner IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
 PERFORM public.meta_analytics_lock_account(p_account_id,p_expected_owner,'facebook');
 RETURN public.meta_analytics_admission_credential('facebook',p_account_id,p_expected_authority);
END;$fn$;
REVOKE ALL ON FUNCTION public.read_fb_analytics_admission_credential(uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_fb_analytics_admission_credential(uuid,jsonb,uuid) TO service_role;


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
              AND b.verified_instagram_user_id=a.platform_user_id AND b.evidence_source IN ('oauth_exchange','token_refresh'))) AS identity_matches
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

CREATE OR REPLACE FUNCTION public.complete_analytics_legacy_bootstrap(p_job_id uuid,p_lease_id uuid,p_revision bigint,p_permissions jsonb) RETURNS jsonb
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
  -- Bootstrap proof must be fresh for the current Facebook provider day. A
  -- midnight-crossing attempt remains retryable, without collection admission.
  IF (observed AT TIME ZONE 'America/Los_Angeles')::date<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'BOOTSTRAP_PERMISSION_STALE'; END IF;
  -- This verification is independent of collection policy: never call policy-blocked prepare/observe.
  authority:=public.meta_analytics_current_authority('facebook',j.social_account_id,j.user_id);
  PERFORM public.fb_analytics_require_usable_credential(j.user_id,authority);
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

-- Bounded queue search under v2 all; no global account array. Invalid early
-- jobs are filtered before the 50-candidate lock ceiling; locked checks remain
-- authoritative and the existing cross-platform claim turn remains unchanged.
CREATE OR REPLACE FUNCTION public.claim_fb_analytics_collection_jobs(p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_candidate record;v_job public.fb_analytics_collection_jobs;v_authority jsonb;v_jobs jsonb:='[]';v_claim uuid;v_hint jsonb;v_enabled jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_limit IS NULL OR p_limit<>1 THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_LIMIT' USING ERRCODE='MAH01'; END IF;
  -- Unlocked search hints never grant authority or invert account -> policy
  -- locking. Every selected candidate repeats the locked checks below.
  SELECT value INTO v_enabled FROM public.app_settings WHERE key='collection_facebook_analytics_enabled';
  IF v_enabled='false'::jsonb THEN RETURN '[]'::jsonb; END IF;
  IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  SELECT value INTO v_hint FROM public.app_settings WHERE key='collection_facebook_analytics_policy';
  BEGIN v_hint:=public.fb_analytics_normalize_policy(v_hint);
  EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END;
  IF v_hint->>'mode'='off' THEN RETURN '[]'::jsonb; END IF;
  FOR v_candidate IN
    SELECT q.id,q.user_id,q.social_account_id FROM public.fb_analytics_collection_jobs q
    JOIN public.social_accounts a ON (a.id,a.user_id,a.platform)=(q.social_account_id,q.user_id,'facebook')
    JOIN public.facebook_user_credential_bindings b ON (b.social_account_id,b.user_id,b.platform)=(a.id,a.user_id,a.platform)
    JOIN public.facebook_user_credential_connection_fences f ON (f.social_account_id,f.user_id,f.platform)=(b.social_account_id,b.user_id,b.platform)
    JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
    JOIN public.fb_analytics_permission_observations o ON o.social_account_id=a.id AND o.user_id=a.user_id
    WHERE a.is_active AND NOT COALESCE(a.needs_reauth,false) AND NULLIF(btrim(a.access_token),'') IS NOT NULL
      AND (a.token_expires_at IS NULL OR a.token_expires_at>clock_timestamp())
      AND c.lifecycle='active' AND NULLIF(btrim(c.token),'') IS NOT NULL AND (c.token_expires_at IS NULL OR c.token_expires_at>clock_timestamp())
      AND b.connection_version=f.connection_version AND b.verified_facebook_user_id=c.provider_user_id
      AND c.provider_user_id IS NOT NULL AND (b.evidence_source IN ('oauth_exchange','token_refresh') OR public.analytics_bootstrap_binding_verified(a.id))
      AND o.state='verified' AND o.granted_scopes @> ARRAY['read_insights','pages_read_engagement']::text[]
      AND o.authority=jsonb_build_object('platform_user_id',a.platform_user_id,'connection_version',f.connection_version,
        'credential_id',c.id,'credential_revision',c.revision,'provider_user_id',c.provider_user_id,'token_expires_at',a.token_expires_at)
      AND (v_hint->>'mode'='all' OR v_hint->'account_ids' @> jsonb_build_array(a.id::text))
      AND q.state IN ('pending','running','partial','retry') AND q.due_on>=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-365
      AND (q.retry_at IS NULL OR q.retry_at<=clock_timestamp()) AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
      AND q.due_at<=clock_timestamp() ORDER BY q.due_at,q.updated_at,q.id LIMIT 50 LOOP
    EXIT WHEN jsonb_array_length(v_jobs)>=p_limit;
    BEGIN
      PERFORM public.meta_analytics_lock_account(v_candidate.social_account_id,v_candidate.user_id,'facebook',true);
      IF NOT public.meta_analytics_collection_allowed('facebook',v_candidate.social_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_NOT_ELIGIBLE' USING ERRCODE='MAH03'; END IF;
      v_authority:=public.meta_analytics_current_authority('facebook',v_candidate.social_account_id,v_candidate.user_id);
      PERFORM public.fb_analytics_require_permission(v_candidate.user_id,v_candidate.social_account_id,v_authority);
      PERFORM 1 FROM public.fb_analytics_report_state WHERE social_account_id=v_candidate.social_account_id AND user_id=v_candidate.user_id AND credential_guarded FOR UPDATE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_NOT_ELIGIBLE' USING ERRCODE='MAH03'; END IF;
      SELECT * INTO v_job FROM public.fb_analytics_collection_jobs WHERE id=v_candidate.id FOR UPDATE NOWAIT;
      IF v_job.state NOT IN ('pending','running','partial','retry') OR v_job.lease_until>clock_timestamp() OR v_job.retry_at>clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
      v_claim:=gen_random_uuid();
      UPDATE public.fb_analytics_collection_jobs SET
        job_generation=job_generation+CASE WHEN credential_authority IS NOT NULL AND credential_authority IS DISTINCT FROM v_authority THEN 1 ELSE 0 END,
        state='running',claim_token=v_claim,lease_until=clock_timestamp()+interval '120 seconds',credential_authority=v_authority,
        attempts=attempts+1,retry_at=NULL,updated_at=clock_timestamp() WHERE id=v_job.id RETURNING * INTO v_job;
      v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('job_id',v_job.id,'user_id',v_job.user_id,'account_id',v_job.social_account_id,
        'job_generation',v_job.job_generation,'claim_token',v_job.claim_token,'lease_until',v_job.lease_until,'authority',v_authority,
        'due_on',v_job.due_on,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at));
    EXCEPTION WHEN lock_not_available THEN CONTINUE;
      WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH03' OR SQLSTATE 'MAH04' THEN CONTINUE;
    END;
  END LOOP;
  RETURN v_jobs;
END;
$fn$;


-- Authority is a version projection also used by historical diagnostics. Keep
-- that contract; validate live protected credential usability at collection and
-- bootstrap proof boundaries, independently of collection policy.
CREATE FUNCTION public.fb_analytics_require_usable_credential(p_owner uuid,p_authority jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.facebook_user_credentials WHERE user_id=p_owner AND id=(p_authority->>'credential_id')::uuid
  AND revision=(p_authority->>'credential_revision')::bigint AND lifecycle='active' AND NULLIF(btrim(token),'') IS NOT NULL
  AND (token_expires_at IS NULL OR token_expires_at>clock_timestamp())) THEN
  RAISE EXCEPTION 'META_ANALYTICS_REAUTH_REQUIRED' USING ERRCODE='MAH03'; END IF;
END;$fn$;
REVOKE ALL ON FUNCTION public.fb_analytics_require_usable_credential(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fb_analytics_require_permission(p_user_id uuid,p_account_id uuid,p_authority jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
  PERFORM public.fb_analytics_require_usable_credential(p_user_id,p_authority);
  IF NOT EXISTS(SELECT 1 FROM public.fb_analytics_permission_observations
    WHERE user_id=p_user_id AND social_account_id=p_account_id AND authority=p_authority AND state='verified'
      AND granted_scopes @> ARRAY['read_insights','pages_read_engagement']::text[]) THEN
    RAISE EXCEPTION 'META_ANALYTICS_PERMISSION_REQUIRED' USING ERRCODE='MAH03'; END IF;
END;
$fn$;
NOTIFY pgrst,'reload schema';
COMMIT;
