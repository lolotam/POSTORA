-- Owned Meta analytics persistence. Synthetic fixtures; all effects roll back.
-- Exercises real service RPCs and role/FK boundaries, not mocked repositories.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email) VALUES
 ('61000000-0000-4000-8000-000000000001','meta-history-owner@example.invalid'),
 ('61000000-0000-4000-8000-000000000002','meta-history-foreign@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,is_active,needs_reauth)
VALUES
 ('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','facebook','920001','synthetic-page','synthetic-page-token',true,false),
 ('62000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','facebook','920002','synthetic-foreign','synthetic-foreign-token',true,false),
 ('63000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','threads','930001','synthetic-threads','synthetic-threads-token',true,false),
 ('63000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','threads','930002','synthetic-foreign','synthetic-foreign-token',true,false);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at)
VALUES('65000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','synthetic-user-token','910001','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform)
VALUES('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source)
VALUES('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','facebook','65000000-0000-4000-8000-000000000001','910001','oauth_exchange');


INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,is_active,needs_reauth,ig_auth_type)
VALUES('64000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','instagram','940001','synthetic-ig','synthetic-ig-token',true,false,'business_login');
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
VALUES('64000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','instagram','direct','ok',ARRAY['instagram_business_basic','instagram_business_manage_insights'],now(),1);
INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on)
VALUES('61000000-0000-4000-8000-000000000001','owner','64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000001',(clock_timestamp() AT TIME ZONE 'Asia/Kuwait')::date);
INSERT INTO public.app_settings(key,value,description) VALUES
 ('collection_instagram_insights_enabled','true'::jsonb,'Synthetic rolled-back IG compatibility test'),
 ('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"allowlist","account_ids":["64000000-0000-4000-8000-000000000001"]},"competitors":{"mode":"off","targets":[]}}'::jsonb,'Synthetic rolled-back IG compatibility test')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

DO $grants$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid,c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND (c.relname LIKE 'fb_analytics_%' OR c.relname LIKE 'threads_analytics_%' OR c.relname LIKE 'ig_analytics_%'
      OR c.relname IN ('fb_page_insight_daily','fb_post_insight_snapshots','fb_page_profile_observations',
        'threads_account_insight_daily','threads_post_insight_snapshots','threads_account_profile_observations')) LOOP
    ASSERT r.relrowsecurity,'RLS required: '||r.relname;
    ASSERT NOT has_table_privilege('authenticated',r.oid,'SELECT'),'browser read denied: '||r.relname;
    ASSERT NOT has_table_privilege('anon',r.oid,'SELECT'),'anon read denied: '||r.relname;
    ASSERT NOT has_table_privilege('service_role',r.oid,'INSERT'),'service raw INSERT denied: '||r.relname;
    ASSERT NOT has_table_privilege('service_role',r.oid,'UPDATE'),'service raw UPDATE denied: '||r.relname;
    ASSERT NOT has_table_privilege('service_role',r.oid,'DELETE'),'service raw DELETE denied: '||r.relname;
  END LOOP;
  ASSERT NOT has_function_privilege('authenticated','public.persist_threads_analytics_capture(uuid,uuid,bigint,uuid,jsonb)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.read_fb_analytics_history(uuid,uuid,jsonb)','EXECUTE');
  ASSERT has_function_privilege('authenticated','public.read_fb_analytics_history(uuid,uuid,jsonb)','EXECUTE');
  ASSERT (SELECT value='false'::jsonb FROM public.app_settings WHERE key='collection_facebook_analytics_enabled');
  ASSERT (SELECT value='false'::jsonb FROM public.app_settings WHERE key='retention_threads_analytics_enabled');
END;
$grants$;

