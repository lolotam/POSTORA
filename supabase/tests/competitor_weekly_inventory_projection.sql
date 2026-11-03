\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email) VALUES
 ('f7710000-0000-4000-8000-000000000001','weekly-a@example.invalid'),
 ('f7710000-0000-4000-8000-000000000002','weekly-b@example.invalid');
INSERT INTO public.user_quotas(user_id,max_tracked_competitors) VALUES
 ('f7710000-0000-4000-8000-000000000001',-1),('f7710000-0000-4000-8000-000000000002',-1)
 ON CONFLICT(user_id) DO UPDATE SET max_tracked_competitors=-1;
INSERT INTO public.competitor_watchlist(id,user_id,username,created_at) VALUES
 ('f7720000-0000-4000-8000-000000000001','f7710000-0000-4000-8000-000000000001','weekly_main',now()),
 ('f7720000-0000-4000-8000-000000000002','f7710000-0000-4000-8000-000000000001','weekly_empty',now()-interval '1 day'),
 ('f7720000-0000-4000-8000-000000000003','f7710000-0000-4000-8000-000000000001','weekly_legacy',now()-interval '2 days'),
 ('f7720000-0000-4000-8000-000000000004','f7710000-0000-4000-8000-000000000002','weekly_main',now());

INSERT INTO public.competitor_capture_coverage(watchlist_id,user_id,captured_on,captured_at,source,job_generation,
 capture_started_at,capture_ended_at,oldest_returned_at,ordering_verified,cursor_present,exhausted,truncated,gap_reason)
VALUES('f7720000-0000-4000-8000-000000000001','f7710000-0000-4000-8000-000000000001',
 ((now()-interval '1 hour') AT TIME ZONE 'Asia/Kuwait')::date,now()-interval '1 hour','official',1,
 now()-interval '1 hour 5 seconds',now()-interval '1 hour',now()-interval '10 days',true,false,true,false,NULL);

-- Two daily observations per media ID must still count as one observed post.
INSERT INTO public.competitor_media_snapshots(watchlist_id,user_id,ig_media_id,captured_on,captured_at,
 published_at,source,status,media_product_type,media_type,view_count)
SELECT 'f7720000-0000-4000-8000-000000000001','f7710000-0000-4000-8000-000000000001',
 'weekly_'||g,((now()-interval '1 hour'-d*interval '1 day') AT TIME ZONE 'Asia/Kuwait')::date,
 now()-interval '1 hour'-d*interval '1 day',now()-interval '3 days'-g*interval '1 second',
 'official','ok','REELS','VIDEO',g FROM generate_series(1,31) g CROSS JOIN generate_series(0,1) d;
INSERT INTO public.competitor_media_snapshots(watchlist_id,user_id,ig_media_id,captured_on,captured_at,published_at,source,status)
SELECT 'f7720000-0000-4000-8000-000000000001','f7710000-0000-4000-8000-000000000001',name,
 ((now()-interval '1 hour') AT TIME ZONE 'Asia/Kuwait')::date,
 CASE WHEN name='future_observation' THEN now()+interval '1 day' ELSE now()-interval '1 hour' END,
 published,'official',CASE WHEN name='failed_observation' THEN 'error' ELSE 'ok' END
FROM (VALUES
 ('boundary_start',now()-interval '169 hours'),('boundary_end',now()-interval '1 hour'),
 ('outside',now()-interval '169 hours 0.000001 seconds'),('future_publication',now()-interval '1 hour'+interval '0.000001 seconds'),
 ('future_observation',now()-interval '2 days'),('failed_observation',now()-interval '2 days')) fixtures(name,published);
INSERT INTO public.competitor_media_snapshots(watchlist_id,user_id,ig_media_id,captured_on,captured_at,published_at,source,status)
VALUES
 ('f7720000-0000-4000-8000-000000000003','f7710000-0000-4000-8000-000000000001','legacy',current_date,now()-interval '1 hour',now()-interval '2 days','official','ok'),
 ('f7720000-0000-4000-8000-000000000004','f7710000-0000-4000-8000-000000000002','foreign',current_date,now()-interval '1 hour',now()-interval '2 days','official','ok');

