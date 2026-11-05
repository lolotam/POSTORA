-- A completed collection is judged by the account's stored cells, not by
-- which job captured them.
--
-- OLD: the metric-coverage rule of a 'success' completion required every
-- required day and post cell to carry a capture_id of THIS job and
-- generation. Daily jobs overlap (job D owns days D-1 and D-2, job D+1
-- owns D and D-1, both inventory the same posts) and persist_*_analytics_
-- capture lets the later writer take the cell's capture_id, so an earlier
-- job could never reach 'success' once two jobs interleaved. On 2026-11-05
-- job b22ce0ec (Page 8d1872d2, due 2026-11-04) was refused with MAH05 on
-- every drain for three hours and, because the worker treated MAH05 as a
-- configuration failure, the whole Facebook drain stopped with it.
--
-- NEW: the coverage rule asks only that an 'available' cell exists for the
-- same user, account, day/post and metric. The first MAH05 block (this
-- job's checkpoint and operations) is unchanged. Everything else in both
-- functions is byte-for-byte the definition from
-- 20261101144500_meta_owned_analytics_capture_failures.sql.
BEGIN;
CREATE OR REPLACE FUNCTION public.complete_fb_analytics_collection_job(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_outcome text,p_reason text DEFAULT NULL,p_retry_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;
BEGIN
  PERFORM public.meta_analytics_assert_service();v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_outcome IS NULL OR p_outcome NOT IN ('success','partial','failed','retry') OR p_reason IS NOT NULL AND p_reason !~ '^[a-z0-9_]{1,64}$'
    OR (p_outcome='retry' OR p_outcome='partial' AND p_retry_at IS NOT NULL) AND (p_retry_at IS NULL OR NOT isfinite(p_retry_at) OR p_retry_at<=clock_timestamp() OR p_retry_at>clock_timestamp()+interval '1 day') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_COMPLETION' USING ERRCODE='MAH01'; END IF;
  IF p_outcome='success' AND (
    NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation AND inventory_complete AND NOT inventory_truncated)
    OR EXISTS(SELECT 1 FROM public.fb_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND state IN ('pending','failed'))
    OR NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND kind='account_day' AND state='success')
    ) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;

  IF p_outcome='success' AND (
    EXISTS(SELECT 1 FROM unnest(ARRAY[v_job.due_on-1,v_job.due_on-2]) day_value CROSS JOIN unnest(ARRAY['views','unique_viewers','engagements','followers']) key_value
      WHERE NOT EXISTS(SELECT 1 FROM public.fb_page_insight_daily d JOIN public.fb_analytics_metric_values m ON m.daily_id=d.id
        WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND m.status='available'))
    OR EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','unique_viewers']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.fb_post_insight_snapshots p JOIN public.fb_analytics_metric_values m ON m.post_snapshot_id=p.id
          WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND m.status='available'))

  ) THEN RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.fb_analytics_collection_jobs SET state=p_outcome,completed_at=CASE WHEN p_outcome IN ('success','failed') THEN clock_timestamp() END,
    last_success_at=CASE WHEN p_outcome='success' THEN clock_timestamp() ELSE last_success_at END,
    last_partial_at=CASE WHEN p_outcome='partial' THEN clock_timestamp() ELSE last_partial_at END,
    retry_at=CASE WHEN p_outcome='retry' THEN p_retry_at WHEN p_outcome='partial' THEN COALESCE(p_retry_at,clock_timestamp()) ELSE NULL END,
    reason_code=p_reason,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=p_job_id;
  UPDATE public.fb_analytics_report_state SET report_revision=report_revision+1,updated_at=now() WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id;
  RETURN jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'state',p_outcome,
    'on_time',p_outcome='success' AND clock_timestamp()<v_job.next_due_at,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at);
END;
$fn$;
CREATE OR REPLACE FUNCTION public.complete_threads_analytics_collection_job(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_outcome text,p_reason text DEFAULT NULL,p_retry_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;
BEGIN
  PERFORM public.meta_analytics_assert_service();v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_outcome IS NULL OR p_outcome NOT IN ('success','partial','failed','retry') OR p_reason IS NOT NULL AND p_reason !~ '^[a-z0-9_]{1,64}$'
    OR (p_outcome='retry' OR p_outcome='partial' AND p_retry_at IS NOT NULL) AND (p_retry_at IS NULL OR NOT isfinite(p_retry_at) OR p_retry_at<=clock_timestamp() OR p_retry_at>clock_timestamp()+interval '1 day') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_COMPLETION' USING ERRCODE='MAH01'; END IF;
  IF p_outcome='success' AND (
    NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation AND inventory_complete AND NOT inventory_truncated)
    OR EXISTS(SELECT 1 FROM public.threads_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND state IN ('pending','failed'))
    OR NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND kind='account_day' AND state='success')
    ) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;

  IF p_outcome='success' AND (
    EXISTS(SELECT 1 FROM unnest(ARRAY[v_job.due_on-1,v_job.due_on-2]) day_value CROSS JOIN unnest(ARRAY['profile_views']) key_value
      WHERE NOT EXISTS(SELECT 1 FROM public.threads_account_insight_daily d JOIN public.threads_analytics_metric_values m ON m.daily_id=d.id
        WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND m.status='available'))
    OR EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','likes','replies','reposts','quotes','shares']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.threads_post_insight_snapshots p JOIN public.threads_analytics_metric_values m ON m.post_snapshot_id=p.id
          WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND m.status='available'))
    OR NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m WHERE m.user_id=v_job.user_id AND m.social_account_id=v_job.social_account_id AND m.profile_observation_id IS NOT NULL AND m.metric_key='followers' AND m.status='available')
  ) THEN RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.threads_analytics_collection_jobs SET state=p_outcome,completed_at=CASE WHEN p_outcome IN ('success','failed') THEN clock_timestamp() END,
    last_success_at=CASE WHEN p_outcome='success' THEN clock_timestamp() ELSE last_success_at END,
    last_partial_at=CASE WHEN p_outcome='partial' THEN clock_timestamp() ELSE last_partial_at END,
    retry_at=CASE WHEN p_outcome='retry' THEN p_retry_at WHEN p_outcome='partial' THEN COALESCE(p_retry_at,clock_timestamp()) ELSE NULL END,
    reason_code=p_reason,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=p_job_id;
  UPDATE public.threads_analytics_report_state SET report_revision=report_revision+1,updated_at=now() WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id;
  RETURN jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'state',p_outcome,
    'on_time',p_outcome='success' AND clock_timestamp()<v_job.next_due_at,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at);
END;
$fn$;
NOTIFY pgrst,'reload schema';
COMMIT;
