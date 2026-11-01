-- Claimed-generation state and request-bound inventory pages. No activation.
BEGIN;

ALTER TABLE public.fb_analytics_collection_checkpoints
  ADD COLUMN inventory_request_id uuid,
  ADD COLUMN inventory_request_claim uuid,
  ADD COLUMN inventory_response_digest text CHECK(inventory_response_digest IS NULL OR inventory_response_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN inventory_receipt jsonb,
  ADD COLUMN inventory_seen_cursors text[] NOT NULL DEFAULT '{}' CHECK(cardinality(inventory_seen_cursors)<=100),
  ADD CONSTRAINT fb_inventory_reservation_pair CHECK((inventory_request_id IS NULL)=(inventory_request_claim IS NULL)),
  ADD CONSTRAINT fb_inventory_receipt_pair CHECK((inventory_response_digest IS NULL)=(inventory_receipt IS NULL));

CREATE FUNCTION public.read_fb_analytics_worker_state(p_job_id uuid,p_claim_token uuid,p_job_generation bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_checkpoint jsonb;v_operations jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT jsonb_build_object('cursor',inventory_cursor,'post_ids',post_ids,'pages_fetched',pages_fetched,
    'inventory_complete',inventory_complete,'inventory_truncated',inventory_truncated)
    INTO v_checkpoint FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operation_key',o.operation_key,'kind',o.kind,'state',o.state,
    'reason',o.reason_code,'last_requested_at',(SELECT max(c.requested_at) FROM public.fb_analytics_captures c WHERE c.operation_id=o.id))
    ORDER BY o.operation_key),'[]'::jsonb) INTO v_operations
    FROM public.fb_analytics_collection_operations o WHERE o.job_id=p_job_id AND o.job_generation=p_job_generation;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN jsonb_build_object('checkpoint',COALESCE(v_checkpoint,jsonb_build_object('cursor',NULL,'post_ids','[]'::jsonb,'pages_fetched',0,
    'inventory_complete',false,'inventory_truncated',false)),'operations',v_operations);
END;
$fn$;

