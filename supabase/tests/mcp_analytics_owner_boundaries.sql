-- Explicit-owner service RPCs share the browser rules without changing auth.uid().
\set ON_ERROR_STOP on
BEGIN;

DO $acl$
DECLARE signature text; fn regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.competitor_quota_for_user(uuid)',
    'public.add_competitor_watchlist_for_user(uuid,text,text)',
    'public.update_competitor_watchlist_for_user(uuid,uuid,text,boolean)',
    'public.read_competitor_tracking_report_for_user(uuid,jsonb)',
    'public.read_competitor_tracking_report_v2_for_user(uuid,jsonb)',
    'public.enqueue_instagram_collection_job_for_user(uuid,text,uuid,text)',
    'public.read_meta_analytics_enqueue_scope(uuid,text,uuid)',
    'public.enqueue_meta_analytics_for_user(uuid,text,uuid)'
  ] LOOP
    fn := signature::regprocedure;
    ASSERT has_function_privilege('service_role',fn,'EXECUTE'), 'service must reach '||signature;
    ASSERT NOT has_function_privilege('anon',fn,'EXECUTE'), 'anon must not reach '||signature;
    ASSERT NOT has_function_privilege('authenticated',fn,'EXECUTE'), 'browser must not select an owner: '||signature;
    ASSERT (SELECT prosecdef AND 'search_path=public, pg_temp'=ANY(proconfig) FROM pg_proc WHERE oid=fn), 'fixed definer boundary: '||signature;
    ASSERT NOT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=fn AND a.grantee=0 AND a.privilege_type='EXECUTE'), 'PUBLIC execute must be revoked';
  END LOOP;
END $acl$;

-- Compare catalog identities and ACLs, never deparsed function/policy SQL:
-- the harness search_path can render auth.uid() as uid().
DO $browser_contracts$
DECLARE contract record;
BEGIN
  FOR contract IN SELECT * FROM (VALUES
    ('public.read_own_competitor_quota()', ARRAY[]::text[], 0),
    ('public.add_competitor_watchlist(text,text)', ARRAY['p_username','p_label'], 1),
    ('public.update_competitor_watchlist(uuid,text,boolean)', ARRAY['p_watchlist_id','p_label','p_is_active'], 2),
    ('public.read_own_competitor_tracking_report(jsonb)', ARRAY['p_request'], 0),
    ('public.read_own_competitor_tracking_report_v2(jsonb)', ARRAY['p_request'], 0),
    ('public.enqueue_instagram_collection_job(text,uuid,text)', ARRAY['p_target_kind','p_target_id','p_mode'], 1)
  ) AS expected(signature, argument_names, default_count) LOOP
    ASSERT has_function_privilege('authenticated',contract.signature,'EXECUTE'), 'browser grant must remain: '||contract.signature;
    ASSERT NOT has_function_privilege('anon',contract.signature,'EXECUTE'), 'anonymous grant must remain denied: '||contract.signature;
    ASSERT (SELECT prorettype='jsonb'::regtype AND COALESCE(proargnames,ARRAY[]::text[])=contract.argument_names
      AND pronargdefaults=contract.default_count FROM pg_proc WHERE oid=contract.signature::regprocedure),
      'browser argument names, defaults and JSON return contract must remain: '||contract.signature;
  END LOOP;
  ASSERT has_function_privilege('service_role','public.read_own_competitor_quota()','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.read_own_competitor_tracking_report(jsonb)','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.read_own_competitor_tracking_report_v2(jsonb)','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.enqueue_instagram_collection_job(text,uuid,text)','EXECUTE');
END $browser_contracts$;

INSERT INTO auth.users(id,email) VALUES
 ('fa110000-0000-4000-8000-000000000001','mcp-analytics-owner@example.invalid'),
 ('fa110000-0000-4000-8000-000000000002','mcp-analytics-other@example.invalid');
INSERT INTO public.user_quotas(user_id,max_tracked_competitors) VALUES
 ('fa110000-0000-4000-8000-000000000001',1),('fa110000-0000-4000-8000-000000000002',1)
 ON CONFLICT(user_id) DO UPDATE SET max_tracked_competitors=EXCLUDED.max_tracked_competitors;
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active) VALUES
 ('fa120000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000001','instagram','ig-mcp-fixture','synthetic-mcp-token',true),
 ('fa120000-0000-4000-8000-000000000002','fa110000-0000-4000-8000-000000000001','facebook','fb-mcp-fixture','synthetic-mcp-token',true),
 ('fa120000-0000-4000-8000-000000000003','fa110000-0000-4000-8000-000000000001','threads','threads-mcp-fixture','synthetic-mcp-token',true);
INSERT INTO public.app_settings(key,value) VALUES
 ('collection_instagram_insights_enabled','false'),('collection_facebook_analytics_enabled','false'),('collection_threads_analytics_enabled','false')
 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
DO $service$
DECLARE owner_id uuid := 'fa110000-0000-4000-8000-000000000001'; other_id uuid := 'fa110000-0000-4000-8000-000000000002';
  receipt jsonb; entry_id uuid; other_entry_id uuid; report jsonb; invalid_handle text;
