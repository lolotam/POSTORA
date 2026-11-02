\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email) VALUES ('d8000000-0000-4000-8000-000000000001','snapshot-owner@example.invalid'),('d8000000-0000-4000-8000-000000000002','snapshot-other@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active) VALUES
 ('d9000000-0000-4000-8000-000000000001','d8000000-0000-4000-8000-000000000001','instagram','799001','fixture-private-token',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','d8000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"d8000000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
DO $proof$
DECLARE result jsonb;
BEGIN
 result:=public.read_instagram_owner_report_snapshot('d8000000-0000-4000-8000-000000000002','d9000000-0000-4000-8000-000000000001',clock_timestamp());
 ASSERT result->'media'='[]'::jsonb AND result->'daily'='[]'::jsonb AND result->'profiles'='[]'::jsonb;
 ASSERT result->'collection'='null'::jsonb;
 ASSERT result::text NOT LIKE '%token%' AND result::text NOT LIKE '%fixture-private%';
END;$proof$;
RESET ROLE;
-- Mutable control state updated after the cutoff cannot describe older data
-- as newly complete, even within one otherwise coherent MVCC statement.
INSERT INTO public.instagram_collection_jobs(id,user_id,target_kind,target_id,social_account_id,captured_on,status,
  created_at,updated_at,last_attempt_at,last_success_at,last_partial_at) VALUES
 ('da000000-0000-4000-8000-000000000001','d8000000-0000-4000-8000-000000000001','owner',
  'd9000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000001',current_date,'completed',
  clock_timestamp()-interval '30 seconds',clock_timestamp()+interval '1 day',
  clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day');
SET LOCAL ROLE authenticated;
DO $cutoff$
DECLARE result jsonb;
BEGIN
 result:=public.read_instagram_owner_report_snapshot(NULL,'d9000000-0000-4000-8000-000000000001',clock_timestamp());
 ASSERT result->'collection'='null'::jsonb,'future control state is not exposed';
END;$cutoff$;
RESET ROLE;
UPDATE public.instagram_collection_jobs SET updated_at=clock_timestamp()-interval '5 seconds',
  last_attempt_at=clock_timestamp()-interval '5 seconds',last_success_at=clock_timestamp()-interval '5 seconds',
  last_partial_at=clock_timestamp()-interval '5 seconds' WHERE id='da000000-0000-4000-8000-000000000001';
INSERT INTO public.instagram_collection_jobs(id,user_id,target_kind,target_id,social_account_id,captured_on,status,
  created_at,updated_at,last_attempt_at,last_success_at,last_partial_at) VALUES
 ('da000000-0000-4000-8000-000000000002','d8000000-0000-4000-8000-000000000001','owner',
  'd9000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000001',current_date+1,'completed',
  clock_timestamp()-interval '30 seconds',clock_timestamp()-interval '5 seconds',clock_timestamp()-interval '5 seconds',
  clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day');
INSERT INTO public.instagram_collection_job_checkpoints(job_id,user_id,job_generation,inventory_window_covered,updated_at) VALUES
 ('da000000-0000-4000-8000-000000000001','d8000000-0000-4000-8000-000000000001',1,true,clock_timestamp()+interval '1 day');
SET LOCAL ROLE authenticated;
DO $cutoff$
DECLARE result jsonb; cutoff timestamptz:=clock_timestamp();
BEGIN
 result:=public.read_instagram_owner_report_snapshot(NULL,'d9000000-0000-4000-8000-000000000001',cutoff);
 ASSERT (result->'collection'->>'last_success_at')::timestamptz<=cutoff AND (result->'collection'->>'last_partial_at')::timestamptz<=cutoff,'future aggregate timestamps are excluded';
 ASSERT result->'collection'->'inventory'->'window_covered'='false'::jsonb,'future checkpoints cannot mark older data covered';
END;$cutoff$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $proof$ BEGIN
 BEGIN PERFORM public.read_instagram_owner_report_snapshot('d8000000-0000-4000-8000-000000000002','d9000000-0000-4000-8000-000000000001',clock_timestamp());
 RAISE EXCEPTION 'foreign read succeeded'; EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
END;$proof$;
RESET ROLE;
INSERT INTO public.ig_account_profile_observations(user_id,social_account_id,observed_at,observed_on,followers_count)
 SELECT 'd8000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000001',
   clock_timestamp()-i*interval '1 minute',current_date,0 FROM generate_series(1,20000) i;
DO $bound$
DECLARE result jsonb;
BEGIN
 result:=public.read_instagram_owner_report_snapshot('d8000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000001',clock_timestamp());
 ASSERT jsonb_array_length(result->'profiles')=20000,'a JSON snapshot bypasses the REST row cap without dropping history';
END;$bound$;
INSERT INTO public.ig_account_profile_observations(user_id,social_account_id,observed_at,observed_on,followers_count)
 VALUES ('d8000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000001',clock_timestamp()-interval '30000 minutes',current_date,0);
DO $bound$ BEGIN
 BEGIN PERFORM public.read_instagram_owner_report_snapshot('d8000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000001',clock_timestamp());
 RAISE EXCEPTION 'overflow silently returned a prefix'; EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL; END;
END;$bound$;
DO $acl$ BEGIN
 ASSERT NOT has_function_privilege('anon','public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz)','EXECUTE');
 ASSERT has_function_privilege('authenticated','public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz)','EXECUTE');
END;$acl$;
ROLLBACK;
\echo 'instagram_report_snapshot: ALL CHECKS PASSED'
