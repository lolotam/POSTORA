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
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["b4000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["b3000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_threads_analytics_policy';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $defer$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b4000000-0000-4000-8000-000000000001';v_authority jsonb;v_job jsonb;v_retry timestamptz:=clock_timestamp()+interval '60 seconds';
BEGIN
  v_authority:=public.prepare_fb_analytics_account(v_owner,v_account);
  PERFORM public.observe_fb_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
  BEGIN
    PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'success');
    RAISE EXCEPTION 'an incomplete collection was accepted as success';
  EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',clock_timestamp()-interval '1 second');
    RAISE EXCEPTION 'a partial retry time in the past was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',clock_timestamp()+interval '2 days');
    RAISE EXCEPTION 'a partial retry time beyond one day was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;
  END;
  PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',v_retry);
  ASSERT public.claim_fb_analytics_collection_jobs(1)='[]'::jsonb,'explicit partial backoff prevents reclaiming the same job within this invocation';
END;
$defer$;
DO $defer$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b3000000-0000-4000-8000-000000000001';v_authority jsonb;v_job jsonb;v_retry timestamptz:=clock_timestamp()+interval '60 seconds';
BEGIN
  v_authority:=public.prepare_threads_analytics_account(v_owner,v_account);
  PERFORM public.observe_threads_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],'780001',clock_timestamp(),'verified');
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
  BEGIN
    PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'success');
    RAISE EXCEPTION 'an incomplete collection was accepted as success';
  EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',clock_timestamp()-interval '1 second');
    RAISE EXCEPTION 'a partial retry time in the past was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',clock_timestamp()+interval '2 days');
    RAISE EXCEPTION 'a partial retry time beyond one day was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;
  END;
  PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',v_retry);
  ASSERT public.claim_threads_analytics_collection_jobs(1)='[]'::jsonb,'explicit partial backoff prevents reclaiming the same job within this invocation';
END;
$defer$;
-- Overlapping jobs: job A (due D) persisted every required cell but was not
-- completed; job B (due D+1) re-persisted the same day and the same posts, so
-- the cells' capture_id now belongs to B. A's 'success' must be accepted,
-- because the account's stored cells are complete, while a genuinely
-- unavailable cell must still be refused.
--
-- A is due two days back and B one day back, so both jobs own the shared day
-- (A's due-1 = B's due-2) and inventory the same post. Both are fresh jobs:
-- the earlier fixture in this file already owns the job due today.
DO $overlap_fb$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b4000000-0000-4000-8000-000000000001';
  v_provider text:='784001';v_post text:='784001_1';
  v_date date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
  v_a jsonb;v_b jsonb;v_capture jsonb;v_payload jsonb;v_day date;v_key text;v_received timestamptz;
