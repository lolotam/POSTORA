-- Real database contracts for the owner period reach
-- (20261104130000_instagram_owner_period_reach.sql).
--
-- The table mirrors ig_account_insight_daily's ownership: owners read their
-- own rows, the service role writes, nobody else. The writer sits behind the
-- accepted collection fence, accepts only a 2-30 day range that ends on the
-- job's last closed day, and never stores a missing total as a zero. The
-- report snapshot returns the totals of the owner only.
\set ON_ERROR_STOP on
BEGIN;

DO $acl$
DECLARE signature text; fn regprocedure;
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.ig_account_insight_period_totals'::regclass),
    'RLS must be enabled';
  ASSERT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ig_account_insight_period_totals'
    AND policyname='Owners can read their own rows' AND cmd='SELECT' AND roles::text='{authenticated}'
    AND qual='(auth.uid() = user_id)' AND permissive='PERMISSIVE'), 'the owner-read policy must match the daily table';
  ASSERT has_table_privilege('authenticated','public.ig_account_insight_period_totals','SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.ig_account_insight_period_totals','INSERT');
  ASSERT NOT has_table_privilege('authenticated','public.ig_account_insight_period_totals','UPDATE');
  ASSERT NOT has_table_privilege('authenticated','public.ig_account_insight_period_totals','DELETE');
  ASSERT NOT has_table_privilege('anon','public.ig_account_insight_period_totals','SELECT');
  ASSERT has_table_privilege('service_role','public.ig_account_insight_period_totals','INSERT');

  FOREACH signature IN ARRAY ARRAY[
    'public.persist_instagram_owner_period_total(uuid,uuid,bigint,jsonb)',
    'public.persist_instagram_owner_period_total_http(uuid,uuid,bigint,jsonb)'
  ] LOOP
    fn := signature::regprocedure;
    ASSERT has_function_privilege('service_role',fn,'EXECUTE'), 'service role must reach ' || signature;
    ASSERT NOT has_function_privilege('anon',fn,'EXECUTE'), 'anonymous must not reach ' || signature;
    ASSERT NOT has_function_privilege('authenticated',fn,'EXECUTE'), 'browser must not reach ' || signature;
    ASSERT NOT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=fn AND a.grantee=0 AND a.privilege_type='EXECUTE'), 'PUBLIC execute must be revoked';
  END LOOP;
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid='public.persist_instagram_owner_period_total(uuid,uuid,bigint,jsonb)'::regprocedure),
    'the writer is the definer behind the fence';
  ASSERT (SELECT NOT prosecdef AND provolatile='v' FROM pg_proc WHERE oid='public.persist_instagram_owner_period_total_http(uuid,uuid,bigint,jsonb)'::regprocedure),
    'the HTTP wrapper keeps invoker privileges and volatility';
  ASSERT has_function_privilege('authenticated','public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz)','EXECUTE'),
    'the replaced report snapshot keeps its grant';
  ASSERT NOT has_function_privilege('anon','public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz)','EXECUTE');
END $acl$;

