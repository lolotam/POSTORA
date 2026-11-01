-- A partial target must yield to an unvisited target with the same due date.
-- Both platforms use real ownership, permission, claim and completion RPCs.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email) VALUES
 ('71000000-0000-4000-8000-000000000001','meta-fairness-one@example.invalid'),
 ('71000000-0000-4000-8000-000000000002','meta-fairness-two@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
 ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','facebook','992001','synthetic-page-one',true,false),
 ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','facebook','992002','synthetic-page-two',true,false),
 ('73000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','threads','993001','synthetic-threads-one',true,false),
 ('73000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','threads','993002','synthetic-threads-two',true,false);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES
 ('75000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','synthetic-user-one','991001','oauth_exchange',clock_timestamp()),
 ('75000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','synthetic-user-two','991002','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES
 ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','facebook'),
 ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source) VALUES
 ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','facebook','75000000-0000-4000-8000-000000000001','991001','oauth_exchange'),
 ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','facebook','75000000-0000-4000-8000-000000000002','991002','oauth_exchange');
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["72000000-0000-4000-8000-000000000001","72000000-0000-4000-8000-000000000002"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["73000000-0000-4000-8000-000000000001","73000000-0000-4000-8000-000000000002"]}'::jsonb WHERE key='collection_threads_analytics_policy';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;

DO $fairness$
DECLARE v_family text;v_platform text;v_accounts uuid[];v_owners uuid[]:=ARRAY['71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002']::uuid[];
  v_scopes text[];v_provider_ids text[];v_authority jsonb;v_first jsonb;v_second jsonb;v_old jsonb;v_index integer;
  v_due date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  FOR v_family,v_platform,v_accounts,v_provider_ids,v_scopes IN VALUES
    ('fb','facebook',ARRAY['72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002']::uuid[],ARRAY['992001','992002'],ARRAY['read_insights','pages_read_engagement']),
    ('threads','threads',ARRAY['73000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002']::uuid[],ARRAY['993001','993002'],ARRAY['threads_basic','threads_manage_insights']) LOOP
    FOR v_index IN 1..2 LOOP
      EXECUTE format('SELECT public.prepare_%s_analytics_account($1,$2)',v_family) INTO v_authority USING v_owners[v_index],v_accounts[v_index];
      EXECUTE format('SELECT public.observe_%s_analytics_permissions($1,$2,$3,$4,$5,$6,$7)',v_family)
        USING v_owners[v_index],v_accounts[v_index],v_authority->'authority',v_scopes,v_provider_ids[v_index],clock_timestamp(),'verified';
      EXECUTE format('SELECT public.enqueue_%s_analytics_collection_job($1,$2,$3)',v_family) USING v_owners[v_index],v_accounts[v_index],v_due;
    END LOOP;
    EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_family) INTO v_first;
    ASSERT jsonb_array_length(v_first)=1,'first fair claim exists';v_first:=v_first->0;
    EXECUTE format('SELECT public.complete_%s_analytics_collection_job($1,$2,$3,$4,$5)',v_family)
      USING (v_first->>'job_id')::uuid,(v_first->>'claim_token')::uuid,(v_first->>'job_generation')::bigint,'partial','budget_yielded';
    EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_family) INTO v_second;
    ASSERT jsonb_array_length(v_second)=1,'unvisited target remains claimable';v_second:=v_second->0;
    ASSERT v_second->>'job_id'<>v_first->>'job_id',v_platform||': a partial target starved an unvisited target';
    ASSERT v_second->>'account_id'<>v_first->>'account_id',v_platform||': scheduling must yield across owners/accounts';
    -- Due-date priority still wins over least-recently-served ordering.
    EXECUTE format('SELECT public.enqueue_%s_analytics_collection_job($1,$2,$3)',v_family) USING v_owners[1],v_accounts[1],v_due-1;
    EXECUTE format('SELECT public.claim_%s_analytics_collection_jobs(1)',v_family) INTO v_old;
    ASSERT jsonb_array_length(v_old)=1 AND v_old#>>'{0,due_on}'=(v_due-1)::text,'earlier due work retains priority';
  END LOOP;
END;
$fairness$;
ROLLBACK;
\echo ALL CHECKS PASSED: owned analytics claim fairness
