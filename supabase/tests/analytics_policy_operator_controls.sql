-- RC-17 operator boundary. Real SQL, rolled back; no provider or production work.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';

CREATE FUNCTION pg_temp.operator_get(p text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
 IF p='instagram' THEN RETURN public.get_instagram_collection_rollout_policy(); END IF;
 RETURN public.get_facebook_analytics_collection_policy();
END;$fn$;
CREATE FUNCTION pg_temp.operator_set(p text, old jsonb, policy jsonb, actor text DEFAULT 'RC-17 operator', approval text DEFAULT 'RC-17 authorization')
RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
 IF p='instagram' THEN RETURN public.set_instagram_collection_rollout_policy(old->>'fingerprint',(old->>'revision')::bigint,policy,actor,approval); END IF;
 RETURN public.set_facebook_analytics_collection_policy(old->>'fingerprint',(old->>'revision')::bigint,policy,actor,approval);
END;$fn$;
CREATE FUNCTION pg_temp.operator_policy(p text, ids jsonb DEFAULT '[]', mode text DEFAULT 'allowlist')
RETURNS jsonb LANGUAGE sql AS $fn$
 SELECT CASE WHEN p='instagram' THEN jsonb_build_object('version',1,'owners',jsonb_build_object('mode',mode,'account_ids',ids),
 'competitors',jsonb_build_object('mode','off','targets','[]'::jsonb)) ELSE jsonb_build_object('account_ids',ids) END;
$fn$;

DO $cases$
DECLARE p text; k text; a jsonb; b jsonb; c jsonb; result jsonb; policy jsonb; invalid jsonb; id1 text:=gen_random_uuid()::text;id2 text:=gen_random_uuid()::text; audit jsonb; cap integer;
BEGIN
 BEGIN TRUNCATE public.app_settings; RAISE EXCEPTION 'owner truncate bypassed revision/audit'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 FOREACH p IN ARRAY ARRAY['instagram','facebook'] LOOP
  k:=CASE p WHEN 'instagram' THEN 'collection_instagram_rollout_policy' ELSE 'collection_facebook_analytics_policy' END;
  a:=pg_temp.operator_get(p);
  ASSERT a->>'state'='valid','baseline policy is valid';
  ASSERT NOT has_table_privilege('anon','public.analytics_collection_policy_revisions','SELECT,INSERT,UPDATE,DELETE');
  ASSERT NOT has_table_privilege('authenticated','public.analytics_collection_policy_revisions','SELECT,INSERT,UPDATE,DELETE');
  ASSERT NOT has_table_privilege('service_role','public.analytics_collection_policy_revisions','SELECT,INSERT,UPDATE,DELETE');
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.analytics_collection_policy_revisions'::regclass);
  -- Canonical ID spelling/order does not change semantic identity.
  policy:=pg_temp.operator_policy(p,jsonb_build_array(id2,upper(id1)));
  result:=pg_temp.operator_set(p,a,policy);
  ASSERT (result->>'ok')::boolean;
  b:=pg_temp.operator_get(p);
  ASSERT (b->>'revision')::bigint=(a->>'revision')::bigint+1;
  result:=pg_temp.operator_set(p,b,pg_temp.operator_policy(p,jsonb_build_array(id1,id2)));
  c:=pg_temp.operator_get(p);
  ASSERT (result->>'ok')::boolean AND c->>'fingerprint'=b->>'fingerprint';
  ASSERT (c->>'revision')::bigint=(b->>'revision')::bigint+1,'same content is still a new write';
  -- A -> B -> A must never resurrect A's original edit token.
  a:=c;
  result:=pg_temp.operator_set(p,a,pg_temp.operator_policy(p));
  b:=pg_temp.operator_get(p);
  result:=pg_temp.operator_set(p,b,a->'policy');
  c:=pg_temp.operator_get(p);
  ASSERT c->>'fingerprint'=a->>'fingerprint';
  ASSERT (c->>'revision')::bigint=(a->>'revision')::bigint+2;
  result:=pg_temp.operator_set(p,a,pg_temp.operator_policy(p));
  ASSERT result->>'reason_code'='policy_conflict','original fingerprint AND revision must be stale after rollback';
  ASSERT pg_temp.operator_get(p)=c,'stale edit changes nothing';
  result:=pg_temp.operator_set(p,c||jsonb_build_object('fingerprint',repeat('0',64)),pg_temp.operator_policy(p));
  ASSERT result->>'reason_code'='policy_conflict','fingerprint is independently required';
  cap:=CASE WHEN p='instagram' THEN 500 ELSE 100 END;
  result:=pg_temp.operator_set(p,c,pg_temp.operator_policy(p,(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,cap))));
  ASSERT (result->>'ok')::boolean,'exact list ceiling accepted';
  b:=pg_temp.operator_get(p);
  result:=pg_temp.operator_set(p,b,pg_temp.operator_policy(p,(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,cap+1))));
  ASSERT result->>'reason_code'='policy_invalid','one over list ceiling refused';
  ASSERT pg_temp.operator_get(p)=b;
  result:=pg_temp.operator_set(p,b,c->'policy');
  ASSERT (result->>'ok')::boolean;
  c:=pg_temp.operator_get(p);

  FOREACH invalid IN ARRAY ARRAY[
   'null'::jsonb,'{}'::jsonb,'[]'::jsonb,
   pg_temp.operator_policy(p,jsonb_build_array(id1,id1)),
   pg_temp.operator_policy(p,jsonb_build_array(id1,upper(id1))),
   pg_temp.operator_policy(p,'[123]'),pg_temp.operator_policy(p,'["bad-id"]'),
   pg_temp.operator_policy(p)||'{"unexpected":true}',
   pg_temp.operator_policy(p,(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,501)))
  ] LOOP
   result:=pg_temp.operator_set(p,c,invalid);
   ASSERT result->>'reason_code'='policy_invalid','invalid policy refused';
   ASSERT pg_temp.operator_get(p)=c;
  END LOOP;
  FOREACH invalid IN ARRAY ARRAY[to_jsonb(''::text),to_jsonb(E' \t\n'::text),to_jsonb(repeat('x',201))] LOOP
   result:=pg_temp.operator_set(p,c,c->'policy',invalid#>>'{}');
   ASSERT result->>'reason_code'='operator_context_invalid';
   result:=pg_temp.operator_set(p,c,c->'policy','operator',invalid#>>'{}');
   ASSERT result->>'reason_code'='operator_context_invalid';
  END LOOP;
  result:=pg_temp.operator_set(p,c,c->'policy',NULL);
  ASSERT result->>'reason_code'='operator_context_invalid';
  result:=pg_temp.operator_set(p,c,c->'policy','operator',NULL);
  ASSERT result->>'reason_code'='operator_context_invalid';
  ASSERT pg_temp.operator_get(p)=c;

  -- Owner maintenance remains possible, and cannot reset the revision on DELETE.
  EXECUTE 'DELETE FROM public.app_settings WHERE key=$1' USING k;
  a:=pg_temp.operator_get(p);
  ASSERT a->>'state'='missing' AND a->'policy'='null'::jsonb;
  ASSERT (a->>'revision')::bigint>(c->>'revision')::bigint;
  result:=pg_temp.operator_set(p,c,pg_temp.operator_policy(p));
  ASSERT result->>'reason_code'='policy_conflict';
  result:=pg_temp.operator_set(p,a,pg_temp.operator_policy(p,jsonb_build_array(id1)));
  ASSERT result->>'reason_code'='recovery_requires_closed_policy';
  result:=pg_temp.operator_set(p,a,pg_temp.operator_policy(p));
  ASSERT (result->>'ok')::boolean,'missing row recovers only to a closed policy';
  EXECUTE 'UPDATE public.app_settings SET value=$1 WHERE key=$2' USING '{"broken":true}'::jsonb,k;
  a:=pg_temp.operator_get(p);
  ASSERT a->>'state'='malformed' AND a->'policy'='null'::jsonb;
  ASSERT a->>'fingerprint'=a->>'raw_fingerprint','malformed recovery uses exact raw identity';
  result:=pg_temp.operator_set(p,a,pg_temp.operator_policy(p,jsonb_build_array(id1)));
  ASSERT result->>'reason_code'='recovery_requires_closed_policy';
  result:=pg_temp.operator_set(p,a,pg_temp.operator_policy(p));
  ASSERT (result->>'ok')::boolean;
  b:=pg_temp.operator_get(p);
  ASSERT b->>'state'='valid';
  SELECT metadata INTO audit FROM public.system_logs WHERE source=p||'-collection-rollout' AND metadata->>'event'='rollout_policy_changed'
   AND metadata->>'new_revision'=b->>'revision' ORDER BY created_at DESC LIMIT 1;
  ASSERT audit->>'old_fingerprint'=a->>'fingerprint' AND audit->>'new_fingerprint'=b->>'fingerprint';
  ASSERT audit->>'old_revision'=a->>'revision' AND audit->>'actor'='RC-17 operator' AND audit->>'approval_ref'='RC-17 authorization';
  ASSERT NOT audit ?| ARRAY['policy','account_ids','raw_policy'],'audit contains no policy list';
 END LOOP;

 a:=pg_temp.operator_get('instagram');
 result:=pg_temp.operator_set('instagram',a,pg_temp.operator_policy('instagram','[]','all'));
 ASSERT (result->>'ok')::boolean,'Instagram all with empty IDs is valid';
 a:=pg_temp.operator_get('instagram');
 result:=pg_temp.operator_set('instagram',a,pg_temp.operator_policy('instagram',jsonb_build_array(id1),'all'));
 ASSERT result->>'reason_code'='policy_invalid';
 result:=pg_temp.operator_set('instagram',a,jsonb_set(a->'policy','{competitors}',jsonb_build_object('mode','all','targets',jsonb_build_array(jsonb_build_object('watchlist_id',id1,'viewer_social_account_id',id2)))));
 ASSERT result->>'reason_code'='policy_invalid';
 result:=pg_temp.operator_set('instagram',a,jsonb_set(a->'policy','{competitors}',jsonb_build_object('mode','allowlist','targets',jsonb_build_array(
 jsonb_build_object('watchlist_id',id1,'viewer_social_account_id',id2),jsonb_build_object('watchlist_id',id1,'viewer_social_account_id',id2)))));
 ASSERT result->>'reason_code'='policy_invalid';
 -- Competitor pins are canonicalized too, without changing their meaning.
 policy:=jsonb_set(a->'policy','{competitors}',jsonb_build_object('mode','allowlist','targets',jsonb_build_array(
  jsonb_build_object('watchlist_id',id2,'viewer_social_account_id',upper(id1)),jsonb_build_object('watchlist_id',id1,'viewer_social_account_id',id2))));
 result:=pg_temp.operator_set('instagram',a,policy);
 ASSERT (result->>'ok')::boolean;
 b:=pg_temp.operator_get('instagram');
 policy:=jsonb_set(policy,'{competitors,targets}',jsonb_build_array(
  jsonb_build_object('watchlist_id',id1,'viewer_social_account_id',id2),jsonb_build_object('watchlist_id',id2,'viewer_social_account_id',id1)));
 result:=pg_temp.operator_set('instagram',b,policy);
 ASSERT result->>'fingerprint'=b->>'fingerprint';
 ASSERT public.ig_collection_rollout_policy_fingerprint(policy)=b->>'fingerprint','live permit fingerprint agrees with operator canonicalization';

 a:=pg_temp.operator_get('facebook');
 FOREACH policy IN ARRAY ARRAY[
  '{"version":2,"mode":"off","account_ids":[]}'::jsonb,
  '{"version":2,"mode":"allowlist","account_ids":[]}'::jsonb,
  '{"version":2,"mode":"all","account_ids":[]}'::jsonb
 ] LOOP
  result:=pg_temp.operator_set('facebook',a,policy);
  ASSERT result->>'reason_code'='facebook_v2_evaluator_not_installed';
  ASSERT pg_temp.operator_get('facebook')=a,'no v2 stored before Phase 6';
 END LOOP;
 FOREACH policy IN ARRAY ARRAY[
  '{"version":2,"mode":"all","account_ids":["00000000-0000-4000-8000-000000000001"]}'::jsonb,
  '{"version":2,"mode":"bogus","account_ids":[]}'::jsonb,
  '{"version":3,"mode":"off","account_ids":[]}'::jsonb,
  '{"version":2,"mode":"off","account_ids":[],"extra":1}'::jsonb
 ] LOOP
  result:=pg_temp.operator_set('facebook',a,policy);
  ASSERT result->>'reason_code'='policy_invalid';
 END LOOP;
 BEGIN
  PERFORM public.meta_analytics_policy_ids('{"version":2,"mode":"all","account_ids":[]}');
  RAISE EXCEPTION 'shared Threads/retention parser must remain strict';
 EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
END;$cases$;

-- Real role switches, including attempts to forge the setter's local context.
CREATE TEMP TABLE operator_acl_before AS SELECT key,value FROM public.app_settings WHERE key IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy');
SET LOCAL ROLE service_role;
SELECT set_config('postora.policy_actor','forged',true),set_config('postora.policy_approval_ref','forged',true);
DO $service$
DECLARE k text; result jsonb; old jsonb;
BEGIN
 old:=public.get_instagram_collection_rollout_policy();
 result:=public.set_instagram_collection_rollout_policy(old->>'fingerprint',(old->>'revision')::bigint,old->'policy','service operator','RC-17 service');
 ASSERT (result->>'ok')::boolean;
 old:=public.get_facebook_analytics_collection_policy();
 result:=public.set_facebook_analytics_collection_policy(old->>'fingerprint',(old->>'revision')::bigint,old->'policy','service operator','RC-17 service');
 ASSERT (result->>'ok')::boolean;
 FOREACH k IN ARRAY ARRAY['collection_instagram_rollout_policy','collection_facebook_analytics_policy'] LOOP
  BEGIN UPDATE public.app_settings SET value=value WHERE key=k; RAISE EXCEPTION 'service direct update accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.app_settings WHERE key=k; RAISE EXCEPTION 'service delete accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.app_settings SET key=k||'_renamed' WHERE key=k; RAISE EXCEPTION 'service rename accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.app_settings(key,value) VALUES(k,'{}') ON CONFLICT(key) DO UPDATE SET value=excluded.value; RAISE EXCEPTION 'service upsert accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 BEGIN UPDATE public.analytics_collection_policy_revisions SET revision=0; RAISE EXCEPTION 'revision reset accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN TRUNCATE public.app_settings; RAISE EXCEPTION 'service truncate accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$service$;
RESET ROLE;

INSERT INTO auth.users(id,email) VALUES ('02170000-0000-4000-8000-000000000099','policy-admin@example.invalid');
INSERT INTO public.user_roles(user_id,role) VALUES ('02170000-0000-4000-8000-000000000099','admin');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='02170000-0000-4000-8000-000000000099';
DO $admin$
DECLARE k text;
BEGIN
 BEGIN PERFORM public.get_instagram_collection_rollout_policy(); RAISE EXCEPTION 'admin getter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.get_facebook_analytics_collection_policy(); RAISE EXCEPTION 'admin FB getter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 FOREACH k IN ARRAY ARRAY['collection_instagram_rollout_policy','collection_facebook_analytics_policy'] LOOP
  UPDATE public.app_settings SET value=value WHERE key=k;
  ASSERT FOUND,'trusted admin update remains executable';
  BEGIN DELETE FROM public.app_settings WHERE key=k; RAISE EXCEPTION 'admin delete accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.app_settings SET key=k||'_renamed' WHERE key=k; RAISE EXCEPTION 'admin rename accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 BEGIN UPDATE public.app_settings SET value='{}' WHERE key='collection_instagram_rollout_policy'; RAISE EXCEPTION 'malformed admin write accepted';
 EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM LIKE 'IG_ROLLOUT_POLICY_INVALID:%'; END;
 BEGIN UPDATE public.app_settings SET value='{"version":2,"mode":"all","account_ids":[]}' WHERE key='collection_facebook_analytics_policy'; RAISE EXCEPTION 'admin v2 write accepted';
 EXCEPTION WHEN feature_not_supported THEN ASSERT SQLERRM='facebook_v2_evaluator_not_installed'; END;
END;$admin$;
RESET ROLE;
SET LOCAL request.jwt.claim.sub='';
DO $admin_audit$
DECLARE source_name text; audit jsonb;
BEGIN
 FOREACH source_name IN ARRAY ARRAY['instagram-collection-rollout','facebook-collection-rollout'] LOOP
  SELECT metadata INTO audit FROM public.system_logs s WHERE s.source=source_name AND metadata->>'path'='trusted_admin_settings' ORDER BY created_at DESC LIMIT 1;
  ASSERT audit->>'actor'='02170000-0000-4000-8000-000000000099';
  ASSERT audit->>'approval_ref'='trusted_admin_settings','forged custom context cannot masquerade as CAS authorization';
 END LOOP;
 ASSERT NOT EXISTS(SELECT 1 FROM public.analytics_collection_policy_revisions WHERE pending_actor IS NOT NULL OR pending_approval_ref IS NOT NULL);
 ASSERT NOT has_function_privilege('authenticated','public.analytics_collection_canonical_policy(text,jsonb)','EXECUTE');
 ASSERT NOT has_function_privilege('service_role','public.analytics_collection_set_policy(text,text,bigint,jsonb,text,text)','EXECUTE');
END;$admin_audit$;
SET LOCAL ROLE anon;
DO $anon$ BEGIN
 ASSERT NOT EXISTS(SELECT 1 FROM public.app_settings WHERE key IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy'));
 BEGIN PERFORM public.get_instagram_collection_rollout_policy(); RAISE EXCEPTION 'anon getter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.set_instagram_collection_rollout_policy('x',0,'{}','x','x'); RAISE EXCEPTION 'anon setter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.get_facebook_analytics_collection_policy(); RAISE EXCEPTION 'anon FB getter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.set_facebook_analytics_collection_policy('x',0,'{}','x','x'); RAISE EXCEPTION 'anon FB setter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$anon$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $authenticated$ BEGIN
 ASSERT NOT EXISTS(SELECT 1 FROM public.app_settings WHERE key IN ('collection_instagram_rollout_policy','collection_facebook_analytics_policy'));
 BEGIN PERFORM public.get_instagram_collection_rollout_policy(); RAISE EXCEPTION 'user getter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.set_instagram_collection_rollout_policy('x',0,'{}','x','x'); RAISE EXCEPTION 'user setter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.get_facebook_analytics_collection_policy(); RAISE EXCEPTION 'user FB getter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.set_facebook_analytics_collection_policy('x',0,'{}','x','x'); RAISE EXCEPTION 'user FB setter accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$authenticated$;
RESET ROLE;

-- Any failure to audit must abort BOTH content and revision, including refusal audits.
CREATE FUNCTION pg_temp.operator_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN IF NEW.source IN ('instagram-collection-rollout','facebook-collection-rollout') THEN RAISE EXCEPTION 'RC17_AUDIT_UNAVAILABLE'; END IF; RETURN NEW; END;$fn$;
CREATE TRIGGER operator_test_audit_failure BEFORE INSERT ON public.system_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.operator_fail_audit();
DO $atomicity$
DECLARE p text; old jsonb; failed boolean;
BEGIN
 FOREACH p IN ARRAY ARRAY['instagram','facebook'] LOOP
  old:=pg_temp.operator_get(p);failed:=false;
  BEGIN PERFORM pg_temp.operator_set(p,old,pg_temp.operator_policy(p));
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='RC17_AUDIT_UNAVAILABLE';failed:=true; END;
  ASSERT failed AND pg_temp.operator_get(p)=old,'audit failure rolls back policy AND revision';
  failed:=false;
  BEGIN PERFORM pg_temp.operator_set(p,old||'{"revision":-1}',pg_temp.operator_policy(p));
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='RC17_AUDIT_UNAVAILABLE';failed:=true; END;
  ASSERT failed AND pg_temp.operator_get(p)=old,'failed refusal audit never reports committed refusal';
 END LOOP;
END;$atomicity$;
ROLLBACK;
\echo === analytics_policy_operator_controls: ALL CHECKS PASSED ===
