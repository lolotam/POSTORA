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
DO $inventory$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b4000000-0000-4000-8000-000000000001';
  v_authority jsonb;v_job jsonb;v_state jsonb;v_page jsonb;v_reply jsonb;v_request uuid;v_ids text[];v_more text[];
BEGIN
  v_authority:=public.prepare_fb_analytics_account(v_owner,v_account);
  PERFORM public.observe_fb_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
  ASSERT v_job->>'account_id'=v_account::text,'fixture claims exact owned account';
  v_state:=public.read_fb_analytics_worker_state((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint);
  ASSERT v_state->'checkpoint'->'post_ids'='[]'::jsonb AND v_state->'operations'='[]'::jsonb,'empty checkpoint is an explicit real state';
  v_page:=public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,NULL,0);
  v_request:=(v_page->>'request_id')::uuid;
  ASSERT public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,NULL,0)=v_page,'pending reservation is idempotent';
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,gen_random_uuid(),ARRAY[]::text[],NULL,false);
    RAISE EXCEPTION 'unreserved response accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  v_reply:=public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,v_request,ARRAY[]::text[],'cursor_1',true);
  ASSERT (v_reply->>'pages_fetched')::integer=1 AND NOT (v_reply->>'inventory_complete')::boolean,'next page cannot be completed';
  ASSERT public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,v_request,ARRAY[]::text[],'cursor_1',true)=v_reply,'identical replay has one receipt';
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,v_request,ARRAY[]::text[],NULL,false);
    RAISE EXCEPTION 'conflicting replay accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  BEGIN PERFORM public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,NULL,0);
    RAISE EXCEPTION 'stale expected position accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  v_page:=public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'cursor_1',1);
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY[]::text[],NULL,true);
    RAISE EXCEPTION 'missing next cursor accepted';EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;END;
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY[]::text[],'cursor_1',true);
    RAISE EXCEPTION 'repeated cursor accepted';EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;END;
  v_reply:=public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY[]::text[],NULL,false);
  ASSERT (v_reply->>'inventory_complete')::boolean,'actual provider exhaustion completes inventory';
  BEGIN PERFORM public.read_fb_analytics_worker_state((v_job->>'job_id')::uuid,gen_random_uuid(),(v_job->>'job_generation')::bigint);
    RAISE EXCEPTION 'foreign claim read accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_next');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
  SELECT array_agg('784001_'||i::text ORDER BY i) INTO v_ids FROM generate_series(1,475) i;
  SELECT array_agg('784001_'||i::text ORDER BY i) INTO v_more FROM generate_series(476,500) i;
  PERFORM public.checkpoint_fb_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',v_ids,19,false,false);
  v_page:=public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',19);
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY['999001_9001'],NULL,false);
    RAISE EXCEPTION 'foreign Page post accepted';EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;END;
  v_reply:=public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,v_more,'next_cursor',true);
  ASSERT (v_reply->>'inventory_complete')::boolean=false,'cap_more has truthful completion';
  ASSERT (v_reply->>'inventory_truncated')::boolean=NOT false,'cap_more has truthful truncation';

  PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_next');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
  SELECT array_agg('784001_'||i::text ORDER BY i) INTO v_ids FROM generate_series(1,475) i;
  SELECT array_agg('784001_'||i::text ORDER BY i) INTO v_more FROM generate_series(476,500) i;
  PERFORM public.checkpoint_fb_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',v_ids,19,false,false);
  v_page:=public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',19);
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY['999001_9001'],NULL,false);
    RAISE EXCEPTION 'foreign Page post accepted';EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;END;
  v_reply:=public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,v_more,NULL,false);
  ASSERT (v_reply->>'inventory_complete')::boolean=true,'exact_end has truthful completion';
  ASSERT (v_reply->>'inventory_truncated')::boolean=NOT true,'exact_end has truthful truncation';

  PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_next');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
  SELECT array_agg('784001_'||i::text ORDER BY i) INTO v_ids FROM generate_series(1,475) i;
  SELECT array_agg('784001_'||i::text ORDER BY i) INTO v_more FROM generate_series(476,500) i;
  v_ids:=ARRAY[]::text[];v_more:=ARRAY[]::text[];
  PERFORM public.checkpoint_fb_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',v_ids,99,false,false);
  v_page:=public.reserve_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',99);
  BEGIN PERFORM public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY['999001_9001'],NULL,false);
    RAISE EXCEPTION 'foreign Page post accepted';EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;END;
  v_reply:=public.commit_fb_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,v_more,'next_cursor',true);
  ASSERT (v_reply->>'inventory_complete')::boolean=false,'page_cap has truthful completion';
  ASSERT (v_reply->>'inventory_truncated')::boolean=NOT false,'page_cap has truthful truncation';