BEGIN
  ASSERT auth.uid() IS NULL, 'service operations must not impersonate an authenticated user';
  receipt := public.add_competitor_watchlist_for_user(owner_id,' @@Brand.Name ','Brand');
  entry_id := (receipt->>'watchlist_id')::uuid;
  ASSERT receipt->>'username'='brand.name';
  ASSERT receipt->'quota'->>'tracked_active'='1';
  ASSERT public.add_competitor_watchlist_for_user(owner_id,'brand.name',NULL)->>'already_tracked'='true';
  BEGIN
    PERFORM public.add_competitor_watchlist_for_user(owner_id,'second',NULL);
    RAISE EXCEPTION 'quota was bypassed';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%';
  END;
  FOREACH invalid_handle IN ARRAY ARRAY['bad..name','bad/name',repeat('a',31),''] LOOP
    BEGIN
      PERFORM public.add_competitor_watchlist_for_user(other_id,invalid_handle,NULL);
      RAISE EXCEPTION 'invalid username accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.add_competitor_watchlist_for_user(other_id,'valid',repeat('x',121));
    RAISE EXCEPTION 'invalid label accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  other_entry_id := (public.add_competitor_watchlist_for_user(other_id,'brand.name',NULL)->>'watchlist_id')::uuid;
  report := public.read_competitor_tracking_report_v2_for_user(owner_id,'{"action":"list","state":"active"}');
  ASSERT jsonb_array_length(report->'entries')=1;
  ASSERT report->'entries'->0->>'watchlist_id'=entry_id::text;
  BEGIN
    PERFORM public.update_competitor_watchlist_for_user(owner_id,other_entry_id,NULL,false);
    RAISE EXCEPTION 'foreign entry changed';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM public.read_competitor_tracking_report_v2_for_user(owner_id,jsonb_build_object('action','detail','watchlist_id',other_entry_id,'period_days',7));
    RAISE EXCEPTION 'foreign history read';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  receipt := public.update_competitor_watchlist_for_user(owner_id,entry_id,NULL,false);
  ASSERT receipt->>'is_active'='false' AND receipt->>'removed_at' IS NOT NULL;
  ASSERT receipt->'quota'->>'remaining'='1';
  ASSERT receipt->>'label'='Brand', 'untracking preserves the label';
  receipt := public.add_competitor_watchlist_for_user(owner_id,'BRAND.NAME',NULL);
  ASSERT receipt->>'watchlist_id'=entry_id::text AND receipt->>'reactivated'='true';
  ASSERT receipt->>'status'='pending';
  ASSERT public.enqueue_instagram_collection_job_for_user(owner_id,'owner','fa120000-0000-4000-8000-000000000001','normal')->>'reason_code'='collection_disabled';
  ASSERT public.read_meta_analytics_enqueue_scope(owner_id,'facebook','fa120000-0000-4000-8000-000000000002')->>'status'='collection_disabled';
  ASSERT public.enqueue_meta_analytics_for_user(owner_id,'threads','fa120000-0000-4000-8000-000000000003')->>'status'='collection_disabled';
  BEGIN
    PERFORM public.enqueue_instagram_collection_job_for_user(other_id,'owner','fa120000-0000-4000-8000-000000000001','normal');
    RAISE EXCEPTION 'foreign account enqueued';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM public.read_meta_analytics_enqueue_scope(other_id,'facebook','fa120000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'foreign Meta account inspected';
  EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL;
  END;
  ASSERT auth.uid() IS NULL, 'no service RPC changed the caller identity';
END $service$;
RESET ROLE;

-- The user-facing wrappers still derive their owner solely from the JWT.
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','fa110000-0000-4000-8000-000000000001',true);
SET LOCAL ROLE authenticated;
DO $browser$
DECLARE receipt jsonb; entry_id uuid;
BEGIN
  receipt := public.add_competitor_watchlist('@Brand.Name',NULL);
  ASSERT receipt->>'already_tracked'='true' AND receipt->>'username'='brand.name';
  ASSERT public.read_own_competitor_quota()->>'tracked_active'='1';
  entry_id := (receipt->>'watchlist_id')::uuid;
  BEGIN
    PERFORM public.add_competitor_watchlist('second',NULL);
    RAISE EXCEPTION 'browser quota was bypassed';
  EXCEPTION WHEN check_violation THEN ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%';
  END;
  BEGIN
    PERFORM public.add_competitor_watchlist('bad..name',NULL);
    RAISE EXCEPTION 'browser username validation changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.add_competitor_watchlist_for_user('fa110000-0000-4000-8000-000000000002','chosen_owner',NULL);
    RAISE EXCEPTION 'browser reached service writer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT public.update_competitor_watchlist(entry_id,NULL,false)->>'is_active'='false';
  ASSERT public.update_competitor_watchlist(entry_id,NULL,true)->>'status'='pending';
END $browser$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $anonymous$ BEGIN
  BEGIN
    PERFORM public.add_competitor_watchlist_for_user('fa110000-0000-4000-8000-000000000001','chosen_owner',NULL);
    RAISE EXCEPTION 'anonymous reached service writer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anonymous$;
RESET ROLE;
ROLLBACK;
SELECT 'mcp_analytics_owner_boundaries: ok' AS result;
