-- Phase 6: real policy/operator/dispatch storage and ownership boundaries.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);

DO $parser$
DECLARE bad jsonb; normalized jsonb;
BEGIN
 normalized:=public.fb_analytics_normalize_policy('{"account_ids":[]}');
 ASSERT normalized='{"version":2,"mode":"allowlist","account_ids":[]}'::jsonb;
 FOREACH bad IN ARRAY ARRAY['null'::jsonb,'{}','[]','{"account_ids":[],"extra":true}',
  '{"version":1,"mode":"all","account_ids":[]}', '{"version":2,"mode":"all"}',
  '{"version":2,"mode":"unknown","account_ids":[]}',
  '{"version":2,"mode":"all","account_ids":["e6000000-0000-4000-8000-000000000001"]}',
  '{"account_ids":["e6000000-0000-4000-8000-000000000001","E6000000-0000-4000-8000-000000000001"]}',
  jsonb_build_object('account_ids',(SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1,101)))
 ] LOOP
  BEGIN
   PERFORM public.fb_analytics_normalize_policy(bad);
   RAISE EXCEPTION 'malformed Facebook policy accepted: %',bad;
  EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'MAH05' THEN NULL; END;
 END LOOP;
 -- The shared parser remains closed to all, even for an empty array.
 BEGIN PERFORM public.meta_analytics_policy_ids('{"version":2,"mode":"all","account_ids":[]}');
  RAISE EXCEPTION 'shared Threads/retention parser widened';
 EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
 ASSERT public.meta_analytics_policy_ids('{"account_ids":[]}')='[]'::jsonb;
END;$parser$;