BEGIN
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_date-2,false);
  v_a:=public.claim_fb_analytics_collection_jobs(1)->0;
  ASSERT v_a IS NOT NULL,'overlap fixture claims job A';
  -- (1) A's inventory is complete with one post.
  v_capture:=public.reserve_fb_analytics_inventory_page((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,NULL,0);
  PERFORM public.commit_fb_analytics_inventory_page((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'request_id')::uuid,ARRAY[v_post],NULL,false);
  -- (2) A persists every required day cell: its two closed days x four metrics.
  FOREACH v_day IN ARRAY ARRAY[v_date-3,v_date-4] LOOP
    FOREACH v_key IN ARRAY ARRAY['views','unique_viewers','engagements','followers'] LOOP
      v_capture:=public.reserve_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'day:'||to_char(v_day,'YYYY-MM-DD')||':'||v_key,
        jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_day,'metrics',jsonb_build_array(v_key)));
      v_received:=clock_timestamp();
      v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',1)),
        'received_at',v_received,'observed_at',(v_capture->>'until')::timestamptz);
      PERFORM public.persist_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
    END LOOP;
  END LOOP;
  -- (3) A persists the cells of the post in its own inventory.
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'post:'||v_post||':'||v_key,
      jsonb_build_object('kind','post','subject_id',v_post,'metrics',jsonb_build_array(v_key)));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',1)),
      'published_at',v_received-interval '3 days','text','fixture','permalink',NULL,'received_at',v_received,'observed_at',v_received);
    PERFORM public.persist_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  -- (4) B (due one day later) claims, completes its own inventory and
  -- re-persists the shared day and the same post, taking those cells.
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_date-1,false);
  v_b:=public.claim_fb_analytics_collection_jobs(1)->0;
  ASSERT v_b IS NOT NULL AND (v_b->>'job_id')<>(v_a->>'job_id'),'overlap fixture needs a second job';
  v_capture:=public.reserve_fb_analytics_inventory_page((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,NULL,0);
  PERFORM public.commit_fb_analytics_inventory_page((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'request_id')::uuid,ARRAY[v_post],NULL,false);
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers','engagements','followers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'day:'||to_char(v_date-3,'YYYY-MM-DD')||':'||v_key,
      jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-3,'metrics',jsonb_build_array(v_key)));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),
      'received_at',v_received,'observed_at',(v_capture->>'until')::timestamptz);
    PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'post:'||v_post||':'||v_key,
      jsonb_build_object('kind','post','subject_id',v_post,'metrics',jsonb_build_array(v_key)));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),
      'published_at',v_received-interval '3 days','text','fixture','permalink',NULL,'received_at',v_received,'observed_at',v_received);
    PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m JOIN public.fb_analytics_captures c ON c.id=m.capture_id
    WHERE c.job_id=(v_a->>'job_id')::uuid AND m.post_snapshot_id IS NOT NULL),'overlap fixture: B took the post cells';
  ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m JOIN public.fb_analytics_captures c ON c.id=m.capture_id
    WHERE c.job_id=(v_a->>'job_id')::uuid AND m.daily_id IN (SELECT d.id FROM public.fb_page_insight_daily d
      WHERE d.user_id=v_owner AND d.social_account_id=v_account AND d.metric_date=v_date-3)),'overlap fixture: B took the shared day cells';
  -- (5) A's success is accepted although B owns the cells now.
  PERFORM public.complete_fb_analytics_collection_job((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'success');
  ASSERT (SELECT state FROM public.fb_analytics_collection_jobs WHERE id=(v_a->>'job_id')::uuid)='success','an overlapped job completes';
  -- (6) B's other required day is available; only one post cell is not.
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers','engagements','followers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'day:'||to_char(v_date-2,'YYYY-MM-DD')||':'||v_key,
      jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-2,'metrics',jsonb_build_array(v_key)));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),
      'received_at',v_received,'observed_at',(v_capture->>'until')::timestamptz);
    PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  -- A genuinely unavailable cell is still refused. 'not_offered' keeps the
  -- operation out of 'failed', so the coverage rule is what refuses it.
  v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'post:'||v_post||':views:unavailable',
    jsonb_build_object('kind','post','subject_id',v_post,'metrics',jsonb_build_array('views')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('views',jsonb_build_object('status','unavailable','reason','not_offered')),
    'published_at',v_received-interval '3 days','text','fixture','permalink',NULL,'received_at',v_received,'observed_at',v_received);
  PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  BEGIN
    PERFORM public.complete_fb_analytics_collection_job((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'success');
    RAISE EXCEPTION 'a job with an unavailable post cell was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL;
  END;
  ASSERT (SELECT state FROM public.fb_analytics_collection_jobs WHERE id=(v_b->>'job_id')::uuid)='running','a refused completion leaves the job unfinished';
END;
$overlap_fb$;
-- The Threads twin of the overlap proof: the same account-level coverage
-- rule, with the profile_views day metric, the six post metrics and the
-- point-in-time followers cell.
DO $overlap_threads$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b3000000-0000-4000-8000-000000000001';
  v_provider text:='780001';v_post text:='780001_1';
  v_date date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
  v_a jsonb;v_b jsonb;v_capture jsonb;v_payload jsonb;v_day date;v_key text;v_received timestamptz;
BEGIN
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,v_date-2,false);
  v_a:=public.claim_threads_analytics_collection_jobs(1)->0;
  ASSERT v_a IS NOT NULL,'overlap fixture claims job A';
  -- (1) A's inventory is complete with one post.
  v_capture:=public.reserve_threads_analytics_inventory_page((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,NULL,0);
  PERFORM public.commit_threads_analytics_inventory_page((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'request_id')::uuid,ARRAY[v_post],NULL,false);
  -- (2) A persists every required day cell: its two closed days.
  FOREACH v_day IN ARRAY ARRAY[v_date-3,v_date-4] LOOP
    v_capture:=public.reserve_threads_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'day:'||to_char(v_day,'YYYY-MM-DD'),
      jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_day,'metrics',jsonb_build_array('profile_views')));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object('profile_views',jsonb_build_object('status','available','value',1)),
      'received_at',v_received,'observed_at',(v_capture->>'until')::timestamptz);
    PERFORM public.persist_threads_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  -- (3) A persists the post cells and the point-in-time followers cell.
  FOREACH v_key IN ARRAY ARRAY['views','likes','replies','reposts','quotes','shares'] LOOP
    v_capture:=public.reserve_threads_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'post:'||v_post||':'||v_key,
      jsonb_build_object('kind','post','subject_id',v_post,'metrics',jsonb_build_array(v_key)));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',1)),
      'published_at',v_received-interval '3 days','text','fixture','permalink',NULL,'received_at',v_received,'observed_at',v_received);
    PERFORM public.persist_threads_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  v_capture:=public.reserve_threads_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'profile:followers',
    jsonb_build_object('kind','profile','subject_id',v_provider,'metrics',jsonb_build_array('followers')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('followers',jsonb_build_object('status','available','value',1)),
    'received_at',v_received,'observed_at',v_received);
  PERFORM public.persist_threads_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  -- (4) B (due one day later) claims, completes its own inventory and
  -- re-persists the shared day and the same post, taking those cells.
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,v_date-1,false);
  v_b:=public.claim_threads_analytics_collection_jobs(1)->0;
  ASSERT v_b IS NOT NULL AND (v_b->>'job_id')<>(v_a->>'job_id'),'overlap fixture needs a second job';
  v_capture:=public.reserve_threads_analytics_inventory_page((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,NULL,0);
  PERFORM public.commit_threads_analytics_inventory_page((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'request_id')::uuid,ARRAY[v_post],NULL,false);
  v_capture:=public.reserve_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'day:'||to_char(v_date-3,'YYYY-MM-DD'),
    jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-3,'metrics',jsonb_build_array('profile_views')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('profile_views',jsonb_build_object('status','available','value',2)),
    'received_at',v_received,'observed_at',(v_capture->>'until')::timestamptz);
  PERFORM public.persist_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  FOREACH v_key IN ARRAY ARRAY['views','likes','replies','reposts','quotes','shares'] LOOP
    v_capture:=public.reserve_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'post:'||v_post||':'||v_key,
      jsonb_build_object('kind','post','subject_id',v_post,'metrics',jsonb_build_array(v_key)));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),
      'published_at',v_received-interval '3 days','text','fixture','permalink',NULL,'received_at',v_received,'observed_at',v_received);
    PERFORM public.persist_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  v_capture:=public.reserve_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'profile:followers',
    jsonb_build_object('kind','profile','subject_id',v_provider,'metrics',jsonb_build_array('followers')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('followers',jsonb_build_object('status','available','value',2)),
    'received_at',v_received,'observed_at',v_received);
  PERFORM public.persist_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  ASSERT NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m JOIN public.threads_analytics_captures c ON c.id=m.capture_id
    WHERE c.job_id=(v_a->>'job_id')::uuid AND m.post_snapshot_id IS NOT NULL),'overlap fixture: B took the post cells';
  ASSERT NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m JOIN public.threads_analytics_captures c ON c.id=m.capture_id
    WHERE c.job_id=(v_a->>'job_id')::uuid AND m.daily_id IN (SELECT d.id FROM public.threads_account_insight_daily d
      WHERE d.user_id=v_owner AND d.social_account_id=v_account AND d.metric_date=v_date-3)),'overlap fixture: B took the shared day cells';
  -- (5) A's success is accepted although B owns the cells now.
  PERFORM public.complete_threads_analytics_collection_job((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'success');
  ASSERT (SELECT state FROM public.threads_analytics_collection_jobs WHERE id=(v_a->>'job_id')::uuid)='success','an overlapped job completes';
  -- (6) B's other required day is available; only one post cell is not.
  v_capture:=public.reserve_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'day:'||to_char(v_date-2,'YYYY-MM-DD'),
    jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-2,'metrics',jsonb_build_array('profile_views')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('profile_views',jsonb_build_object('status','available','value',2)),
    'received_at',v_received,'observed_at',(v_capture->>'until')::timestamptz);
  PERFORM public.persist_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  -- A genuinely unavailable cell is still refused. 'not_offered' keeps the
  -- operation out of 'failed', so the coverage rule is what refuses it.
  v_capture:=public.reserve_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'post:'||v_post||':views:unavailable',
    jsonb_build_object('kind','post','subject_id',v_post,'metrics',jsonb_build_array('views')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('views',jsonb_build_object('status','unavailable','reason','not_offered')),
    'published_at',v_received-interval '3 days','text','fixture','permalink',NULL,'received_at',v_received,'observed_at',v_received);
  PERFORM public.persist_threads_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  BEGIN
    PERFORM public.complete_threads_analytics_collection_job((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'success');
    RAISE EXCEPTION 'a job with an unavailable post cell was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL;
  END;
  ASSERT (SELECT state FROM public.threads_analytics_collection_jobs WHERE id=(v_b->>'job_id')::uuid)='running','a refused completion leaves the job unfinished';
END;
$overlap_threads$;
RESET ROLE;
ROLLBACK;
\echo 'meta_owned_analytics_capture_failures: ALL CHECKS PASSED'