INSERT INTO auth.users(id,email) VALUES
 ('f2110000-0000-4000-8000-000000000001','period-reach-owner@example.invalid'),
 ('f2110000-0000-4000-8000-000000000002','period-reach-other@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active)
VALUES ('f2120000-0000-4000-8000-000000000001','f2110000-0000-4000-8000-000000000001','instagram','ig-period-reach','period_reach','synthetic-period-reach-token','facebook_page',true);
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
VALUES ('f2120000-0000-4000-8000-000000000001','f2110000-0000-4000-8000-000000000001','instagram','page_linked','ok',ARRAY['instagram_manage_insights'],now(),1);
INSERT INTO public.app_settings(key,value,description) VALUES
('collection_instagram_insights_enabled','true'::jsonb,'Synthetic period reach fixture'),
('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"allowlist","account_ids":["f2120000-0000-4000-8000-000000000001"]},"competitors":{"mode":"off","targets":[]}}'::jsonb,'Synthetic period reach fixture')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','f2110000-0000-4000-8000-000000000001',true);
SET LOCAL ROLE authenticated;
SELECT public.enqueue_instagram_collection_job(p_target_kind=>'owner',p_target_id=>'f2120000-0000-4000-8000-000000000001',p_mode=>'normal');
DO $browser_refusal$ BEGIN
  BEGIN
    PERFORM public.persist_instagram_owner_period_total_http('f2130000-0000-4000-8000-000000000001','f2140000-0000-4000-8000-000000000001',1,'{}');
    RAISE EXCEPTION 'browser unexpectedly reached the period writer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ig_account_insight_period_totals(user_id,social_account_id,metric,period_days,since_date,until_date,period_start,period_end,provider_timezone,value,status)
    VALUES ('f2110000-0000-4000-8000-000000000001','f2120000-0000-4000-8000-000000000001','reach',7,current_date-7,current_date-1,now()-interval '7 days',now(),'Asia/Kuwait',1,'ok');
    RAISE EXCEPTION 'browser unexpectedly wrote a period total';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $browser_refusal$;
RESET ROLE;

CREATE TEMP TABLE period_reach_claim(claim jsonb) ON COMMIT DROP;
GRANT SELECT,INSERT ON period_reach_claim TO service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
INSERT INTO period_reach_claim SELECT c FROM public.claim_instagram_collection_jobs('owner',100) c
WHERE c->>'social_account_id'='f2120000-0000-4000-8000-000000000001';

DO $writer$
DECLARE
  c jsonb; receipt jsonb; until_day date; base jsonb; bad jsonb; stored record;
BEGIN
  SELECT claim INTO STRICT c FROM period_reach_claim;
  until_day := (c->>'captured_on')::date - 1;
  base := jsonb_build_object(
    'metric','reach','period_days',30,
    'since_date',(until_day-29)::text,'until_date',until_day::text,
    'period_start',((until_day-29)::timestamp AT TIME ZONE 'Asia/Kuwait'),
    'period_end',((until_day+1)::timestamp AT TIME ZONE 'Asia/Kuwait') - interval '1 millisecond',
    'provider_timezone','Asia/Kuwait','status','ok','value',1200);

  receipt := public.persist_instagram_owner_period_total_http((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint,base);
  ASSERT (receipt->>'written')::integer=1 AND receipt->>'job_id'=c->>'job_id'
    AND (receipt->>'job_generation')::bigint=(c->>'job_generation')::bigint, 'the receipt names the job';
  SELECT * INTO STRICT stored FROM public.ig_account_insight_period_totals
   WHERE social_account_id='f2120000-0000-4000-8000-000000000001' AND since_date=until_day-29 AND until_date=until_day;
  ASSERT stored.value=1200 AND stored.status='ok' AND stored.period_days=30
    AND stored.user_id='f2110000-0000-4000-8000-000000000001', 'the total is stored for the job''s owner';

  -- A second write of the same range replaces it rather than duplicating.
  PERFORM public.persist_instagram_owner_period_total_http((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint,
    base || '{"value":1300}'::jsonb);
  ASSERT (SELECT count(*) FROM public.ig_account_insight_period_totals WHERE social_account_id='f2120000-0000-4000-8000-000000000001')=1;
  ASSERT (SELECT value FROM public.ig_account_insight_period_totals WHERE social_account_id='f2120000-0000-4000-8000-000000000001')=1300;

  -- A range the provider did not report is unavailable with NO value.
  PERFORM public.persist_instagram_owner_period_total_http((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint,
    base || jsonb_build_object('period_days',7,'since_date',(until_day-6)::text,
      'period_start',((until_day-6)::timestamp AT TIME ZONE 'Asia/Kuwait'),'status','unavailable','value',NULL));
  SELECT * INTO STRICT stored FROM public.ig_account_insight_period_totals
   WHERE social_account_id='f2120000-0000-4000-8000-000000000001' AND period_days=7;
  ASSERT stored.status='unavailable' AND stored.value IS NULL, 'a missing total is never a zero';

  FOREACH bad IN ARRAY ARRAY[
    base || jsonb_build_object('until_date',(until_day-1)::text,'since_date',(until_day-30)::text), -- not the job's last closed day
    base || jsonb_build_object('until_date',(until_day+1)::text,'since_date',(until_day-28)::text), -- the capture day is still open
    base || jsonb_build_object('since_date',(until_day-30)::text),                                -- 31 days under a 30 day label
    base || jsonb_build_object('period_days',31,'since_date',(until_day-30)::text),               -- longer than Meta accepts
    base || jsonb_build_object('period_days',1,'since_date',until_day::text),                     -- a day is the daily row
    base || '{"period_days":30.5}'::jsonb,
    base || '{"period_days":"30"}'::jsonb,
    base || '{"metric":"views"}'::jsonb,
    base || '{"value":null}'::jsonb,                                                              -- ok without a value
    base || '{"status":"unavailable"}'::jsonb,                                                    -- unavailable with a value
    base || '{"value":-1}'::jsonb,
    base || '{"value":1.5}'::jsonb,
    base || '{"value":"1200"}'::jsonb,
    base || '{"status":"error"}'::jsonb,
    base - 'period_start',
    base - 'period_days',
    base - 'status',
    '[]'::jsonb
  ] LOOP
    BEGIN
      PERFORM public.persist_instagram_owner_period_total_http((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint,bad);
      RAISE EXCEPTION 'an invalid period total was accepted: %', bad;
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
  END LOOP;
  ASSERT (SELECT count(*) FROM public.ig_account_insight_period_totals WHERE social_account_id='f2120000-0000-4000-8000-000000000001')=2,
    'refused writes leave nothing behind';

  -- The fence: a wrong claim token or generation is a definitive conflict.
  BEGIN
    PERFORM public.persist_instagram_owner_period_total_http((c->>'job_id')::uuid,'f2140000-0000-4000-8000-000000000099',(c->>'job_generation')::bigint,base);
    RAISE EXCEPTION 'a wrong claim token was accepted';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
  END;
  BEGIN
    PERFORM public.persist_instagram_owner_period_total((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint+1,base);
    RAISE EXCEPTION 'the native writer accepted a wrong generation';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    PERFORM public.persist_instagram_owner_period_total_http('f2130000-0000-4000-8000-000000000099','f2140000-0000-4000-8000-000000000099',1,base);
    RAISE EXCEPTION 'a missing job was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END $writer$;
RESET ROLE;

-- The table itself refuses a zero standing in for a missing value, even for
-- a direct service write that bypasses the writer.
DO $constraints$ BEGIN
  BEGIN
    INSERT INTO public.ig_account_insight_period_totals(user_id,social_account_id,metric,period_days,since_date,until_date,period_start,period_end,provider_timezone,value,status)
    VALUES ('f2110000-0000-4000-8000-000000000001','f2120000-0000-4000-8000-000000000001','reach',14,current_date-20,current_date-7,now()-interval '20 days',now()-interval '6 days','Asia/Kuwait',0,'unavailable');
    RAISE EXCEPTION 'an unavailable row with a value was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ig_account_insight_period_totals(user_id,social_account_id,metric,period_days,since_date,until_date,period_start,period_end,provider_timezone,value,status)
    VALUES ('f2110000-0000-4000-8000-000000000001','f2120000-0000-4000-8000-000000000001','reach',14,current_date-20,current_date-6,now()-interval '20 days',now()-interval '6 days','Asia/Kuwait',5,'ok');
    RAISE EXCEPTION 'a range that disagrees with its length was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $constraints$;

-- The owner reads its totals through the report snapshot; nobody else does.
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','f2110000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"f2110000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
DO $owner_read$
DECLARE result jsonb; row jsonb;
BEGIN
  result := public.read_instagram_owner_report_snapshot(NULL,'f2120000-0000-4000-8000-000000000001',clock_timestamp());
  ASSERT jsonb_array_length(result->'period_totals')=2, 'the owner sees both stored totals';
  FOR row IN SELECT * FROM jsonb_array_elements(result->'period_totals') LOOP
    ASSERT row->>'user_id'='f2110000-0000-4000-8000-000000000001'
      AND row->>'social_account_id'='f2120000-0000-4000-8000-000000000001', 'every row carries its owner';
  END LOOP;
  ASSERT result ? 'media' AND result ? 'daily' AND result ? 'profiles' AND result ? 'collection',
    'the earlier keys are unchanged';
  ASSERT (SELECT count(*) FROM public.ig_account_insight_period_totals)=2, 'RLS lets the owner read its own rows';
  -- A cutoff before the capture hides it.
  result := public.read_instagram_owner_report_snapshot(NULL,'f2120000-0000-4000-8000-000000000001',clock_timestamp()-interval '1 day');
  ASSERT result->'period_totals'='[]'::jsonb, 'a total captured after the cutoff is not part of the snapshot';
END $owner_read$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','f2110000-0000-4000-8000-000000000002',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"f2110000-0000-4000-8000-000000000002"}',true);
SET LOCAL ROLE authenticated;
DO $other_read$ BEGIN
  ASSERT (SELECT count(*) FROM public.ig_account_insight_period_totals)=0, 'RLS hides another owner''s totals';
  BEGIN
    PERFORM public.read_instagram_owner_report_snapshot(NULL,'f2120000-0000-4000-8000-000000000001',clock_timestamp());
    RAISE EXCEPTION 'another owner read the snapshot';
  EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;
  END;
END $other_read$;
RESET ROLE;

ROLLBACK;
\echo 'ALL CHECKS PASSED'