-- Only these synthetic targets are enabled inside this rolled-back transaction.
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["62000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["63000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_threads_analytics_policy';

SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;

DO $pipeline$
DECLARE v_prefix text;v_platform text;v_account uuid;v_foreign uuid;v_provider text;v_key text;v_scopes text[];
  v_owner uuid:='61000000-0000-4000-8000-000000000001';v_authority jsonb;v_claim jsonb;v_capture_a jsonb;v_capture_b jsonb;v_capture_c jsonb;
  v_payload jsonb;v_receipt jsonb;v_replay jsonb;v_report jsonb;v_date date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
  v_received timestamptz;v_reason text;v_row record;v_count integer;v_before bigint;v_after bigint;v_old_job uuid;v_old_claim uuid;v_old_generation bigint;
BEGIN
  FOR v_prefix,v_platform,v_account,v_foreign,v_provider,v_key,v_scopes IN VALUES
    ('fb','facebook','62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid,'920001','views',ARRAY['read_insights','pages_read_engagement']),
    ('threads','threads','63000000-0000-4000-8000-000000000001'::uuid,'63000000-0000-4000-8000-000000000002'::uuid,'930001','profile_views',ARRAY['threads_basic','threads_manage_insights']) LOOP
    BEGIN
      EXECUTE format('SELECT public.prepare_%s_analytics_account($1,$2)',v_prefix) USING v_owner,v_foreign;
      RAISE EXCEPTION 'foreign account was prepared';
    EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
    EXECUTE format('SELECT public.prepare_%s_analytics_account($1,$2)',v_prefix) INTO v_authority USING v_owner,v_account;
    v_authority:=v_authority->'authority';
    BEGIN
      EXECUTE format('SELECT public.observe_%s_analytics_permissions($1,$2,$3,$4,$5,$6,$7)',v_prefix)
      USING v_owner,v_account,'{}'::jsonb,v_scopes,v_provider,clock_timestamp(),'verified';
      RAISE EXCEPTION 'stale permission authority was accepted';
    EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
    EXECUTE format('SELECT public.observe_%s_analytics_permissions($1,$2,$3,$4,$5,$6,$7)',v_prefix)
      USING v_owner,v_account,v_authority,v_scopes,v_provider,clock_timestamp(),'verified';
    EXECUTE format('SELECT public.enqueue_%s_analytics_collection_job($1,$2,$3)',v_prefix) USING v_owner,v_account,v_date;
    EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_prefix) INTO v_claim;
    ASSERT jsonb_array_length(v_claim)=1,'one eligible target claimed';v_claim:=v_claim->0;
    EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_prefix) INTO v_replay;
    ASSERT jsonb_array_length(v_replay)=0,'live lease cannot be claimed twice';
    EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture_a
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'day:primary',
        jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-1,'metrics',jsonb_build_array(v_key));
    BEGIN
      EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'day:primary',
          jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-2,'metrics',jsonb_build_array(v_key));
      RAISE EXCEPTION 'one operation accepted two windows';
    EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
    EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture_b
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'day:primary',
        jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-1,'metrics',jsonb_build_array(v_key));
    v_received:=clock_timestamp();
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',0)),
      'received_at',v_received,'observed_at',(v_capture_a->>'until')::timestamptz);
    BEGIN
      EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture_a->>'capture_id')::uuid,v_payload;
      RAISE EXCEPTION 'older response won while newer reservation outstanding';
    EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
    v_payload:=jsonb_set(v_payload,ARRAY['metrics',v_key],'{"status":"unavailable","reason":"provider_error"}'::jsonb);
    EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_receipt
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture_b->>'capture_id')::uuid,v_payload;
    EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_replay
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture_b->>'capture_id')::uuid,v_payload;
    ASSERT v_replay=v_receipt,'duplicate response returns original receipt';
    BEGIN
      EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture_b->>'capture_id')::uuid,
          jsonb_set(v_payload,ARRAY['metrics',v_key],'{"status":"available","value":0}'::jsonb);
      RAISE EXCEPTION 'conflicting replay accepted';
    EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
    FOR v_reason IN SELECT unnest(ARRAY['reauth_required','permission_missing','window_mismatch','outside_retention','capability_unverified','not_offered','not_collected']) LOOP
      EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture_c
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'reason:'||v_reason,
          jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-1,'metrics',jsonb_build_array(v_key));
      v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','unavailable','reason',v_reason)),
        'received_at',clock_timestamp(),'observed_at',(v_capture_c->>'until')::timestamptz);
      EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture_c->>'capture_id')::uuid,v_payload;
      EXECUTE format('SELECT reason,value FROM public.%s_analytics_metric_values WHERE social_account_id=$1 AND metric_key=$2',v_prefix) INTO v_row USING v_account,v_key;
      ASSERT v_row.reason=v_reason AND v_row.value IS NULL,'per-metric cause survives persistence';
    END LOOP;
    EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture_c
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'repair:zero',
        jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_date-1,'metrics',jsonb_build_array(v_key));
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',0)),
      'received_at',clock_timestamp(),'observed_at',(v_capture_c->>'until')::timestamptz);
    EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture_c->>'capture_id')::uuid,v_payload;
    EXECUTE format('SELECT public.read_%s_analytics_history($1,$2,$3)',v_prefix) INTO v_report USING v_owner,v_account,
      jsonb_build_object('since',(v_date-7)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_date::timestamp AT TIME ZONE 'America/Los_Angeles');
    ASSERT v_report->>'ok'='true' AND jsonb_array_length(v_report->'daily')=1,'actual owned history read';
    ASSERT v_report#>>'{daily,0,metrics,0,status}'='available' AND v_report#>>'{daily,0,metrics,0,value}'='0','real zero survives report';
    v_before:=(v_report->>'revision')::bigint;
    BEGIN
      EXECUTE format('SELECT public.read_%s_analytics_history($1,$2,$3)',v_prefix) USING v_owner,v_account,
        jsonb_build_object('since',(v_date-7)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_date::timestamp AT TIME ZONE 'America/Los_Angeles',
          'after_published_at',clock_timestamp()-interval '1 day','after_id','123');
      RAISE EXCEPTION 'continuation without revision accepted';
    EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL; END;
    EXECUTE format('SELECT public.read_%s_analytics_history($1,$2,$3)',v_prefix) INTO v_replay USING v_owner,v_account,
      jsonb_build_object('since',(v_date-7)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_date::timestamp AT TIME ZONE 'America/Los_Angeles','expected_revision',v_before-1);
    ASSERT v_replay->>'reason'='history_revision_changed','changed revision explicitly refused';
    BEGIN
      EXECUTE format('SELECT public.complete_%s_analytics_collection_job($1,$2,$3,$4)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'success';
      RAISE EXCEPTION 'incomplete inventory/account plan passed';
    EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
    v_old_job:=(v_claim->>'job_id')::uuid;v_old_claim:=(v_claim->>'claim_token')::uuid;v_old_generation:=(v_claim->>'job_generation')::bigint;
    EXECUTE format('SELECT public.enqueue_%s_analytics_collection_job($1,$2,$3,true)',v_prefix) USING v_owner,v_account,v_date;
    BEGIN
      EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
        USING v_old_job,v_old_claim,v_old_generation,(v_capture_c->>'capture_id')::uuid,v_payload;
      RAISE EXCEPTION 'stale generation replay accepted';
    EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
    EXECUTE format('SELECT count(*) FROM public.%s_analytics_captures WHERE job_id=$1',v_prefix) INTO v_count USING v_old_job;
    ASSERT v_count>0,'force preserves previous-generation capture history';
  END LOOP;
END;
$pipeline$;

DO $facebook_guard$
BEGIN
  BEGIN
    UPDATE public.social_accounts SET access_token='unfenced-replacement' WHERE id='62000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'raw service write bypassed admitted Facebook guard';
  EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
  UPDATE public.social_accounts SET platform_username='renamed-synthetic-page' WHERE id='62000000-0000-4000-8000-000000000001';
END;
$facebook_guard$;

DO $facebook_subject_isolation$
DECLARE v_owner uuid:='61000000-0000-4000-8000-000000000001';v_account uuid:='62000000-0000-4000-8000-000000000001';
  v_claim jsonb;v_subject text;
BEGIN
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_claim:=public.claim_fb_analytics_collection_jobs(1)->0;
  -- SQL LIKE '_' must not admit a different Page sharing the owned Page's digits.
  FOREACH v_subject IN ARRAY ARRAY['9200010_123','920001X123','920001_abc'] LOOP
    BEGIN
      PERFORM public.checkpoint_fb_analytics_inventory((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,
        (v_claim->>'job_generation')::bigint,NULL,ARRAY[v_subject],1,true,false);
      PERFORM public.reserve_fb_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,
        (v_claim->>'job_generation')::bigint,'foreign:post',jsonb_build_object('kind','post','subject_id',v_subject,'metrics',jsonb_build_array('views')));
      RAISE EXCEPTION 'foreign or malformed Facebook Page post was admitted: %',v_subject;
    EXCEPTION WHEN SQLSTATE 'MAH01' OR SQLSTATE 'MAH02' THEN NULL; END;
  END LOOP;
END;
$facebook_subject_isolation$;

DO $completion_truth$
DECLARE v_prefix text;v_account uuid;v_provider text;v_day_keys text[];v_post_keys text[];v_empty boolean;
  v_owner uuid:='61000000-0000-4000-8000-000000000001';v_claim jsonb;v_capture jsonb;v_payload jsonb;v_metrics jsonb;v_result jsonb;
  v_today date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_day date;v_post text;v_ids text[];v_received timestamptz;
BEGIN
  FOR v_prefix,v_account,v_provider,v_day_keys,v_post_keys IN VALUES
    ('fb','62000000-0000-4000-8000-000000000001'::uuid,'920001',ARRAY['views','unique_viewers','engagements','followers'],ARRAY['views','unique_viewers']),
    ('threads','63000000-0000-4000-8000-000000000001'::uuid,'930001',ARRAY['profile_views'],ARRAY['views','likes','replies','reposts','quotes','shares']) LOOP
    FOREACH v_empty IN ARRAY ARRAY[false,true] LOOP
      EXECUTE format('SELECT public.enqueue_%s_analytics_collection_job($1,$2,$3,true)',v_prefix) USING v_owner,v_account,v_today;
      EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_prefix) INTO v_claim;
      v_claim:=v_claim->0;ASSERT v_claim IS NOT NULL,'new completion generation is claimable';
      FOREACH v_day IN ARRAY ARRAY[v_today-1,v_today-2] LOOP
        SELECT jsonb_object_agg(k,jsonb_build_object('status','available','value',0)) INTO v_metrics FROM unnest(v_day_keys) k;
        EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'complete:day:'||v_day,
            jsonb_build_object('kind','account_day','subject_id',v_provider,'metric_date',v_day,'metrics',to_jsonb(v_day_keys));
        EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,
            jsonb_build_object('metrics',v_metrics,'received_at',clock_timestamp(),'observed_at',(v_capture->>'until')::timestamptz);
      END LOOP;
      IF v_prefix='threads' THEN
        v_capture:=public.reserve_threads_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
          'complete:profile',jsonb_build_object('kind','profile','subject_id',v_provider,'metrics',jsonb_build_array('followers')));
        v_received:=clock_timestamp();
        PERFORM public.persist_threads_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
          (v_capture->>'capture_id')::uuid,jsonb_build_object('metrics',jsonb_build_object('followers',jsonb_build_object('status','available','value',0)),
          'received_at',v_received,'observed_at',v_received));
      END IF;
      v_ids:=CASE WHEN v_empty THEN ARRAY[]::text[] ELSE ARRAY[v_provider||'_101',v_provider||'_102'] END;
      EXECUTE format('SELECT public.checkpoint_%s_analytics_inventory($1,$2,$3,NULL,$4,1,true,false)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,v_ids;
      FOREACH v_post IN ARRAY v_ids LOOP
        SELECT jsonb_object_agg(k,jsonb_build_object('status','available','value',0)) INTO v_metrics FROM unnest(v_post_keys) k;
        IF v_post=v_ids[2] THEN v_metrics:=jsonb_set(v_metrics,ARRAY[v_post_keys[1]],'{"status":"unavailable","reason":"not_offered"}'); END IF;
        EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'complete:post:'||v_post,
            jsonb_build_object('kind','post','subject_id',v_post,'metrics',to_jsonb(v_post_keys));
        v_payload:=jsonb_build_object('metrics',v_metrics,'received_at',clock_timestamp(),'observed_at',clock_timestamp()-interval '1 second',
          'published_at',(v_today-1)::timestamp AT TIME ZONE 'America/Los_Angeles');
        EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload;
      END LOOP;
      IF NOT v_empty THEN
        BEGIN
          EXECUTE format('SELECT public.complete_%s_analytics_collection_job($1,$2,$3,$4)',v_prefix)
            USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'success';
          RAISE EXCEPTION 'caller-supplied not_offered excused a supported required post metric';
        EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
        v_post:=v_ids[2];
        SELECT jsonb_object_agg(k,jsonb_build_object('status','available','value',0)) INTO v_metrics FROM unnest(v_post_keys) k;
        EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'complete:repair:'||v_post,
            jsonb_build_object('kind','post','subject_id',v_post,'metrics',to_jsonb(v_post_keys));
        EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,
            jsonb_build_object('metrics',v_metrics,'received_at',clock_timestamp(),'observed_at',clock_timestamp()-interval '1 second',
              'published_at',(v_today-1)::timestamp AT TIME ZONE 'America/Los_Angeles');
      END IF;
      EXECUTE format('SELECT public.complete_%s_analytics_collection_job($1,$2,$3,$4)',v_prefix) INTO v_result
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'success';
      ASSERT v_result->>'state'='success' AND (v_result->>'on_time')::boolean,'complete values, including genuine zeros/empty inventory, succeed';
    END LOOP;
  END LOOP;
END;
$completion_truth$;

DO $exact_period_identity$
DECLARE v_prefix text;v_account uuid;v_provider text;v_owner uuid:='61000000-0000-4000-8000-000000000001';
  v_claim jsonb;v_capture jsonb;v_old jsonb;v_payload jsonb;v_report jsonb;v_days integer;
  v_today date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_until timestamptz;
BEGIN
  v_until:=v_today::timestamp AT TIME ZONE 'America/Los_Angeles';
  FOR v_prefix,v_account,v_provider IN VALUES
    ('fb','62000000-0000-4000-8000-000000000001'::uuid,'920001'),
    ('threads','63000000-0000-4000-8000-000000000001'::uuid,'930001') LOOP
    EXECUTE format('SELECT public.enqueue_%s_analytics_collection_job($1,$2,$3,true)',v_prefix) USING v_owner,v_account,v_today;
    EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_prefix) INTO v_claim;v_claim:=v_claim->0;
    FOREACH v_days IN ARRAY ARRAY[7,30] LOOP
      EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'exact:'||v_days,
          jsonb_build_object('kind','period_total','subject_id',v_provider,'since',(v_today-v_days)::timestamp AT TIME ZONE 'America/Los_Angeles',
            'until',v_until,'metrics',jsonb_build_array('reach'));
      v_payload:=jsonb_build_object('metrics',jsonb_build_object('reach',jsonb_build_object('status','unavailable','reason','capability_unverified')),
        'received_at',clock_timestamp(),'observed_at',v_until);
      IF v_days=7 THEN
        v_old:=v_capture;
        EXECUTE format('SELECT public.reserve_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix) INTO v_capture
          USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'exact:7',
            jsonb_build_object('kind','period_total','subject_id',v_provider,'since',(v_today-7)::timestamp AT TIME ZONE 'America/Los_Angeles',
              'until',v_until,'metrics',jsonb_build_array('reach'));
        BEGIN
          EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
            USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_old->>'capture_id')::uuid,v_payload;
          RAISE EXCEPTION 'older exact total survived a newer reservation';
        EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
        v_payload:=jsonb_set(v_payload,'{received_at}',to_jsonb(clock_timestamp()));
      END IF;
      EXECUTE format('SELECT public.persist_%s_analytics_capture($1,$2,$3,$4,$5)',v_prefix)
        USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload;
    END LOOP;
    FOREACH v_days IN ARRAY ARRAY[7,30] LOOP
      EXECUTE format('SELECT public.read_%s_analytics_history($1,$2,$3)',v_prefix) INTO v_report
        USING v_owner,v_account,jsonb_build_object('since',(v_today-v_days)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_until);
      ASSERT jsonb_array_length(v_report->'period_totals')=1,'overlapping 7/30-day totals are distinct and selected by exact bounds';
      ASSERT (v_report#>>'{period_totals,0,window_since}')::timestamptz=(v_today-v_days)::timestamp AT TIME ZONE 'America/Los_Angeles';
      ASSERT v_report#>>'{period_totals,0,reason}'='capability_unverified','storage does not invent verified period support';
    END LOOP;
    EXECUTE format('SELECT public.complete_%s_analytics_collection_job($1,$2,$3,$4)',v_prefix)
      USING (v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,'partial';
  END LOOP;
END;
$exact_period_identity$;


DO $instagram_compatibility$
DECLARE v_claim jsonb;v_capture jsonb;v_old jsonb;v_payload jsonb;v_metric jsonb;v_received timestamptz;v_observed timestamptz;v_receipt jsonb;v_replay jsonb;
  v_date date:=(clock_timestamp() AT TIME ZONE 'Asia/Kuwait')::date-1;v_row record;
BEGIN
  SELECT c INTO v_claim FROM public.claim_instagram_collection_jobs('owner',25) c
    WHERE c->>'social_account_id'='64000000-0000-4000-8000-000000000001';
  ASSERT v_claim IS NOT NULL,'existing IG owner queue supplies real fenced claim';
  v_capture:=public.reserve_ig_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_account_day','metric_date',v_date,'metrics',jsonb_build_array('views','reach')));
  v_received:=clock_timestamp();
  v_payload:=jsonb_build_object('kind','owner_account_day','items',jsonb_build_array(jsonb_build_object('metric_date',v_date,'provider_date',v_date,
    'query_kind','interactions','period_start',v_date::timestamp AT TIME ZONE 'Asia/Kuwait','period_end',(v_date+1)::timestamp AT TIME ZONE 'Asia/Kuwait',
    'provider_timezone','Asia/Kuwait','status','ok','metrics',jsonb_build_object('views',NULL,'reach',0))));
  v_metric:='{"views":{"status":"unavailable","reason":"permission_missing"},"reach":{"status":"unavailable","reason":"capability_unverified"}}';
  v_receipt:=public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    (v_capture->>'capture_id')::uuid,v_payload,v_metric,v_received);
  v_replay:=public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    (v_capture->>'capture_id')::uuid,v_payload,v_metric,v_received);
  ASSERT v_replay=v_receipt,'IG duplicate response is idempotent';
  SELECT d.reach,d.views,m.reason INTO v_row FROM public.ig_account_insight_daily d JOIN public.ig_analytics_metric_values m ON m.daily_id=d.id
    WHERE d.social_account_id='64000000-0000-4000-8000-000000000001' AND m.metric_key='views';
  ASSERT v_row.reach=0 AND v_row.views IS NULL AND v_row.reason='permission_missing','legacy zero and per-metric cause preserved together';
  ASSERT EXISTS(SELECT 1 FROM public.ig_account_insight_daily d JOIN public.ig_analytics_metric_values m ON m.daily_id=d.id
    WHERE d.social_account_id='64000000-0000-4000-8000-000000000001' AND m.metric_key='views'
      AND m.window_since=d.period_start AND m.window_until=d.period_end AND m.provider_timezone=d.provider_timezone),
    'IG provenance preserves its actual legacy provider window without promoting capability';
  v_old:=v_capture;
  v_capture:=public.reserve_ig_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_account_day','metric_date',v_date,'metrics',jsonb_build_array('views','reach')));
  BEGIN
    PERFORM public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
      (v_old->>'capture_id')::uuid,v_payload,v_metric,v_received);
    RAISE EXCEPTION 'superseded IG replay bypassed a newer reservation';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
  PERFORM public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    (v_capture->>'capture_id')::uuid,v_payload,v_metric,clock_timestamp());
  v_capture:=public.reserve_ig_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_media','media_id','940100','metrics',jsonb_build_array('views')));
  v_payload:=jsonb_build_object('kind','owner_media','items',jsonb_build_array(jsonb_build_object('ig_media_id','940100','published_at',now()-interval '1 day',
    'media_type','IMAGE','status','unavailable','metrics',jsonb_build_object('views',NULL))));
  v_receipt:=public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    (v_capture->>'capture_id')::uuid,v_payload,'{"views":{"status":"unavailable","reason":"reauth_required"}}',clock_timestamp());
  ASSERT EXISTS(SELECT 1 FROM public.ig_analytics_metric_values WHERE post_snapshot_id IS NOT NULL AND reason='reauth_required'),'IG post cause persisted';
  PERFORM public.persist_instagram_collection_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_media','items',jsonb_build_array(jsonb_build_object('ig_media_id','940100','published_at',now()-interval '1 day',
      'media_type','IMAGE','status','ok','metrics',jsonb_build_object('views',9)))));
  ASSERT NOT EXISTS(SELECT 1 FROM public.ig_analytics_metric_values WHERE post_snapshot_id IS NOT NULL AND metric_key='views'),
    'later legacy post value invalidates its old provenance';
  v_capture:=public.reserve_ig_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_profile_observation','metrics',jsonb_build_array('followers')));
  v_observed:=clock_timestamp();
  v_payload:=jsonb_build_object('kind','owner_profile_observation','items',jsonb_build_array(jsonb_build_object('observed_at',v_observed,'status','unavailable','metrics',jsonb_build_object('followers_count',NULL))));
  v_receipt:=public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    (v_capture->>'capture_id')::uuid,v_payload,'{"followers":{"status":"unavailable","reason":"provider_error"}}',clock_timestamp());
  ASSERT EXISTS(SELECT 1 FROM public.ig_analytics_metric_values WHERE profile_observation_id IS NOT NULL AND reason='provider_error'),'IG profile cause persisted';
  PERFORM public.persist_instagram_collection_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_profile_observation','items',jsonb_build_array(jsonb_build_object('observed_at',v_observed,'status','ok','metrics',jsonb_build_object('followers_count',5)))));
  ASSERT NOT EXISTS(SELECT 1 FROM public.ig_analytics_metric_values WHERE profile_observation_id IS NOT NULL AND metric_key='followers'),
    'later legacy follower value invalidates its old provenance';
  -- The default legacy RPC is unchanged. Its later scalar mutation cannot
  -- inherit the sidecar's earlier capture or leave false available provenance.
  PERFORM public.persist_instagram_collection_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_account_day','items',jsonb_build_array(jsonb_build_object('metric_date',v_date,'provider_date',v_date,
      'query_kind','interactions','status','ok','metrics',jsonb_build_object('views',3,'reach',0)))));
  ASSERT NOT EXISTS(SELECT 1 FROM public.ig_analytics_metric_values m JOIN public.ig_account_insight_daily d ON d.id=m.daily_id
    WHERE d.social_account_id='64000000-0000-4000-8000-000000000001' AND m.metric_key='views'),'changed legacy scalar invalidates stale provenance';
  ASSERT EXISTS(SELECT 1 FROM public.ig_account_insight_daily WHERE social_account_id='64000000-0000-4000-8000-000000000001' AND views=3),'default legacy values retained';
  v_capture:=public.reserve_ig_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_account_day','metric_date',v_date-1,'metrics',jsonb_build_array('views')));
  BEGIN
    PERFORM public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
      (v_capture->>'capture_id')::uuid,jsonb_build_object('kind','owner_account_day','items',jsonb_build_array(jsonb_build_object('metric_date',v_date-1,
        'provider_date',v_date-1,'query_kind','interactions','status','ok','metrics',jsonb_build_object('views',0)))),
      '{"views":{"status":"available","value":0}}',clock_timestamp());
    RAISE EXCEPTION 'unverified IG cell promoted to available';
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.ig_account_insight_daily WHERE social_account_id='64000000-0000-4000-8000-000000000001' AND metric_date=v_date-1),
    'failed provenance rolls back the compatibility write atomically';
  v_payload:=jsonb_build_object('kind','owner_account_day','items',jsonb_build_array(jsonb_build_object('metric_date',v_date-2,'provider_date',v_date-2,
    'query_kind','interactions','status','ok','metrics',jsonb_build_object('views',2))));
  PERFORM public.persist_instagram_collection_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,v_payload);
  v_capture:=public.reserve_ig_analytics_capture((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_build_object('kind','owner_account_day','metric_date',v_date-2,'metrics',jsonb_build_array('views')));
  PERFORM public.persist_instagram_collection_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
    jsonb_set(v_payload,'{items,0,metrics,views}','8'));
  BEGIN
    PERFORM public.persist_ig_analytics_snapshot((v_claim->>'job_id')::uuid,(v_claim->>'claim_token')::uuid,(v_claim->>'job_generation')::bigint,
      (v_capture->>'capture_id')::uuid,v_payload,'{"views":{"status":"unavailable","reason":"provider_error"}}',clock_timestamp());
    RAISE EXCEPTION 'an outstanding IG response overwrote a newer legacy write';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
  ASSERT EXISTS(SELECT 1 FROM public.ig_account_insight_daily WHERE social_account_id='64000000-0000-4000-8000-000000000001' AND metric_date=v_date-2 AND views=8),
    'a later accepted legacy capture retains its numeric value';
