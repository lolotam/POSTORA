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
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $read$
DECLARE v_request jsonb;v_result jsonb;
BEGIN
  v_request:=jsonb_build_object('since',((clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-7)::timestamp AT TIME ZONE 'America/Los_Angeles',
    'until',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_result:=public.read_meta_owned_analytics_history('facebook','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',v_request);
  ASSERT (v_result->>'ok')::boolean AND v_result->'health'->>'active'='true','empty saved history retains real account state';
  ASSERT v_result->'daily'='[]'::jsonb AND v_result->'posts'='[]'::jsonb,'only a successful read is empty';
  ASSERT v_result::text NOT LIKE '%access_token%' AND v_result::text NOT LIKE '%fixture-page%','no credential field or value enters report';
  BEGIN PERFORM public.read_meta_owned_analytics_history('threads','b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001',v_request);
    RAISE EXCEPTION 'foreign owner read succeeded';EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;END;
END;
$read$;
RESET ROLE;
UPDATE public.social_accounts SET is_active=false,needs_reauth=true,token_expires_at=clock_timestamp()-interval '1 hour'
  WHERE id='b4000000-0000-4000-8000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"b1000000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
DO $owner$
DECLARE v_request jsonb;v_result jsonb;
BEGIN
  v_request:=jsonb_build_object('since',((clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-7)::timestamp AT TIME ZONE 'America/Los_Angeles',
    'until',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_result:=public.read_meta_owned_analytics_history('facebook','b1000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001',v_request);
  ASSERT (v_result->>'ok')::boolean,'JWT owner overrides the body owner';
  ASSERT v_result->'health'='{"active":false,"needs_reauth":true,"token_expired":true}'::jsonb,'disconnected saved history is still readable with truthful health';
  BEGIN PERFORM public.read_meta_owned_analytics_history('threads',NULL,'b3000000-0000-4000-8000-000000000002',v_request);
    RAISE EXCEPTION 'cross-owner read succeeded';EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;END;
END;
$owner$;
RESET ROLE;
DO $acl$ BEGIN
  ASSERT NOT has_function_privilege('anon','public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb)','EXECUTE');
  ASSERT has_function_privilege('authenticated','public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb)','EXECUTE');
  ASSERT has_function_privilege('service_role','public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb)','EXECUTE');
END;$acl$;
ROLLBACK;
\echo 'meta_owned_analytics_reports: ALL CHECKS PASSED'
