-- Synthetic SQL-owner fixtures; reader identity comes from service-role claims.
-- Both platforms: current authority, checkpoint provenance, fences and mixed captures.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email) VALUES
 ('b1000000-0000-4000-8000-000000000001','meta-dispatch-one@example.invalid'),
 ('b1000000-0000-4000-8000-000000000002','meta-dispatch-two@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
SELECT ('b3000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
  CASE WHEN i%2=0 THEN 'b1000000-0000-4000-8000-000000000002'::uuid ELSE 'b1000000-0000-4000-8000-000000000001'::uuid END,
  'threads',(780000+i)::text,'fixture-threads',true,false FROM generate_series(1,1) i;
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook','784001','fixture-page',true,false);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES
 ('b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','fixture-user','785001','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook','b5000000-0000-4000-8000-000000000001','785001','oauth_exchange');

INSERT INTO public.threads_analytics_connection_fences(social_account_id,user_id,platform)
SELECT id,user_id,platform FROM public.social_accounts WHERE id='b3000000-0000-4000-8000-000000000001';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
DO $test$
DECLARE v_platform text;v_prefix text;v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid;
  v_old uuid;v_new uuid;v_operation uuid;v_capture uuid;v_authority jsonb;v_request jsonb;v_report jsonb;
  v_tail uuid;v_fence text;
  v_profile uuid;v_when timestamptz;
  v_day date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_version text;
BEGIN
  v_request:=jsonb_build_object('since',(v_day-7)::timestamp AT TIME ZONE 'America/Los_Angeles',
    'until',v_day::timestamp AT TIME ZONE 'America/Los_Angeles');
  FOREACH v_platform IN ARRAY ARRAY['facebook','threads'] LOOP
    v_prefix:=CASE v_platform WHEN 'facebook' THEN 'fb' ELSE 'threads' END;
    v_version:=CASE v_platform WHEN 'facebook' THEN 'v25.0' ELSE 'v1.0' END;
    v_account:=CASE v_platform WHEN 'facebook' THEN 'b4000000-0000-4000-8000-000000000001'::uuid
      ELSE 'b3000000-0000-4000-8000-000000000001'::uuid END;
    v_old:=gen_random_uuid();v_new:=gen_random_uuid();v_operation:=gen_random_uuid();v_capture:=gen_random_uuid();
    v_authority:=public.meta_analytics_current_authority(v_platform,v_account,v_owner);
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'='{"complete":false,"truncated":false,"state":"unknown","source":null}'::jsonb) IS TRUE,'no source is unknown';
    EXECUTE format($sql$INSERT INTO public.%I(id,user_id,social_account_id,due_on,due_at,next_due_at,credential_authority)
      VALUES($1,$2,$3,$4,$4::timestamp AT TIME ZONE 'America/Los_Angeles',($4+1)::timestamp AT TIME ZONE 'America/Los_Angeles',$5)$sql$,
      v_prefix||'_analytics_collection_jobs') USING v_old,v_owner,v_account,v_day-2,v_authority;
    EXECUTE format('INSERT INTO public.%I(job_id,user_id,social_account_id,job_generation,inventory_complete) VALUES($1,$2,$3,1,true)',
      v_prefix||'_analytics_collection_checkpoints') USING v_old,v_owner,v_account;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='complete') IS TRUE,'authoritative newest own checkpoint';
    ASSERT (v_report->'inventory'->'source'->>'checkpoint_updated_at' IS NOT NULL) IS TRUE,'checkpoint time is explicit';
    EXECUTE format($sql$INSERT INTO public.%I(id,user_id,social_account_id,due_on,due_at,next_due_at)
      VALUES($1,$2,$3,$4,$4::timestamp AT TIME ZONE 'America/Los_Angeles',($4+1)::timestamp AT TIME ZONE 'America/Los_Angeles')$sql$,
      v_prefix||'_analytics_collection_jobs') USING v_new,v_owner,v_account,v_day-1;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->'source'->>'job_id'=v_old::text) IS TRUE,'never-claimed first generation may fall back';
    v_tail:=gen_random_uuid();
    EXECUTE format($sql$INSERT INTO public.%I(id,user_id,social_account_id,due_on,due_at,next_due_at)
      VALUES($1,$2,$3,$4,$4::timestamp AT TIME ZONE 'America/Los_Angeles',($4+1)::timestamp AT TIME ZONE 'America/Los_Angeles')$sql$,
      v_prefix||'_analytics_collection_jobs') USING v_tail,v_owner,v_account,v_day;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='complete' AND v_report->'inventory'->'source'->>'job_id'=v_old::text) IS TRUE,
      'consecutive pristine jobs preserve older authoritative checkpoint coverage';
    FOREACH v_fence IN ARRAY ARRAY['failed','running','forced'] LOOP
      EXECUTE format('UPDATE public.%I SET state=$2,attempts=$3,job_generation=$4,credential_authority=NULL,
        claim_token=CASE WHEN $2=''running'' THEN gen_random_uuid() ELSE NULL END,
        lease_until=CASE WHEN $2=''running'' THEN clock_timestamp()+interval ''1 minute'' ELSE NULL END WHERE id=$1',
        v_prefix||'_analytics_collection_jobs') USING v_new,CASE WHEN v_fence='forced' THEN 'pending' ELSE v_fence END,
        CASE WHEN v_fence='forced' THEN 0 ELSE 1 END,CASE WHEN v_fence='forced' THEN 2 ELSE 1 END;
      v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
      ASSERT (v_report->'inventory'->>'state'='unknown' AND v_report->'inventory'->'source'='null'::jsonb) IS TRUE,
        'an intervening failed, claimed or forced job fences older coverage';
    END LOOP;
    EXECUTE format('DELETE FROM public.%I WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_tail;
    EXECUTE format('UPDATE public.%I SET job_generation=1,attempts=0,state=''pending'',credential_authority=NULL WHERE id=$1',
      v_prefix||'_analytics_collection_jobs') USING v_new;
    EXECUTE format('UPDATE public.%I SET attempts=1,state=''running'',credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new,v_authority;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='unknown') IS TRUE,'claimed newest without own checkpoint cannot fall back';
    EXECUTE format('UPDATE public.%I SET attempts=0,state=''pending'',credential_authority=NULL WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new;
    EXECUTE format('UPDATE public.%I SET job_generation=2 WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='unknown') IS TRUE,'force cannot fall back';
    EXECUTE format('UPDATE public.%I SET job_generation=1,credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new,v_authority;
    EXECUTE format('INSERT INTO public.%I(job_id,user_id,social_account_id,job_generation,inventory_complete) VALUES($1,$2,$3,1,true)',
      v_prefix||'_analytics_collection_checkpoints') USING v_new,v_owner,v_account;
    EXECUTE format('UPDATE public.%I SET credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_collection_jobs')
      USING v_new,v_authority||'{"fixture_other_authority":true}'::jsonb;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='unknown') IS TRUE,'newest own checkpoint after authority change is not trusted';
    EXECUTE format('UPDATE public.%I SET credential_authority=NULL WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='unknown') IS TRUE,'null authority never proves a match';
    EXECUTE format('UPDATE public.%I SET credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new,v_authority;
    UPDATE public.social_accounts SET needs_reauth=true WHERE id=v_account;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='unknown') IS TRUE,'missing current authority remains readable but unknown';
    UPDATE public.social_accounts SET needs_reauth=false WHERE id=v_account;
    v_authority:=public.meta_analytics_current_authority(v_platform,v_account,v_owner);
    EXECUTE format('UPDATE public.%I SET credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new,v_authority;
    EXECUTE format($sql$INSERT INTO public.%I(id,job_id,user_id,social_account_id,job_generation,operation_key,kind,requested_metrics)
      VALUES($1,$2,$3,$4,1,'fixture-post','post',ARRAY['views'])$sql$,v_prefix||'_analytics_collection_operations')
      USING v_operation,v_new,v_owner,v_account;
    EXECUTE format($sql$INSERT INTO public.%I(id,job_id,operation_id,job_generation,claim_token,user_id,social_account_id,
      capture_sequence,kind,subject_id,api_version,requested_metrics,credential_authority,requested_at,received_at,payload_digest,receipt)
      VALUES($1,$2,$3,1,gen_random_uuid(),$4,$5,1,'post','shared-post',$6,ARRAY['views'],$7,transaction_timestamp(),transaction_timestamp(),repeat('a',64),'{}')$sql$,v_prefix||'_analytics_captures')
      USING v_capture,v_new,v_operation,v_owner,v_account,v_version,v_authority||'{"fixture_other_authority":true}'::jsonb;
    EXECUTE format($sql$INSERT INTO public.%I(user_id,social_account_id,platform_post_id,captured_on,published_at,metadata_capture_id)
      VALUES($1,$2,'shared-post',$3,$3::timestamp AT TIME ZONE 'America/Los_Angeles',$4)$sql$,v_prefix||'_post_insight_snapshots')
      USING v_owner,v_account,v_day-1,v_capture;
    EXECUTE format('UPDATE public.%I SET post_ids=ARRAY[''shared-post''] WHERE job_id=$1',v_prefix||'_analytics_collection_checkpoints') USING v_new;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (jsonb_array_length(v_report->'posts')=1) IS TRUE,'the same post ID is actually presented';
    ASSERT (v_report->'inventory'->>'state'='incomplete') IS TRUE,'matching post IDs under another capture authority do not prove coverage';
    EXECUTE format('UPDATE public.%I SET credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_captures') USING v_capture,v_authority;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='complete') IS TRUE,'matching capture authority and checkpoint IDs prove checkpoint coverage';
    -- A historical profile cell remains visible; conservative coverage checks its authority too.
    v_operation:=gen_random_uuid();v_capture:=gen_random_uuid();v_profile:=gen_random_uuid();
    v_when:=(v_day-7)::timestamp AT TIME ZONE 'America/Los_Angeles';
    EXECUTE format($sql$INSERT INTO public.%I(id,job_id,user_id,social_account_id,job_generation,operation_key,kind,requested_metrics)
      VALUES($1,$2,$3,$4,1,'fixture-profile','profile',ARRAY['followers'])$sql$,v_prefix||'_analytics_collection_operations')
      USING v_operation,v_new,v_owner,v_account;
    EXECUTE format($sql$INSERT INTO public.%I(id,job_id,operation_id,job_generation,claim_token,user_id,social_account_id,
      capture_sequence,kind,subject_id,api_version,requested_metrics,credential_authority,requested_at,received_at,payload_digest,receipt)
      VALUES($1,$2,$3,1,gen_random_uuid(),$4,$5,2,'profile','fixture-account',$6,ARRAY['followers'],$7,$8-interval '1 second',$8,repeat('b',64),'{}')$sql$,
      v_prefix||'_analytics_captures') USING v_capture,v_new,v_operation,v_owner,v_account,v_version,
      v_authority||'{"fixture_other_authority":true}'::jsonb,v_when;
    EXECUTE format('INSERT INTO public.%I(id,user_id,social_account_id,capture_id,observed_at) VALUES($1,$2,$3,$4,$5)',
      CASE v_platform WHEN 'facebook' THEN 'fb_page_profile_observations' ELSE 'threads_account_profile_observations' END)
      USING v_profile,v_owner,v_account,v_capture,v_when;
    EXECUTE format($sql$INSERT INTO public.%I(user_id,social_account_id,profile_observation_id,metric_key,status,value,reason,
      provider_metric,api_version,window_kind,source_ref,capture_id,observed_at)
      VALUES($1,$2,$3,'followers',$4,$5,$6,$7,$8,'point_in_time',$9,$10,$11)$sql$,v_prefix||'_analytics_metric_values')
      USING v_owner,v_account,v_profile,
      CASE WHEN v_platform='facebook' THEN 'unavailable' ELSE 'available' END,
      CASE WHEN v_platform='facebook' THEN NULL::bigint ELSE 12::bigint END,
      CASE WHEN v_platform='facebook' THEN 'not_offered' ELSE NULL END,
      public.meta_analytics_provider_metric(v_platform,'account','followers','point_in_time'),
      v_version,CASE v_platform WHEN 'facebook' THEN 'meta_graph_v25' ELSE 'threads_graph_v1' END,v_capture,v_when;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (jsonb_array_length(v_report->'profile_boundaries')>0 AND jsonb_array_length(v_report->'posts')=1) IS TRUE,'history and current post remain presented';
    ASSERT (v_report->'inventory'->>'state'='incomplete') IS TRUE,'historical profile authority mismatch refuses all-presented coverage, not history';
    EXECUTE format('UPDATE public.%I SET credential_authority=$2 WHERE id=$1',v_prefix||'_analytics_captures') USING v_capture,v_authority;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='complete') IS TRUE,'same-authority historical profile and current post restore coverage';
    EXECUTE format('UPDATE public.%I SET post_ids=ARRAY[]::text[] WHERE job_id=$1',v_prefix||'_analytics_collection_checkpoints') USING v_new;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='incomplete') IS TRUE,'presented post outside checkpoint inventory is not covered';
    EXECUTE format('UPDATE public.%I SET inventory_truncated=true WHERE job_id=$1',v_prefix||'_analytics_collection_checkpoints') USING v_new;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='truncated' AND v_report->'inventory'->>'complete'='false') IS TRUE,'truncated remains incomplete';
    EXECUTE format('UPDATE public.%I SET job_generation=2 WHERE id=$1',v_prefix||'_analytics_collection_jobs') USING v_new;
    v_report:=public.read_meta_owned_analytics_history(v_platform,v_owner,v_account,v_request);
    ASSERT (v_report->'inventory'->>'state'='unknown') IS TRUE,'superseded own checkpoint cannot substitute for current generation';
  END LOOP;
  ASSERT (NOT has_function_privilege('anon','public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb)','EXECUTE')) IS TRUE;
  ASSERT (has_function_privilege('authenticated','public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb)','EXECUTE')) IS TRUE;
  ASSERT (has_function_privilege('service_role','public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb)','EXECUTE')) IS TRUE;
END;
$test$;
RESET ROLE;
ROLLBACK;
\echo 'meta_owned_inventory_checkpoint_coverage: ALL CHECKS PASSED'