END;
$instagram_compatibility$;

RESET ROLE;

-- Historical observations cannot be backdated through a current live claim.
-- Seed accepted historical responses as the database owner, only in this rollback.
CREATE FUNCTION pg_temp.seed_meta_profile_observation(p_fixture jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $fixture$
DECLARE v_account uuid:=(p_fixture->>'account_id')::uuid;v_owner uuid;v_platform text;v_prefix text;v_provider text;
  v_when timestamptz:=(p_fixture->>'observed_at')::timestamptz;v_day date;v_job uuid;v_operation uuid:=gen_random_uuid();
  v_capture uuid:=gen_random_uuid();v_observation uuid:=COALESCE((p_fixture->>'id')::uuid,gen_random_uuid());v_sequence bigint;
  v_status text:=COALESCE(p_fixture->>'status','available');v_metric text;v_source text;v_api text;
BEGIN
  SELECT user_id,platform,platform_user_id INTO STRICT v_owner,v_platform,v_provider FROM public.social_accounts WHERE id=v_account;
  v_prefix:=CASE v_platform WHEN 'facebook' THEN 'fb' WHEN 'threads' THEN 'threads' END;
  ASSERT v_prefix IS NOT NULL,'fixture accepts only the two C2 table families';
  v_api:=CASE v_platform WHEN 'facebook' THEN 'v25.0' ELSE 'v1.0' END;
  v_source:=CASE v_platform WHEN 'facebook' THEN 'meta_graph_v25' ELSE 'threads_graph_v1' END;
  v_metric:=public.meta_analytics_provider_metric(v_platform,'account','followers','point_in_time');
  v_day:=(v_when AT TIME ZONE 'America/Los_Angeles')::date;
  EXECUTE format('INSERT INTO public.%s_analytics_collection_jobs(user_id,social_account_id,due_on,due_at,next_due_at,state)
    VALUES($1,$2,$3,$3::timestamp AT TIME ZONE ''America/Los_Angeles'',($3+1)::timestamp AT TIME ZONE ''America/Los_Angeles'',''success'')
    ON CONFLICT(user_id,social_account_id,due_on) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING id',v_prefix)
    INTO v_job USING v_owner,v_account,v_day;
  EXECUTE format('UPDATE public.%s_analytics_report_state SET next_capture_sequence=next_capture_sequence+1 WHERE social_account_id=$1 RETURNING next_capture_sequence',v_prefix)
    INTO v_sequence USING v_account;
  EXECUTE format('INSERT INTO public.%s_analytics_collection_operations(id,job_id,user_id,social_account_id,job_generation,operation_key,kind,state,requested_metrics)
    VALUES($1,$2,$3,$4,1,$5,''profile'',''success'',ARRAY[''followers''])',v_prefix)
    USING v_operation,v_job,v_owner,v_account,'fixture:profile:'||v_sequence;
  EXECUTE format('INSERT INTO public.%s_analytics_captures(id,job_id,operation_id,job_generation,claim_token,user_id,social_account_id,capture_sequence,kind,subject_id,
    api_version,requested_metrics,credential_authority,requested_at,received_at,payload_digest,receipt)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,''profile'',$8,$9,ARRAY[''followers''],''{}'',$10-interval ''1 second'',$10,repeat(''0'',64),''{"fixture":true}'')',v_prefix)
    USING v_capture,v_job,v_operation,gen_random_uuid(),v_owner,v_account,v_sequence,v_provider,v_api,v_when;
  EXECUTE format('INSERT INTO public.%s(id,user_id,social_account_id,capture_id,observed_at) VALUES($1,$2,$3,$4,$5)',
    CASE v_platform WHEN 'facebook' THEN 'fb_page_profile_observations' ELSE 'threads_account_profile_observations' END)
    USING v_observation,v_owner,v_account,v_capture,v_when;
  EXECUTE format('INSERT INTO public.%s_analytics_metric_values(user_id,social_account_id,profile_observation_id,metric_key,status,value,reason,
    provider_metric,api_version,window_kind,source_ref,capture_id,observed_at) VALUES($1,$2,$3,''followers'',$4,$5,$6,$7,$8,''point_in_time'',$9,$10,$11)',v_prefix)
    USING v_owner,v_account,v_observation,v_status,(p_fixture->>'value')::bigint,p_fixture->>'reason',v_metric,v_api,v_source,v_capture,v_when;
  RETURN jsonb_build_object('observation_id',v_observation,'capture_id',v_capture,'operation_id',v_operation,'job_id',v_job);
END;
$fixture$;

DO $follower_boundary_selection$
DECLARE v_owner uuid:='61000000-0000-4000-8000-000000000001';v_account uuid:='63000000-0000-4000-8000-000000000001';
  v_today date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_since timestamptz;v_until timestamptz;v_previous timestamptz;
  v_request jsonb;v_report jsonb;v_samples jsonb;v_fixture jsonb;v_end jsonb;v_unavailable jsonb;v_when timestamptz;
BEGIN
  v_since:=(v_today-7)::timestamp AT TIME ZONE 'America/Los_Angeles';v_until:=v_today::timestamp AT TIME ZONE 'America/Los_Angeles';
  v_previous:=(v_today-14)::timestamp AT TIME ZONE 'America/Los_Angeles';v_request:=jsonb_build_object('since',v_since,'until',v_until);
  -- Inclusive 24-hour edge; stale by one microsecond; future by one microsecond;
  -- equal-time ties; a newer failed read must not displace a valid boundary.
  FOREACH v_when IN ARRAY ARRAY[v_previous-interval '24 hours',v_since-interval '1 hour',v_until-interval '24 hours'] LOOP
    v_fixture:=pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_when,'value',0));
    IF v_when=v_until-interval '24 hours' THEN v_end:=v_fixture; END IF;
  END LOOP;
  PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_previous-interval '24 hours 0.000001 seconds','value',99));
  PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_until+interval '0.000001 seconds','value',99));
  PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_since-interval '30 minutes',
    'id','6fffffff-ffff-4fff-8fff-fffffffffff2','value',0));
  PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_since-interval '30 minutes',
    'id','6fffffff-ffff-4fff-8fff-fffffffffff1','value',98));
  PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_since-interval '1 minute','status','unavailable','reason','permission_missing'));
  v_unavailable:=pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_until-interval '1 hour','status','unavailable','reason','reauth_required'));
  v_report:=public.read_threads_analytics_history(v_owner,v_account,v_request);v_samples:=v_report->'profile_boundaries';
  ASSERT jsonb_array_length(v_samples)=3,'each boundary has one valid sample';
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_samples) s WHERE s->>'status'<>'available' OR (s->>'value')::bigint<>0),
    'genuine zero boundary values survive newer failures, stale and future samples';
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_samples) s WHERE (s->>'boundary')::timestamptz=v_since
    AND s->>'observation_id'='6fffffff-ffff-4fff-8fff-fffffffffff2' AND (s->>'observed_at')::timestamptz=v_since-interval '30 minutes'),
    'equal-time tie uses descending ID and exposes actual observation time';
  DELETE FROM public.threads_account_profile_observations WHERE id=(v_end->>'observation_id')::uuid;
  v_report:=public.read_threads_analytics_history(v_owner,v_account,v_request);
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_report->'profile_boundaries') s WHERE (s->>'boundary')::timestamptz=v_until
    AND s->>'reason'='reauth_required' AND s->>'value' IS NULL),'failed boundary retains actual unavailable reason';
  DELETE FROM public.threads_account_profile_observations WHERE id=(v_unavailable->>'observation_id')::uuid;
  v_report:=public.read_threads_analytics_history(v_owner,v_account,v_request);
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_report->'profile_boundaries') s WHERE (s->>'boundary')::timestamptz=v_until),
    'a future observation never fills a missing past boundary';