END;
$inventory$;
DO $inventory$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b3000000-0000-4000-8000-000000000001';
  v_authority jsonb;v_job jsonb;v_state jsonb;v_page jsonb;v_reply jsonb;v_request uuid;v_ids text[];v_more text[];
BEGIN
  v_authority:=public.prepare_threads_analytics_account(v_owner,v_account);
  PERFORM public.observe_threads_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],'780001',clock_timestamp(),'verified');
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
  ASSERT v_job->>'account_id'=v_account::text,'fixture claims exact owned account';
  v_state:=public.read_threads_analytics_worker_state((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint);
  ASSERT v_state->'checkpoint'->'post_ids'='[]'::jsonb AND v_state->'operations'='[]'::jsonb,'empty checkpoint is an explicit real state';
  v_page:=public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,NULL,0);
  v_request:=(v_page->>'request_id')::uuid;
  ASSERT public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,NULL,0)=v_page,'pending reservation is idempotent';
  BEGIN PERFORM public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,gen_random_uuid(),ARRAY[]::text[],NULL,false);
    RAISE EXCEPTION 'unreserved response accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  v_reply:=public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,v_request,ARRAY[]::text[],'cursor_1',true);
  ASSERT (v_reply->>'pages_fetched')::integer=1 AND NOT (v_reply->>'inventory_complete')::boolean,'next page cannot be completed';
  ASSERT public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,v_request,ARRAY[]::text[],'cursor_1',true)=v_reply,'identical replay has one receipt';
  BEGIN PERFORM public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,v_request,ARRAY[]::text[],NULL,false);
    RAISE EXCEPTION 'conflicting replay accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  BEGIN PERFORM public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,NULL,0);
    RAISE EXCEPTION 'stale expected position accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  v_page:=public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'cursor_1',1);
  BEGIN PERFORM public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY[]::text[],NULL,true);
    RAISE EXCEPTION 'missing next cursor accepted';EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;END;
  BEGIN PERFORM public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY[]::text[],'cursor_1',true);
    RAISE EXCEPTION 'repeated cursor accepted';EXCEPTION WHEN SQLSTATE 'MAH01' THEN NULL;END;
  v_reply:=public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,ARRAY[]::text[],NULL,false);
  ASSERT (v_reply->>'inventory_complete')::boolean,'actual provider exhaustion completes inventory';
  BEGIN PERFORM public.read_threads_analytics_worker_state((v_job->>'job_id')::uuid,gen_random_uuid(),(v_job->>'job_generation')::bigint);
    RAISE EXCEPTION 'foreign claim read accepted';EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL;END;
  PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_next');
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
  SELECT array_agg(''||i::text ORDER BY i) INTO v_ids FROM generate_series(1,475) i;
  SELECT array_agg(''||i::text ORDER BY i) INTO v_more FROM generate_series(476,500) i;
  PERFORM public.checkpoint_threads_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',v_ids,19,false,false);
  v_page:=public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',19);
  v_reply:=public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,v_more,'next_cursor',true);
  ASSERT (v_reply->>'inventory_complete')::boolean=false,'cap_more has truthful completion';
  ASSERT (v_reply->>'inventory_truncated')::boolean=NOT false,'cap_more has truthful truncation';

  PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_next');
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
  SELECT array_agg(''||i::text ORDER BY i) INTO v_ids FROM generate_series(1,475) i;
  SELECT array_agg(''||i::text ORDER BY i) INTO v_more FROM generate_series(476,500) i;
  PERFORM public.checkpoint_threads_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',v_ids,19,false,false);
  v_page:=public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',19);
  v_reply:=public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,v_more,NULL,false);
  ASSERT (v_reply->>'inventory_complete')::boolean=true,'exact_end has truthful completion';
  ASSERT (v_reply->>'inventory_truncated')::boolean=NOT true,'exact_end has truthful truncation';

  PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_next');
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);
  v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
  SELECT array_agg(''||i::text ORDER BY i) INTO v_ids FROM generate_series(1,475) i;
  SELECT array_agg(''||i::text ORDER BY i) INTO v_more FROM generate_series(476,500) i;
  v_ids:=ARRAY[]::text[];v_more:=ARRAY[]::text[];
  PERFORM public.checkpoint_threads_analytics_inventory((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',v_ids,99,false,false);
  v_page:=public.reserve_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'seed_cursor',99);
  v_reply:=public.commit_threads_analytics_inventory_page((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,(v_page->>'request_id')::uuid,v_more,'next_cursor',true);
  ASSERT (v_reply->>'inventory_complete')::boolean=false,'page_cap has truthful completion';
  ASSERT (v_reply->>'inventory_truncated')::boolean=NOT false,'page_cap has truthful truncation';

END;
$inventory$;
RESET ROLE;
ROLLBACK;

\echo "meta_owned_analytics_inventory: ALL CHECKS PASSED"
