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
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='bootstrap_required';
 ASSERT pg_temp.readiness('instagram')#>>'{collection,next_action}'='contact_support','bootstrap has no automatic completion path';
END;$proof$;
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
-- A retried old generation remains historical evidence, never a current blocker.
UPDATE public.instagram_collection_jobs SET status='retry',last_reason_code='provider_error',
 context_viewer_social_account_id='e8120000-0000-4000-8000-000000000001',context_login_kind='direct',context_credential_generation=1
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
DO $proof$ BEGIN ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='provider_error'; END;$proof$;
UPDATE public.instagram_account_capabilities SET credential_generation=2
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='awaiting_first_capture';
 ASSERT pg_temp.readiness('instagram')#>>'{last_attempt,reason_code}'='provider_error';
END;$proof$;
DO $proof$
DECLARE setting jsonb; BEGIN
 FOREACH setting IN ARRAY ARRAY['"true"'::jsonb,'" TRUE "'::jsonb] LOOP
  UPDATE public.app_settings SET value=setting WHERE key='collection_instagram_insights_enabled';
  ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='awaiting_first_capture','legacy enabled string is accepted by intake';
 END LOOP;
 FOREACH setting IN ARRAY ARRAY['"false"'::jsonb,'""'::jsonb,'null'::jsonb] LOOP
  UPDATE public.app_settings SET value=setting WHERE key='collection_instagram_insights_enabled';
  ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='collection_disabled';
 END LOOP;
 DELETE FROM public.app_settings WHERE key='collection_instagram_insights_enabled';
 ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='collection_disabled';
 INSERT INTO public.app_settings(key,value) VALUES ('collection_instagram_insights_enabled','true');
END;$proof$;
UPDATE public.app_settings SET value='{}' WHERE key='collection_instagram_rollout_policy';
DO $proof$ BEGIN ASSERT pg_temp.readiness('instagram')#>>'{collection,reason_code}'='settings_unavailable'; END;$proof$;

-- The legacy owner collector accepts migrated protected User bindings without
-- OAuth identity/fence evidence. Readiness must project that same authority.
UPDATE public.app_settings SET value='{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'
 WHERE key='collection_instagram_rollout_policy';
UPDATE public.instagram_account_capabilities SET login_kind='page_linked',granted_scopes=ARRAY['instagram_manage_insights']
 WHERE social_account_id='e8120000-0000-4000-8000-000000000001';
INSERT INTO public.facebook_user_credentials(id,user_id,token,provenance_source)
VALUES ('e8130000-0000-4000-8000-000000000003','e8110000-0000-4000-8000-000000000001',repeat('synthetic',3),'migrated_instagram_account_credential');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,evidence_source)
VALUES ('e8120000-0000-4000-8000-000000000001','e8110000-0000-4000-8000-000000000001','instagram',
 'e8130000-0000-4000-8000-000000000003','migrated_instagram_account_credential');
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('instagram')#>>'{connection,state}'='verified','supported migrated binding remains collectable';
END;$proof$;

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
-- A terminal provider refusal is current only while its captured authority matches.
INSERT INTO public.fb_analytics_collection_jobs(user_id,social_account_id,due_on,due_at,next_due_at,state,attempts,reason_code,credential_authority)
VALUES ('e8110000-0000-4000-8000-000000000001','e8120000-0000-4000-8000-000000000002',current_date,current_date::timestamp AT TIME ZONE 'America/Los_Angeles',(current_date+1)::timestamp AT TIME ZONE 'America/Los_Angeles',
 'failed',1,'permission_missing',public.meta_analytics_current_authority('facebook','e8120000-0000-4000-8000-000000000002','e8110000-0000-4000-8000-000000000001'));
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='permission_missing','current provider denial must not appear ready';
 ASSERT pg_temp.readiness('facebook')#>>'{permission,state}'='missing';
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_source}'='job';
 ASSERT pg_temp.readiness('facebook')#>'{permission,missing_scopes}'='[]'::jsonb,'never invent the denied scope names';
END;$proof$;
UPDATE public.fb_analytics_collection_jobs SET reason_code='reauth_required'
 WHERE social_account_id='e8120000-0000-4000-8000-000000000002';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='token_invalid','current provider token refusal is actionable';
 ASSERT pg_temp.readiness('facebook')#>>'{connection,state}'='invalid';
END;$proof$;
UPDATE public.fb_analytics_permission_observations SET state='unavailable',observed_at=clock_timestamp()
 WHERE social_account_id='e8120000-0000-4000-8000-000000000002';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='token_invalid','a failed verification cannot clear proven token refusal';
END;$proof$;
UPDATE public.fb_analytics_permission_observations SET state='verified',observed_at=clock_timestamp()
 WHERE social_account_id='e8120000-0000-4000-8000-000000000002';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='awaiting_first_capture','newer verification supersedes the refusal';
 ASSERT pg_temp.readiness('facebook')#>>'{last_attempt,reason_code}'='reauth_required','dated failure remains visible';