END;
$follower_boundary_selection$;

DO $relational_owner_platform_boundaries$
DECLARE v_metric uuid;v_capture uuid;
BEGIN
  SELECT id INTO STRICT v_metric FROM public.threads_analytics_metric_values WHERE profile_observation_id='6fffffff-ffff-4fff-8fff-fffffffffff2';
  SELECT id INTO v_capture FROM public.fb_analytics_captures ORDER BY capture_sequence LIMIT 1;
  BEGIN
    UPDATE public.threads_analytics_metric_values SET capture_id=v_capture WHERE id=v_metric;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'cross-platform capture attached to a Threads metric';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.threads_analytics_metric_values SET user_id='61000000-0000-4000-8000-000000000002' WHERE id=v_metric;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'foreign owner inherited an existing measurement and capture';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.threads_analytics_metric_values SET social_account_id='63000000-0000-4000-8000-000000000002' WHERE id=v_metric;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'foreign account inherited an existing measurement and capture';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.social_accounts SET user_id='61000000-0000-4000-8000-000000000002' WHERE id='63000000-0000-4000-8000-000000000001';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'history changed owner through account reassignment';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END;
$relational_owner_platform_boundaries$;

CREATE FUNCTION pg_temp.meta_history_fingerprint(p_prefix text,p_account uuid)
RETURNS jsonb LANGUAGE plpgsql AS $fixture$
DECLARE v_table text;v_tables text[];v_count bigint;v_rows bigint:=0;v_digest text;v_digests text:='';
BEGIN
  v_tables:=ARRAY[p_prefix||'_analytics_collection_jobs',p_prefix||'_analytics_collection_operations',p_prefix||'_analytics_collection_checkpoints',
    p_prefix||'_analytics_captures',p_prefix||'_analytics_metric_values',p_prefix||'_analytics_period_totals'];
  v_tables:=v_tables||CASE p_prefix WHEN 'fb' THEN ARRAY['fb_page_insight_daily','fb_post_insight_snapshots','fb_page_profile_observations']
    ELSE ARRAY['threads_account_insight_daily','threads_post_insight_snapshots','threads_account_profile_observations'] END;
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*),md5(COALESCE(string_agg(to_jsonb(r)::text,'''' ORDER BY to_jsonb(r)::text),'''')) FROM public.%I r WHERE social_account_id=$1',v_table)
      INTO v_count,v_digest USING p_account;
    v_rows:=v_rows+v_count;v_digests:=v_digests||v_digest;
  END LOOP;
  EXECUTE format('SELECT md5(to_jsonb(r)::text) FROM public.%s_analytics_report_state r WHERE social_account_id=$1',p_prefix) INTO v_digest USING p_account;
  RETURN jsonb_build_object('rows',v_rows,'digest',md5(v_digests||v_digest));
END;
$fixture$;

DO $bounded_independent_retention$
DECLARE v_prefix text;v_platform text;v_account uuid;v_profile_table text;v_daily_table text;v_owner uuid:='61000000-0000-4000-8000-000000000001';
  v_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';v_row jsonb;v_anchor jsonb;
  v_before jsonb;v_after jsonb;v_result jsonb;v_policy jsonb;v_i integer;v_revision bigint;v_current_revision bigint;v_day date;
  v_old_daily uuid:=gen_random_uuid();v_kept_daily uuid:=gen_random_uuid();v_exact_profile jsonb;
  v_case text;v_capture uuid;v_envelope uuid;v_capture_day date;v_until timestamptz;v_api text;v_source text;v_provider text;
  v_post_table text;v_old_post uuid;v_kept_post uuid;v_old_total uuid;v_overlap_total uuid;v_new_total uuid;
BEGIN
  FOR v_prefix,v_platform,v_account,v_profile_table,v_daily_table IN VALUES
    ('fb','facebook','62000000-0000-4000-8000-000000000001'::uuid,'fb_page_profile_observations','fb_page_insight_daily'),
    ('threads','threads','63000000-0000-4000-8000-000000000001'::uuid,'threads_account_profile_observations','threads_account_insight_daily') LOOP
    -- More than 500 physical children, with a valid pre-floor anchor only
    -- where point-in-time follower capability is actually verified (Threads).
    FOR v_i IN 1..260 LOOP
      v_row:=pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_floor-interval '2 days'-v_i*interval '1 second')
        ||CASE v_platform WHEN 'threads' THEN '{"value":0}'::jsonb ELSE '{"status":"unavailable","reason":"provider_error"}'::jsonb END);
    END LOOP;
    IF v_platform='threads' THEN
      v_anchor:=pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_floor-interval '1 second','value',0,
        'id','6eeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'));
      PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_floor-interval '1 second','value',99,
        'id','6eeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'));
      PERFORM pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_floor-interval '0.000001 seconds',
        'status','unavailable','reason','permission_missing'));
    END IF;
    v_exact_profile:=pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_floor)
      ||CASE v_platform WHEN 'threads' THEN '{"value":0}'::jsonb ELSE '{"status":"unavailable","reason":"not_collected"}'::jsonb END);
    v_day:=(v_floor AT TIME ZONE 'America/Los_Angeles')::date;
    v_old_daily:=gen_random_uuid();v_kept_daily:=gen_random_uuid();
    EXECUTE format('INSERT INTO public.%I(id,user_id,social_account_id,metric_date,period_start,period_end,provider_timezone)
      VALUES($1,$3,$4,$5-1,($5-1)::timestamp AT TIME ZONE ''America/Los_Angeles'',$5::timestamp AT TIME ZONE ''America/Los_Angeles'',''America/Los_Angeles''),
      ($2,$3,$4,$5,$5::timestamp AT TIME ZONE ''America/Los_Angeles'',($5+1)::timestamp AT TIME ZONE ''America/Los_Angeles'',''America/Los_Angeles'')',v_daily_table)
      USING v_old_daily,v_kept_daily,v_owner,v_account,v_day;
    v_post_table:=CASE v_platform WHEN 'facebook' THEN 'fb_post_insight_snapshots' ELSE 'threads_post_insight_snapshots' END;
    v_api:=CASE v_platform WHEN 'facebook' THEN 'v25.0' ELSE 'v1.0' END;
    v_source:=CASE v_platform WHEN 'facebook' THEN 'meta_graph_v25' ELSE 'threads_graph_v1' END;
    SELECT platform_user_id INTO v_provider FROM public.social_accounts WHERE id=v_account;
    -- Exact totals require both an expired window and an old capture date.
    -- The unverified cells below exercise retention without inventing support.
    FOREACH v_case IN ARRAY ARRAY['old_total','overlap_total','new_total','old_post','kept_post'] LOOP
      v_capture_day:=(v_floor AT TIME ZONE 'UTC')::date-CASE WHEN v_case IN ('new_total','kept_post') THEN 0 ELSE 1 END;
      v_row:=pg_temp.seed_meta_profile_observation(jsonb_build_object('account_id',v_account,'observed_at',v_capture_day::timestamp AT TIME ZONE 'UTC',
        'status','unavailable','reason','capability_unverified'));
      v_capture:=(v_row->>'capture_id')::uuid;v_envelope:=gen_random_uuid();
      EXECUTE format('DELETE FROM public.%s_analytics_metric_values WHERE profile_observation_id=$1',v_prefix) USING (v_row->>'observation_id')::uuid;
      EXECUTE format('DELETE FROM public.%I WHERE id=$1',v_profile_table) USING (v_row->>'observation_id')::uuid;
      v_until:=(v_day+CASE WHEN v_case='overlap_total' THEN 1 ELSE 0 END)::timestamp AT TIME ZONE 'America/Los_Angeles';
      EXECUTE format('UPDATE public.%s_analytics_collection_operations SET kind=$1,requested_metrics=ARRAY[$2],state=''failed'' WHERE id=$3',v_prefix)
        USING CASE WHEN v_case LIKE '%post' THEN 'post' ELSE 'period_total' END,CASE WHEN v_case LIKE '%post' THEN 'views' ELSE 'reach' END,(v_row->>'operation_id')::uuid;
      EXECUTE format('UPDATE public.%s_analytics_captures SET kind=$1,requested_metrics=ARRAY[$2],window_since=$3,window_until=$4,provider_timezone=$5,subject_id=$6 WHERE id=$7',v_prefix)
        USING CASE WHEN v_case LIKE '%post' THEN 'post' ELSE 'period_total' END,CASE WHEN v_case LIKE '%post' THEN 'views' ELSE 'reach' END,
          CASE WHEN v_case NOT LIKE '%post' THEN v_until-interval '7 days' END,CASE WHEN v_case NOT LIKE '%post' THEN v_until END,
          CASE WHEN v_case NOT LIKE '%post' THEN 'America/Los_Angeles' END,
          CASE WHEN v_case LIKE '%post' THEN v_provider||CASE WHEN v_case='old_post' THEN '_701' ELSE '_702' END ELSE v_provider END,v_capture;
      IF v_case LIKE '%post' THEN
        EXECUTE format('INSERT INTO public.%I(id,user_id,social_account_id,platform_post_id,captured_on,published_at,metadata_capture_id) VALUES($1,$2,$3,$4,$5,$6,$7)',v_post_table)
          USING v_envelope,v_owner,v_account,v_provider||CASE WHEN v_case='old_post' THEN '_701' ELSE '_702' END,v_capture_day,v_floor-interval '10 days',v_capture;
        IF v_case='old_post' THEN v_old_post:=v_envelope; ELSE v_kept_post:=v_envelope; END IF;
      ELSE
        EXECUTE format('INSERT INTO public.%s_analytics_period_totals(id,user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,
          captured_on,status,reason,source_ref,capture_id,observed_at) VALUES($1,$2,$3,''account'',$4,''reach'',$5,''America/Los_Angeles'',$6,$7,$8,''unavailable'',''capability_unverified'',$9,$10,$11)',v_prefix)
          USING v_envelope,v_owner,v_account,v_provider,v_api,v_until-interval '7 days',v_until,v_capture_day,v_source,v_capture,v_capture_day::timestamp AT TIME ZONE 'UTC';
        IF v_case='old_total' THEN v_old_total:=v_envelope; ELSIF v_case='overlap_total' THEN v_overlap_total:=v_envelope; ELSE v_new_total:=v_envelope; END IF;
      END IF;
    END LOOP;
    v_before:=pg_temp.meta_history_fingerprint(v_prefix,v_account);
    BEGIN
      EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,500,true)',v_prefix) USING v_owner,v_account,v_floor;
      RAISE EXCEPTION 'dry run bypassed its independent target policy';
    EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
    v_policy:=jsonb_build_object('account_ids',jsonb_build_array(v_account));
    UPDATE public.app_settings SET value=v_policy WHERE key='retention_'||v_platform||'_analytics_policy';
    EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,500,true)',v_prefix) INTO v_result USING v_owner,v_account,v_floor;
    v_after:=pg_temp.meta_history_fingerprint(v_prefix,v_account);
    ASSERT v_before=v_after AND (v_result->>'deleted')::integer=500,'dry run applies physical cap and leaves all rows/revision unchanged';
    BEGIN
      EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,500,false)',v_prefix) USING v_owner,v_account,v_floor;
      RAISE EXCEPTION 'a dry run authorized later physical deletion';
    EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
    UPDATE public.app_settings SET value='false'::jsonb WHERE key='collection_'||v_platform||'_analytics_enabled';
    UPDATE public.social_accounts SET is_active=false,needs_reauth=true WHERE id=v_account;
    UPDATE public.app_settings SET value='true'::jsonb WHERE key='retention_'||v_platform||'_analytics_enabled';
    EXECUTE format('SELECT report_revision FROM public.%s_analytics_report_state WHERE social_account_id=$1',v_prefix) INTO v_revision USING v_account;
    EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,1,false)',v_prefix) INTO v_result USING v_owner,v_account,v_floor;
    ASSERT (v_result->>'deleted')::integer=1 AND (v_result->>'report_revision')::bigint=v_revision+1,
      'retention works for a disabled/disconnected target and invalidates revision for a single child deletion';
    SET CONSTRAINTS ALL IMMEDIATE;
    v_before:=pg_temp.meta_history_fingerprint(v_prefix,v_account);
    EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,500,false)',v_prefix) INTO v_result USING v_owner,v_account,v_floor;
    v_after:=pg_temp.meta_history_fingerprint(v_prefix,v_account);
    ASSERT (v_before->>'rows')::bigint-(v_after->>'rows')::bigint=500 AND (v_result->>'deleted')::integer=500,
      'one budget counts every physical metric/envelope/capture/operation/checkpoint/job row';
    SET CONSTRAINTS ALL IMMEDIATE;
    FOR v_i IN 1..20 LOOP
      EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,500,false)',v_prefix) INTO v_result USING v_owner,v_account,v_floor;
      EXIT WHEN (v_result->>'deleted')::integer=0;
    END LOOP;
    ASSERT (v_result->>'deleted')::integer=0,'bounded batches eventually drain eligible children';
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=$1',v_daily_table) INTO v_current_revision USING v_old_daily;
    ASSERT v_current_revision=0,'provider bucket ending before UTC floor is removed';
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=$1',v_daily_table) INTO v_current_revision USING v_kept_daily;
    ASSERT v_current_revision=1,'provider bucket overlapping UTC floor survives';
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=$1',v_profile_table) INTO v_current_revision USING (v_exact_profile->>'observation_id')::uuid;
    ASSERT v_current_revision=1,'profile observation exactly on floor survives';
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=$1',v_post_table) INTO v_current_revision USING v_old_post;
    ASSERT v_current_revision=0,'post captured before the UTC floor date is removed';
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=$1',v_post_table) INTO v_current_revision USING v_kept_post;
    ASSERT v_current_revision=1,'post captured on the UTC floor date survives';
    EXECUTE format('SELECT count(*) FROM public.%s_analytics_period_totals WHERE id=$1',v_prefix) INTO v_current_revision USING v_old_total;
    ASSERT v_current_revision=0,'expired exact total with old capture is removed';
    EXECUTE format('SELECT count(*) FROM public.%s_analytics_period_totals WHERE id IN ($1,$2)',v_prefix) INTO v_current_revision USING v_overlap_total,v_new_total;
    ASSERT v_current_revision=2,'overlapping exact total and newer capture of an expired window both survive';
    IF v_platform='threads' THEN
      ASSERT EXISTS(SELECT 1 FROM public.threads_account_profile_observations o JOIN public.threads_analytics_metric_values m ON m.profile_observation_id=o.id
        JOIN public.threads_analytics_captures c ON c.id=m.capture_id JOIN public.threads_analytics_collection_operations op ON op.id=c.operation_id
        JOIN public.threads_analytics_collection_jobs j ON j.id=op.job_id WHERE o.id=(v_anchor->>'observation_id')::uuid AND m.value=0),
        'deterministic valid pre-floor anchor and its entire dependency chain survive';
      ASSERT NOT EXISTS(SELECT 1 FROM public.threads_account_profile_observations WHERE id='6eeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'),
        'older tie is not retained as a second anchor';
    END IF;
    EXECUTE format('SELECT report_revision FROM public.%s_analytics_report_state WHERE social_account_id=$1',v_prefix) INTO v_revision USING v_account;
    EXECUTE format('SELECT public.cleanup_%s_analytics_history($1,$2,$3,500,false)',v_prefix) INTO v_result USING v_owner,v_account,v_floor;
    ASSERT (v_result->>'deleted')::integer=0 AND (v_result->>'report_revision')::bigint=v_revision,'no-op cleanup preserves report revision';
  END LOOP;
END;
$bounded_independent_retention$;

SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"61000000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
DO $owner_boundary$
DECLARE v_request jsonb;v_report jsonb;v_date date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  v_request:=jsonb_build_object('since',(v_date-7)::timestamp AT TIME ZONE 'America/Los_Angeles','until',v_date::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_report:=public.read_threads_analytics_history('61000000-0000-4000-8000-000000000002','63000000-0000-4000-8000-000000000001',v_request);
  ASSERT v_report->>'ok'='true','JWT identity wins over different body user';
  BEGIN
    PERFORM public.read_threads_analytics_history('61000000-0000-4000-8000-000000000002','63000000-0000-4000-8000-000000000002',v_request);
    RAISE EXCEPTION 'foreign owner history exposed';
  EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
  BEGIN
    PERFORM public.meta_analytics_fb_guarded('62000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'foreign guard lookup silently returned false';
  EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
  BEGIN
    PERFORM 1 FROM public.threads_analytics_metric_values;
    RAISE EXCEPTION 'browser read private metric rows';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$owner_boundary$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
\echo ALL CHECKS PASSED: meta_owned_analytics_history
