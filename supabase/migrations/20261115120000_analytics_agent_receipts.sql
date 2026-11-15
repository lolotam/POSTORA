-- Additive service-only agent receipts. No settings, schedules or provider work.
BEGIN;

CREATE FUNCTION public.save_competitor_tool_receipt_for_user(p_user_id uuid,p_username text,p_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='5s' AS $fn$
DECLARE result jsonb;
BEGIN
 result:=public.add_competitor_watchlist_for_user(p_user_id,p_username,p_label);
 RETURN result||jsonb_build_object('saved',true,'operation',CASE
  WHEN (result->>'already_tracked')::boolean THEN 'already_tracked'
  WHEN (result->>'reactivated')::boolean THEN 'reactivated' ELSE 'created' END,
  'quota',public.competitor_quota_for_user(p_user_id));
EXCEPTION WHEN check_violation THEN
 IF SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%' THEN
  RETURN jsonb_build_object('ok',false,'saved',false,'reason_code','quota_exceeded',
   'quota',public.competitor_quota_for_user(p_user_id));
 END IF;
 RAISE;
END;
$fn$;

CREATE FUNCTION public.read_competitor_tool_collection_for_user(p_user_id uuid,p_watchlist_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='5s' AS $fn$
DECLARE target public.competitor_watchlist; job public.instagram_collection_jobs;
 allowed jsonb; reason text; eligible boolean:=false; viewer uuid; candidate uuid; evidence jsonb; state text; action text;
 daily text; drain text; daily_active boolean; drain_active boolean;
 last_capture_on date; last_capture_at timestamptz;
BEGIN
 IF p_user_id IS NULL THEN RAISE EXCEPTION 'COMPETITOR_UNAUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM public.competitor_watchlist WHERE id=p_watchlist_id AND user_id=p_user_id AND platform='instagram';
 IF NOT FOUND THEN RAISE EXCEPTION 'COMPETITOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 -- The existing collector evaluator owns rollout precedence, independently of owner collection membership.
 allowed:=public.ig_collection_rollout_target_allowed(p_user_id,'competitor',p_watchlist_id,NULL);
 IF NOT COALESCE((allowed->>'allowed')::boolean,false) THEN reason:=allowed->>'reason_code';
 ELSIF NOT target.is_active THEN reason:='account_inactive';
 ELSE
  -- Nonsecret projection of the worker's trusted Page-linked viewer boundary.
  -- Metadata and direct-login tokens cannot supply Business Discovery authority.
  SELECT a.id INTO viewer FROM public.social_accounts a
   JOIN public.instagram_account_capabilities c ON c.social_account_id=a.id AND c.user_id=a.user_id AND c.platform=a.platform
   JOIN public.facebook_user_credential_bindings b ON b.social_account_id=a.id AND b.user_id=a.user_id AND b.platform=a.platform
   JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
   LEFT JOIN public.facebook_user_credential_connection_fences f ON f.social_account_id=a.id AND f.user_id=a.user_id AND f.platform=a.platform
   WHERE a.user_id=p_user_id AND a.platform='instagram' AND a.is_active AND NOT COALESCE(a.needs_reauth,false)
    AND NULLIF(btrim(a.platform_user_id),'') IS NOT NULL AND c.login_kind='page_linked'
    AND c.permission_read_state='ok' AND c.credential_generation>=1
    AND c.granted_scopes && ARRAY['instagram_manage_insights','instagram_business_manage_insights']::text[]
    AND g.lifecycle='active' AND NULLIF(btrim(g.token),'') IS NOT NULL AND (g.token_expires_at IS NULL OR g.token_expires_at>now())
    AND (b.evidence_source='migrated_instagram_account_credential' OR
     (b.connection_version=f.connection_version AND b.verified_facebook_user_id=g.provider_user_id
      AND b.verified_instagram_user_id=a.platform_user_id
      AND (b.evidence_source IN ('oauth_exchange','token_refresh') OR public.analytics_bootstrap_binding_verified(a.id))))
    AND COALESCE((public.ig_collection_rollout_target_allowed(p_user_id,'competitor',p_watchlist_id,a.id)->>'allowed')::boolean,false)
   ORDER BY a.id LIMIT 1;
  IF viewer IS NULL THEN
   SELECT a.id INTO candidate FROM public.social_accounts a
    LEFT JOIN public.instagram_account_capabilities c ON c.social_account_id=a.id AND c.user_id=a.user_id
    WHERE a.user_id=p_user_id AND a.platform='instagram' AND a.is_active
     AND (c.social_account_id IS NULL OR c.login_kind='page_linked') ORDER BY a.id LIMIT 1;
   IF candidate IS NULL THEN reason:='page_linked_viewer_required';
   ELSE
    -- Reuse canonical independent evidence, ignoring owner collection policy:
    -- owner admission and public-discovery viewer admission are separate.
    evidence:=public.owner_analytics_readiness_snapshot('instagram',p_user_id,candidate,now(),NULL);
    reason:=COALESCE(evidence#>>'{connection,reason_code}',CASE evidence#>>'{permission,state}'
     WHEN 'missing' THEN 'permission_missing' WHEN 'verified' THEN 'provider_error' ELSE 'permission_verification_pending' END);
   END IF;
  ELSE eligible:=true; END IF;
 END IF;
 SELECT * INTO job FROM public.instagram_collection_jobs WHERE user_id=p_user_id AND target_kind='competitor'
  AND target_id=p_watchlist_id AND captured_on=(now() AT TIME ZONE 'Asia/Kuwait')::date;
 IF reason IS NOT NULL THEN state:='refused';
 ELSIF job.status IN ('queued','pending') THEN state:='queued';reason:='queued';
 ELSIF job.status='leased' THEN state:='running';reason:='running';
 ELSIF job.status='completed' THEN state:='complete';reason:='ready';
 ELSIF job.status IN ('retry','partial') THEN state:='retry';reason:=CASE WHEN job.last_reason_code='rate_limited' THEN 'rate_limited' ELSE 'provider_error' END;
 ELSIF job.status IS NOT NULL THEN state:='unavailable';reason:='provider_error';
 ELSE
  -- No current-day job is not evidence of no history. Only retained numerical
  -- observations promote this fallback; current refusals and work still win.
  SELECT captured_on,captured_at INTO last_capture_on,last_capture_at FROM (
   (SELECT s.captured_on,s.captured_at FROM public.competitor_profile_snapshots s
    WHERE s.user_id=p_user_id AND s.watchlist_id=p_watchlist_id AND s.status='ok'
     AND (s.followers_count IS NOT NULL OR s.media_count IS NOT NULL)
    ORDER BY s.captured_on DESC,s.captured_at DESC LIMIT 1)
   UNION ALL
   (SELECT s.captured_on,s.captured_at FROM public.competitor_media_snapshots s
    WHERE s.user_id=p_user_id AND s.watchlist_id=p_watchlist_id AND s.status='ok'
     AND (s.like_count IS NOT NULL OR s.comments_count IS NOT NULL OR s.view_count IS NOT NULL)
    ORDER BY s.captured_on DESC,s.captured_at DESC LIMIT 1)
  ) captures ORDER BY captured_on DESC,captured_at DESC LIMIT 1;
  IF last_capture_at IS NOT NULL THEN state:='complete';reason:='ready';
  ELSE state:='never_synced';reason:='awaiting_first_capture'; END IF;
 END IF;
 action:=CASE WHEN reason='page_linked_viewer_required' THEN 'connect_page_linked'
  WHEN state IN ('refused','unavailable') THEN 'contact_support' WHEN state='complete' THEN 'none'
  WHEN state='retry' THEN 'retry_after' ELSE 'wait' END;
 -- These are configured scheduler facts, not an SLA. Cron may be paused.
 SELECT schedule,active INTO daily,daily_active FROM cron.job WHERE jobname='competitor-snapshot-enqueue-daily';
 SELECT schedule,active INTO drain,drain_active FROM cron.job WHERE jobname='competitor-snapshot-drain';
 RETURN jsonb_build_object('accepted',false,'queued',state='queued','status',state,'reason_code',reason,
  'next_action',action,'reconnect_can_help',false,'retry_at',CASE WHEN state='retry' THEN job.retry_at END,'collection_eligible',eligible,
  'job_id',job.id,'captured_on',COALESCE(job.captured_on,last_capture_on),'last_capture_at',last_capture_at,
  'schedule',jsonb_build_object('timezone','UTC','daily_enqueue',daily,'drain',drain,
   'daily_enqueue_active',daily_active,'drain_active',drain_active,
   'first_capture','After a successful eligible run; no guaranteed completion time.'));
END;
$fn$;

CREATE FUNCTION public.enqueue_competitor_tool_initial_for_user(p_user_id uuid,p_watchlist_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='5s' AS $fn$
DECLARE readiness jsonb; result jsonb; state text; reason text;
BEGIN
 readiness:=public.read_competitor_tool_collection_for_user(p_user_id,p_watchlist_id);
 IF NOT COALESCE((readiness->>'collection_eligible')::boolean,false) THEN
  PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
   'event','collection_enqueue_refused','reason_code',readiness->>'reason_code',
   'user_id',p_user_id,'target_kind','competitor','target_id',p_watchlist_id,
   'details',jsonb_build_object('actor','agent','mode','normal')));
  RETURN readiness;
 END IF;
 -- Natural key (owner, competitor, target, Kuwait day), normal enqueue only.
 -- The existing SQL rechecks ownership/policy before spending the throttle.
 result:=public.enqueue_instagram_collection_job_for_user(p_user_id,'competitor',p_watchlist_id,'normal');
 IF COALESCE((result->>'refused')::boolean,false) THEN
  RETURN readiness||jsonb_build_object('accepted',false,'queued',false,'status','refused',
   'reason_code',result->>'reason_code','next_action','contact_support');
 END IF;
 IF NOT COALESCE((result->>'accepted')::boolean,false) THEN
  RETURN readiness||jsonb_build_object('accepted',false,'queued',false,'status','retry','reason_code','rate_limited','next_action','retry_after',
   'retry_at',now()+make_interval(secs=>(result->>'retry_after_seconds')::integer));
 END IF;
 state:=CASE result->>'status' WHEN 'queued' THEN 'queued' WHEN 'leased' THEN 'running'
  WHEN 'completed' THEN 'complete' WHEN 'retry' THEN 'retry' WHEN 'partial' THEN 'retry' ELSE 'unavailable' END;
 reason:=CASE state WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' WHEN 'complete' THEN 'ready' ELSE 'provider_error' END;
 RETURN readiness||result||jsonb_build_object('accepted',true,'queued',state='queued','status',state,'reason_code',reason,
  'next_action',CASE state WHEN 'complete' THEN 'none' WHEN 'retry' THEN 'retry_after' ELSE 'wait' END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.save_competitor_tool_receipt_for_user(uuid,text,text),
 public.read_competitor_tool_collection_for_user(uuid,uuid), public.enqueue_competitor_tool_initial_for_user(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_competitor_tool_receipt_for_user(uuid,text,text),
 public.read_competitor_tool_collection_for_user(uuid,uuid), public.enqueue_competitor_tool_initial_for_user(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