END;$proof$;
UPDATE public.facebook_user_credentials SET revision=revision+1 WHERE id='e8130000-0000-4000-8000-000000000001';
DO $proof$ BEGIN
 ASSERT pg_temp.readiness('facebook')#>>'{permission,state}'='unknown','stale authority cannot prove denied permissions';
 ASSERT pg_temp.readiness('facebook')#>>'{collection,reason_code}'='permission_verification_pending';
END;$proof$;

-- One precedence table drives SQL assertions AND the TypeScript projection in
-- admissionIntegration.test.ts. Every snapshot below comes from the real SQL.
CREATE TEMP TABLE readiness_precedence_cases(
 name text, platform text, policy text, connection text, proof text, proof_age interval,
 attempt_state text, attempt_reason text, context_current boolean, expected text,
 expected_permission text, snapshot jsonb
);
INSERT INTO readiness_precedence_cases(name,platform,policy,connection,proof,proof_age,attempt_state,attempt_reason,context_current,expected,expected_permission)
SELECT platform||':'||name,platform,policy,connection,proof,proof_age::interval,
 CASE WHEN attempt_state='terminal' THEN CASE platform WHEN 'instagram' THEN 'unavailable' ELSE 'failed' END ELSE attempt_state END,
 CASE attempt_reason WHEN 'scope' THEN CASE platform WHEN 'instagram' THEN 'scope_missing' ELSE 'permission_missing' END
 WHEN 'token' THEN CASE platform WHEN 'instagram' THEN 'token_invalid' ELSE 'reauth_required' END ELSE attempt_reason END,
 context_current,expected,expected_permission
FROM (VALUES
 ('disabled denial','disabled','valid','verified','2 hours','terminal','scope',true,'collection_disabled','missing'),
 ('excluded denial','excluded','valid','verified','2 hours','terminal','scope',true,'collection_not_eligible','missing'),
 ('invalid settings denial','invalid','valid','verified','2 hours','terminal','scope',true,'settings_unavailable','missing'),
 ('disabled token','disabled','valid','verified','2 hours','terminal','token',true,'collection_disabled','verified'),
 ('live connection','all','invalid','verified','2 hours','retry','provider_error',true,'token_invalid','verified'),
 ('reconnect with scope refusal','all','invalid','verified','2 hours','terminal','scope',true,'token_invalid','missing'),
 ('disabled reconnect with scope refusal','disabled','invalid','verified','2 hours','terminal','scope',true,'collection_disabled','missing'),
 ('excluded reconnect with scope refusal','excluded','invalid','verified','2 hours','terminal','scope',true,'collection_not_eligible','missing'),
 ('invalid settings reconnect with scope refusal','invalid','invalid','verified','2 hours','terminal','scope',true,'settings_unavailable','missing'),
 ('reconnect with failed read and scope refusal','all','invalid','unavailable','30 minutes','terminal','scope',true,'token_invalid','missing'),
 ('reconnect with newer verification','all','invalid','verified','30 minutes','terminal','scope',true,'token_invalid','verified'),
 ('reconnect with rotated scope refusal','all','invalid','verified','2 hours','terminal','scope',false,'token_invalid','verified'),
 ('reconnect with future scope refusal','all','invalid','verified','2 hours','terminal','scope',true,'token_invalid','verified'),
 ('reconnect with nonterminal scope refusal','all','invalid','verified','2 hours','retry','scope',true,'token_invalid','verified'),
 ('reconnect with named missing scope','all','invalid','missing','30 minutes','terminal','token',true,'token_invalid','missing'),
 ('disabled with granted scopes','disabled','valid','verified','30 minutes','retry','provider_error',true,'collection_disabled','verified'),
 ('excluded with named missing scope','excluded','valid','missing','30 minutes','retry','provider_error',true,'collection_not_eligible','missing'),
 ('current scope refusal','all','valid','verified','2 hours','terminal','scope',true,'permission_missing','missing'),
 ('current token refusal','all','valid','verified','2 hours','terminal','token',true,'token_invalid','verified'),
 ('failed read cannot clear scope','all','valid','unavailable','30 minutes','terminal','scope',true,'permission_missing','missing'),
 ('failed read cannot clear token','all','valid','unavailable','30 minutes','terminal','token',true,'token_invalid','unavailable'),
 ('new verification clears scope','all','valid','verified','30 minutes','terminal','scope',true,'awaiting_first_capture','verified'),
 ('new verification clears token','all','valid','verified','30 minutes','terminal','token',true,'awaiting_first_capture','verified'),
 ('rotated scope is historical','all','valid','verified','2 hours','terminal','scope',false,'awaiting_first_capture','verified'),
 ('rotated token is historical','all','valid','verified','2 hours','terminal','token',false,'awaiting_first_capture','verified'),
 ('missing named scope','all','valid','missing','30 minutes','retry','provider_error',true,'permission_missing','missing'),
 ('failed permission read','all','valid','unavailable','30 minutes','retry','provider_error',true,'permission_verification_pending','unavailable'),
 ('scheduled rate limit','all','valid','verified','30 minutes','retry','rate_limited',true,'rate_limited','verified'),
 ('scheduled provider retry','all','valid','verified','30 minutes','retry','provider_error',true,'provider_error','verified'),
 ('obsolete retry','all','valid','verified','30 minutes','retry','provider_error',false,'awaiting_first_capture','verified'),
 ('queued work','all','valid','verified','30 minutes','queued',NULL,false,'queued','verified'),
 ('running work','all','valid','verified','30 minutes','running',NULL,true,'running','verified')
) AS scenario(name,policy,connection,proof,proof_age,attempt_state,attempt_reason,context_current,expected,expected_permission)
CROSS JOIN (VALUES ('instagram'),('facebook')) AS platforms(platform);
-- At 12:00 UTC the LA day started at 08:00. A 10-hour-old verification
-- supersedes an 11-hour-old refusal even though neither is fresh today.
INSERT INTO readiness_precedence_cases(name,platform,policy,connection,proof,proof_age,attempt_state,attempt_reason,context_current,expected,expected_permission)
VALUES ('facebook:next provider day scope','facebook','all','valid','verified','10 hours','failed','permission_missing',true,'permission_verification_pending','unknown'),
 ('facebook:next provider day token','facebook','all','valid','verified','10 hours','failed','reauth_required',true,'permission_verification_pending','unknown');
