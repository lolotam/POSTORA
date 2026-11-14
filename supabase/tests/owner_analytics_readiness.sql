\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email) VALUES
 ('e8110000-0000-4000-8000-000000000001','readiness-owner@example.invalid'),
 ('e8110000-0000-4000-8000-000000000002','readiness-other@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active) VALUES
 ('e8120000-0000-4000-8000-000000000001','e8110000-0000-4000-8000-000000000001','instagram','711001',repeat('fixture',3),true),
 ('e8120000-0000-4000-8000-000000000002','e8110000-0000-4000-8000-000000000001','facebook','711002',repeat('fixture',3),true);
INSERT INTO public.app_settings(key,value) VALUES
 ('collection_instagram_insights_enabled','true'),
 ('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'),
 ('collection_facebook_analytics_enabled','true'),('collection_facebook_analytics_policy','{"account_ids":[]}')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on,status,last_attempt_at,last_reason_code)
VALUES ('e8110000-0000-4000-8000-000000000001','owner','e8120000-0000-4000-8000-000000000001',
 'e8120000-0000-4000-8000-000000000001',current_date,'retry',now()-interval '9 days','capability_missing');

SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
CREATE FUNCTION pg_temp.readiness(p_platform text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE r jsonb; BEGIN
 IF p_platform='instagram' THEN
  r:=public.read_instagram_owner_report_snapshot('e8110000-0000-4000-8000-000000000001','e8120000-0000-4000-8000-000000000001',clock_timestamp());
 ELSE
  r:=public.read_meta_owned_analytics_history('facebook','e8110000-0000-4000-8000-000000000001','e8120000-0000-4000-8000-000000000002',
   jsonb_build_object('since',((now() AT TIME ZONE 'America/Los_Angeles')::date-7)::timestamp AT TIME ZONE 'America/Los_Angeles',
   'until',(now() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles'));
 END IF;
 RETURN r->'readiness';
END;$fn$;
DO $proof$
DECLARE r jsonb; p text; BEGIN
 FOREACH p IN ARRAY ARRAY['instagram','facebook'] LOOP
  r:=pg_temp.readiness(p);
  ASSERT r IS NOT NULL,'snapshot must expose readiness';
  ASSERT r#>>'{collection,reason_code}'='collection_not_eligible','policy precedes absent trusted authority';
  ASSERT r#>>'{connection,reason_code}'='bootstrap_required','independent connection evidence retained';
  ASSERT r#>>'{permission,state}'='unknown','missing capability never proves denied scopes';
  ASSERT r#>>'{collection,reconnect_can_help}'='false';
  ASSERT r#>>'{collection,next_action}'='contact_support';
  ASSERT r::text NOT LIKE '%fixture%' AND r::text NOT LIKE '%credential_id%' AND r::text NOT LIKE '%account_ids%';
 END LOOP;
 ASSERT pg_temp.readiness('instagram')#>>'{last_attempt,reason_code}'='capability_missing','history remains separate';
END;$proof$;
UPDATE public.app_settings SET value='{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'
 WHERE key='collection_instagram_rollout_policy';
DO $proof$ BEGIN ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='bootstrap_required'; END;$proof$;
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind,credential_generation)
VALUES ('e8120000-0000-4000-8000-000000000001','e8110000-0000-4000-8000-000000000001','direct',1);
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='permission_verification_pending';
 ASSERT pg_temp.readiness('instagram')#>>'{permission,state}'='unknown';
END;$proof$;
UPDATE public.instagram_account_capabilities SET permission_read_state='failed',last_read_failed_at=now()
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{permission,state}'='unavailable';
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='permission_verification_pending';
END;$proof$;
UPDATE public.instagram_account_capabilities SET permission_read_state='ok',scopes_read_at=now(),granted_scopes='{}'
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='permission_missing';
 ASSERT pg_temp.readiness('instagram')#>'{permission,missing_scopes}'='["instagram_business_manage_insights"]'::jsonb;
END;$proof$;
UPDATE public.instagram_account_capabilities SET granted_scopes=ARRAY['instagram_business_manage_insights']
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
UPDATE public.instagram_collection_jobs SET status='queued',last_reason_code=NULL
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='queued';
 ASSERT pg_temp.readiness('instagram')#>>'{permission,state}'='verified';
END;$proof$;
UPDATE public.app_settings SET value='{}' WHERE key='collection_instagram_rollout_policy';
DO $proof$ BEGIN ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='settings_unavailable'; END;$proof$;

UPDATE public.app_settings SET value='{"account_ids":["e8120000-0000-4000-8000-000000000002"]}' WHERE key='collection_facebook_analytics_policy';
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at)
VALUES ('e8130000-0000-4000-8000-000000000001','e8110000-0000-4000-8000-000000000001',repeat('synthetic',3),'711003','oauth_exchange',now());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform)
VALUES ('e8120000-0000-4000-8000-000000000002','e8110000-0000-4000-8000-000000000001','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source)
VALUES ('e8120000-0000-4000-8000-000000000002','e8110000-0000-4000-8000-000000000001','facebook',
 'e8130000-0000-4000-8000-000000000001','711003','oauth_exchange');
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='permission_verification_pending';
END;$proof$;
INSERT INTO public.fb_analytics_permission_observations(user_id,social_account_id,authority,granted_scopes,observed_at,state,source_ref)
VALUES ('e8110000-0000-4000-8000-000000000001','e8120000-0000-4000-8000-000000000002',
 public.meta_analytics_current_authority('facebook','e8120000-0000-4000-8000-000000000002','e8110000-0000-4000-8000-000000000001'),
 ARRAY['read_insights'],now(),'verified','meta_graph_v25');
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='permission_missing';
 ASSERT pg_temp.readiness('facebook')#>'{permission,missing_scopes}'='["pages_read_engagement"]'::jsonb;
END;$proof$;
UPDATE public.fb_analytics_permission_observations SET state='unavailable' WHERE social_account_id='e8120000-0000-4000-8000-000000000002';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{permission,state}'='unavailable';
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='permission_verification_pending';
END;$proof$;
UPDATE public.fb_analytics_permission_observations SET state='verified',granted_scopes=ARRAY['read_insights','pages_read_engagement']
 WHERE social_account_id='e8120000-0000-4000-8000-000000000002';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{permission,state}'='verified';
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='awaiting_first_capture';
END;$proof$;
UPDATE public.facebook_user_credentials SET revision=revision+1 WHERE id='e8130000-0000-4000-8000-000000000001';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{permission,state}'='unknown','stale authority cannot prove denied permissions';
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='permission_verification_pending';
END;$proof$;

-- Real grants and authenticated identity, including a forged body owner.
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','e8110000-0000-4000-8000-000000000002',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"e8110000-0000-4000-8000-000000000002"}',true);
SET LOCAL ROLE authenticated;
DO $proof$ BEGIN
 BEGIN PERFORM public.read_instagram_owner_report_snapshot('e8110000-0000-4000-8000-000000000001','e8120000-0000-4000-8000-000000000001',now());
  RAISE EXCEPTION 'foreign snapshot succeeded'; EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
 BEGIN PERFORM public.read_meta_owned_analytics_history('facebook','e8110000-0000-4000-8000-000000000001','e8120000-0000-4000-8000-000000000002',
  '{"since":"2026-11-01T07:00:00Z","until":"2026-11-08T08:00:00Z"}');
  RAISE EXCEPTION 'foreign Facebook snapshot succeeded'; EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
 ASSERT NOT has_function_privilege('anon','public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz)','EXECUTE');
 ASSERT NOT has_function_privilege('authenticated','public.owner_analytics_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb)','EXECUTE');
 ASSERT NOT has_function_privilege('service_role','public.owner_analytics_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb)','EXECUTE');
END;$proof$;
RESET ROLE;
ROLLBACK;
\echo 'owner_analytics_readiness: ALL CHECKS PASSED'