INSERT INTO auth.users(id,email) VALUES
 ('e6100000-0000-4000-8000-000000000001','phase6-one@example.invalid'),
 ('e6100000-0000-4000-8000-000000000002','phase6-two@example.invalid'),
 ('e6100000-0000-4000-8000-000000000003','phase6-three@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
SELECT ('e6200000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 ('e6100000-0000-4000-8000-'||lpad((i%3+1)::text,12,'0'))::uuid,
 'facebook',(860000+i)::text,'phase6-page-'||i,true,false FROM generate_series(1,1205) i;
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
 ('e6190000-0000-4000-8000-000000000001','e6100000-0000-4000-8000-000000000001','facebook','859001',gen_random_uuid()::text,false,false),
 ('e6190000-0000-4000-8000-000000000002','e6100000-0000-4000-8000-000000000001','threads','859002',gen_random_uuid()::text,true,false);
UPDATE public.app_settings SET value='true'::jsonb WHERE key='collection_facebook_analytics_enabled';

SET LOCAL ROLE service_role;
DO $cas$
DECLARE a jsonb; b jsonb; r jsonb;
BEGIN
 a:=public.get_facebook_analytics_collection_policy();
 r:=public.set_facebook_analytics_collection_policy(a->>'fingerprint',(a->>'revision')::bigint,
  '{"version":2,"mode":"allowlist","account_ids":[]}','phase6 test','phase6 local only');
 ASSERT r->>'ok'='true','v2 allowlist conversion must be accepted';
 a:=public.get_facebook_analytics_collection_policy();
 r:=public.set_facebook_analytics_collection_policy(a->>'fingerprint',(a->>'revision')::bigint,
  '{"version":2,"mode":"all","account_ids":[]}','phase6 test','phase6 local only');
 ASSERT r->>'ok'='true','all requires the installed evaluator';
 b:=public.get_facebook_analytics_collection_policy();
 r:=public.set_facebook_analytics_collection_policy(b->>'fingerprint',(b->>'revision')::bigint,a->'policy','phase6 test','phase6 rollback');
 ASSERT r->>'fingerprint'=a->>'fingerprint' AND (r->>'revision')::bigint>(a->>'revision')::bigint;
 r:=public.set_facebook_analytics_collection_policy(a->>'fingerprint',(a->>'revision')::bigint,b->'policy','phase6 test','phase6 stale');
 ASSERT r->>'reason_code'='policy_conflict','original A token must remain stale after A/B/A';
 a:=public.get_facebook_analytics_collection_policy();
 r:=public.set_facebook_analytics_collection_policy(a->>'fingerprint',(a->>'revision')::bigint,b->'policy','phase6 test','phase6 all');
 ASSERT r->>'ok'='true';
 BEGIN UPDATE public.app_settings SET value='{"account_ids":[]}' WHERE key='collection_facebook_analytics_policy';
  RAISE EXCEPTION 'service bypassed CAS'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM public.fb_analytics_sweep_outcomes;
  RAISE EXCEPTION 'service read private population'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$cas$;
RESET ROLE;

DO $population$
DECLARE t jsonb; first_ticket jsonb; r jsonb; n integer:=0; sweep public.meta_analytics_enqueue_sweeps; old_digest text;
BEGIN
 ASSERT public.meta_analytics_collection_allowed('facebook','e6200000-0000-4000-8000-000000000001');
 ASSERT NOT public.meta_analytics_collection_allowed('facebook',gen_random_uuid()),'all is not permission for an absent row';
 first_ticket:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 ASSERT first_ticket->>'owner_id'='e6100000-0000-4000-8000-000000000002','owner derives from selected Page';
 old_digest:=first_ticket->>'policy_digest';
 LOOP
  t:=public.next_meta_analytics_dispatch_target('facebook',false)->'ticket';
  EXIT WHEN t IS NULL;
  r:=public.commit_meta_analytics_dispatch_target(t,'refused','admission_refused');
  ASSERT r->>'state'='advanced'; n:=n+1;
  IF n=50 THEN
   ASSERT public.next_meta_analytics_dispatch_target('facebook',false)#>>'{ticket,account_id}'='e6200000-0000-4000-8000-000000000051','bounded visit resumes after 50';
  END IF;
  ASSERT n<=1205,'keyset must terminate';
 END LOOP;
 ASSERT n=1205,'every active Page visited across tenants';
 SELECT * INTO STRICT sweep FROM public.meta_analytics_enqueue_sweeps WHERE platform='facebook' AND policy_digest=old_digest;
 ASSERT sweep.complete AND sweep.outcomes='{}' AND sweep.refused_count=1205 AND sweep.visited_count=1205;
 ASSERT (SELECT count(*)=1205 FROM public.fb_analytics_sweep_outcomes WHERE platform='facebook' AND policy_digest=old_digest AND dispatch_round=sweep.dispatch_round);
 ASSERT (SELECT pg_column_size(jsonb_object_agg(social_account_id,jsonb_build_object('outcome',outcome,'reason',reason)))>65536
  FROM public.fb_analytics_sweep_outcomes WHERE policy_digest=old_digest),'test exceeds the old JSON byte ceiling';
 BEGIN PERFORM public.commit_meta_analytics_dispatch_target(first_ticket,'refused','admission_refused');
  RAISE EXCEPTION 'consumed ticket replayed'; EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
 ASSERT public.next_meta_analytics_dispatch_target('facebook',false)->>'state'='complete','drain cannot reopen completion';
 -- A future connection behind the completed cursor joins the next explicit round.
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
  ('e6200000-0000-4000-8000-000000000000','e6100000-0000-4000-8000-000000000001','facebook','869999','phase6-new-page',true,false);
 ASSERT public.next_meta_analytics_dispatch_target('facebook',false)->>'state'='complete';
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 ASSERT t->>'account_id'='e6200000-0000-4000-8000-000000000000' AND t->>'round'='2';
 ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_sweep_outcomes WHERE policy_digest=old_digest),'reopen atomically prunes previous round';
 -- Reownership between ticket and admission must not read the new owner's credential.
 UPDATE public.social_accounts SET user_id='e6100000-0000-4000-8000-000000000002' WHERE id=(t->>'account_id')::uuid;
 BEGIN PERFORM public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL);
  RAISE EXCEPTION 'reowned Page accepted old ticket'; EXCEPTION WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH04' THEN NULL; END;
 BEGIN PERFORM public.read_fb_analytics_admission_credential((t->>'account_id')::uuid,NULL,(t->>'owner_id')::uuid);
  RAISE EXCEPTION 'reowned Page exposed new owner credential'; EXCEPTION WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH04' THEN NULL; END;
 t:=public.next_meta_analytics_dispatch_target('facebook',false)->'ticket';
 r:=public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL);
 ASSERT r->>'outcome'='refused','invalid early Page cannot starve later Pages';
 ASSERT public.next_meta_analytics_dispatch_target('facebook',false)#>>'{ticket,account_id}'='e6200000-0000-4000-8000-000000000001';
 -- Deleting the composite parent must remove its normalized child outcomes.
 DELETE FROM public.meta_analytics_enqueue_sweeps WHERE platform='facebook' AND policy_digest=old_digest;
 ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_sweep_outcomes WHERE policy_digest=old_digest);
END;$population$;