DO $matrix$
DECLARE t record; r jsonb; v_owner uuid:='e8110000-0000-4000-8000-000000000001'; v_account uuid;
 v_now timestamptz:='2026-11-15T12:00:00Z'; v_attempt_at timestamptz;
BEGIN
 FOR t IN SELECT * FROM readiness_precedence_cases LOOP
  v_account:=CASE t.platform WHEN 'instagram' THEN 'e8120000-0000-4000-8000-000000000001'::uuid ELSE 'e8120000-0000-4000-8000-000000000002'::uuid END;
  v_attempt_at:=v_now-CASE WHEN t.name LIKE '%next provider day%' THEN interval '11 hours'
   WHEN t.name LIKE '%future scope refusal%' THEN interval '-1 hour' ELSE interval '1 hour' END;
  UPDATE public.social_accounts SET needs_reauth=false WHERE id=v_account;
  UPDATE public.app_settings SET value=CASE t.policy WHEN 'disabled' THEN 'false'::jsonb WHEN 'invalid' THEN '{}'::jsonb ELSE 'true'::jsonb END
   WHERE key=CASE t.platform WHEN 'instagram' THEN 'collection_instagram_insights_enabled' ELSE 'collection_facebook_analytics_enabled' END;
  UPDATE public.app_settings SET value=CASE WHEN t.policy='excluded' THEN
   CASE t.platform WHEN 'instagram' THEN '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb ELSE '{"account_ids":[]}'::jsonb END
   ELSE CASE t.platform WHEN 'instagram' THEN '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb
   ELSE jsonb_build_object('account_ids',jsonb_build_array(v_account::text)) END END
   WHERE key=CASE t.platform WHEN 'instagram' THEN 'collection_instagram_rollout_policy' ELSE 'collection_facebook_analytics_policy' END;
  IF t.platform='instagram' THEN
   UPDATE public.instagram_account_capabilities SET permission_read_state=CASE WHEN t.proof='unavailable' THEN 'failed' ELSE 'ok' END,
    scopes_read_at=v_now-t.proof_age,granted_scopes=CASE WHEN t.proof='missing' THEN '{}'::text[] ELSE ARRAY['instagram_manage_insights'] END
    WHERE social_account_id=v_account;
  ELSE
   UPDATE public.fb_analytics_permission_observations SET authority=public.meta_analytics_current_authority('facebook',v_account,v_owner),
    state=CASE WHEN t.proof='unavailable' THEN 'unavailable' ELSE 'verified' END,observed_at=v_now-t.proof_age,
    granted_scopes=CASE WHEN t.proof='missing' THEN ARRAY['read_insights'] ELSE ARRAY['read_insights','pages_read_engagement'] END
    WHERE social_account_id=v_account;
  END IF;
  UPDATE public.social_accounts SET needs_reauth=(t.connection='invalid') WHERE id=v_account;
  r:=public.owner_analytics_readiness_snapshot(t.platform,v_owner,v_account,v_now,jsonb_build_object('state',t.attempt_state,
   'reason_code',t.attempt_reason,'observed_at',v_attempt_at,'context_current',t.context_current,'retry_at',v_now+interval '1 minute'));
  ASSERT r#>>'{collection,reason_code}'=t.expected,t.name||': expected '||t.expected||', got '||(r#>>'{collection,reason_code}');
  ASSERT r#>>'{permission,state}'=t.expected_permission,t.name||': independent permission proof';
  ASSERT r#>>'{last_attempt,reason_code}' IS NOT DISTINCT FROM t.attempt_reason,t.name||': history retained';
  UPDATE readiness_precedence_cases SET snapshot=r WHERE name=t.name;
 END LOOP;
END;$matrix$;
SELECT 'readiness_case:'||jsonb_build_object('name',name,'expected',expected,'snapshot',snapshot)::text FROM readiness_precedence_cases ORDER BY name;

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
