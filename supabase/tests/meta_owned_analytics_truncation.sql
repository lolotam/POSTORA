-- A terminal bounded inventory keeps measurements and releases later due dates.
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
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["b4000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["b3000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_threads_analytics_policy';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $terminal$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b4000000-0000-4000-8000-000000000001';v_authority jsonb;v_job jsonb;v_next jsonb;v_capture jsonb;v_before jsonb;v_after jsonb;v_completion jsonb;v_request jsonb;v_received timestamptz;
 v_today date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
 v_authority:=public.prepare_fb_analytics_account(v_owner,v_account);
 PERFORM public.observe_fb_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
 PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_today-1,false);
 PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_today,false);
 v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
 ASSERT (v_job->>'due_on')::date=v_today-1,'the real queue first claims the older date';
 v_capture:=public.reserve_fb_analytics_capture((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,
   'bounded:daily',jsonb_build_object('kind','account_day','subject_id','784001','metric_date',v_today-2,'metrics',jsonb_build_array('views')));
 v_received:=clock_timestamp();
 PERFORM public.persist_fb_analytics_capture((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,
   (v_capture->>'capture_id')::uuid,jsonb_build_object('metrics',jsonb_build_object('views',jsonb_build_object('status','available','value',0)),'received_at',v_received,'observed_at',v_received));
 PERFORM public.checkpoint_fb_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'bounded_cursor',ARRAY['784001_9001'],100,false,true);
 v_request:=jsonb_build_object('since',(v_today-7)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_today::timestamp AT TIME ZONE 'America/Los_Angeles');
 v_before:=public.read_fb_analytics_history(v_owner,v_account,v_request);
 ASSERT jsonb_array_length(v_before->'daily')=1,'real captured zero is stored before terminal completion';
 v_completion:=public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'failed','inventory_truncated',NULL);
 v_after:=public.read_fb_analytics_history(v_owner,v_account,v_request);
 ASSERT v_after->'daily'=v_before->'daily','terminal truncation does not remove bounded measurements';
 ASSERT v_completion->>'state'='failed','truncated collection never becomes a successful due date';
 v_next:=public.claim_fb_analytics_collection_jobs(1)->0;
 ASSERT (v_next->>'due_on')::date=v_today,'later due date advances instead of reclaiming truncated history';
END;$terminal$;
DO $terminal$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b3000000-0000-4000-8000-000000000001';v_authority jsonb;v_job jsonb;v_next jsonb;v_capture jsonb;v_before jsonb;v_after jsonb;v_completion jsonb;v_request jsonb;v_received timestamptz;
 v_today date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
 v_authority:=public.prepare_threads_analytics_account(v_owner,v_account);
 PERFORM public.observe_threads_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],'780001',clock_timestamp(),'verified');
 PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,v_today-1,false);
 PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,v_today,false);
 v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
 ASSERT (v_job->>'due_on')::date=v_today-1,'the real queue first claims the older date';
 v_capture:=public.reserve_threads_analytics_capture((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,
   'bounded:daily',jsonb_build_object('kind','account_day','subject_id','780001','metric_date',v_today-2,'metrics',jsonb_build_array('profile_views')));
 v_received:=clock_timestamp();
 PERFORM public.persist_threads_analytics_capture((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,
   (v_capture->>'capture_id')::uuid,jsonb_build_object('metrics',jsonb_build_object('profile_views',jsonb_build_object('status','available','value',0)),'received_at',v_received,'observed_at',v_received));
 PERFORM public.checkpoint_threads_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'bounded_cursor',ARRAY['7800019001'],100,false,true);
 v_request:=jsonb_build_object('since',(v_today-7)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_today::timestamp AT TIME ZONE 'America/Los_Angeles');
 v_before:=public.read_threads_analytics_history(v_owner,v_account,v_request);
 ASSERT jsonb_array_length(v_before->'daily')=1,'real captured zero is stored before terminal completion';
 v_completion:=public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'failed','inventory_truncated',NULL);
 v_after:=public.read_threads_analytics_history(v_owner,v_account,v_request);
 ASSERT v_after->'daily'=v_before->'daily','terminal truncation does not remove bounded measurements';
 ASSERT v_completion->>'state'='failed','truncated collection never becomes a successful due date';
 v_next:=public.claim_threads_analytics_collection_jobs(1)->0;
 ASSERT (v_next->>'due_on')::date=v_today,'later due date advances instead of reclaiming truncated history';
END;$terminal$;
RESET ROLE;
ROLLBACK;
\echo 'meta_owned_analytics_truncation: ALL CHECKS PASSED'