CREATE FUNCTION public.reserve_fb_analytics_inventory_page(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_expected_cursor text,p_expected_pages integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_checkpoint public.fb_analytics_collection_checkpoints;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  INSERT INTO public.fb_analytics_collection_checkpoints(job_id,user_id,social_account_id,job_generation)
    VALUES(p_job_id,v_job.user_id,v_job.social_account_id,p_job_generation) ON CONFLICT DO NOTHING;
  SELECT * INTO v_checkpoint FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation FOR UPDATE;
  IF p_expected_pages IS DISTINCT FROM v_checkpoint.pages_fetched OR p_expected_cursor IS DISTINCT FROM v_checkpoint.inventory_cursor
    OR v_checkpoint.inventory_complete OR v_checkpoint.inventory_truncated OR v_checkpoint.pages_fetched>=100 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_POSITION_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_checkpoint.inventory_request_id IS NULL OR v_checkpoint.inventory_response_digest IS NOT NULL
    OR v_checkpoint.inventory_request_claim IS DISTINCT FROM p_claim_token THEN
    UPDATE public.fb_analytics_collection_checkpoints SET inventory_request_id=gen_random_uuid(),inventory_request_claim=p_claim_token,
      inventory_response_digest=NULL,inventory_receipt=NULL,updated_at=clock_timestamp()
      WHERE job_id=p_job_id AND job_generation=p_job_generation RETURNING * INTO v_checkpoint;
  END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN jsonb_build_object('request_id',v_checkpoint.inventory_request_id,'cursor',v_checkpoint.inventory_cursor,'pages_fetched',v_checkpoint.pages_fetched);
END;
$fn$;

CREATE FUNCTION public.commit_fb_analytics_inventory_page(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_request_id uuid,p_post_ids text[],p_next_cursor text,p_has_more boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_checkpoint public.fb_analytics_collection_checkpoints;
  v_digest text;v_ids text[];v_complete boolean;v_truncated boolean;v_receipt jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT * INTO v_checkpoint FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation FOR UPDATE;
  IF NOT FOUND OR p_request_id IS NULL OR v_checkpoint.inventory_request_id IS DISTINCT FROM p_request_id
    OR v_checkpoint.inventory_request_claim IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_RESERVATION_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF p_post_ids IS NULL OR cardinality(p_post_ids)>25 OR p_has_more IS NULL
    OR p_has_more IS DISTINCT FROM (p_next_cursor IS NOT NULL)
    OR EXISTS(SELECT 1 FROM unnest(p_post_ids) k WHERE k IS NULL OR length(k)>200 OR k !~ '^[A-Za-z0-9_-]+$')
    OR cardinality(p_post_ids)<>(SELECT count(DISTINCT k) FROM unnest(p_post_ids) k)
    OR p_next_cursor IS NOT NULL AND (length(p_next_cursor) NOT BETWEEN 1 AND 4096 OR p_next_cursor ~ '://|[[:space:]]' OR lower(p_next_cursor) LIKE '%access_token%') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_INVENTORY_PAGE' USING ERRCODE='MAH01'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_post_ids) k WHERE k !~ '^[0-9]+_[0-9]+$' OR split_part(k,'_',1) IS DISTINCT FROM v_job.credential_authority->>'platform_user_id') THEN
    RAISE EXCEPTION 'META_ANALYTICS_SUBJECT_NOT_OWNED' USING ERRCODE='MAH02'; END IF;
  v_digest:=encode(sha256(convert_to(jsonb_build_object('post_ids',p_post_ids,'next_cursor',p_next_cursor,'has_more',p_has_more)::text,'utf8')),'hex');
  IF v_checkpoint.inventory_response_digest IS NOT NULL THEN
    IF v_checkpoint.inventory_response_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_REPLAY_CONFLICT' USING ERRCODE='MAH04'; END IF;
    IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
    RETURN v_checkpoint.inventory_receipt;
  END IF;
  IF v_checkpoint.inventory_complete OR v_checkpoint.inventory_truncated THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_ALREADY_FINISHED' USING ERRCODE='MAH04'; END IF;
  IF p_next_cursor IS NOT NULL AND (p_next_cursor IS NOT DISTINCT FROM v_checkpoint.inventory_cursor OR p_next_cursor=ANY(v_checkpoint.inventory_seen_cursors)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_CURSOR_CYCLE' USING ERRCODE='MAH01'; END IF;
  SELECT COALESCE(array_agg(k ORDER BY first_seen),'{}') INTO v_ids FROM
    (SELECT k,min(ordinality) first_seen FROM unnest(v_checkpoint.post_ids||p_post_ids) WITH ORDINALITY a(k,ordinality) GROUP BY k) ids;
  v_truncated:=cardinality(v_ids)>500 OR p_has_more AND (cardinality(v_ids)>=500 OR v_checkpoint.pages_fetched+1>=100);
  v_complete:=NOT p_has_more AND NOT v_truncated;
  v_ids:=v_ids[1:500];
  v_receipt:=public.checkpoint_fb_analytics_inventory(p_job_id,p_claim_token,p_job_generation,p_next_cursor,v_ids,
    v_checkpoint.pages_fetched+1,v_complete,v_truncated);
  v_receipt:=v_receipt||jsonb_build_object('inventory_truncated',v_truncated);
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.fb_analytics_collection_checkpoints SET inventory_response_digest=v_digest,inventory_receipt=v_receipt,
    inventory_seen_cursors=inventory_seen_cursors||CASE WHEN p_next_cursor IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p_next_cursor] END
    WHERE job_id=p_job_id AND job_generation=p_job_generation;
  RETURN v_receipt;
END;
$fn$;

REVOKE ALL ON FUNCTION public.read_fb_analytics_worker_state(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserve_fb_analytics_inventory_page(uuid,uuid,bigint,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.commit_fb_analytics_inventory_page(uuid,uuid,bigint,uuid,text[],text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_fb_analytics_worker_state(uuid,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_fb_analytics_inventory_page(uuid,uuid,bigint,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_fb_analytics_inventory_page(uuid,uuid,bigint,uuid,text[],text,boolean) TO service_role;

ALTER TABLE public.threads_analytics_collection_checkpoints
  ADD COLUMN inventory_request_id uuid,
  ADD COLUMN inventory_request_claim uuid,
  ADD COLUMN inventory_response_digest text CHECK(inventory_response_digest IS NULL OR inventory_response_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN inventory_receipt jsonb,
  ADD COLUMN inventory_seen_cursors text[] NOT NULL DEFAULT '{}' CHECK(cardinality(inventory_seen_cursors)<=100),
  ADD CONSTRAINT threads_inventory_reservation_pair CHECK((inventory_request_id IS NULL)=(inventory_request_claim IS NULL)),
  ADD CONSTRAINT threads_inventory_receipt_pair CHECK((inventory_response_digest IS NULL)=(inventory_receipt IS NULL));

CREATE FUNCTION public.read_threads_analytics_worker_state(p_job_id uuid,p_claim_token uuid,p_job_generation bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_checkpoint jsonb;v_operations jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT jsonb_build_object('cursor',inventory_cursor,'post_ids',post_ids,'pages_fetched',pages_fetched,
    'inventory_complete',inventory_complete,'inventory_truncated',inventory_truncated)
    INTO v_checkpoint FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operation_key',o.operation_key,'kind',o.kind,'state',o.state,
    'reason',o.reason_code,'last_requested_at',(SELECT max(c.requested_at) FROM public.threads_analytics_captures c WHERE c.operation_id=o.id))
    ORDER BY o.operation_key),'[]'::jsonb) INTO v_operations
    FROM public.threads_analytics_collection_operations o WHERE o.job_id=p_job_id AND o.job_generation=p_job_generation;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN jsonb_build_object('checkpoint',COALESCE(v_checkpoint,jsonb_build_object('cursor',NULL,'post_ids','[]'::jsonb,'pages_fetched',0,
    'inventory_complete',false,'inventory_truncated',false)),'operations',v_operations);
END;
$fn$;

CREATE FUNCTION public.reserve_threads_analytics_inventory_page(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_expected_cursor text,p_expected_pages integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_checkpoint public.threads_analytics_collection_checkpoints;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  INSERT INTO public.threads_analytics_collection_checkpoints(job_id,user_id,social_account_id,job_generation)
    VALUES(p_job_id,v_job.user_id,v_job.social_account_id,p_job_generation) ON CONFLICT DO NOTHING;
  SELECT * INTO v_checkpoint FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation FOR UPDATE;
  IF p_expected_pages IS DISTINCT FROM v_checkpoint.pages_fetched OR p_expected_cursor IS DISTINCT FROM v_checkpoint.inventory_cursor
    OR v_checkpoint.inventory_complete OR v_checkpoint.inventory_truncated OR v_checkpoint.pages_fetched>=100 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_POSITION_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_checkpoint.inventory_request_id IS NULL OR v_checkpoint.inventory_response_digest IS NOT NULL
    OR v_checkpoint.inventory_request_claim IS DISTINCT FROM p_claim_token THEN
    UPDATE public.threads_analytics_collection_checkpoints SET inventory_request_id=gen_random_uuid(),inventory_request_claim=p_claim_token,
      inventory_response_digest=NULL,inventory_receipt=NULL,updated_at=clock_timestamp()
      WHERE job_id=p_job_id AND job_generation=p_job_generation RETURNING * INTO v_checkpoint;
  END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN jsonb_build_object('request_id',v_checkpoint.inventory_request_id,'cursor',v_checkpoint.inventory_cursor,'pages_fetched',v_checkpoint.pages_fetched);
END;
$fn$;

CREATE FUNCTION public.commit_threads_analytics_inventory_page(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_request_id uuid,p_post_ids text[],p_next_cursor text,p_has_more boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_checkpoint public.threads_analytics_collection_checkpoints;
  v_digest text;v_ids text[];v_complete boolean;v_truncated boolean;v_receipt jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT * INTO v_checkpoint FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation FOR UPDATE;
  IF NOT FOUND OR p_request_id IS NULL OR v_checkpoint.inventory_request_id IS DISTINCT FROM p_request_id
    OR v_checkpoint.inventory_request_claim IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_RESERVATION_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF p_post_ids IS NULL OR cardinality(p_post_ids)>25 OR p_has_more IS NULL
    OR p_has_more IS DISTINCT FROM (p_next_cursor IS NOT NULL)
    OR EXISTS(SELECT 1 FROM unnest(p_post_ids) k WHERE k IS NULL OR length(k)>200 OR k !~ '^[A-Za-z0-9_-]+$')
    OR cardinality(p_post_ids)<>(SELECT count(DISTINCT k) FROM unnest(p_post_ids) k)
    OR p_next_cursor IS NOT NULL AND (length(p_next_cursor) NOT BETWEEN 1 AND 4096 OR p_next_cursor ~ '://|[[:space:]]' OR lower(p_next_cursor) LIKE '%access_token%') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_INVENTORY_PAGE' USING ERRCODE='MAH01'; END IF;
  v_digest:=encode(sha256(convert_to(jsonb_build_object('post_ids',p_post_ids,'next_cursor',p_next_cursor,'has_more',p_has_more)::text,'utf8')),'hex');
  IF v_checkpoint.inventory_response_digest IS NOT NULL THEN
    IF v_checkpoint.inventory_response_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_REPLAY_CONFLICT' USING ERRCODE='MAH04'; END IF;
    IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
    RETURN v_checkpoint.inventory_receipt;
  END IF;
  IF v_checkpoint.inventory_complete OR v_checkpoint.inventory_truncated THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_ALREADY_FINISHED' USING ERRCODE='MAH04'; END IF;
  IF p_next_cursor IS NOT NULL AND (p_next_cursor IS NOT DISTINCT FROM v_checkpoint.inventory_cursor OR p_next_cursor=ANY(v_checkpoint.inventory_seen_cursors)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_CURSOR_CYCLE' USING ERRCODE='MAH01'; END IF;
  SELECT COALESCE(array_agg(k ORDER BY first_seen),'{}') INTO v_ids FROM
    (SELECT k,min(ordinality) first_seen FROM unnest(v_checkpoint.post_ids||p_post_ids) WITH ORDINALITY a(k,ordinality) GROUP BY k) ids;
  v_truncated:=cardinality(v_ids)>500 OR p_has_more AND (cardinality(v_ids)>=500 OR v_checkpoint.pages_fetched+1>=100);
  v_complete:=NOT p_has_more AND NOT v_truncated;
  v_ids:=v_ids[1:500];
  v_receipt:=public.checkpoint_threads_analytics_inventory(p_job_id,p_claim_token,p_job_generation,p_next_cursor,v_ids,
    v_checkpoint.pages_fetched+1,v_complete,v_truncated);
  v_receipt:=v_receipt||jsonb_build_object('inventory_truncated',v_truncated);
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.threads_analytics_collection_checkpoints SET inventory_response_digest=v_digest,inventory_receipt=v_receipt,
    inventory_seen_cursors=inventory_seen_cursors||CASE WHEN p_next_cursor IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p_next_cursor] END
    WHERE job_id=p_job_id AND job_generation=p_job_generation;
  RETURN v_receipt;
END;
$fn$;

REVOKE ALL ON FUNCTION public.read_threads_analytics_worker_state(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserve_threads_analytics_inventory_page(uuid,uuid,bigint,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.commit_threads_analytics_inventory_page(uuid,uuid,bigint,uuid,text[],text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_threads_analytics_worker_state(uuid,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_threads_analytics_inventory_page(uuid,uuid,bigint,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_threads_analytics_inventory_page(uuid,uuid,bigint,uuid,text[],text,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