CREATE FUNCTION pg_temp.fb6_set(policy jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE old jsonb; receipt jsonb;
BEGIN
 old:=public.get_facebook_analytics_collection_policy();
 receipt:=public.set_facebook_analytics_collection_policy(old->>'fingerprint',(old->>'revision')::bigint,policy,'phase6 test','phase6 local only');
 ASSERT receipt->>'ok'='true'; RETURN receipt;
END;$fn$;

DO $closed_modes_and_recovery$
DECLARE r jsonb;t jsonb;
BEGIN
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"off","account_ids":[]}');
 ASSERT public.next_meta_analytics_dispatch_target('facebook',true)->>'state'='disabled';
 ASSERT NOT public.meta_analytics_collection_allowed('facebook','e6200000-0000-4000-8000-000000000001');
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"allowlist","account_ids":[]}');
 ASSERT public.next_meta_analytics_dispatch_target('facebook',true)->>'state'='complete';
 -- A duplicate stored by trusted maintenance is unavailable, never deduplicated admission.
 UPDATE public.app_settings SET value='{"account_ids":["e6200000-0000-4000-8000-000000000001","e6200000-0000-4000-8000-000000000001"]}' WHERE key='collection_facebook_analytics_policy';
 BEGIN PERFORM public.next_meta_analytics_dispatch_target('facebook',true); RAISE EXCEPTION 'malformed configuration opened a sweep';
 EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
 ASSERT NOT public.meta_analytics_collection_allowed('facebook','e6200000-0000-4000-8000-000000000001');
 t:=public.get_facebook_analytics_collection_policy();
 r:=public.set_facebook_analytics_collection_policy(t->>'fingerprint',(t->>'revision')::bigint,'{"version":2,"mode":"all","account_ids":[]}','phase6 test','unsafe recovery');
 ASSERT r->>'reason_code'='recovery_requires_closed_policy','empty all is open, not a closed recovery';
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"off","account_ids":[]}');
 DELETE FROM public.app_settings WHERE key='collection_facebook_analytics_policy';
 BEGIN PERFORM public.next_meta_analytics_dispatch_target('facebook',true); RAISE EXCEPTION 'missing configuration opened a sweep';
 EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
 PERFORM pg_temp.fb6_set('{"account_ids":[]}');
 -- Legacy allowlist, v2 staging and rollback all retain the same diagnostics.
 PERFORM pg_temp.fb6_set('{"account_ids":["e6200000-0000-4000-8000-000000000001"]}');
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 PERFORM public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL);
 ASSERT EXISTS(SELECT 1 FROM public.fb_analytics_sweep_outcomes WHERE policy_digest=t->>'policy_digest' AND dispatch_round=(t->>'round')::bigint AND outcome='refused');
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"allowlist","account_ids":["e6200000-0000-4000-8000-000000000001"]}');
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 PERFORM public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL);
 ASSERT EXISTS(SELECT 1 FROM public.fb_analytics_sweep_outcomes WHERE policy_digest=t->>'policy_digest' AND dispatch_round=(t->>'round')::bigint AND outcome='refused');
 ASSERT NOT EXISTS(SELECT 1 FROM public.meta_analytics_enqueue_sweeps WHERE platform='facebook' AND outcomes<>'{}');
 PERFORM pg_temp.fb6_set('{"account_ids":[]}');
END;$closed_modes_and_recovery$;