DO $grants$ BEGIN
 ASSERT has_function_privilege('authenticated','public.read_own_competitor_tracking_report_v2(jsonb)','EXECUTE'), 'authenticated read grant';
 ASSERT NOT has_function_privilege('anon','public.read_own_competitor_tracking_report_v2(jsonb)','EXECUTE'), 'anon must be refused';
 ASSERT NOT has_function_privilege('service_role','public.read_own_competitor_tracking_report_v2(jsonb)','EXECUTE'), 'service role must be refused';
END;$grants$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','',true);
DO $no_owner$ BEGIN
 BEGIN
  PERFORM public.read_own_competitor_tracking_report_v2('{"action":"list"}'::jsonb);
  RAISE EXCEPTION 'missing owner was accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;$no_owner$;
SELECT set_config('request.jwt.claim.sub','f7710000-0000-4000-8000-000000000001',true);
DO $counts$
DECLARE listed jsonb; detail jsonb; continued jsonb; old jsonb; legacy jsonb; empty_entry jsonb;
BEGIN
 listed:=public.read_own_competitor_tracking_report_v2('{"action":"list","state":"active","limit":50}');
 ASSERT jsonb_array_length(listed->'entries')=3, 'foreign owner must not enter list';
 ASSERT (listed#>>'{entries,0,weekly_inventory,observed_count}')::integer=33,
   'count distinct IDs across daily duplicates with both inclusive boundaries; exclude future, failed and foreign rows';
 old:=public.read_own_competitor_tracking_report('{"action":"list","state":"active","limit":50}');
 ASSERT ((listed#>'{entries,0}')-'weekly_inventory')=(old#>'{entries,0}'), 'old projection remains unchanged';
 detail:=public.read_own_competitor_tracking_report_v2('{"action":"detail","watchlist_id":"f7720000-0000-4000-8000-000000000001","period_days":7,"limit":10}');
 ASSERT jsonb_array_length(detail->'media')=10 AND detail->>'next_cursor' IS NOT NULL, 'detail must actually be paginated';
 ASSERT detail#>'{entry,weekly_inventory}'=listed#>'{entries,0,weekly_inventory}', 'list and first detail page share the whole window';
 continued:=public.read_own_competitor_tracking_report_v2(jsonb_build_object('action','detail','watchlist_id','f7720000-0000-4000-8000-000000000001','period_days',7,'limit',10,'cursor',detail->>'next_cursor'));
 ASSERT jsonb_array_length(continued->'media')=10, 'continuation must execute';
 ASSERT continued#>'{entry,weekly_inventory}'=detail#>'{entry,weekly_inventory}', 'display page must not change the count';
 legacy:=public.read_own_competitor_tracking_report_v2('{"action":"detail","watchlist_id":"f7720000-0000-4000-8000-000000000003","period_days":30}');
 ASSERT (legacy#>>'{entry,weekly_inventory,observed_count}')::integer=1, 'stored media supplies the anchor without coverage';
 empty_entry:=public.read_own_competitor_tracking_report_v2('{"action":"detail","watchlist_id":"f7720000-0000-4000-8000-000000000002","period_days":7}');
 ASSERT empty_entry#>'{entry,weekly_inventory}'='{"observed_count":0,"interval_start":null,"interval_end":null}'::jsonb, 'empty stored inventory remains zero observed records with no invented interval';
END;$counts$;
SELECT 'WEEKLY_V2_FIXTURE:'||public.read_own_competitor_tracking_report_v2('{"action":"detail","watchlist_id":"f7720000-0000-4000-8000-000000000001","period_days":7,"limit":10}')::text;
SELECT set_config('request.jwt.claim.sub','f7710000-0000-4000-8000-000000000002',true);
DO $foreign$ BEGIN
 BEGIN
  PERFORM public.read_own_competitor_tracking_report_v2('{"action":"detail","watchlist_id":"f7720000-0000-4000-8000-000000000001","period_days":7}');
  RAISE EXCEPTION 'foreign target was accepted';
 EXCEPTION WHEN no_data_found THEN NULL; END;
END;$foreign$;
RESET ROLE;
ROLLBACK;
\echo 'competitor_weekly_inventory_projection: ALL CHECKS PASSED'
