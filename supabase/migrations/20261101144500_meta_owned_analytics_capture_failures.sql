-- Preserve per-cell failure provenance and yield bounded partial visits.
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
        JOIN public.fb_analytics_captures c ON c.id=m.capture_id WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
          AND m.status='available'))
    OR EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','unique_viewers']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.fb_post_insight_snapshots p JOIN public.fb_analytics_metric_values m ON m.post_snapshot_id=p.id
          JOIN public.fb_analytics_captures c ON c.id=m.capture_id WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
            AND m.status='available'))

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
        JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
          AND m.status='available'))
    OR EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','likes','replies','reposts','quotes','shares']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.threads_post_insight_snapshots p JOIN public.threads_analytics_metric_values m ON m.post_snapshot_id=p.id
          JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
            AND m.status='available'))
    OR NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE c.job_id=p_job_id AND c.job_generation=p_job_generation AND m.profile_observation_id IS NOT NULL AND m.metric_key='followers' AND m.status='available')
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