DO $excluded_bootstrap_then_all$
DECLARE target uuid:='e6000000-0000-4000-8000-000000000001'; owner_id uuid:='e6100000-0000-4000-8000-000000000001';
 capture jsonb;installed jsonb;r jsonb;t jsonb;proof jsonb;claim jsonb;old_ticket jsonb;first_policy jsonb;
 run_id uuid:=gen_random_uuid();credential uuid;current_authority jsonb;attempt uuid:=gen_random_uuid();due date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,account_metadata,is_active,needs_reauth)
  VALUES(target,owner_id,'facebook','869998',gen_random_uuid()::text,jsonb_build_object('user_token',gen_random_uuid()::text),true,false);
 UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
 UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',jsonb_build_array(target),'max_accounts_per_run',5,'max_attempts_per_account_per_day',3)
  WHERE key='analytics_legacy_bootstrap_policy';
 PERFORM public.dispatch_analytics_legacy_bootstrap(run_id);
 capture:=public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run_id);
 ASSERT capture->>'state'='verifying';
 ASSERT public.permit_analytics_legacy_bootstrap(run_id,(capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'860001');
 installed:=public.commit_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,
  jsonb_build_object('app_id','860001','provider_user_id','868001','page_id','869998','instagram_user_id',NULL,
   'token_type','USER','verified_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
 ASSERT installed->>'state'='permission_pending';
 ASSERT NOT public.meta_analytics_collection_allowed('facebook',target);
 BEGIN
  UPDATE public.analytics_legacy_bootstrap_jobs SET installed_at=clock_timestamp()-interval '2 days' WHERE id=(capture->>'job_id')::uuid;
  BEGIN
   PERFORM public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(installed->>'revision')::bigint,
    jsonb_build_object('state','ok','scopes',jsonb_build_array('read_insights','pages_read_engagement'),'observed_at',clock_timestamp()-interval '1 day'));
   RAISE EXCEPTION 'previous-day bootstrap proof accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'BOOTSTRAP_PERMISSION_STALE' THEN RAISE; END IF; END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_permission_observations WHERE social_account_id=target);
  RAISE EXCEPTION 'restore synthetic midnight crossing' USING ERRCODE='TST01';
 EXCEPTION WHEN SQLSTATE 'TST01' THEN NULL; END;
 r:=public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(installed->>'revision')::bigint,
  jsonb_build_object('state','ok','scopes',jsonb_build_array('read_insights','pages_read_engagement'),'observed_at',clock_timestamp()));
 ASSERT r->>'state'='ready';
 ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_report_state WHERE social_account_id=target),'bootstrap must not prepare or enqueue collection';
 ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_jobs WHERE social_account_id=target);
 proof:=public.owner_analytics_readiness_snapshot('facebook',owner_id,target,clock_timestamp(),NULL);
 ASSERT proof#>>'{collection,reason_code}'='collection_not_eligible';
 ASSERT proof#>>'{connection,state}'='verified' AND proof#>>'{permission,state}'='verified','bootstrap proof projects independently of policy';
 first_policy:=pg_temp.fb6_set('{"version":2,"mode":"all","account_ids":[]}');
 proof:=public.owner_analytics_readiness_snapshot('facebook',owner_id,target,clock_timestamp(),NULL);
 ASSERT proof#>>'{collection,reason_code}'='awaiting_first_capture','v2 all readiness uses the same Facebook decoder';
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 ASSERT t->>'account_id'=target::text;
 old_ticket:=t;
 -- Content identity repeats after rollback, but ticket identity must not.
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"off","account_ids":[]}');
 r:=pg_temp.fb6_set('{"version":2,"mode":"all","account_ids":[]}');
 ASSERT r->>'fingerprint'=first_policy->>'fingerprint';
 BEGIN PERFORM public.commit_meta_analytics_dispatch_target(old_ticket,'enqueue',NULL); RAISE EXCEPTION 'ABA revived stale ticket';
 EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 ASSERT t->>'policy_digest'<>old_ticket->>'policy_digest';
 BEGIN PERFORM public.commit_meta_analytics_dispatch_target(jsonb_set(t,'{due_on}',to_jsonb((due-1)::text)),'enqueue',NULL);
  RAISE EXCEPTION 'previous-day ticket admitted'; EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
 UPDATE public.fb_analytics_permission_observations SET state='unavailable' WHERE social_account_id=target;
 r:=public.record_meta_analytics_admission_failure(t,'provider_unavailable',attempt);
 ASSERT r='{"state":"pending","attempts":1}'::jsonb;
 ASSERT public.next_meta_analytics_dispatch_target('facebook',false)->'ticket'=t;
 r:=public.record_meta_analytics_admission_failure(t,'provider_unavailable',attempt);
 ASSERT r->>'attempts'='1','lost counter reply replay cannot increment attempts';
 r:=public.record_meta_analytics_admission_failure(t,'invalid_contract',gen_random_uuid());
 ASSERT r->>'attempts'='2';
 r:=public.record_meta_analytics_admission_failure(t,'provider_unavailable',gen_random_uuid());
 ASSERT r->>'state'='advanced' AND r->>'outcome'='refused';
 ASSERT EXISTS(SELECT 1 FROM public.fb_analytics_sweep_outcomes WHERE social_account_id=target AND policy_digest=t->>'policy_digest'
  AND dispatch_round=(t->>'round')::bigint AND outcome='refused' AND reason='provider_error' AND cardinality(attempt_ids)=3);
 ASSERT public.next_meta_analytics_dispatch_target('facebook',false)#>>'{ticket,account_id}'<>target::text,'bounded failed admissions release later targets';
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"all","account_ids":[]}');
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 UPDATE public.fb_analytics_permission_observations SET state='verified' WHERE social_account_id=target;
 UPDATE public.fb_analytics_permission_observations SET observed_at=(due-1)::timestamp AT TIME ZONE 'America/Los_Angeles' WHERE social_account_id=target;
 ASSERT public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL)->>'state'='needs_admission','yesterday proof is not current-day admission';
 current_authority:=public.meta_analytics_current_authority('facebook',target,owner_id);
 UPDATE public.fb_analytics_permission_observations SET observed_at=clock_timestamp(),authority=jsonb_set(current_authority,'{credential_revision}','9999') WHERE social_account_id=target;
 ASSERT public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL)->>'state'='needs_admission','today proof must match current authority';
 UPDATE public.fb_analytics_permission_observations SET authority=public.meta_analytics_current_authority('facebook',target,owner_id) WHERE social_account_id=target;
 r:=public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL);
 ASSERT r->>'outcome'='queued';
 -- Lost response resumes the durable next cursor; it cannot enqueue the old target twice.
 ASSERT public.next_meta_analytics_dispatch_target('facebook',false)#>>'{ticket,account_id}'<>target::text;
 ASSERT (SELECT count(*)=1 FROM public.fb_analytics_collection_jobs WHERE social_account_id=target);
 INSERT INTO public.fb_analytics_collection_jobs(user_id,social_account_id,due_on,due_at,next_due_at)
  SELECT user_id,id,due-1,(due-1)::timestamp AT TIME ZONE 'America/Los_Angeles',due::timestamp AT TIME ZONE 'America/Los_Angeles'
  FROM public.social_accounts WHERE platform='facebook' AND id>'e6200000-0000-4000-8000-000000000000' ORDER BY id LIMIT 60;
 claim:=public.claim_fb_analytics_collection_jobs(1)->0;
 ASSERT claim->>'account_id'=target::text,'invalid early queued jobs cannot starve a later ready Page';
 PERFORM public.read_fb_analytics_collection_credential((claim->>'job_id')::uuid,(claim->>'claim_token')::uuid,(claim->>'job_generation')::bigint);
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"allowlist","account_ids":[]}');
 BEGIN PERFORM public.read_fb_analytics_collection_credential((claim->>'job_id')::uuid,(claim->>'claim_token')::uuid,(claim->>'job_generation')::bigint);
  RAISE EXCEPTION 'revoked next provider permit accepted'; EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
 BEGIN PERFORM public.reserve_fb_analytics_capture((claim->>'job_id')::uuid,(claim->>'claim_token')::uuid,(claim->>'job_generation')::bigint,'account_day:'||(due-1),
  jsonb_build_object('kind','account_day','subject_id','869998','metric_date',due-1,'metrics',jsonb_build_array('page_post_engagements')));
  RAISE EXCEPTION 'revoked write accepted'; EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
 ASSERT public.claim_fb_analytics_collection_jobs(1)='[]'::jsonb,'revoked targets cannot be claimed';
 -- Revocation of the grant after proof also prevents admission after policy reopens.
 SELECT credential_id INTO credential FROM public.facebook_user_credential_bindings WHERE social_account_id=target;
 UPDATE public.facebook_user_credentials SET token_expires_at=clock_timestamp()-interval '1 second' WHERE id=credential;
 PERFORM pg_temp.fb6_set('{"version":2,"mode":"all","account_ids":[]}');
 t:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
 ASSERT public.commit_meta_analytics_dispatch_target(t,'enqueue',NULL)->>'outcome'='refused','expired User authority cannot reuse bootstrap proof';
END;$excluded_bootstrap_then_all$;

SET LOCAL ROLE anon;
DO $anon$ BEGIN
 BEGIN PERFORM public.get_facebook_analytics_collection_policy(); RAISE EXCEPTION 'anon policy read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.next_meta_analytics_dispatch_target('facebook',true); RAISE EXCEPTION 'anon dispatch'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM public.fb_analytics_sweep_outcomes; RAISE EXCEPTION 'anon population'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.read_fb_analytics_admission_credential(NULL,NULL,NULL); RAISE EXCEPTION 'anon credential read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$anon$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $auth$ BEGIN
 BEGIN PERFORM public.set_facebook_analytics_collection_policy(NULL,NULL,'{}','x','x'); RAISE EXCEPTION 'browser policy write'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM public.fb_analytics_sweep_outcomes; RAISE EXCEPTION 'browser population'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.read_fb_analytics_admission_credential(NULL,NULL,NULL); RAISE EXCEPTION 'browser credential read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$auth$;
RESET ROLE;
ROLLBACK;
\echo === facebook_analytics_all: ALL CHECKS PASSED ===
