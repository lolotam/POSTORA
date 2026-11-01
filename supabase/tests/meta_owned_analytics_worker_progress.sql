-- Boundaries: off/malformed/empty policy, >50 targets, two owners, same-day
-- reopen, credential rotation, CAS replay/skip, expired day and policy change.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email) VALUES
 ('b1000000-0000-4000-8000-000000000001','meta-dispatch-one@example.invalid'),
 ('b1000000-0000-4000-8000-000000000002','meta-dispatch-two@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
SELECT ('b3000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
  CASE WHEN i%2=0 THEN 'b1000000-0000-4000-8000-000000000002'::uuid ELSE 'b1000000-0000-4000-8000-000000000001'::uuid END,
  'threads',(780000+i)::text,'fixture-threads',true,false FROM generate_series(1,60) i;
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook','784001','fixture-page',true,false);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES
 ('b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','fixture-user','785001','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook','b5000000-0000-4000-8000-000000000001','785001','oauth_exchange');
DO $acl$
DECLARE v_signature text;v_role text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY['public.next_meta_analytics_dispatch_target(text,boolean)',
    'public.commit_meta_analytics_dispatch_target(jsonb,text,text)'] LOOP
    ASSERT has_function_privilege('service_role',v_signature,'EXECUTE'),'service dispatch RPC is granted';
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      ASSERT NOT has_function_privilege(v_role,v_signature,'EXECUTE'),'browser cannot enumerate dispatch';
    END LOOP;
  END LOOP;
  ASSERT NOT has_table_privilege('service_role','public.meta_analytics_enqueue_sweeps','INSERT,UPDATE,DELETE'),'service cannot bypass cursor writers';
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    ASSERT NOT has_table_privilege(v_role,'public.meta_analytics_enqueue_sweeps','SELECT,INSERT,UPDATE,DELETE'),'browser cannot access global enumeration';
  END LOOP;
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.meta_analytics_enqueue_sweeps'::regclass),'enumeration RLS is enabled';
END;
$acl$;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $off$
BEGIN
  ASSERT public.next_meta_analytics_dispatch_target('threads',true)='{"state":"disabled"}'::jsonb,'off state wins before policy';
END;
$off$;
RESET ROLE;
DO $untouched$ BEGIN ASSERT NOT EXISTS(SELECT 1 FROM public.meta_analytics_enqueue_sweeps),'off creates no sweep'; END; $untouched$;
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value=(SELECT jsonb_build_object('account_ids',jsonb_agg(id::text ORDER BY id)) FROM public.social_accounts WHERE platform='threads' AND user_id IN ('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002')) WHERE key='collection_threads_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["b4000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
SET LOCAL ROLE service_role;
DO $dispatch$
DECLARE v_next jsonb;v_ticket jsonb;v_result jsonb;v_authority jsonb;v_account record;v_index integer;v_digest text;
  v_owner uuid:='b1000000-0000-4000-8000-000000000001';
BEGIN
  v_next:=public.next_meta_analytics_dispatch_target('threads',true);v_ticket:=v_next->'ticket';
  ASSERT v_next->>'state'='target','first target is selected';
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'state'='needs_admission','grant evidence is required before cursor advancement';
  ASSERT public.next_meta_analytics_dispatch_target('threads',false)->'ticket'=v_ticket,'unfinished admission resumes the same ticket';
  FOR v_account IN SELECT id,user_id,platform_user_id FROM public.social_accounts WHERE platform='threads' AND user_id IN (v_owner,'b1000000-0000-4000-8000-000000000002'::uuid) LOOP
    v_authority:=public.prepare_threads_analytics_account(v_account.user_id,v_account.id);
    PERFORM public.observe_threads_analytics_permissions(v_account.user_id,v_account.id,v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],v_account.platform_user_id,clock_timestamp(),'verified');
  END LOOP;
  v_result:=public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL);
  ASSERT v_result->>'outcome'='queued','fresh admitted target is queued';
  BEGIN PERFORM public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL);RAISE EXCEPTION 'consumed ticket replay advanced';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  FOR v_index IN 2..50 LOOP
    v_next:=public.next_meta_analytics_dispatch_target('threads',false);
    ASSERT v_next->>'state'='target','first bounded visit still has targets';
    PERFORM public.commit_meta_analytics_dispatch_target(v_next->'ticket','enqueue',NULL);
  END LOOP;
  v_next:=public.next_meta_analytics_dispatch_target('threads',true);
  ASSERT v_next#>>'{ticket,account_id}'='b3000000-0000-4000-8000-000000000051','new invocation resumes behind the first 50';
  FOR v_index IN 51..60 LOOP
    v_next:=public.next_meta_analytics_dispatch_target('threads',false);
    v_result:=public.commit_meta_analytics_dispatch_target(v_next->'ticket','enqueue',NULL);
  END LOOP;
  ASSERT (v_result->>'complete')::boolean,'the bounded continuation reaches the actual end';
  ASSERT public.next_meta_analytics_dispatch_target('threads',false)->>'state'='complete','resume does not reopen a complete round';
  ASSERT (SELECT count(*)=60 AND min(job_generation)=1 AND max(job_generation)=1 FROM public.threads_analytics_collection_jobs WHERE user_id IN (v_owner,'b1000000-0000-4000-8000-000000000002'::uuid)),'all owners queued once without force';
  v_next:=public.next_meta_analytics_dispatch_target('threads',true);v_ticket:=v_next->'ticket';
  ASSERT v_ticket->>'round'='2' AND v_ticket->'after_account_id'='null'::jsonb,'later start reopens exactly one new round';
  v_result:=public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL);
  ASSERT v_result->>'outcome'='queued','existing jobs are idempotent across a new round';
  v_next:=public.next_meta_analytics_dispatch_target('threads',false);v_ticket:=v_next->'ticket';
  UPDATE public.social_accounts SET access_token='fixture-rotated' WHERE id=(v_ticket->>'account_id')::uuid;
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'state'='needs_admission','rotated authority is not hidden by an existing job';
  SELECT id,user_id,platform_user_id INTO v_account FROM public.social_accounts WHERE id=(v_ticket->>'account_id')::uuid;
  v_authority:=public.prepare_threads_analytics_account(v_account.user_id,v_account.id);
  PERFORM public.observe_threads_analytics_permissions(v_account.user_id,v_account.id,v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],v_account.platform_user_id,clock_timestamp(),'verified');
  PERFORM public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL);
  v_next:=public.next_meta_analytics_dispatch_target('threads',false);v_ticket:=v_next->'ticket';
  BEGIN PERFORM public.commit_meta_analytics_dispatch_target(jsonb_set(v_ticket,'{due_on}',to_jsonb(((v_ticket->>'due_on')::date-1)::text)),'enqueue',NULL);RAISE EXCEPTION 'expired due date advanced';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  BEGIN PERFORM public.commit_meta_analytics_dispatch_target(jsonb_set(v_ticket,'{account_id}','"b3000000-0000-4000-8000-000000000004"'),'enqueue',NULL);RAISE EXCEPTION 'skipped target advanced';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  v_digest:=v_ticket->>'policy_digest';
  UPDATE public.app_settings SET value=jsonb_set(value,'{account_ids}',value->'account_ids'||'"b0000000-0000-4000-8000-000000000001"'::jsonb) WHERE key='collection_threads_analytics_policy';
  BEGIN PERFORM public.commit_meta_analytics_dispatch_target(v_ticket,'refused','provider_error');RAISE EXCEPTION 'changed policy accepted stale ticket';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  v_next:=public.next_meta_analytics_dispatch_target('threads',true);
  ASSERT v_next#>>'{ticket,policy_digest}'<>v_digest AND v_next#>>'{ticket,account_id}'='b0000000-0000-4000-8000-000000000001','new policy starts its own ordered sweep';
  v_result:=public.commit_meta_analytics_dispatch_target(v_next->'ticket','enqueue',NULL);
  ASSERT v_result->>'outcome'='refused' AND (v_result->>'refused_count')::integer=1,'missing target is a visible refusal and cannot starve later targets';
  ASSERT public.next_meta_analytics_dispatch_target('threads',false)#>>'{ticket,account_id}'='b3000000-0000-4000-8000-000000000001','refusal advances to the next allowed identity';
  v_next:=public.next_meta_analytics_dispatch_target('facebook',true);v_ticket:=v_next->'ticket';
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'state'='needs_admission','Facebook also requires a current grant';
  v_authority:=public.prepare_fb_analytics_account(v_owner,'b4000000-0000-4000-8000-000000000001');
  PERFORM public.observe_fb_analytics_permissions(v_owner,'b4000000-0000-4000-8000-000000000001',v_authority->'authority',ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'outcome'='queued','Facebook uses its own queue';
  UPDATE public.app_settings SET value='{"bad":[]}'::jsonb WHERE key='collection_threads_analytics_policy';
  BEGIN PERFORM public.next_meta_analytics_dispatch_target('threads',true);RAISE EXCEPTION 'malformed enabled policy looked complete';
  EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL;END;
  UPDATE public.app_settings SET value='false'::jsonb WHERE key='collection_threads_analytics_enabled';
  ASSERT public.next_meta_analytics_dispatch_target('threads',true)->>'state'='disabled','disabled switch is read before malformed policy';
  UPDATE public.app_settings SET value='{"account_ids":[]}'::jsonb WHERE key='collection_threads_analytics_policy';
  UPDATE public.app_settings SET value='true'::jsonb WHERE key='collection_threads_analytics_enabled';
  ASSERT public.next_meta_analytics_dispatch_target('threads',true)->>'state'='complete','a valid empty enabled policy is an empty enumeration';
END;
$dispatch$;
RESET ROLE;
UPDATE public.fb_analytics_permission_observations SET observed_at=((clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles')-interval '1 second'
  WHERE social_account_id='b4000000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
DO $freshness$
DECLARE v_ticket jsonb;v_prepared jsonb;
BEGIN
  v_ticket:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'state'='needs_admission','a matching older-day grant must be renewed';
  v_prepared:=public.prepare_fb_analytics_account('b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001');
  PERFORM public.observe_fb_analytics_permissions('b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',v_prepared->'authority',
    ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'outcome'='queued','renewal permits idempotent enqueue';
  UPDATE public.app_settings SET value='{"account_ids":["B4000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
  v_ticket:=public.next_meta_analytics_dispatch_target('facebook',true)->'ticket';
  ASSERT public.commit_meta_analytics_dispatch_target(v_ticket,'enqueue',NULL)->>'outcome'='queued','valid uppercase UUID policy identifies the same account';
END;
$freshness$;
RESET ROLE;
ROLLBACK;
\echo ALL CHECKS PASSED: owned analytics worker progress
