-- Phase 2 only. APPLY AS supabase_admin (the existing app_settings owner).
-- PRECONDITION: pause affected collection workers/schedules OR turn their
-- masters off before applying this direct-write restriction. Preserve the
-- reviewed settings, wait for in-flight leases to settle, verify the catalog
-- and admin tooling, then restore only the previously authorized state.
-- This migration changes NO policy/master value and activates nothing.
--
-- Trusted compatibility paths: validated authenticated-admin settings UPDATE
-- (the existing R3 admin-path contract) and database-owner maintenance/migrations.
-- Raw service-role DML is denied even with forged JWT/GUC context. Browser
-- admins cannot delete/rename these keys or call the service-only RPCs.
-- Owner maintenance can inject malformed rows for recovery, but is audited
-- and advances the durable revision even on DELETE. It is not a normal
-- operator shortcut. Use the CAS RPCs for all ordinary rollout operations.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- A tombstone survives missing/deleted settings; revisions never live inside
-- the policy JSON, whose exact legacy shapes must remain compatible.
CREATE TABLE public.analytics_collection_policy_revisions (
 key text PRIMARY KEY CHECK (key IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy')),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
 pending_actor text CHECK (length(pending_actor)<=200 AND pending_actor !~ '^[[:space:]]*$'),
 pending_approval_ref text CHECK (length(pending_approval_ref)<=200 AND pending_approval_ref !~ '^[[:space:]]*$'),
 CHECK ((pending_actor IS NULL)=(pending_approval_ref IS NULL)),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.analytics_collection_policy_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_collection_policy_revisions FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.analytics_collection_policy_revisions(key) VALUES
 ('collection_instagram_rollout_policy'),('collection_facebook_analytics_policy');

-- Instagram already has its restrictive private-key policy. Give Facebook
-- the same structural boundary, independent of future permissive read lists.
CREATE POLICY app_settings_facebook_collection_policy_private ON public.app_settings
AS RESTRICTIVE FOR ALL TO anon,authenticated
USING (key<>'collection_facebook_analytics_policy' OR public.has_role(auth.uid(),'admin'))
WITH CHECK (key<>'collection_facebook_analytics_policy' OR public.has_role(auth.uid(),'admin'));

-- Validate with the existing Instagram authority, then reconstruct its stored
-- shape with sorted, canonical UUID arrays (including competitor pins).
CREATE FUNCTION public.analytics_collection_canonical_policy(p_key text,p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE norm jsonb; ids jsonb; targets jsonb; keys text[]; versioned boolean;
BEGIN
 IF p_key='collection_instagram_rollout_policy' THEN
  norm:=public.ig_collection_rollout_normalize_policy(p_policy);
  SELECT COALESCE(jsonb_agg(e ORDER BY e#>>'{}'),'[]') INTO ids FROM jsonb_array_elements(norm->'owner_ids') e;
  SELECT COALESCE(jsonb_agg(e ORDER BY e->>'watchlist_id',e->>'viewer_social_account_id'),'[]') INTO targets
   FROM jsonb_array_elements(norm->'competitor_targets') e;
  RETURN jsonb_build_object('version',1,'owners',jsonb_build_object('mode',norm->>'owner_mode','account_ids',ids),
   'competitors',jsonb_build_object('mode',norm->>'competitor_mode','targets',targets));
 END IF;
 IF p_key IS DISTINCT FROM 'collection_facebook_analytics_policy' OR p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' THEN
  RAISE EXCEPTION 'ANALYTICS_POLICY_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p_policy) k;
 versioned:=keys=ARRAY['account_ids','mode','version'];
 IF keys IS DISTINCT FROM ARRAY['account_ids'] AND NOT COALESCE(versioned,false) THEN
  RAISE EXCEPTION 'ANALYTICS_POLICY_INVALID' USING ERRCODE='22023';
 END IF;
 IF versioned THEN
  IF p_policy->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(p_policy->'mode') IS DISTINCT FROM 'string'
   OR p_policy->>'mode' NOT IN ('off','allowlist','all') THEN
   RAISE EXCEPTION 'ANALYTICS_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
 END IF;
 -- Do not change meta_analytics_policy_ids: Threads and retention stay strict.
 ids:=public.meta_analytics_policy_ids(jsonb_build_object('account_ids',p_policy->'account_ids'));
 IF jsonb_array_length(ids)<>jsonb_array_length(p_policy->'account_ids') THEN
  RAISE EXCEPTION 'ANALYTICS_POLICY_DUPLICATE' USING ERRCODE='22023';
 END IF;
 IF versioned THEN
  IF p_policy->>'mode'='all' AND jsonb_array_length(ids)<>0 THEN
   RAISE EXCEPTION 'ANALYTICS_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('version',2,'mode',p_policy->>'mode','account_ids',ids);
 END IF;
 RETURN jsonb_build_object('account_ids',ids);
END;$fn$;

CREATE FUNCTION public.analytics_collection_policy_snapshot(p_key text)
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
 IF canonical ? 'version' AND p_key='collection_facebook_analytics_policy' THEN
  -- Phase 6 must deliberately replace this gate together with all evaluator,
  -- dispatcher, request/write fences and compatible runtime contracts.
  state:='facebook_v2_evaluator_not_installed';canonical:=NULL;
 END IF;
 fingerprint:=CASE WHEN state='valid' THEN encode(sha256(convert_to(canonical::text,'utf8')),'hex') ELSE raw_fingerprint END;
 RETURN jsonb_build_object('state',state,'policy',canonical,'fingerprint',fingerprint,'raw_fingerprint',raw_fingerprint,'revision',revision);
END;$fn$;

-- Existing permits/audits now identify semantically equal valid arrays alike.
-- Malformed documents retain a deterministic raw fingerprint for diagnostics.
CREATE OR REPLACE FUNCTION public.ig_collection_rollout_policy_fingerprint(p_policy jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE canonical jsonb;
BEGIN
 BEGIN canonical:=public.analytics_collection_canonical_policy('collection_instagram_rollout_policy',p_policy);
 EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE '22023' THEN canonical:=COALESCE(p_policy,'{}'); END;
 RETURN encode(sha256(convert_to(canonical::text,'utf8')),'hex');
END;$fn$;

-- The definer guard NEVER authorizes using current_user (its own owner), JWT
-- claims or custom GUCs. PostgreSQL's role setting is privilege checked by
-- SET ROLE; 'none' means the actual session_user. Only the private locked
-- revision row can carry a pending CAS context, invisible to client roles.
CREATE FUNCTION public.analytics_collection_policy_write_guard()
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
 IF TG_OP<>'DELETE' AND k='collection_facebook_analytics_policy' AND NEW.value->'version'='2'::jsonb THEN
  RAISE EXCEPTION 'facebook_v2_evaluator_not_installed' USING ERRCODE='0A000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;$fn$;

CREATE TRIGGER analytics_collection_policy_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.analytics_collection_policy_write_guard();
REVOKE TRUNCATE ON public.app_settings FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER analytics_collection_policy_truncate_guard BEFORE TRUNCATE ON public.app_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.analytics_collection_policy_write_guard();

-- Internal audit/revision writer. NOWAIT avoids an inversion with exceptional
-- owner/admin DML, which may already hold the settings row before this trigger
-- runs. CAS holds revision -> settings. A competing maintenance write must
-- abort and be retried from a fresh read; it must never deadlock or bypass CAS.
CREATE FUNCTION public.analytics_collection_policy_audit_trigger()
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
 IF k='collection_facebook_analytics_policy' AND before_policy ? 'version' THEN before_policy:=NULL; END IF;
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
DROP TRIGGER app_settings_rollout_policy_audit ON public.app_settings;
DROP FUNCTION public.ig_collection_rollout_policy_audit_trigger();
CREATE TRIGGER analytics_collection_policy_audit AFTER INSERT OR UPDATE OR DELETE ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.analytics_collection_policy_audit_trigger();

CREATE FUNCTION public.analytics_collection_set_policy(p_key text,p_expected_fingerprint text,p_expected_revision bigint,p_policy jsonb,p_actor text,p_approval_ref text)
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
  IF reason IS NULL AND p_key='collection_facebook_analytics_policy' AND canonical ? 'version' THEN
   reason:='facebook_v2_evaluator_not_installed';
  END IF;
  IF reason IS NULL AND old->>'state'<>'valid' THEN
   closed:=CASE WHEN p_key='collection_instagram_rollout_policy' THEN
    (canonical->'owners'->>'mode'='off' OR (canonical->'owners'->>'mode'='allowlist' AND canonical->'owners'->'account_ids'='[]'::jsonb))
    AND (canonical->'competitors'->>'mode'='off' OR (canonical->'competitors'->>'mode'='allowlist' AND canonical->'competitors'->'targets'='[]'::jsonb))
    ELSE canonical->'account_ids'='[]'::jsonb END;
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

CREATE FUNCTION public.get_instagram_collection_rollout_policy() RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='10s' AS $fn$
 SELECT public.analytics_collection_policy_snapshot('collection_instagram_rollout_policy');
$fn$;
CREATE FUNCTION public.get_facebook_analytics_collection_policy() RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='10s' AS $fn$
 SELECT public.analytics_collection_policy_snapshot('collection_facebook_analytics_policy');
$fn$;
CREATE FUNCTION public.set_instagram_collection_rollout_policy(p_expected_fingerprint text,p_expected_revision bigint,p_policy jsonb,p_actor text,p_approval_ref text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' SET statement_timeout='10s' AS $fn$
 SELECT public.analytics_collection_set_policy('collection_instagram_rollout_policy',p_expected_fingerprint,p_expected_revision,p_policy,p_actor,p_approval_ref);
$fn$;
CREATE FUNCTION public.set_facebook_analytics_collection_policy(p_expected_fingerprint text,p_expected_revision bigint,p_policy jsonb,p_actor text,p_approval_ref text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' SET statement_timeout='10s' AS $fn$
 SELECT public.analytics_collection_set_policy('collection_facebook_analytics_policy',p_expected_fingerprint,p_expected_revision,p_policy,p_actor,p_approval_ref);
$fn$;

REVOKE ALL ON FUNCTION public.analytics_collection_canonical_policy(text,jsonb),public.analytics_collection_policy_snapshot(text),
 public.analytics_collection_policy_write_guard(),public.analytics_collection_policy_audit_trigger(),
 public.analytics_collection_set_policy(text,text,bigint,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_instagram_collection_rollout_policy(),public.get_facebook_analytics_collection_policy(),
 public.set_instagram_collection_rollout_policy(text,bigint,jsonb,text,text),public.set_facebook_analytics_collection_policy(text,bigint,jsonb,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_instagram_collection_rollout_policy(),public.get_facebook_analytics_collection_policy(),
 public.set_instagram_collection_rollout_policy(text,bigint,jsonb,text,text),public.set_facebook_analytics_collection_policy(text,bigint,jsonb,text,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
